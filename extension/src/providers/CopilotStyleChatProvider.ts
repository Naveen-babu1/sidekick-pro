import * as vscode from "vscode";
import { ModelService } from "../services/modelService";
import { CodeIndexer } from "../indexer/CodeIndexer";
import { ContextExtractor, ExtractedContext } from "../services/ContextExtractor";
import { SmartCache } from "../services/SmartCache";
import { PromptTemplates } from "../services/PromptTemplates";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  context?: {
    files: string[];
    symbols: string[];
    selection?: { start: number; end: number };
    command?: string | null;
  };
  references?: {
    file: string;
    lines: string;
    content?: string;
  }[];
  timestamp: Date;
}

interface CodeContext {
  type: "file" | "selection" | "workspace" | "symbol";
  name: string;
  content: string;
  path?: string;
  range?: vscode.Range;
}

// New interfaces for GitHub Copilot-style features
interface ContextItem {
  id: string;
  type: 'openEditors' | 'files' | 'clipboard' | 'instructions' | 'screenshot' | 'problems' | 'symbols' | 'tools';
  content?: string;
  files?: string[];
}

interface Tool {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  category: 'builtin' | 'extension' | 'mcp';
}

export class CopilotStyleChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "sidekickPro.copilotChat";

  private _view?: vscode.WebviewView;
  private _messages: ChatMessage[] = [];
  private _currentContext: CodeContext[] = [];
  private _disposables: vscode.Disposable[] = [];
  private readonly _contextExtractor = ContextExtractor.getInstance();
  private readonly _smartCache = SmartCache.getInstance();
  private readonly _promptTemplates = PromptTemplates.getInstance();
  private _extractedContextCache = new Map<string, ExtractedContext>();
  
  // New properties for GitHub Copilot-style features
  private _activeContextItems: ContextItem[] = [];
  private _availableTools: Map<string, Tool> = new Map();
  private _selectedModel: string = 'GPT-4o mini';
  private _agentMode: boolean = true;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
    private readonly _modelService: ModelService,
    private readonly _codeIndexer: CodeIndexer
  ) {
    this.loadChatHistory();
    this.initializeTools();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(
      async (data) => {
        switch (data.type) {
          case "sendMessage":
            await this.handleUserMessage(data.message);
            break;
          case "message":
            await this.handleUserMessage(data.text, data.context);
            break;
          case "addContext":
            await this.handleAddContext(data.contextType);
            break;
          case "selectContext":
            await this.handleContextSelection(data.contextType);
            break;
          case "switchModel":
            await this.switchModel(data.model);
            break;
          case "switchAgent":
            await this.toggleAgentMode();
            break;
          case "showHistory":
            await this.showChatHistory();
            break;
          case "showSettings":
            await this.showSettings();
            break;
          case "generateInstructions":
            await this.generateOnboardingInstructions();
            break;
          case "removeContext":
            this.removeContext(data.index);
            break;
          case "insertCode":
            this.insertCode(data.code);
            break;
          case "applyInEditor":
            this.applyInEditor(data.code);
            break;
          case "copyCode":
            await vscode.env.clipboard.writeText(data.code);
            vscode.window.showInformationMessage("Code copied to clipboard");
            break;
          case "createNewFile":
            await this.createNewFile(data.code, data.language);
            break;
          case "openDiff":
            await this.openDiff(data.code);
            break;
          case "clear":
            this.clearChat();
            break;
          case "insertIntoTerminal":
            await vscode.commands.executeCommand(
              "workbench.action.terminal.sendSequence",
              {
                text: data.code,
              }
            );
            vscode.window.showInformationMessage("Code sent to terminal");
            break;
        }
      },
      null,
      this._disposables
    );

    // Update context when selection changes
    vscode.window.onDidChangeTextEditorSelection(
      () => this.updateSelectionContext(),
      null,
      this._disposables
    );

    // Initialize with current context
    this.updateInitialContext();
  }

  private async createNewFile(code: string, language: string) {
    const newFileUri = vscode.Uri.parse(`untitled:NewFile.${language}`);
    const document = await vscode.workspace.openTextDocument(newFileUri);
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit((editBuilder) => {
      editBuilder.insert(new vscode.Position(0, 0), code);
    });
  }

  private async handleUserMessage(message: string, contextItems?: ContextItem[]) {
    if (!message.trim()) return;

    const { command, mentions, text } = this.parseMessage(message);

    const userMessage: ChatMessage = {
      role: "user",
      content: message,
      context: {
        files: this._currentContext
          .filter((c) => c.type === "file")
          .map((c) => c.name),
        symbols: this._currentContext
          .filter((c) => c.type === "symbol")
          .map((c) => c.name),
        command,
      },
      timestamp: new Date(),
    };

    this._messages.push(userMessage);
    this.updateChat();

    this._view?.webview.postMessage({ type: "showTyping" });

    try {
      let response = "";
      let references: { file: string; lines: string; content?: string }[] = [];

      if (command) {
        const result = await this.handleSlashCommand(command, text);
        response = result.response;
        references = result.references || [];
      } else {
        const result = await this.processWithContext(text, mentions, contextItems);
        response = result.response;
        references = result.references || [];
      }

      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: response,
        references,
        timestamp: new Date(),
      };

      this._messages.push(assistantMessage);
    } catch (error: any) {
      console.error("Error processing message:", error);
      this._messages.push({
        role: "assistant",
        content: `Error: ${String(error?.message ?? error)}`,
        timestamp: new Date(),
      });
    }

    this._view?.webview.postMessage({ type: "hideTyping" });
    this.updateChat();
    this.saveChatHistory();
  }

  // Enhanced context selection handler for GitHub Copilot-style UI
  private async handleContextSelection(contextType: string) {
    let contextContent: any = null;
    
    switch (contextType) {
      case 'openEditors':
        contextContent = await this.getOpenEditorsContext();
        break;
      case 'files':
        contextContent = await this.selectFilesForContext();
        break;
      case 'clipboard':
        contextContent = await this.getClipboardContext();
        break;
      case 'instructions':
        contextContent = await this.getInstructionsContext();
        break;
      case 'screenshot':
        contextContent = await this.captureScreenshot();
        break;
      case 'problems':
        contextContent = await this.getProblemsContext();
        break;
      case 'symbols':
        contextContent = await this.getSymbolsContext();
        break;
      case 'tools':
        contextContent = await this.configureTools();
        break;
    }
    
    if (contextContent) {
      this._activeContextItems.push({
        id: `context-${Date.now()}`,
        type: contextType as any,
        content: contextContent
      });
      
      // Notify webview that context was added
      this._view?.webview.postMessage({
        type: 'contextAdded',
        contextType: contextType
      });
    }
  }

  // Context gathering methods
  private async getOpenEditorsContext(): Promise<string[]> {
    const editors = vscode.window.tabGroups.all
      .flatMap(group => group.tabs)
      .filter(tab => tab.input instanceof vscode.TabInputText)
      .map(tab => (tab.input as vscode.TabInputText).uri.fsPath);
    
    return editors;
  }

  private async selectFilesForContext(): Promise<string[]> {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: true,
      title: 'Select files or folders to add as context'
    });
    
    if (files) {
      return files.map(f => f.fsPath);
    }
    return [];
  }

  private async getClipboardContext(): Promise<string> {
    const clipboardContent = await vscode.env.clipboard.readText();
    return clipboardContent;
  }

  private async getInstructionsContext(): Promise<string> {
    const instructions = await vscode.window.showInputBox({
      prompt: 'Enter custom instructions for the AI',
      placeHolder: 'e.g., Use TypeScript, follow our coding standards...'
    });
    
    return instructions || '';
  }

  private async captureScreenshot(): Promise<string> {
    vscode.window.showInformationMessage('Screenshot capture integration coming soon');
    return '';
  }

  private async getProblemsContext(): Promise<any[]> {
    const diagnostics = vscode.languages.getDiagnostics();
    const problems: any[] = [];
    
    diagnostics.forEach(([uri, diags]) => {
      diags.forEach(diag => {
        problems.push({
          file: uri.fsPath,
          line: diag.range.start.line,
          message: diag.message,
          severity: diag.severity
        });
      });
    });
    
    return problems;
  }

  private async getSymbolsContext(): Promise<any[]> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return [];
    
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      editor.document.uri
    );
    
    if (symbols) {
      return symbols.map(s => ({
        name: s.name,
        kind: s.kind,
        range: s.range
      }));
    }
    
    return [];
  }

  private async configureTools(): Promise<void> {
    vscode.window.showInformationMessage('Tools configuration panel will be shown in the webview');
  }

  // Initialize available tools
  private initializeTools() {
    // Built-in tools
    this._availableTools.set('changes', {
      id: 'changes',
      name: 'Get Changes',
      description: 'Get diffs of changed files',
      enabled: true,
      category: 'builtin'
    });
    
    this._availableTools.set('edit', {
      id: 'edit',
      name: 'Edit Files',
      description: 'Edit files in your workspace',
      enabled: true,
      category: 'builtin'
    });
    
    this._availableTools.set('search', {
      id: 'search',
      name: 'Search',
      description: 'Search and read files in your workspace',
      enabled: true,
      category: 'builtin'
    });
    
    this._availableTools.set('extensions', {
      id: 'extensions',
      name: 'Extensions',
      description: 'Search for VS Code extensions',
      enabled: true,
      category: 'builtin'
    });
    
    this._availableTools.set('fetch', {
      id: 'fetch',
      name: 'Fetch',
      description: 'Fetch content from a web page',
      enabled: true,
      category: 'builtin'
    });
    
    this._availableTools.set('githubRepo', {
      id: 'githubRepo',
      name: 'GitHub Repo',
      description: 'Search GitHub repositories',
      enabled: true,
      category: 'builtin'
    });
  }

  // Enhanced process with context including GitHub Copilot features
  private async processWithContext(
    query: string,
    mentions: string[],
    contextItems?: ContextItem[]
  ): Promise<{ response: string; references: any[] }> {
    const editor = vscode.window.activeTextEditor;
    let references: any[] = [];
    let contextString = '';
    
    // Build context from active context items
    if (contextItems && contextItems.length > 0) {
      for (const item of contextItems) {
        switch (item.type) {
          case 'openEditors':
            const editors = await this.getOpenEditorsContext();
            contextString += `\nOpen Files: ${editors.join(', ')}`;
            break;
          case 'problems':
            const problems = await this.getProblemsContext();
            contextString += `\nProblems: ${JSON.stringify(problems)}`;
            break;
          case 'symbols':
            const symbols = await this.getSymbolsContext();
            contextString += `\nSymbols: ${symbols.map(s => s.name).join(', ')}`;
            break;
          default:
            if (item.content) {
              contextString += `\n${item.type}: ${item.content}`;
            }
        }
      }
    }
    
    // Extract current editor context
    let extractedContext: ExtractedContext | undefined;
    if (editor) {
      extractedContext = await this._contextExtractor.extractContext(
        editor.document,
        editor.selection.active
      );
      
      contextString += this.buildContextString(extractedContext);
    }
    
    // Add mentions context
    if (mentions.includes('@workspace')) {
      const workspaceContext = await this._codeIndexer.getContext();
      contextString += `\nWorkspace: ${workspaceContext}`;
    }
    
    // Build enhanced prompt with agent mode
    const prompt = this.buildEnhancedPrompt(query, contextString, this._agentMode);
    
    // Get response from model service
    const response = await this._modelService.chat(
      prompt,
      contextString
    );
    
    // Extract references from response if needed
    if (extractedContext) {
      const referenceRange: vscode.Range | undefined =
        editor?.selection && !editor.selection.isEmpty
          ? editor.selection
          : ((extractedContext as any)?.range as vscode.Range | undefined);
      const fallbackLine = editor?.selection?.active.line ?? 0;

      references.push({
        file: editor?.document.fileName || 'current',
        lines: referenceRange
          ? `${referenceRange.start.line + 1}-${referenceRange.end.line + 1}`
          : `${fallbackLine + 1}-${fallbackLine + 1}`,
        content: extractedContext.prefix
      });
    }
    
    return { response, references };
  }

  // Build enhanced prompt with agent mode
  private buildEnhancedPrompt(query: string, context: string, agentMode: boolean): string {
    if (agentMode) {
      return `You are an AI agent helping with code development. 
You have access to various tools and can execute commands.
Be proactive in suggesting improvements and automations.

Context:
${context}

User Query: ${query}

Provide a comprehensive response with actionable suggestions.`;
    } else {
      return `Context:
${context}

Query: ${query}`;
    }
  }

  // Model and mode management
  private async switchModel(model: string) {
    this._selectedModel = model;
    
    // Update model service if needed
    if (model === 'Local Model') {
      await this._modelService.switchProvider('local');
    } else {
      await this._modelService.switchProvider('openai');
    }
    
    vscode.window.showInformationMessage(`Switched to ${model}`);
    this.saveChatHistory();
  }

  private async toggleAgentMode() {
    this._agentMode = !this._agentMode;
    vscode.window.showInformationMessage(
      `Agent mode ${this._agentMode ? 'enabled' : 'disabled'}`
    );
  }

  // Show chat history
  private async showChatHistory() {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = 'Chat History';
    quickPick.placeholder = 'Select a previous conversation to restore';
    
    const history = this._context.globalState.get<any[]>('copilotChatHistory') || [];
    
    quickPick.items = history.slice(-20).map(msg => ({
      label: msg.content.substring(0, 50) + '...',
      description: new Date(msg.timestamp).toLocaleString(),
      detail: msg.role
    }));
    
    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      if (selected) {
        vscode.window.showInformationMessage('Restored conversation');
      }
      quickPick.dispose();
    });
    
    quickPick.show();
  }

  // Show settings
  private async showSettings() {
    vscode.commands.executeCommand('workbench.action.openSettings', 'sidekick-pro');
  }

  // Generate onboarding instructions
  private async generateOnboardingInstructions() {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }
    
    const projectLang = await this.detectProjectLanguage();
    const framework = await this.detectFramework();
    
    const instructions = `# Sidekick Pro Onboarding Instructions

## Project Structure
- **Language**: ${projectLang}
- **Framework**: ${framework}
- **Dependencies**: Check package.json/requirements.txt

## Coding Standards
- Follow existing code style
- Use TypeScript/type hints when available
- Write comprehensive tests

## AI Assistant Guidelines
- Provide contextual suggestions
- Explain complex code sections
- Help with debugging and optimization
- Use agent mode for proactive assistance

## Available Commands
- **/explain** - Explain selected code
- **/fix** - Fix errors in code
- **/refactor** - Improve code structure
- **/test** - Generate test cases
- **/docs** - Generate documentation

## Context Options
- **@workspace** - Include entire workspace context
- **@file** - Include specific file
- **#symbol** - Reference specific symbol

Start by selecting code and using /explain to understand the codebase!`;
    
    // Send instructions as a message
    this._view?.webview.postMessage({
      type: 'addMessage',
      role: 'assistant',
      content: instructions
    });
    
    // Add to messages
    this._messages.push({
      role: 'assistant',
      content: instructions,
      timestamp: new Date()
    });
    
    this.updateChat();
  }

  // Helper method to detect project language
  private async detectProjectLanguage(): Promise<string> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return 'Unknown';
    
    const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 10);
    
    const extensions = files.map(f => f.path.split('.').pop());
    const langMap: Record<string, string> = {
      'ts': 'TypeScript',
      'js': 'JavaScript',
      'py': 'Python',
      'java': 'Java',
      'cs': 'C#',
      'go': 'Go',
      'rs': 'Rust',
      'cpp': 'C++'
    };
    
    for (const [ext, lang] of Object.entries(langMap)) {
      if (extensions.includes(ext)) {
        return lang;
      }
    }
    
    return 'Unknown';
  }

  // Helper method to detect framework
  private async detectFramework(): Promise<string> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return 'None';
    
    const frameworkFiles: Record<string, string> = {
      'package.json': 'Node.js',
      'requirements.txt': 'Python',
      'pom.xml': 'Maven',
      'build.gradle': 'Gradle',
      'Cargo.toml': 'Rust/Cargo',
      'go.mod': 'Go Modules'
    };
    
    for (const [file, framework] of Object.entries(frameworkFiles)) {
      const exists = await vscode.workspace.findFiles(file, null, 1);
      if (exists.length > 0) {
        return framework;
      }
    }
    
    return 'None detected';
  }

  // Focus chat method for external calls
  public focusChat() {
    if (this._view) {
      this._view.show?.(true); // true means preserveFocus
      // Send a focus event to the webview
      this._view.webview.postMessage({ type: "focus" });
    }
  }

  // Existing methods continue from here...
  private async handleSlashCommand(command: string, text: string) {
    const editor = vscode.window.activeTextEditor;
    let response = "";
    let references: { file: string; lines: string; content?: string }[] = [];

    // Extract context if editor is available
    let extractedContext: ExtractedContext | undefined;
    if (editor) {
      extractedContext = await this._contextExtractor.extractContext(
        editor.document,
        editor.selection.active
      );
    }
    
    console.log(
      `Handling command: ${command} with provider: ${this._modelService.getCurrentProvider()}`
    );
    
    switch (command) {
      case "/explain":
        if (editor && extractedContext) {
          const explainPrompt = this._promptTemplates.explainPrompt(
            editor.selection.isEmpty 
              ? extractedContext.prefix
              : editor.document.getText(editor.selection),
            extractedContext,
            { style: 'concise' }
          );
          response = await this._modelService.chat(explainPrompt, "");
          references.push({
            file: vscode.workspace.asRelativePath(editor.document.uri),
            lines: `${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`,
          });
        } else {
          response = "Please select code or open a file to explain.";
        }
        break;

      case "/fix":
        if (editor) {
          const selectedText = editor.selection.isEmpty
            ? editor.document.getText()
            : editor.document.getText(editor.selection);
          const prompt = `Fix any issues in this code:\n\n${selectedText}`;
          response = await this._modelService.chat(prompt, "");
        }
        break;

      case "/refactor":
        if (editor && extractedContext) {
          const refactorPrompt = this._promptTemplates.refactorPrompt(
            editor.selection.isEmpty
              ? extractedContext.prefix
              : editor.document.getText(editor.selection),
            extractedContext
          );
          response = await this._modelService.chat(refactorPrompt, "");
          references.push({
            file: vscode.workspace.asRelativePath(editor.document.uri),
            lines: `${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`,
          });
        }
        break;

      case "/test":
      case "/tests":
        if (editor && extractedContext) {
          const codeForTests = editor.selection.isEmpty
            ? this.getFunctionSource(extractedContext.currentFunction) ?? extractedContext.prefix ?? ""
            : editor.document.getText(editor.selection);
          const testPrompt = this._promptTemplates.testPrompt(
            codeForTests,
            extractedContext
          );
          response = await this._modelService.chat(testPrompt, "");
          references.push({
            file: vscode.workspace.asRelativePath(editor.document.uri),
            lines: `${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`,
          });
        }
        break;

      case "/docs":
        if (editor) {
          const selectedText = editor.selection.isEmpty
            ? editor.document.getText()
            : editor.document.getText(editor.selection);
          const prompt = `Generate documentation for this code:\n\n${selectedText}`;
          response = await this._modelService.chat(prompt, "");
        }
        break;

      default:
        response = `Unknown command: ${command}. Available commands: /explain, /fix, /refactor, /test, /docs`;
    }

    return { response, references };
  }

  // Keep all your existing methods below...
  private async handleAddContext(contextType: string) {
    const editor = vscode.window.activeTextEditor;

    switch (contextType) {
      case "selection": {
        if (editor && !editor.selection.isEmpty) {
          const selectedText = editor.document.getText(editor.selection);
          this._currentContext.push({
            type: "selection",
            name: `Lines ${editor.selection.start.line + 1}-${
              editor.selection.end.line + 1
            }`,
            content: selectedText,
            range: editor.selection,
          });
          this.updateContextBadges();
        }
        break;
      }
      case "file": {
        if (editor) {
          const fileName = vscode.workspace.asRelativePath(editor.document.uri);
          const fileContent = editor.document.getText();
          
          const existing = this._currentContext.findIndex(
            c => c.type === "file" && c.name === fileName
          );
          
          if (existing === -1) {
            this._currentContext.push({
              type: "file",
              name: fileName,
              content: fileContent,
              path: editor.document.uri.fsPath,
            });
            this.updateContextBadges();
          } else {
            vscode.window.showInformationMessage("File already in context");
          }
        }
        break;
      }
      case "workspace": {
        this._currentContext.push({
          type: "workspace",
          name: "@workspace",
          content: "Full workspace context",
        });
        this.updateContextBadges();
        break;
      }
    }
  }

  private removeContext(index: number) {
    if (index >= 0 && index < this._currentContext.length) {
      this._currentContext.splice(index, 1);
      this.updateContextBadges();
    }
  }
  private updateContextBadges() {
    this._view?.webview.postMessage({
      type: "updateContext",
      context: this._currentContext.map((c) => ({
        type: c.type,
        name: c.name,
      })),
    });
  }

  private getFunctionSource(currentFunction: ExtractedContext["currentFunction"]): string | undefined {
    if (!currentFunction) {
      return undefined;
    }

    if (typeof currentFunction === "string") {
      return currentFunction;
    }

    const text = typeof (currentFunction as any).text === "string"
      ? (currentFunction as any).text
      : undefined;

    if (text && text.trim().length > 0) {
      return text;
    }

    const signature = typeof (currentFunction as any).signature === "string"
      ? (currentFunction as any).signature
      : undefined;

    const body = typeof (currentFunction as any).body === "string"
      ? (currentFunction as any).body
      : undefined;

    const parts = [signature, body].filter(
      (part): part is string => typeof part === "string" && part.trim().length > 0
    );

    if (parts.length > 0) {
      return parts.join("\n");
    }

    const parameterList = Array.isArray(currentFunction.parameters)
      ? currentFunction.parameters.join(", ")
      : "";

    if (currentFunction.name) {
      return `${currentFunction.name}(${parameterList})`;
    }

    return undefined;
  }

  private buildContextString(extractedContext?: ExtractedContext): string {
    let contextString = this._currentContext
      .map((ctx) => `[${ctx.name}]:\n${(ctx.content ?? "").substring(0, 1000)}`)
      .join("\n\n");
    
    if (extractedContext) {
      const functionSnippet = this.getFunctionSource(extractedContext.currentFunction);
      const contextDetails = [
        functionSnippet
          ? `Function: ${functionSnippet.substring(0, 500)}`
          : null,
        extractedContext.currentClass
          ? `Class: ${extractedContext.currentClass}`
          : null,
        extractedContext.imports.length
          ? `Imports: ${extractedContext.imports.join(", ")}`
          : null,
        `Language: ${extractedContext.language}`,
        extractedContext.localVariables.length
          ? `Variables: ${extractedContext.localVariables.slice(0, 10).join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      
      contextString += `\n\nCode Context:\n${contextDetails}`;
    }
    
    return contextString;
  }

  private parseMessage(message: string): {
    command: string | null;
    mentions: string[];
    text: string;
  } {
    const commandMatch = message.match(/^(\/\w+)\s*(.*)/);
    const command = commandMatch ? commandMatch[1] : null;
    const remainingText = commandMatch ? commandMatch[2] : message;

    const mentions: string[] = [];
    const mentionRegex = /@(\w+)/g;
    let match;
    while ((match = mentionRegex.exec(remainingText)) !== null) {
      mentions.push(match[1]);
    }

    const text = remainingText.replace(mentionRegex, "").trim();
    return { command, mentions, text };
  }

  private updateSelectionContext() {
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.selection.isEmpty) {
      const selectedText = editor.document.getText(editor.selection);
      if (selectedText.length > 10) {
        this._view?.webview.postMessage({
          type: "selectionAvailable",
          lines: `${editor.selection.start.line + 1}-${
            editor.selection.end.line + 1
          }`,
        });
      }
    }
  }

  private updateInitialContext() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      this._currentContext.push({
        type: "file",
        name: vscode.workspace.asRelativePath(editor.document.uri),
        content: editor.document.getText(),
        path: editor.document.uri.fsPath,
      });
      this.updateContextBadges();
    }
  }

  private insertCode(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.edit((editBuilder) => {
        editBuilder.insert(editor.selection.active, code);
      });
    }
  }

  private applyInEditor(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.edit((editBuilder) => {
        editBuilder.replace(editor.selection, code);
      });
    }
  }

  private async openDiff(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const originalText = editor.selection.isEmpty
      ? editor.document.getText()
      : editor.document.getText(editor.selection);

    // Create documents for comparison
    const originalDoc = await vscode.workspace.openTextDocument({
      content: originalText,
      language: editor.document.languageId,
    });

    const newDoc = await vscode.workspace.openTextDocument({
      content: code,
      language: editor.document.languageId,
    });

    // Open diff view
    await vscode.commands.executeCommand(
      "vscode.diff",
      originalDoc.uri,
      newDoc.uri,
      "Original ↔ AI Suggestion"
    );
  }

  private clearChat() {
    this._messages = [];
    this._activeContextItems = [];
    this.updateChat();
    this.saveChatHistory();
  }

  private updateChat() {
    this._view?.webview.postMessage({
      type: "updateMessages",
      messages: this._messages,
    });
  }

  private saveChatHistory() {
    // store last 100
    this._context.globalState.update(
      "copilotChatHistory",
      this._messages.slice(-100)
    );
  }

  private loadChatHistory() {
    const saved = this._context.globalState.get<any[]>("copilotChatHistory");
    if (saved) {
      // JSON -> Date revival (if needed)
      this._messages = saved.map((m) => ({
        ...m,
        timestamp: new Date(m.timestamp),
      })) as ChatMessage[];
    }
  }

  // Enhanced HTML for GitHub Copilot-style UI
  private _getHtmlForWebview(webview: vscode.Webview) {
    return this.getEnhancedCopilotChatHtml();
  }

  private getEnhancedCopilotChatHtml(): string {
    // This is the complete enhanced HTML from the artifact
    // Including all the GitHub Copilot-style UI elements
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    /* [Include all the styles from the enhanced HTML artifact] */
    :root {
        --vscode-foreground: #cccccc;
        --vscode-background: #1e1e1e;
        --vscode-panel-background: #252526;
        --vscode-input-background: #3c3c3c;
        --vscode-input-foreground: #cccccc;
        --vscode-button-background: #0e639c;
        --vscode-button-foreground: #ffffff;
        --vscode-button-hoverBackground: #1177bb;
        --vscode-border: #464647;
        --vscode-widget-shadow: rgba(0, 0, 0, 0.36);
        --vscode-list-hoverBackground: #2a2d2e;
        --vscode-list-activeSelectionBackground: #094771;
    }

    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }

    body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: var(--vscode-background);
        color: var(--vscode-foreground);
        height: 100vh;
        display: flex;
        flex-direction: column;
        font-size: 13px;
    }

    .header {
        display: flex;
        align-items: center;
        padding: 8px 12px;
        background: var(--vscode-panel-background);
        border-bottom: 1px solid var(--vscode-border);
    }

    .header-title {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        opacity: 0.8;
        margin-right: auto;
    }

    .header-actions {
        display: flex;
        gap: 2px;
    }

    .header-action {
        background: transparent;
        border: none;
        color: var(--vscode-foreground);
        cursor: pointer;
        padding: 4px 6px;
        border-radius: 4px;
        opacity: 0.7;
    }

    .header-action:hover {
        opacity: 1;
        background: var(--vscode-list-hoverBackground);
    }

    .welcome-container {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 24px;
        text-align: center;
    }

    .welcome-icon {
        font-size: 48px;
        margin-bottom: 24px;
        opacity: 0.8;
    }

    .welcome-title {
        font-size: 24px;
        font-weight: 300;
        margin-bottom: 12px;
    }

    .welcome-subtitle {
        color: #999;
        font-size: 14px;
        margin-bottom: 24px;
    }

    .welcome-link {
        color: #0e639c;
        text-decoration: none;
        font-size: 14px;
        cursor: pointer;
    }

    .messages-container {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        display: none;
    }

    .messages-container.has-messages {
        display: block;
    }

    .message {
        margin-bottom: 24px;
        animation: fadeIn 0.3s ease-in;
    }

    @keyframes fadeIn {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
    }

    .message-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        font-weight: 600;
    }

    .message-content {
        margin-left: 28px;
        line-height: 1.6;
    }

    .message-content pre {
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-border);
        border-radius: 4px;
        padding: 12px;
        margin: 8px 0;
        overflow-x: auto;
    }

    .message-content code {
        background: var(--vscode-input-background);
        padding: 2px 4px;
        border-radius: 3px;
        font-family: "Consolas", "Monaco", monospace;
        font-size: 12px;
    }

    .input-section {
        padding: 12px;
        background: var(--vscode-panel-background);
        border-top: 1px solid var(--vscode-border);
    }

    .context-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 8px;
        min-height: 28px;
    }

    .context-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-border);
        border-radius: 12px;
        font-size: 12px;
        animation: slideIn 0.2s ease-out;
    }

    @keyframes slideIn {
        from { opacity: 0; transform: scale(0.9); }
        to { opacity: 1; transform: scale(1); }
    }

    .input-wrapper {
        position: relative;
        display: flex;
        align-items: flex-end;
        gap: 8px;
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-border);
        border-radius: 6px;
        padding: 8px;
    }

    .input-wrapper:focus-within {
        border-color: var(--vscode-button-background);
    }

    .add-context-btn {
        background: transparent;
        border: none;
        color: var(--vscode-foreground);
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        opacity: 0.7;
        transition: all 0.2s;
        white-space: nowrap;
    }

    .add-context-btn:hover {
        opacity: 1;
        background: var(--vscode-list-hoverBackground);
    }

    #chatInput {
        flex: 1;
        background: transparent;
        border: none;
        color: var(--vscode-foreground);
        font-size: 13px;
        font-family: inherit;
        resize: none;
        outline: none;
        padding: 0;
        min-height: 20px;
        max-height: 120px;
        line-height: 1.5;
    }

    .context-menu {
        position: absolute;
        bottom: calc(100% + 8px);
        left: 0;
        right: 0;
        background: var(--vscode-panel-background);
        border: 1px solid var(--vscode-border);
        border-radius: 6px;
        box-shadow: 0 4px 12px var(--vscode-widget-shadow);
        display: none;
        max-height: 300px;
        overflow-y: auto;
        z-index: 1000;
    }

    .context-menu.active {
        display: block;
    }

    .context-menu-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 12px;
        cursor: pointer;
        transition: background 0.2s;
    }

    .context-menu-item:hover {
        background: var(--vscode-list-hoverBackground);
    }

    .model-selector {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        background: var(--vscode-list-hoverBackground);
        border: 1px solid var(--vscode-border);
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
    }

    .model-selector:hover {
        background: var(--vscode-list-activeSelectionBackground);
    }

    .send-button {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        transition: all 0.2s;
    }

    .send-button:hover:not(:disabled) {
        background: var(--vscode-button-hoverBackground);
    }

    .send-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .tools-modal {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.8);
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 2000;
    }

    .tools-modal.active {
        display: flex;
    }

    .tools-modal-content {
        background: var(--vscode-panel-background);
        border: 1px solid var(--vscode-border);
        border-radius: 8px;
        width: 90%;
        max-width: 600px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    }

    .typing-indicator {
        display: none;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        margin-left: 28px;
    }

    .typing-indicator.active {
        display: flex;
    }

    .typing-dot {
        width: 4px;
        height: 4px;
        background: var(--vscode-foreground);
        border-radius: 50%;
        opacity: 0.3;
        animation: typing 1.4s infinite;
    }

    @keyframes typing {
        0%, 60%, 100% { opacity: 0.3; }
        30% { opacity: 1; }
    }
</style>
</head>
<body>
    <!-- [Include all the HTML structure from the enhanced artifact] -->
    <!-- Header -->
    <div class="header">
        <span class="header-title">SIDEKICK PRO CHAT: CHAT</span>
        <div class="header-actions">
            <button class="header-action" title="New Chat" onclick="clearChat()">➕</button>
            <button class="header-action" title="History" onclick="showHistory()">🕐</button>
            <button class="header-action" title="Settings" onclick="showSettings()">⚙️</button>
            <button class="header-action" title="More Actions">⋯</button>
        </div>
    </div>

    <!-- Welcome Container -->
    <div class="welcome-container" id="welcomeContainer">
        <div class="welcome-icon">✨</div>
        <h2 class="welcome-title">Build with agent mode.</h2>
        <p class="welcome-subtitle">AI responses may be inaccurate.</p>
        <a href="#" class="welcome-link" onclick="generateInstructions()">Generate instructions to onboard AI onto your codebase.</a>
    </div>

    <!-- Messages Container -->
    <div class="messages-container" id="messagesContainer"></div>

    <!-- Input Section -->
    <div class="input-section">
        <div class="context-pills" id="contextPills"></div>
        
        <div class="input-wrapper">
            <button class="add-context-btn" onclick="toggleContextMenu()">
                <span>📎</span>
                <span>Add Context...</span>
            </button>
            
            <textarea id="chatInput" placeholder="Ask about your code or type / for commands..." rows="1"></textarea>
            
            <!-- Context Menu -->
            <div class="context-menu" id="contextMenu">
                <div class="context-menu-item" onclick="selectContext('openEditors')">
                    <span>📄</span>
                    <span>Open Editors</span>
                </div>
                <div class="context-menu-item" onclick="selectContext('files')">
                    <span>📁</span>
                    <span>Files & Folders...</span>
                </div>
                <div class="context-menu-item" onclick="selectContext('clipboard')">
                    <span>📋</span>
                    <span>Image from Clipboard</span>
                </div>
                <div class="context-menu-item" onclick="selectContext('instructions')">
                    <span>📝</span>
                    <span>Instructions...</span>
                </div>
                <div class="context-menu-item" onclick="selectContext('screenshot')">
                    <span>📷</span>
                    <span>Screenshot Window</span>
                </div>
                <div class="context-menu-item" onclick="selectContext('problems')">
                    <span>❌</span>
                    <span>Problems...</span>
                </div>
                <div class="context-menu-item" onclick="selectContext('symbols')">
                    <span>📦</span>
                    <span>Symbols...</span>
                </div>
                <div class="context-menu-item" onclick="selectContext('tools')">
                    <span>🔧</span>
                    <span>Tools...</span>
                </div>
            </div>
        </div>
        
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
            <div style="display: flex; align-items: center; gap: 8px;">
                <div class="model-selector" onclick="switchModel()">
                    <span>Agent</span>
                    <span>▼</span>
                </div>
                <div class="model-selector" onclick="selectModel()">
                    <span id="currentModel">GPT-4o mini</span>
                    <span>▼</span>
                </div>
                <button class="add-context-btn" onclick="showTools()" style="padding: 4px;">
                    ⚙️
                </button>
            </div>
            <div class="input-actions">
                <button class="send-button" id="sendButton" onclick="sendMessage()">
                    Send ▶
                </button>
            </div>
        </div>
        
        <div class="input-hint" style="font-size: 11px; color: #999; margin-top: 4px;">
            Press Enter to send, Shift+Enter for new line
        </div>
    </div>

    <!-- Typing Indicator -->
    <div class="typing-indicator" id="typingIndicator">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
    </div>

    <!-- Tools Configuration Modal -->
    <div class="tools-modal" id="toolsModal">
        <div class="tools-modal-content">
            <!-- [Include tools modal content] -->
        </div>
    </div>

<script>
    const vscode = acquireVsCodeApi();
    let messages = [];
    let contextItems = [];
    let selectedTools = new Set();

    // [Include all JavaScript from enhanced artifact]
    document.addEventListener('DOMContentLoaded', function() {
        const chatInput = document.getElementById('chatInput');
        
        // Auto-resize textarea
        chatInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            updateSendButton();
        });

        // Handle Enter key
        chatInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    });

    function toggleContextMenu() {
        const menu = document.getElementById('contextMenu');
        menu.classList.toggle('active');
    }

    function selectContext(type) {
        vscode.postMessage({
            type: 'selectContext',
            contextType: type
        });
        addContextPill(type);
        document.getElementById('contextMenu').classList.remove('active');
    }

    function addContextPill(type) {
        const pillsContainer = document.getElementById('contextPills');
        const pillId = 'context-' + Date.now();
        
        const typeInfo = {
            'openEditors': { icon: '📄', label: 'Open Editors' },
            'files': { icon: '📁', label: 'Selected Files' },
            'clipboard': { icon: '📋', label: 'Clipboard' },
            'instructions': { icon: '📝', label: 'Instructions' },
            'screenshot': { icon: '📷', label: 'Screenshot' },
            'problems': { icon: '❌', label: 'Problems' },
            'symbols': { icon: '📦', label: 'Symbols' },
            'tools': { icon: '🔧', label: 'Tools' }
        };

        const info = typeInfo[type] || { icon: '📎', label: type };
        
        const pill = document.createElement('div');
        pill.className = 'context-pill';
        pill.id = pillId;
        pill.innerHTML = \`
            <span>\${info.icon}</span>
            <span>\${info.label}</span>
            <span style="cursor: pointer; opacity: 0.5;" onclick="removeContextPill('\${pillId}')">✕</span>
        \`;
        
        pillsContainer.appendChild(pill);
        contextItems.push({ id: pillId, type: type });
    }

    function removeContextPill(pillId) {
        const pill = document.getElementById(pillId);
        if (pill) {
            pill.remove();
            contextItems = contextItems.filter(item => item.id !== pillId);
        }
    }

    function showTools() {
        vscode.postMessage({ type: 'showTools' });
    }

    function switchModel() {
        vscode.postMessage({ type: 'switchAgent' });
    }

    function selectModel() {
        const models = ['GPT-4o mini', 'GPT-4', 'Claude 3.5', 'Local Model'];
        const currentModel = document.getElementById('currentModel').textContent;
        const nextIndex = (models.indexOf(currentModel) + 1) % models.length;
        document.getElementById('currentModel').textContent = models[nextIndex];
        
        vscode.postMessage({ 
            type: 'switchModel',
            model: models[nextIndex]
        });
    }

    function sendMessage() {
        const input = document.getElementById('chatInput');
        const message = input.value.trim();
        
        if (!message) return;
        
        document.getElementById('welcomeContainer').style.display = 'none';
        document.getElementById('messagesContainer').classList.add('has-messages');
        
        input.value = '';
        input.style.height = 'auto';
        updateSendButton();
        
        vscode.postMessage({
            type: 'message',
            text: message,
            context: contextItems
        });
        
        document.getElementById('contextPills').innerHTML = '';
        contextItems = [];
    }

    function updateSendButton() {
        const input = document.getElementById('chatInput');
        const sendButton = document.getElementById('sendButton');
        sendButton.disabled = !input.value.trim();
    }

    function clearChat() {
        vscode.postMessage({ type: 'clear' });
    }

    function showHistory() {
        vscode.postMessage({ type: 'showHistory' });
    }

    function showSettings() {
        vscode.postMessage({ type: 'showSettings' });
    }

    function generateInstructions() {
        vscode.postMessage({ type: 'generateInstructions' });
    }

    // Listen for messages from extension
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'updateMessages':
                updateMessages(message.messages);
                break;
            case 'showTyping':
                document.getElementById('typingIndicator').classList.add('active');
                break;
            case 'hideTyping':
                document.getElementById('typingIndicator').classList.remove('active');
                break;
            case 'contextAdded':
                addContextPill(message.contextType);
                break;
        }
    });

    function updateMessages(msgs) {
        messages = msgs;
        const container = document.getElementById('messagesContainer');
        
        if (!messages || messages.length === 0) {
            container.innerHTML = '';
            container.classList.remove('has-messages');
            document.getElementById('welcomeContainer').style.display = 'flex';
            return;
        }
        
        document.getElementById('welcomeContainer').style.display = 'none';
        container.classList.add('has-messages');
        container.innerHTML = '';
        
        messages.forEach(msg => {
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message ' + msg.role;
            
            const icon = msg.role === 'user' ? '👤' : '🤖';
            const roleName = msg.role === 'user' ? 'You' : 'Sidekick Pro';
            
            messageDiv.innerHTML = \`
                <div class="message-header">
                    <span>\${icon}</span>
                    <span>\${roleName}</span>
                </div>
                <div class="message-content">\${formatContent(msg.content)}</div>
            \`;
            
            if (msg.references && msg.references.length > 0) {
                const refsDiv = document.createElement('div');
                refsDiv.style.marginLeft = '28px';
                refsDiv.style.marginTop = '8px';
                msg.references.forEach(ref => {
                    refsDiv.innerHTML += \`<span style="background: var(--vscode-input-background); padding: 2px 6px; border-radius: 4px; margin-right: 4px; font-size: 12px;">📄 \${ref.file}</span>\`;
                });
                messageDiv.appendChild(refsDiv);
            }
            
            container.appendChild(messageDiv);
        });
        
        container.scrollTop = container.scrollHeight;
    }

    function formatContent(content) {
        return content
            .replace(/\`\`\`([\\w]*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>')
            .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
            .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
            .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
            .replace(/\\n/g, '<br>');
    }
</script>
</body>
</html>`;
  }

  // Cleanup
  public dispose() {
    this._disposables.forEach(d => d.dispose());
  }
}