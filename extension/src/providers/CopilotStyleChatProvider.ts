import * as vscode from "vscode";
import { ModelService } from "../services/modelService";
import { CodeIndexer } from "../indexer/CodeIndexer";
import {
  ContextExtractor,
  ExtractedContext,
} from "../services/ContextExtractor";
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
  type:
    | "openEditors"
    | "files"
    | "clipboard"
    | "instructions"
    | "screenshot"
    | "problems"
    | "symbols"
    | "tools";
  content?: string;
  files?: string[];
}

interface Tool {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  category: "builtin" | "extension" | "mcp";
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
  private _selectedModel: string = "GPT-4o mini";
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

    webviewView.title = "Chat";
    webviewView.description = "Sidekick Pro Chat";

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

  private async handleUserMessage(
    message: string,
    contextItems?: ContextItem[]
  ) {
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
        const result = await this.processWithContext(
          text,
          mentions,
          contextItems
        );
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
    
    try {
        switch (contextType) {
            case 'openEditors':
                contextContent = await this.getOpenEditorsContext();
                if (contextContent && contextContent.length > 0) {
                    // Add context item with proper formatting
                    this._activeContextItems.push({
                        id: `context-${Date.now()}`,
                        type: 'openEditors',
                        files: contextContent,
                        content: `Open files: ${contextContent.join(', ')}`
                    });
                    
                    // Send visual feedback to webview
                    this._view?.webview.postMessage({
                        type: 'contextAdded',
                        contextType: 'openEditors',
                        display: `📂 ${contextContent.length} open files`,
                        details: contextContent
                    });
                    
                    vscode.window.showInformationMessage(`Added ${contextContent.length} open files to context`);
                }
                break;
                
            case 'files':
                contextContent = await this.selectFilesForContext();
                if (contextContent && contextContent.length > 0) {
                    this._activeContextItems.push({
                        id: `context-${Date.now()}`,
                        type: 'files',
                        files: contextContent.map((f: any) => f.path),
                        content: `Selected files: ${contextContent.map((f: any) => f.name).join(', ')}`
                    });
                    
                    this._view?.webview.postMessage({
                        type: 'contextAdded',
                        contextType: 'files',
                        display: `📄 ${contextContent.length} selected files`,
                        details: contextContent.map((f: any) => f.name)
                    });
                }
                break;
                
            case 'clipboard':
                contextContent = await this.getClipboardContext();
                if (contextContent) {
                    const preview = contextContent.substring(0, 50) + (contextContent.length > 50 ? '...' : '');
                    this._activeContextItems.push({
                        id: `context-${Date.now()}`,
                        type: 'clipboard',
                        content: contextContent
                    });
                    
                    this._view?.webview.postMessage({
                        type: 'contextAdded',
                        contextType: 'clipboard',
                        display: `📋 Clipboard (${contextContent.length} chars)`,
                        details: preview
                    });
                    
                    vscode.window.showInformationMessage('Clipboard content added to context');
                }
                break;
                
            case 'instructions':
                contextContent = await this.getInstructionsContext();
                if (contextContent) {
                    this._activeContextItems.push({
                        id: `context-${Date.now()}`,
                        type: 'instructions',
                        content: contextContent
                    });
                    
                    this._view?.webview.postMessage({
                        type: 'contextAdded',
                        contextType: 'instructions',
                        display: `📝 Custom instructions`,
                        details: contextContent.substring(0, 100) + '...'
                    });
                }
                break;
                
            case 'screenshot':
                // Enhanced screenshot handling with options
                const screenshotOption = await vscode.window.showQuickPick([
                    'Capture Active Editor',
                    'Capture Selection',
                    'Capture Window',
                    'Paste from Clipboard'
                ], {
                    placeHolder: 'Select screenshot capture method'
                });
                
                if (screenshotOption) {
                    contextContent = await this.captureScreenshot(screenshotOption);
                    if (contextContent) {
                        this._activeContextItems.push({
                            id: `context-${Date.now()}`,
                            type: 'screenshot',
                            content: contextContent
                        });
                        
                        this._view?.webview.postMessage({
                            type: 'contextAdded',
                            contextType: 'screenshot',
                            display: `📸 Screenshot (${screenshotOption})`,
                            details: 'Image captured'
                        });
                    }
                }
                break;
                
            case 'problems':
                contextContent = await this.getProblemsContext();
                if (contextContent && contextContent.length > 0) {
                    const errorCount = contextContent.filter((p: any) => p.severity === 'error').length;
                    const warningCount = contextContent.filter((p: any) => p.severity === 'warning').length;
                    
                    this._activeContextItems.push({
                        id: `context-${Date.now()}`,
                        type: 'problems',
                        content: JSON.stringify(contextContent, null, 2)
                    });
                    
                    this._view?.webview.postMessage({
                        type: 'contextAdded',
                        contextType: 'problems',
                        display: `⚠️ ${errorCount} errors, ${warningCount} warnings`,
                        details: contextContent.slice(0, 5).map((p: any) => `${p.source}: ${p.message}`)
                    });
                }
                break;
                
            case 'symbols':
                contextContent = await this.getSymbolsContext();
                if (contextContent && contextContent.length > 0) {
                    const symbolsByType: Record<string, any[]> = {};
                    contextContent.forEach((s: any) => {
                        if (!symbolsByType[s.kind]) symbolsByType[s.kind] = [];
                        symbolsByType[s.kind].push(s);
                    });
                    
                    this._activeContextItems.push({
                        id: `context-${Date.now()}`,
                        type: 'symbols',
                        content: JSON.stringify(contextContent, null, 2)
                    });
                    
                    const summary = Object.entries(symbolsByType)
                        .map(([type, symbols]) => `${symbols.length} ${type}s`)
                        .join(', ');
                    
                    this._view?.webview.postMessage({
                        type: 'contextAdded',
                        contextType: 'symbols',
                        display: `🔤 Symbols: ${summary}`,
                        details: contextContent.slice(0, 10).map((s: any) => `${s.kind}: ${s.name}`)
                    });
                }
                break;
                
            case 'tools':
                contextContent = await this.configureTools();
                if (contextContent) {
                    this._view?.webview.postMessage({
                        type: 'toolsConfigured',
                        tools: contextContent
                    });
                }
                break;
        }
        
        // Update the webview to show active contexts
        this.updateActiveContextsDisplay();
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to add context: ${error}`);
        console.error('Context selection error:', error);
    }

    
}

  // Context gathering methods
  private async getOpenEditorsContext(): Promise<string[]> {
    const editors = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputText)
      .map((tab) => (tab.input as vscode.TabInputText).uri.fsPath);

    return editors;
  }

  private updateActiveContextsDisplay() {
    // Send updated context list to webview
    const contextSummary = this._activeContextItems.map(item => ({
        id: item.id,
        type: item.type,
        summary: this.getContextSummary(item)
    }));
    
    this._view?.webview.postMessage({
        type: 'updateActiveContexts',
        contexts: contextSummary
    });
}

  private getContextSummary(item: ContextItem): string {
    switch (item.type) {
        case 'openEditors':
            return `${item.files?.length || 0} open files`;
        case 'files':
            return `${item.files?.length || 0} selected files`;
        case 'clipboard':
            return `Clipboard (${item.content?.length || 0} chars)`;
        case 'instructions':
            return 'Custom instructions';
        case 'screenshot':
            return 'Screenshot';
        case 'problems':
            const problems = JSON.parse(item.content || '[]');
            return `${problems.length} problems`;
        case 'symbols':
            const symbols = JSON.parse(item.content || '[]');
            return `${symbols.length} symbols`;
        case 'tools':
            return 'Tools configured';
        default:
            return item.type;
    }
}

  private async selectFilesForContext(): Promise<any[]> {
    // Show a multi-step selection process
    const option = await vscode.window.showQuickPick([
        '📁 Select files from workspace',
        '📂 Select entire folder',
        '🔍 Search for files',
        '📝 Recently edited files'
    ], {
        placeHolder: 'How would you like to select files?'
    });
    
    if (!option) return [];
    
    let files: vscode.Uri[] = [];
    
    if (option.includes('Select files from workspace')) {
        const selected = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Add to Context',
            filters: {
                'All Files': ['*'],
                'Code Files': ['ts', 'js', 'tsx', 'jsx', 'py', 'java', 'cs', 'cpp', 'go', 'rs'],
                'Documents': ['md', 'txt', 'json', 'xml', 'yaml', 'yml']
            }
        });
        files = selected || [];
        
    } else if (option.includes('Select entire folder')) {
        const selected = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: 'Add Folder to Context'
        });
        
        if (selected && selected[0]) {
            // Get all files in the folder (non-recursive for performance)
            const pattern = new vscode.RelativePattern(selected[0], '*.*');
            files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 20);
        }
        
    } else if (option.includes('Search for files')) {
        const pattern = await vscode.window.showInputBox({
            prompt: 'Enter file pattern (e.g., *.ts, **/*.json)',
            placeHolder: '**/*.ts'
        });
        
        if (pattern) {
            files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 20);
        }
        
    } else if (option.includes('Recently edited')) {
        // Get recently edited files from workspace
        const recentFiles = vscode.workspace.textDocuments
            .filter(doc => !doc.isUntitled)
            .map(doc => doc.uri)
            .slice(0, 10);
        files = recentFiles;
    }
    
    // Read file contents with size limits
    const fileContents = [];
    for (const file of files) {
        try {
            const stat = await vscode.workspace.fs.stat(file);
            
            // Skip files larger than 100KB to avoid performance issues
            if (stat.size > 100000) {
                vscode.window.showWarningMessage(`Skipping large file: ${vscode.workspace.asRelativePath(file)}`);
                continue;
            }
            
            const content = await vscode.workspace.fs.readFile(file);
            const text = Buffer.from(content).toString('utf8');
            
            fileContents.push({
                name: vscode.workspace.asRelativePath(file),
                path: file.fsPath,
                content: text,
                size: stat.size
            });
        } catch (error) {
            console.error(`Error reading file ${file.fsPath}:`, error);
        }
    }
    
    return fileContents;
}

  private async getClipboardContext(): Promise<string> {
    const clipboardContent = await vscode.env.clipboard.readText();
    return clipboardContent;
  }

  private async getInstructionsContext(): Promise<string> {
    // Multi-step instructions input
    const instructionType = await vscode.window.showQuickPick([
        '📝 Custom instructions',
        '🎯 Project guidelines',
        '🔧 Code style preferences',
        '📚 Domain knowledge',
        '🚀 Performance requirements'
    ], {
        placeHolder: 'What type of instructions would you like to add?'
    });
    
    if (!instructionType) return '';
    
    let promptText = 'Enter your instructions:';
    let placeholder = 'Type your instructions here...';
    
    if (instructionType.includes('Project guidelines')) {
        promptText = 'Enter project-specific guidelines:';
        placeholder = 'e.g., Use functional components, follow SOLID principles...';
    } else if (instructionType.includes('Code style')) {
        promptText = 'Enter code style preferences:';
        placeholder = 'e.g., Use 2 spaces for indentation, prefer const over let...';
    } else if (instructionType.includes('Domain knowledge')) {
        promptText = 'Enter domain-specific knowledge:';
        placeholder = 'e.g., This is a financial app, use BigDecimal for money calculations...';
    } else if (instructionType.includes('Performance')) {
        promptText = 'Enter performance requirements:';
        placeholder = 'e.g., Must handle 1000 requests/sec, optimize for mobile devices...';
    }
    
    const instructions = await vscode.window.showInputBox({
        prompt: promptText,
        placeHolder: placeholder,
        ignoreFocusOut: true
    });
    
    if (instructions) {
        // Prepend the type for context
        return `[${instructionType}]\n${instructions}`;
    }
    
    return '';
}

  private async getCodeSnippet(uri: vscode.Uri, range: vscode.Range): Promise<string> {
    try {
        const document = await vscode.workspace.openTextDocument(uri);
        return document.getText(range);
    } catch {
        return '';
    }
}

  private async captureScreenshot(method?: string): Promise<string> {
    // This is a placeholder - actual screenshot functionality would require
    // additional implementation or an extension API
    
    if (method === 'Paste from Clipboard') {
        // Try to get image data from clipboard (if available)
        const clipboardData = await vscode.env.clipboard.readText();
        if (clipboardData.startsWith('data:image')) {
            return clipboardData;
        }
    }
    
    // For other methods, we'd need to implement actual screenshot capture
    // This could involve:
    // 1. Using a native module
    // 2. Calling an external tool
    // 3. Using the VS Code proposed API (when available)
    
    vscode.window.showInformationMessage(
        'Screenshot capture requires additional setup. ' +
        'You can paste an image URL or base64 data instead.'
    );
    
    const imageData = await vscode.window.showInputBox({
        prompt: 'Paste image URL or base64 data',
        placeHolder: 'https://... or data:image/png;base64,...'
    });
    
    return imageData || '';
}

  private async getProblemsContext(): Promise<any[]> {
    const diagnostics = vscode.languages.getDiagnostics();
    const problems: any[] = [];
    
    // Process diagnostics with enhanced information
    for (const [uri, diags] of diagnostics) {
        if (diags.length > 0) {
            const relativePath = vscode.workspace.asRelativePath(uri);
            
            for (const diag of diags) {
                problems.push({
                    file: relativePath,
                    line: diag.range.start.line + 1,
                    column: diag.range.start.character + 1,
                    severity: diag.severity === vscode.DiagnosticSeverity.Error ? 'error' : 
                             diag.severity === vscode.DiagnosticSeverity.Warning ? 'warning' : 'info',
                    message: diag.message,
                    source: diag.source || 'unknown',
                    code: diag.code || '',
                    // Include the problematic code snippet
                    snippet: await this.getCodeSnippet(uri, diag.range)
                });
            }
        }
    }
    
    // Sort by severity (errors first) and then by file
    problems.sort((a, b) => {
        if (a.severity !== b.severity) {
            return a.severity === 'error' ? -1 : 1;
        }
        return a.file.localeCompare(b.file);
    });
    
    return problems;
}

  private async getSymbolsContext(): Promise<any[]> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return [];
    
    // Get document symbols with enhanced information
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        editor.document.uri
    );
    
    if (!symbols) return [];
    
    // Flatten and enhance symbol information
    const flattenSymbols = (
        syms: vscode.DocumentSymbol[], 
        parent?: string
    ): any[] => {
        const result: any[] = [];
        
        for (const sym of syms) {
            const symbolInfo = {
                name: sym.name,
                kind: vscode.SymbolKind[sym.kind],
                parent: parent,
                range: {
                    start: { line: sym.range.start.line + 1, character: sym.range.start.character + 1 },
                    end: { line: sym.range.end.line + 1, character: sym.range.end.character + 1 }
                },
                detail: sym.detail || '',
                // Get the actual code for the symbol
                code: editor.document.getText(sym.range).substring(0, 200)
            };
            
            result.push(symbolInfo);
            
            // Recursively process children
            if (sym.children && sym.children.length > 0) {
                result.push(...flattenSymbols(sym.children, sym.name));
            }
        }
        
        return result;
    };
    
    return flattenSymbols(symbols);
}

  private async configureTools(): Promise<Map<string, Tool>> {
    // Show tool configuration dialog
    const tools = Array.from(this._availableTools.values());
    
    const quickPickItems = tools.map(tool => ({
        label: tool.name,
        description: tool.description,
        picked: tool.enabled,
        detail: `Category: ${tool.category}`
    }));
    
    const selected = await vscode.window.showQuickPick(quickPickItems, {
        canPickMany: true,
        placeHolder: 'Select tools to enable'
    });
    
    if (selected) {
        // Update tool states
        tools.forEach(tool => {
            tool.enabled = selected.some(s => s.label === tool.name);
        });
        
        // Save configuration
        await this._context.globalState.update('enabledTools', 
            tools.filter(t => t.enabled).map(t => t.id)
        );
        
        vscode.window.showInformationMessage(
            `Enabled ${selected.length} tools`
        );
    }
    
    return this._availableTools;
}

  // Initialize available tools
  private initializeTools() {
    // Built-in tools
    this._availableTools.set("changes", {
      id: "changes",
      name: "Get Changes",
      description: "Get diffs of changed files",
      enabled: true,
      category: "builtin",
    });

    this._availableTools.set("edit", {
      id: "edit",
      name: "Edit Files",
      description: "Edit files in your workspace",
      enabled: true,
      category: "builtin",
    });

    this._availableTools.set("search", {
      id: "search",
      name: "Search",
      description: "Search and read files in your workspace",
      enabled: true,
      category: "builtin",
    });

    this._availableTools.set("extensions", {
      id: "extensions",
      name: "Extensions",
      description: "Search for VS Code extensions",
      enabled: true,
      category: "builtin",
    });

    this._availableTools.set("fetch", {
      id: "fetch",
      name: "Fetch",
      description: "Fetch content from a web page",
      enabled: true,
      category: "builtin",
    });

    this._availableTools.set("githubRepo", {
      id: "githubRepo",
      name: "GitHub Repo",
      description: "Search GitHub repositories",
      enabled: true,
      category: "builtin",
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
    let contextString = "";

    // Build context from active context items
    if (contextItems && contextItems.length > 0) {
      for (const item of contextItems) {
        switch (item.type) {
          case "openEditors":
            const editors = await this.getOpenEditorsContext();
            contextString += `\nOpen Files: ${editors.join(", ")}`;
            break;
          case "problems":
            const problems = await this.getProblemsContext();
            contextString += `\nProblems: ${JSON.stringify(problems)}`;
            break;
          case "symbols":
            const symbols = await this.getSymbolsContext();
            contextString += `\nSymbols: ${symbols
              .map((s) => s.name)
              .join(", ")}`;
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
    if (mentions.includes("@workspace")) {
      const workspaceContext = await this._codeIndexer.getContext();
      contextString += `\nWorkspace: ${workspaceContext}`;
    }

    // Build enhanced prompt with agent mode
    const prompt = this.buildEnhancedPrompt(
      query,
      contextString,
      this._agentMode
    );

    // Get response from model service
    const response = await this._modelService.chat(prompt, contextString);

    // Extract references from response if needed
    if (extractedContext) {
      const referenceRange: vscode.Range | undefined =
        editor?.selection && !editor.selection.isEmpty
          ? editor.selection
          : ((extractedContext as any)?.range as vscode.Range | undefined);
      const fallbackLine = editor?.selection?.active.line ?? 0;

      references.push({
        file: editor?.document.fileName || "current",
        lines: referenceRange
          ? `${referenceRange.start.line + 1}-${referenceRange.end.line + 1}`
          : `${fallbackLine + 1}-${fallbackLine + 1}`,
        content: extractedContext.prefix,
      });
    }

    return { response, references };
  }

  // Build enhanced prompt with agent mode
  private buildEnhancedPrompt(
    query: string,
    context: string,
    agentMode: boolean
  ): string {
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
    if (model === "Local Model") {
      await this._modelService.switchProvider("local");
    } else {
      await this._modelService.switchProvider("openai");
    }

    vscode.window.showInformationMessage(`Switched to ${model}`);
    this.saveChatHistory();
  }

  private async toggleAgentMode() {
    this._agentMode = !this._agentMode;
    vscode.window.showInformationMessage(
      `Agent mode ${this._agentMode ? "enabled" : "disabled"}`
    );
  }

  // Show chat history
  private async showChatHistory() {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = "Chat History";
    quickPick.placeholder = "Select a previous conversation to restore";

    const history =
      this._context.globalState.get<any[]>("copilotChatHistory") || [];

    quickPick.items = history.slice(-20).map((msg) => ({
      label: msg.content.substring(0, 50) + "...",
      description: new Date(msg.timestamp).toLocaleString(),
      detail: msg.role,
    }));

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      if (selected) {
        vscode.window.showInformationMessage("Restored conversation");
      }
      quickPick.dispose();
    });

    quickPick.show();
  }

  // Show settings
  private async showSettings() {
    vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "sidekick-pro"
    );
  }

  // Generate onboarding instructions
  private async generateOnboardingInstructions() {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      vscode.window.showErrorMessage("No workspace folder open");
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
      type: "addMessage",
      role: "assistant",
      content: instructions,
    });

    // Add to messages
    this._messages.push({
      role: "assistant",
      content: instructions,
      timestamp: new Date(),
    });

    this.updateChat();
  }

  // Helper method to detect project language
  private async detectProjectLanguage(): Promise<string> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return "Unknown";

    const files = await vscode.workspace.findFiles(
      "**/*",
      "**/node_modules/**",
      10
    );

    const extensions = files.map((f) => f.path.split(".").pop());
    const langMap: Record<string, string> = {
      ts: "TypeScript",
      js: "JavaScript",
      py: "Python",
      java: "Java",
      cs: "C#",
      go: "Go",
      rs: "Rust",
      cpp: "C++",
    };

    for (const [ext, lang] of Object.entries(langMap)) {
      if (extensions.includes(ext)) {
        return lang;
      }
    }

    return "Unknown";
  }

  // Helper method to detect framework
  private async detectFramework(): Promise<string> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return "None";

    const frameworkFiles: Record<string, string> = {
      "package.json": "Node.js",
      "requirements.txt": "Python",
      "pom.xml": "Maven",
      "build.gradle": "Gradle",
      "Cargo.toml": "Rust/Cargo",
      "go.mod": "Go Modules",
    };

    for (const [file, framework] of Object.entries(frameworkFiles)) {
      const exists = await vscode.workspace.findFiles(file, null, 1);
      if (exists.length > 0) {
        return framework;
      }
    }

    return "None detected";
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
            { style: "concise" }
          );
          response = await this._modelService.chat(explainPrompt, "");
          references.push({
            file: vscode.workspace.asRelativePath(editor.document.uri),
            lines: `${editor.selection.start.line + 1}-${
              editor.selection.end.line + 1
            }`,
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
            lines: `${editor.selection.start.line + 1}-${
              editor.selection.end.line + 1
            }`,
          });
        }
        break;

      case "/test":
      case "/tests":
        if (editor && extractedContext) {
          const codeForTests = editor.selection.isEmpty
            ? this.getFunctionSource(extractedContext.currentFunction) ??
              extractedContext.prefix ??
              ""
            : editor.document.getText(editor.selection);
          const testPrompt = this._promptTemplates.testPrompt(
            codeForTests,
            extractedContext
          );
          response = await this._modelService.chat(testPrompt, "");
          references.push({
            file: vscode.workspace.asRelativePath(editor.document.uri),
            lines: `${editor.selection.start.line + 1}-${
              editor.selection.end.line + 1
            }`,
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
            (c) => c.type === "file" && c.name === fileName
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
    if (index >= 0 && index < this._activeContextItems.length) {
        const removed = this._activeContextItems.splice(index, 1)[0];
        
        vscode.window.showInformationMessage(
            `Removed ${this.getContextSummary(removed)} from context`
        );
        
        this.updateActiveContextsDisplay();
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

  private getFunctionSource(
    currentFunction: ExtractedContext["currentFunction"]
  ): string | undefined {
    if (!currentFunction) {
      return undefined;
    }

    if (typeof currentFunction === "string") {
      return currentFunction;
    }

    const text =
      typeof (currentFunction as any).text === "string"
        ? (currentFunction as any).text
        : undefined;

    if (text && text.trim().length > 0) {
      return text;
    }

    const signature =
      typeof (currentFunction as any).signature === "string"
        ? (currentFunction as any).signature
        : undefined;

    const body =
      typeof (currentFunction as any).body === "string"
        ? (currentFunction as any).body
        : undefined;

    const parts = [signature, body].filter(
      (part): part is string =>
        typeof part === "string" && part.trim().length > 0
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
      const functionSnippet = this.getFunctionSource(
        extractedContext.currentFunction
      );
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
          ? `Variables: ${extractedContext.localVariables
              .slice(0, 10)
              .join(", ")}`
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

  // Replace the getEnhancedCopilotChatHtml method in your CopilotStyleChatProvider class

private getEnhancedCopilotChatHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
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
            --context-menu-background: #2d2d30;
            --context-item-hover: #094771;
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
            min-width: 350px;
        }

        /* Header */
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            background: var(--vscode-panel-background);
            border-bottom: 1px solid var(--vscode-border);
            min-height: 40px;
        }

        .header-title {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            opacity: 0.8;
        }

        .header-actions {
            display: flex;
            gap: 4px;
            align-items: center;
        }

        .header-action {
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.7;
            transition: all 0.2s;
            font-size: 16px;
        }

        .header-action:hover {
            opacity: 1;
            background: var(--vscode-list-hoverBackground);
        }

        /* Chat Container */
        .chat-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        /* Messages Area */
        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .message {
            display: flex;
            gap: 12px;
            animation: slideIn 0.3s ease;
        }

        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .message-icon {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            background: var(--vscode-button-background);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            font-size: 12px;
        }

        .message-content {
            flex: 1;
            line-height: 1.5;
        }

        .message-header {
            font-weight: 600;
            margin-bottom: 4px;
            opacity: 0.9;
        }

        .message pre {
            background: var(--vscode-panel-background);
            border: 1px solid var(--vscode-border);
            border-radius: 4px;
            padding: 8px;
            margin: 8px 0;
            overflow-x: auto;
        }

        .message code {
            background: var(--vscode-panel-background);
            padding: 2px 4px;
            border-radius: 3px;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 12px;
        }

        /* Context Pills */
        .active-contexts {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            padding: 8px 16px;
            background: var(--vscode-panel-background);
            border-top: 1px solid var(--vscode-border);
            min-height: 40px;
            align-items: center;
        }

        .context-pill {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-border);
            border-radius: 12px;
            padding: 4px 10px;
            font-size: 11px;
            display: flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .context-pill:hover {
            background: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-button-background);
        }

        .context-pill .remove {
            opacity: 0.6;
            cursor: pointer;
        }

        .context-pill .remove:hover {
            opacity: 1;
        }

        /* Input Area */
        .input-area {
            padding: 12px;
            background: var(--vscode-panel-background);
            border-top: 1px solid var(--vscode-border);
        }

        /* Context Menu Button */
        .context-menu-container {
            position: relative;
            margin-bottom: 8px;
        }

        .add-context-btn {
            width: 100%;
            padding: 8px;
            background: transparent;
            border: 1px dashed var(--vscode-border);
            border-radius: 4px;
            color: var(--vscode-foreground);
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            opacity: 0.7;
            transition: all 0.2s;
        }

        .add-context-btn:hover {
            opacity: 1;
            background: var(--vscode-list-hoverBackground);
            border-style: solid;
        }

        /* Context Menu */
        .context-menu {
            position: absolute;
            bottom: 100%;
            left: 0;
            right: 0;
            background: var(--context-menu-background);
            border: 1px solid var(--vscode-border);
            border-radius: 6px;
            box-shadow: var(--vscode-widget-shadow) 0 2px 8px;
            margin-bottom: 4px;
            display: none;
            z-index: 1000;
            max-height: 400px;
            overflow-y: auto;
        }

        .context-menu.show {
            display: block;
            animation: menuSlideUp 0.2s ease;
        }

        @keyframes menuSlideUp {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .context-menu-item {
            padding: 8px 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 12px;
            transition: background 0.15s;
            border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        }

        .context-menu-item:last-child {
            border-bottom: none;
        }

        .context-menu-item:hover {
            background: var(--context-item-hover);
        }

        .context-menu-icon {
            font-size: 16px;
            width: 24px;
            text-align: center;
            flex-shrink: 0;
        }

        .context-menu-label {
            flex: 1;
            display: flex;
            flex-direction: column;
        }

        .context-menu-title {
            font-weight: 500;
        }

        .context-menu-desc {
            font-size: 11px;
            opacity: 0.7;
            margin-top: 2px;
        }

        /* Input Controls */
        .input-controls {
            display: flex;
            gap: 8px;
            margin-top: 8px;
        }

        .model-selector {
            flex: 1;
            display: flex;
            gap: 4px;
        }

        .model-dropdown {
            flex: 1;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-border);
            color: var(--vscode-input-foreground);
            padding: 6px 8px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
        }

        /* Message Input */
        .message-input {
            width: 100%;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-border);
            color: var(--vscode-input-foreground);
            padding: 8px;
            border-radius: 4px;
            font-family: inherit;
            font-size: 13px;
            resize: vertical;
            min-height: 60px;
            max-height: 200px;
        }

        .message-input:focus {
            outline: none;
            border-color: var(--vscode-button-background);
        }

        /* Send Button */
        .send-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 500;
            transition: background 0.2s;
            white-space: nowrap;
        }

        .send-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        /* Welcome Screen */
        .welcome {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 32px;
            text-align: center;
        }

        .welcome-icon {
            font-size: 48px;
            margin-bottom: 16px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .welcome h2 {
            font-size: 20px;
            margin-bottom: 8px;
            font-weight: 600;
        }

        .welcome p {
            opacity: 0.7;
            margin-bottom: 24px;
        }

        .welcome-actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            justify-content: center;
        }

        .welcome-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.2s;
        }

        .welcome-btn:hover {
            background: var(--vscode-button-hoverBackground);
            transform: translateY(-1px);
        }

        /* Typing Indicator */
        .typing-indicator {
            display: none;
            padding: 8px 16px;
            opacity: 0.6;
        }

        .typing-indicator.show {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .typing-dot {
            width: 8px;
            height: 8px;
            background: var(--vscode-foreground);
            border-radius: 50%;
            animation: typing 1.4s infinite ease-in-out;
        }

        .typing-dot:nth-child(2) {
            animation-delay: 0.2s;
        }

        .typing-dot:nth-child(3) {
            animation-delay: 0.4s;
        }

        @keyframes typing {
            0%, 60%, 100% {
                opacity: 0.3;
                transform: scale(0.8);
            }
            30% {
                opacity: 1;
                transform: scale(1);
            }
        }

        /* Code Actions */
        .code-actions {
            display: flex;
            gap: 4px;
            margin-top: 8px;
        }

        .code-action {
            background: transparent;
            border: 1px solid var(--vscode-border);
            color: var(--vscode-foreground);
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 11px;
            cursor: pointer;
            opacity: 0.7;
            transition: all 0.2s;
        }

        .code-action:hover {
            opacity: 1;
            background: var(--vscode-list-hoverBackground);
        }
    </style>
</head>
<body>
    <!-- Header -->
    <div class="header">
        <span class="header-title">SIDEKICK PRO CHAT</span>
        <div class="header-actions">
            <button class="header-action" id="newChatBtn" title="New Chat">➕</button>
            <button class="header-action" id="historyBtn" title="History">🕐</button>
            <button class="header-action" id="settingsBtn" title="Settings">⚙️</button>
            <button class="header-action" id="moreBtn" title="More">⋯</button>
        </div>
    </div>

    <!-- Chat Container -->
    <div class="chat-container">
        <!-- Welcome Screen (shown when no messages) -->
        <div class="welcome" id="welcomeScreen">
            <div class="welcome-icon">✨</div>
            <h2>Sidekick Pro Chat</h2>
            <p>Your AI-powered coding assistant</p>
            <div class="welcome-actions">
                <button class="welcome-btn" onclick="quickAction('explain')">💡 Explain Code</button>
                <button class="welcome-btn" onclick="quickAction('fix')">🔧 Fix Issues</button>
                <button class="welcome-btn" onclick="quickAction('refactor')">🔄 Refactor</button>
                <button class="welcome-btn" onclick="quickAction('test')">🧪 Write Tests</button>
            </div>
        </div>

        <!-- Messages Area -->
        <div class="messages" id="messagesContainer" style="display: none;"></div>
        
        <!-- Typing Indicator -->
        <div class="typing-indicator" id="typingIndicator">
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
        </div>
    </div>

    <!-- Active Contexts Display -->
    <div class="active-contexts" id="activeContexts"></div>

    <!-- Input Area -->
    <div class="input-area">
        <!-- Context Menu -->
        <div class="context-menu-container">
            <button class="add-context-btn" id="addContextBtn">
                <span>📎</span>
                <span>Add Context...</span>
            </button>
            
            <div class="context-menu" id="contextMenu">
                <div class="context-menu-item" data-context="openEditors">
                    <span class="context-menu-icon">📝</span>
                    <div class="context-menu-label">
                        <span class="context-menu-title">Open Editors</span>
                        <span class="context-menu-desc">Include all open files</span>
                    </div>
                </div>
                <div class="context-menu-item" data-context="files">
                    <span class="context-menu-icon">📁</span>
                    <div class="context-menu-label">
                        <span class="context-menu-title">Files & Folders</span>
                        <span class="context-menu-desc">Select specific files or folders</span>
                    </div>
                </div>
                <div class="context-menu-item" data-context="clipboard">
                    <span class="context-menu-icon">📋</span>
                    <div class="context-menu-label">
                        <span class="context-menu-title">Image from Clipboard</span>
                        <span class="context-menu-desc">Paste image from clipboard</span>
                    </div>
                </div>
                <div class="context-menu-item" data-context="instructions">
                    <span class="context-menu-icon">📝</span>
                    <div class="context-menu-label">
                        <span class="context-menu-title">Instructions</span>
                        <span class="context-menu-desc">Add custom instructions</span>
                    </div>
                </div>
                <div class="context-menu-item" data-context="screenshot">
                    <span class="context-menu-icon">📸</span>
                    <div class="context-menu-label">
                        <span class="context-menu-title">Screenshot Window</span>
                        <span class="context-menu-desc">Capture a screenshot</span>
                    </div>
                </div>
                <div class="context-menu-item" data-context="problems">
                    <span class="context-menu-icon">❌</span>
                    <div class="context-menu-label">
                        <span class="context-menu-title">Problems</span>
                        <span class="context-menu-desc">Include errors and warnings</span>
                    </div>
                </div>
                <div class="context-menu-item" data-context="symbols">
                    <span class="context-menu-icon">🔤</span>
                    <div class="context-menu-label">
                        <span class="context-menu-title">Symbols</span>
                        <span class="context-menu-desc">Include document symbols</span>
                    </div>
                </div>
                <div class="context-menu-item" data-context="tools">
                    <span class="context-menu-icon">🔧</span>
                    <div class="context-menu-label">
                        <span class="context-menu-title">Tools</span>
                        <span class="context-menu-desc">Configure available tools</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Input Controls -->
        <div class="input-controls">
            <div class="model-selector">
                <select class="model-dropdown" id="agentDropdown">
                    <option value="agent">Agent ▼</option>
                    <option value="chat">Chat</option>
                </select>
                <select class="model-dropdown" id="modelDropdown">
                    <option value="gpt-4o-mini">GPT-4o mini ▼</option>
                    <option value="gpt-4">GPT-4</option>
                    <option value="local">Local Model</option>
                </select>
            </div>
            <button class="send-btn" id="sendBtn">Send ➤</button>
        </div>

        <!-- Message Input -->
        <textarea 
            class="message-input" 
            id="messageInput" 
            placeholder="Ask about your code or type / for commands..."
            rows="3"
        ></textarea>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentContexts = [];

        // Add Context Menu Toggle
        document.getElementById('addContextBtn').addEventListener('click', () => {
            const menu = document.getElementById('contextMenu');
            menu.classList.toggle('show');
        });

        // Handle context menu item clicks
        document.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', () => {
                const contextType = item.dataset.context;
                vscode.postMessage({ 
                    type: 'selectContext', 
                    contextType: contextType 
                });
                document.getElementById('contextMenu').classList.remove('show');
            });
        });

        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('contextMenu');
            const btn = document.getElementById('addContextBtn');
            if (!menu.contains(e.target) && !btn.contains(e.target)) {
                menu.classList.remove('show');
            }
        });

        // Handle message sending
        document.getElementById('sendBtn').addEventListener('click', sendMessage);
        document.getElementById('messageInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        function sendMessage() {
            const input = document.getElementById('messageInput');
            const message = input.value.trim();
            
            if (!message) return;
            
            vscode.postMessage({ 
                type: 'sendMessage', 
                message: message,
                contexts: currentContexts
            });
            
            input.value = '';
            
            // Show messages container and hide welcome
            document.getElementById('welcomeScreen').style.display = 'none';
            document.getElementById('messagesContainer').style.display = 'block';
        }

        // Handle model/agent selection
        document.getElementById('modelDropdown').addEventListener('change', (e) => {
            vscode.postMessage({ 
                type: 'switchModel', 
                model: e.target.value 
            });
        });

        document.getElementById('agentDropdown').addEventListener('change', (e) => {
            vscode.postMessage({ 
                type: 'switchAgent', 
                mode: e.target.value 
            });
        });

        // Header actions
        document.getElementById('newChatBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'clear' });
        });

        document.getElementById('historyBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'showHistory' });
        });

        document.getElementById('settingsBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'showSettings' });
        });

        // Quick actions
        function quickAction(action) {
            const commands = {
                'explain': '/explain',
                'fix': '/fix',
                'refactor': '/refactor',
                'test': '/test'
            };
            
            document.getElementById('messageInput').value = commands[action] + ' ';
            document.getElementById('messageInput').focus();
        }

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.type) {
                case 'updateMessages':
                    updateMessages(message.messages);
                    break;
                case 'showTyping':
                    document.getElementById('typingIndicator').classList.add('show');
                    break;
                case 'hideTyping':
                    document.getElementById('typingIndicator').classList.remove('show');
                    break;
                case 'contextAdded':
                    addContextPill(message);
                    break;
                case 'updateActiveContexts':
                    updateActiveContexts(message.contexts);
                    break;
            }
        });

        function updateMessages(messages) {
            const container = document.getElementById('messagesContainer');
            
            if (!messages || messages.length === 0) {
                document.getElementById('welcomeScreen').style.display = 'flex';
                container.style.display = 'none';
                return;
            }
            
            document.getElementById('welcomeScreen').style.display = 'none';
            container.style.display = 'block';
            
            container.innerHTML = '';
            
            messages.forEach(msg => {
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message';
                
                const icon = document.createElement('div');
                icon.className = 'message-icon';
                icon.textContent = msg.role === 'user' ? '👤' : '🤖';
                
                const content = document.createElement('div');
                content.className = 'message-content';
                
                const header = document.createElement('div');
                header.className = 'message-header';
                header.textContent = msg.role === 'user' ? 'You' : 'Sidekick Pro';
                
                const text = document.createElement('div');
                text.innerHTML = formatMessage(msg.content);
                
                content.appendChild(header);
                content.appendChild(text);
                
                // Add code actions if there's code
                if (msg.content.includes('\`\`\`')) {
                    const actions = document.createElement('div');
                    actions.className = 'code-actions';
                    actions.innerHTML = \`
                        <button class="code-action" onclick="copyCode()">📋 Copy</button>
                        <button class="code-action" onclick="insertCode()">📝 Insert</button>
                        <button class="code-action" onclick="applyCode()">✅ Apply</button>
                    \`;
                    content.appendChild(actions);
                }
                
                messageDiv.appendChild(icon);
                messageDiv.appendChild(content);
                container.appendChild(messageDiv);
            });
            
            container.scrollTop = container.scrollHeight;
        }

        function formatMessage(content) {
            return content
                .replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (match, lang, code) => {
                    return \`<pre><code class="\${lang}">\${escapeHtml(code)}</code></pre>\`;
                })
                .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
                .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
                .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
                .replace(/\\n/g, '<br>');
        }

        function escapeHtml(text) {
            const map = {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#039;'
            };
            return text.replace(/[&<>"']/g, m => map[m]);
        }

        function addContextPill(context) {
            const container = document.getElementById('activeContexts');
            const pill = document.createElement('div');
            pill.className = 'context-pill';
            pill.innerHTML = \`
                <span>\${context.display}</span>
                <span class="remove" onclick="removeContext(\${currentContexts.length})">×</span>
            \`;
            container.appendChild(pill);
            
            currentContexts.push(context);
        }

        function updateActiveContexts(contexts) {
            const container = document.getElementById('activeContexts');
            container.innerHTML = '';
            currentContexts = contexts || [];
            
            contexts.forEach((ctx, index) => {
                const pill = document.createElement('div');
                pill.className = 'context-pill';
                pill.innerHTML = \`
                    <span>\${ctx.summary}</span>
                    <span class="remove" onclick="removeContext(\${index})">×</span>
                \`;
                container.appendChild(pill);
            });
        }

        function removeContext(index) {
            vscode.postMessage({ 
                type: 'removeContext', 
                index: index 
            });
        }

        function copyCode() {
            // Find the last code block
            const codes = document.querySelectorAll('pre code');
            if (codes.length > 0) {
                const code = codes[codes.length - 1].textContent;
                vscode.postMessage({ type: 'copyCode', code: code });
            }
        }

        function insertCode() {
            const codes = document.querySelectorAll('pre code');
            if (codes.length > 0) {
                const code = codes[codes.length - 1].textContent;
                vscode.postMessage({ type: 'insertCode', code: code });
            }
        }

        function applyCode() {
            const codes = document.querySelectorAll('pre code');
            if (codes.length > 0) {
                const code = codes[codes.length - 1].textContent;
                vscode.postMessage({ type: 'applyInEditor', code: code });
            }
        }
    </script>
</body>
</html>`;
}

  // Cleanup
  public dispose() {
    this._disposables.forEach((d) => d.dispose());
  }
}
