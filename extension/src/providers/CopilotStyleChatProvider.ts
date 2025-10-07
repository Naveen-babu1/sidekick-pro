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

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
    private readonly _modelService: ModelService,
    private readonly _codeIndexer: CodeIndexer
  ) {
    this.loadChatHistory();
  }
  public focusChat() {
  if (this._view) {
    this._view.show?.(true); // true means preserveFocus
    // Send a focus event to the webview
    this._view.webview.postMessage({ type: "focus" });
  }
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
          case "addContext":
            await this.handleAddContext(data.contextType);
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
          case "switchModel":
            await this.switchModel(data.model);
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

  //   private async createNewFile(code: string, language: string) {
  //     const newFileUri = vscode.Uri.parse(`untitled:NewFile.${language}`);
  //     const document = await vscode.workspace.openTextDocument(newFileUri);
  //     const editor = await vscode.window.showTextDocument(document);
  //     await editor.edit((editBuilder) => {
  //       editBuilder.insert(new vscode.Position(0, 0), code);
  //     });
  //   }

  private async handleUserMessage(message: string) {
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
        const result = await this.processWithContext(text, mentions);
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
          // Use PromptTemplates for better explanations
          const explainPrompt = this._promptTemplates.explainPrompt(
            editor.selection.isEmpty 
              ? editor.document.getText()
              : editor.document.getText(editor.selection),
            extractedContext,
            { style: 'detailed' }
          );
          
          // Check cache first
          const cacheKey = `explain:${extractedContext.fileName}:${editor.selection.start.line}`;
          const cached = await this._smartCache.get(cacheKey, extractedContext, 'explain');
          
          if (cached) {
            response = cached;
          } else {
            response = await this._modelService.chat(explainPrompt, '');
            
            // Cache the explanation
            await this._smartCache.set(cacheKey, response, extractedContext, {
              feature: 'explain',
              language: extractedContext.language,
              modelUsed: this._modelService.getCurrentProvider(),
              ttl: 3600000 // 1 hour
            });
          }
          references = [{
            file: extractedContext.fileName,
            lines: `${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`,
            content: `Function: ${extractedContext.currentFunction?.name || 'global'}, Class: ${extractedContext.currentClass?.name || 'none'}`
          }];
        } else {
          response = "No active editor found to explain.";
        }
        break;
      
      case "/refactor":
        if (editor && extractedContext) {
          // Use PromptTemplates for refactoring
          const refactorPrompt = this._promptTemplates.refactorPrompt(
            editor.document.getText(editor.selection),
            extractedContext,
            { includeExamples: true }
          );
          
          const refactored = await this._modelService.chat(refactorPrompt, '');
          response = `Here's the refactored code:\n\n\`\`\`${editor.document.languageId}\n${refactored}\n\`\`\``;
          
          references = [{
            file: extractedContext.fileName,
            lines: `Refactored ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`,
            content: `Improved: ${text || 'code quality and structure'}`
          }];
        } else {
          response = "No active editor found to refactor.";
        }
        break;
      
      case "/debug":
        if (editor && extractedContext) {
          // Use PromptTemplates for debugging when available
          const debugPrompt = this.buildDebugPrompt(
            editor.document.getText(editor.selection),
            text || "Debug this code",
            extractedContext
          );
          
          const debugSolution = await this._modelService.chat(debugPrompt, '');
          response = debugSolution;
          
          references = [{
            file: extractedContext.fileName,
            lines: `Debug analysis for lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`,
            content: `Variables in scope: ${extractedContext.localVariables.slice(0, 5).join(', ')}`
          }];
        } else {
          response = "No active editor found to debug.";
        }
        break;

      case "/fix":
        if (editor) {
          const selectedText = editor.selection.isEmpty
            ? editor.document.getText()
            : editor.document.getText(editor.selection);

          const fixed = await this._modelService.fixError(
            selectedText,
            text, // error description
            this.getContextString(),
            editor.document.languageId
          );
          response = `Here's the fixed code:\n\n\`\`\`${editor.document.languageId}\n${fixed}\n\`\`\``;
        } else {
          response = "No active editor found to fix.";
        }
        break;

      case "/tests":
        if (editor) {
          const selectedText = editor.selection.isEmpty
            ? editor.document.getText()
            : editor.document.getText(editor.selection);

          const tests = await this._modelService.generateTests(
            selectedText,
            this.getContextString(),
            editor.document.languageId
          );
          response = `Generated tests:\n\n\`\`\`${editor.document.languageId}\n${tests}\n\`\`\``;
        } else {
          response = "No active editor found to generate tests.";
        }
        break;

      case "/docs":
        if (editor) {
          const selectedText = editor.selection.isEmpty
            ? editor.document.getText()
            : editor.document.getText(editor.selection);

          const docs = await this._modelService.chat(
            `Generate comprehensive documentation for this code:\n${selectedText}`,
            this.getContextString()
          );
          response = docs;
        } else {
          response = "No active editor found to document.";
        }
        break;

      default:
        response = await this._modelService.chat(text, this.getContextString());
    }

    return { response, references };
  }

  private async processWithContext(
    text: string,
    mentions: string[]
  ): Promise<{
    response: string;
    references?: { file: string; lines: string; content?: string }[];
  }> {
    const editor = vscode.window.activeTextEditor;
    let extractedContext: ExtractedContext | undefined;
    
    // Use ContextExtractor for richer context
    if (editor) {
      extractedContext = await this._contextExtractor.extractContext(
        editor.document,
        editor.selection.active
      );
      
      // Cache the extracted context for later use
      this._extractedContextCache.set(editor.document.uri.toString(), extractedContext);
    }
    
    // Build enhanced context string using extracted context
    const contextString = this.buildEnhancedContextString(extractedContext, mentions);
    
    // Create cache key for response caching
    const cacheKey = this.createChatCacheKey(text, extractedContext, mentions);
    
    // Check SmartCache first
    const cached = await this._smartCache.get(cacheKey, extractedContext || {}, 'chat');
    if (cached) {
      console.log('Using cached chat response');
      return {
        response: cached,
        references: extractedContext ? [{
          file: extractedContext.fileName,
          lines: `${editor?.selection.start.line || 1}-${editor?.selection.end.line || 1}`,
          content: extractedContext.prefix
        }] : []
      };
    }
    
    // Determine best prompt template based on query
    const enhancedPrompt = this.selectAndBuildPrompt(text, extractedContext, contextString);
    
    // Get response from model
    const response = await this._modelService.chat(
      enhancedPrompt,
      contextString
    );
    
    // Cache the response
    await this._smartCache.set(cacheKey, response, extractedContext || {}, {
      feature: 'chat',
      language: extractedContext?.language || 'unknown',
      modelUsed: this._modelService.getCurrentProvider(),
      ttl: 1800000 // 30 minutes
    });
    
    const references: { file: string; lines: string; content?: string }[] = [];
    
    if (extractedContext) {
      references.push({
        file: extractedContext.fileName,
        lines: `Context includes ${extractedContext.localVariables.length} variables, ${extractedContext.imports.length} imports`,
        content: extractedContext.prefix.substring(0, 200)
      });
    }
    
    // Add workspace context references if mentioned
    if (mentions.includes('@workspace')) {
      const workspaceFiles = await this.fetchRelevantWorkspaceFiles(text);
      workspaceFiles.slice(0, 3).forEach(file => {
        if (!file?.path) {
          return;
        }
        references.push({
          file: file.path,
          lines: 'Workspace context',
          content: file.content?.substring(0, 100)
        });
      });
    }
    
    return { response, references };
  }
  private buildEnhancedContextString(
    extractedContext: ExtractedContext | undefined,
    mentions: string[]
  ): string {
    let contextParts: string[] = [];
    
    if (extractedContext) {
      contextParts.push(`File: ${extractedContext.fileName}`);
      contextParts.push(`Language: ${extractedContext.language}`);
      
      if (extractedContext.currentFunction) {
        contextParts.push(`Current Function: ${extractedContext.currentFunction.name}`);
      }
      
      if (extractedContext.currentClass) {
        contextParts.push(`Current Class: ${extractedContext.currentClass.name}`);
      }
      
      if (extractedContext.localVariables.length > 0) {
        contextParts.push(`Variables: ${extractedContext.localVariables.slice(0, 10).join(', ')}`);
      }
      
      if (extractedContext.imports.length > 0) {
        contextParts.push(`Imports: ${extractedContext.imports.slice(0, 5).join(', ')}`);
      }
    }
    
    // Add existing context from mentions
    if (mentions.includes('@workspace')) {
      contextParts.push('Workspace context included');
    }
    
    if (mentions.includes('@file') && this._currentContext.length > 0) {
      contextParts.push(`Files in context: ${this._currentContext.map(c => c.name).join(', ')}`);
    }

    return contextParts.join('\n');
  }

  private createChatCacheKey(
    text: string,
    context: ExtractedContext | undefined,
    mentions: string[]
  ): string {
    const parts = [
      'chat',
      text.substring(0, 50).replace(/\s+/g, '_'),
      context?.fileName || 'no-file',
      context?.currentFunction?.name || 'global',
      mentions.join('-')
    ];
    
    return parts.join(':');
  }

  private async fetchRelevantWorkspaceFiles(
    query: string
  ): Promise<Array<{ path: string; content?: string }>> {
    const indexer = this._codeIndexer as unknown as {
      getRelevantFiles?: (q: string) => Promise<Array<{ path: string; content?: string }>>;
      search?: (q: string) => Promise<Array<{ path: string; content?: string }>>;
    };

    if (typeof indexer.search === 'function') {
      return indexer.search(query);
    }

    return [];
  }

  private buildDebugPrompt(
    selectedCode: string,
    debugRequest: string,
    extractedContext: ExtractedContext
  ): string {
    const templates = this._promptTemplates as unknown as {
      debugPrompt?: (code: string, request: string, context: ExtractedContext) => string;
    };

    if (typeof templates.debugPrompt === "function") {
      return templates.debugPrompt(selectedCode, debugRequest, extractedContext);
    }

    const contextSummary = [
      extractedContext.fileName ? `File: ${extractedContext.fileName}` : null,
      extractedContext.currentClass ? `Class: ${extractedContext.currentClass.name}` : null,
      extractedContext.currentFunction ? `Function: ${extractedContext.currentFunction.name}` : null,
      extractedContext.language ? `Language: ${extractedContext.language}` : null,
      extractedContext.localVariables.length
        ? `Variables: ${extractedContext.localVariables.slice(0, 10).join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    return [
      "You are an experienced software engineer who diagnoses bugs.",
      debugRequest ? `Request: ${debugRequest}` : "Request: Debug this code.",
      contextSummary ? `Context:\n${contextSummary}` : "",
      "Code:\n```",
      selectedCode,
      "```",
      "Identify likely issues, explain them, and propose fixes."
    ].join("\n");
  }

  // ENHANCEMENT 4: Add method to get chat statistics
  public getChatStats() {
    const cacheStats = this._smartCache.getStatistics();
    
    return {
      totalMessages: this._messages.length,
      cacheHitRate: cacheStats.hitRate,
      cachedResponses: cacheStats.memoryCacheSize,
      contextsCached: this._extractedContextCache.size,
      currentModel: this._modelService.getCurrentProvider()
    };
  }

  // ENHANCEMENT 5: Add method to clear caches
  public clearCaches() {
    this._smartCache.clear();
    this._extractedContextCache.clear();
    console.log('Chat caches cleared');
  }
  private selectAndBuildPrompt(
    query: string,
    extractedContext: ExtractedContext | undefined,
    contextString: string
  ): string {
    const lowerQuery = query.toLowerCase();
    
    // Determine query type and use appropriate template
    if (extractedContext) {
      if (lowerQuery.includes('explain')) {
        return this._promptTemplates.explainPrompt(
          extractedContext.prefix,
          extractedContext,
          { style: 'concise' }
        );
      } else if (lowerQuery.includes('refactor') || lowerQuery.includes('improve')) {
        return this._promptTemplates.refactorPrompt(
          extractedContext.prefix,
          extractedContext,
          { includeExamples: false }
        );
      } else if (lowerQuery.includes('debug') || lowerQuery.includes('fix')) {
        const templates = this._promptTemplates as unknown as {
          debugPrompt?: (code: string, request: string, context: ExtractedContext) => string;
        };
        if (typeof templates.debugPrompt === 'function') {
          return templates.debugPrompt(
            extractedContext.prefix,
            query,
            extractedContext
          );
        }
        return this.buildDebugPrompt(
          extractedContext.prefix,
          query,
          extractedContext
        );
      } else if (lowerQuery.includes('test')) {
        return this._promptTemplates.testPrompt(
          extractedContext.prefix,
          extractedContext
        );
      }
    }
    
    // Default prompt with enhanced context
    return `${query}\n\nContext:\n${contextString}`;
  }
  private async getWorkspaceContext(): Promise<string> {
    const files = await vscode.workspace.findFiles(
      "**/*.{ts,js,py,java}",
      "**/node_modules/**",
      10
    );
    return files.map((f) => vscode.workspace.asRelativePath(f)).join("\n");
  }

  private parseMessage(message: string) {
    const commandMatch = message.match(/^(\/\w+)\s*(.*)/);
    const command = commandMatch ? commandMatch[1] : null;

    const mentions: string[] = [];
    const mentionRegex = /@(\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(message)) !== null) {
      mentions.push(match[1]);
    }

    const text = command ? message.substring(command.length).trim() : message;

    return { command, mentions, text };
  }

  private async handleAddContext(contextType: string) {
    switch (contextType) {
      case "file": {
        const files = await vscode.window.showOpenDialog({
          canSelectMany: true,
          canSelectFiles: true,
        });

        if (files) {
          for (const file of files) {
            const document = await vscode.workspace.openTextDocument(file);
            this._currentContext.push({
              type: "file",
              name: vscode.workspace.asRelativePath(file),
              content: document.getText(),
              path: file.fsPath,
            });
          }
          this.updateContextBadges();
        }
        break;
      }
      case "selection": {
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty) {
          const selectedText = editor.document.getText(editor.selection);
          this._currentContext.push({
            type: "selection",
            name: `${vscode.workspace.asRelativePath(editor.document.uri)}:${
              editor.selection.start.line + 1
            }-${editor.selection.end.line + 1}`,
            content: selectedText,
            path: editor.document.uri.fsPath,
            range: editor.selection,
          });
          this.updateContextBadges();
        } else {
          vscode.window.showInformationMessage(
            "No selection found in the active editor."
          );
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

  private getContextString(): string {
    return this._currentContext
      .map((ctx) => `[${ctx.name}]:\n${(ctx.content ?? "").substring(0, 1000)}`)
      .join("\n\n");
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

  //   private applyInEditor(code: string) {
  //     const editor = vscode.window.activeTextEditor;
  //     if (editor) {
  //       editor.edit((editBuilder) => {
  //         editBuilder.replace(editor.selection, code);
  //       });
  //     }
  //   }

  private clearChat() {
    this._messages = [];
    this.updateChat();
    this.saveChatHistory();
  }

  private updateChat() {
    this._view?.webview.postMessage({
      type: "updateMessages",
      messages: this._messages,
    });
  }

  //   private async openDiff(code: string) {
  //     const editor = vscode.window.activeTextEditor;
  //     if (editor) {
  //       const document = editor.document;
  //       const originalText = editor.selection.isEmpty
  //         ? document.getText()
  //         : document.getText(editor.selection);

  //       const diffUri = vscode.Uri.parse(`untitled:DiffView`);
  //       const diffDocument = await vscode.workspace.openTextDocument(diffUri);
  //       const diffEditor = await vscode.window.showTextDocument(diffDocument);

  //       await diffEditor.edit((editBuilder) => {
  //         editBuilder.insert(new vscode.Position(0, 0), `Original:\n${originalText}\n\nModified:\n${code}`);
  //       });
  //     } else {
  //       vscode.window.showInformationMessage("No active editor found to show diff.");
  //     }
  //   }

  private applyInEditor(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const selection = editor.selection;
      editor.edit((editBuilder) => {
        if (selection.isEmpty) {
          // If no selection, replace entire document
          const fullRange = new vscode.Range(
            editor.document.positionAt(0),
            editor.document.positionAt(editor.document.getText().length)
          );
          editBuilder.replace(fullRange, code);
        } else {
          // Replace selection
          editBuilder.replace(selection, code);
        }
      });
      vscode.window.showInformationMessage("Code applied in editor");
    } else {
      vscode.window.showWarningMessage("No active editor to apply code");
    }
  }

  private async createNewFile(code: string, language: string) {
    // Map language to file extension
    const extensionMap: { [key: string]: string } = {
      javascript: "js",
      typescript: "ts",
      python: "py",
      java: "java",
      csharp: "cs",
      cpp: "cpp",
      c: "c",
      html: "html",
      css: "css",
      json: "json",
      xml: "xml",
      yaml: "yaml",
      markdown: "md",
      sql: "sql",
      go: "go",
      rust: "rs",
      php: "php",
      ruby: "rb",
      swift: "swift",
      kotlin: "kt",
    };

    const extension = extensionMap[language] || "txt";
    const fileName = `untitled-${Date.now()}.${extension}`;

    // Create new untitled document
    const doc = await vscode.workspace.openTextDocument({
      content: code,
      language: language,
    });

    // Show the document
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`Created new ${language} file`);
  }

  private async openDiff(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("No active editor to compare with");
      return;
    }

    // Get current selection or entire document
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

  private async switchModel(model: string) {
    // Hook into your ModelService if needed
    vscode.window.showInformationMessage(`Switched to ${model}`);
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

  private _getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "copilotChat.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "copilotChat.css")
    );

    return this.getCopilotChatHtml(scriptUri, styleUri);
  }

  // Single, final HTML provider (fixed & deduplicated)
  private getCopilotChatHtml(
    _scriptUri: vscode.Uri,
    _styleUri: vscode.Uri
  ): string {
    console.log('Extension URI:', this._extensionUri.fsPath);
    
  
    // try {
    //     if (this._view) {
    //         insertIcon = this._view.webview.asWebviewUri(
    //             vscode.Uri.joinPath(this._extensionUri, 'media', 'insert.svg')
    //         ).toString();
    //         copyIcon = this._view.webview.asWebviewUri(
    //             vscode.Uri.joinPath(this._extensionUri, 'media', 'copy.svg')
    //         ).toString();
    //         // Log to verify paths
    //         console.log('Icon URLs generated:', { insertIcon, copyIcon });
    //     }
    // } catch (error) {
    //     console.error('Error generating icon URIs:', error);
    // }
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sidekick Pro Chat</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    height: 100vh;
    display: flex;
    flex-direction: column;
}
.chat-container { display: flex; flex-direction: column; height: 100%; }

/* Header with model selector */
.chat-header {
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex; justify-content: space-between; align-items: center;
    background: var(--vscode-sideBarSectionHeader-background);
}
.header-title { font-weight: 600; display: flex; align-items: center; gap: 6px; }
.model-selector {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    padding: 2px 6px; border-radius: 2px; font-size: 12px; cursor: pointer;
}

/* Context badges area */
.context-badges {
    padding: 6px 12px; display: flex; flex-wrap: wrap; gap: 4px;
    border-bottom: 1px solid var(--vscode-panel-border);
    min-height: 32px; align-items: center; background: var(--vscode-editor-background);
}
.code-actions {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
}

.code-action {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-button-border);
    padding: 2px 6px;
    cursor: pointer;
    font-size: 11px;
    opacity: 0.7;
    border-radius: 2px;
    transition: all 0.2s;
}

.code-action:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
    border-color: var(--vscode-focusBorder);
}

.code-action:active {
    background: var(--vscode-toolbar-activeBackground);
}

/* Add icons to buttons (optional) */
.code-action::before {
    margin-right: 2px;
}

.code-action[title*="Replace"]::before { content: "✓"; }
.code-action[title*="Insert"]::before { content: "↵"; }
.code-action[title*="Copy"]::before { content: "📋"; }
.code-action[title*="Create"]::before { content: "📄"; }
.code-action[title*="Compare"]::before { content: "⇄"; }
.context-badge {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 2px 8px; border-radius: 10px; font-size: 11px;
    display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
}
.context-badge:hover { opacity: 0.8; }
.context-badge .remove { margin-left: 2px; cursor: pointer; opacity: 0.7; }
.context-badge .remove:hover { opacity: 1; }

/* Messages area */
.messages-container {
    flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 16px;
}
.message { display: flex; flex-direction: column; gap: 8px; animation: fadeIn 0.3s ease; }
@keyframes fadeIn { from {opacity: 0; transform: translateY(10px);} to {opacity: 1; transform: translateY(0);} }
.message-header { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.message.user .message-header { color: var(--vscode-textLink-foreground); }
.message.assistant .message-header { color: var(--vscode-foreground); }
.message-content { padding-left: 24px; line-height: 1.5; }
.message-content pre {
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; padding: 12px; margin: 8px 0; overflow-x: auto;
}
.message-content code { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
.code-block-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 4px 8px; background: var(--vscode-titleBar-activeBackground);
    border-bottom: 1px solid var(--vscode-panel-border);
    border-radius: 4px 4px 0 0; margin-bottom: -1px;
}
.code-block-language { font-size: 11px; opacity: 0.8; }
.code-actions { display: flex; gap: 4px; }
.code-action {
    background: transparent; color: var(--vscode-foreground);
    border: none; padding: 2px 6px; cursor: pointer; font-size: 11px; opacity: 0.7;
}
.code-action:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

/* References section */
.references { margin-top: 8px; padding-left: 24px; }
.references details { font-size: 12px; opacity: 0.8; }
.references summary { cursor: pointer; user-select: none; padding: 4px 0; }
.references-list { margin-top: 4px; padding-left: 16px; }
.reference-item { padding: 2px 0; font-family: var(--vscode-editor-font-family); font-size: 11px; }

/* Input area */
.input-container { border-top: 1px solid var(--vscode-panel-border); padding: 12px; background: var(--vscode-sideBar-background); }
.input-actions { display: flex; gap: 4px; margin-bottom: 8px; }
.add-context-btn {
    background: transparent; color: var(--vscode-foreground);
    border: 1px dashed var(--vscode-input-border); padding: 4px 8px; border-radius: 2px;
    font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 4px;
}
.add-context-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
.input-wrapper { position: relative; }
.chat-input {
    width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); padding: 8px; border-radius: 2px;
    font-family: inherit; font-size: inherit; resize: vertical; min-height: 60px; max-height: 200px;
}
.code-action {
    background: transparent;
    border: none;
    padding: 2px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 3px;
}

.code-action:hover {
    background: var(--vscode-toolbar-hoverBackground);
}

.code-action svg {
    width: 14px;
    height: 14px;
    fill: var(--vscode-foreground);
    opacity: 0.7;
}

.code-action:hover svg {
    opacity: 1;
}
.chat-input:focus { outline: none; border-color: var(--vscode-focusBorder); }
.suggestions {
    position: absolute; bottom: 100%; left: 0; right: 0;
    background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border);
    border-radius: 2px; display: none; max-height: 150px; overflow-y: auto; z-index: 1000;
}
.suggestions.active { display: block; }
.suggestion-item { padding: 4px 8px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 8px; }
.suggestion-item:hover { background: var(--vscode-list-hoverBackground); }
.suggestion-icon { opacity: 0.6; font-size: 11px; }
.input-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }
.input-hints { font-size: 11px; opacity: 0.6; }
.send-button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 4px 12px; border-radius: 2px; cursor: pointer; font-size: 12px;
}
.send-button:hover { background: var(--vscode-button-hoverBackground); }
.send-button:disabled { opacity: 0.5; cursor: not-allowed; }

/* Typing indicator */
.typing-indicator { display: none; padding: 8px 24px; font-style: italic; opacity: 0.7; }
.typing-indicator.active { display: block; }

.code-block {
    position: relative;
    margin: 8px 0;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    overflow: hidden;
}

.code-block-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 8px;
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    min-height: 28px;
}

.code-block-language {
    font-size: 11px;
    opacity: 0.6;
    text-transform: lowercase;
}

.code-actions {
    display: flex;
    gap: 2px;
    align-items: center;
    opacity: 0;
    transition: opacity 0.2s ease;
}

.code-block:hover .code-actions {
    opacity: 1;
}

.code-action {
    background: transparent;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    transition: background 0.2s;
}

.code-action:hover {
    background: var(--vscode-toolbar-hoverBackground);
}

.code-action svg {
    width: 16px;
    height: 16px;
    opacity: 0.7;
}

.code-action:hover svg {
    opacity: 1;
}

.code-block pre {
    margin: 0;
    padding: 12px;
    background: var(--vscode-editor-background);
    overflow-x: auto;
}

.code-block code {
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    line-height: 1.5;
}

/* Toast notification */
.toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: var(--vscode-notifications-background);
    color: var(--vscode-notifications-foreground);
    padding: 8px 16px;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    opacity: 0;
    transform: translateY(10px);
    transition: all 0.3s;
    z-index: 10000;
}

.toast.show {
    opacity: 1;
    transform: translateY(0);
}

/* Welcome message */
.welcome-message { padding: 24px; text-align: center; opacity: 0.8; }
.welcome-message h3 { margin-bottom: 12px; }
.quick-commands { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 16px; }
.quick-command {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; padding: 4px 8px; border-radius: 2px; font-size: 11px; cursor: pointer;
}
.quick-command:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
<div class="chat-container">
    <div class="chat-header">
        <span class="header-title">
            <span>💬</span>
            <span>Chat</span>
        </span>
        <select class="model-selector" id="modelSelector">
            <option value="openai">OpenAI GPT</option>
            <option value="claude">Claude</option>
            <option value="local">Local Model</option>
        </select>
    </div>

    <div class="context-badges" id="contextBadges"></div>

    <div class="messages-container" id="messages">
        <div class="welcome-message">
            <h3>Welcome to Sidekick Pro Chat</h3>
            <p>Ask questions about your code or use commands:</p>
            <div class="quick-commands">
                <button class="quick-command" onclick="insertCommand('/explain')">/explain</button>
                <button class="quick-command" onclick="insertCommand('/fix')">/fix</button>
                <button class="quick-command" onclick="insertCommand('/tests')">/tests</button>
                <button class="quick-command" onclick="insertCommand('/docs')">/docs</button>
                <button class="quick-command" onclick="insertCommand('@workspace')">@workspace</button>
            </div>
        </div>
    </div>

    <div class="typing-indicator" id="typingIndicator">Assistant is thinking...</div>

    <div class="input-container">
        <div class="input-actions">
            <button class="add-context-btn" onclick="showContextMenu(event)">
                <span>📎</span>
                <span>Add Context...</span>
            </button>
        </div>
        <div class="input-wrapper">
            <div class="suggestions" id="suggestions"></div>
            <textarea
                class="chat-input"
                id="chatInput"
                placeholder="Ask about your code or type / for commands..."
                rows="3"
            ></textarea>
        </div>
        <div class="input-footer">
            <span class="input-hints">Press Enter to send, Shift+Enter for new line</span>
            <button class="send-button" id="sendButton" onclick="sendMessage()">Send</button>
        </div>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();
let currentContext = [];
let messages = [];
// Store icon paths as constants
const ICON_COPY = \`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 512 512" fill="currentColor">
<path d="M128.385 80.482q3.174-.008 6.347-.02c5.705-.019 11.409-.012 17.114 0..."/>
</svg>\`;

const ICON_INSERT = \`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 512 512" fill="currentColor">
<path d="m23.16 140.74 2.114-.012c2.326-.01 4.652-.007..."/>
</svg>\`;

const ICON_NEWFILE = \`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 512 512" fill="currentColor">
<path d="m100.61 268.866 3.407-.014h3.728l3.972-.01..."/>
</svg>\`;

const ICON_TERMINAL = \`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
<rect x="2" y="2" width="12" height="12" stroke="currentColor" fill="none"/>
<path d="M4 6l2 2-2 2M7 10h5"/>
</svg>\`;


// Command suggestions
const commandSuggestions = [
    { trigger: '/explain', description: 'Explain selected code' },
    { trigger: '/fix', description: 'Fix problems in code' },
    { trigger: '/tests', description: 'Generate unit tests' },
    { trigger: '/docs', description: 'Generate documentation' },
    { trigger: '@workspace', description: 'Include workspace context' },
    { trigger: '@file', description: 'Reference a file' },
    { trigger: '#', description: 'Reference a symbol' }
];

// GLOBAL FUNCTIONS - Define these BEFORE they're used in onclick handlers

function sendMessage() {
    const input = document.getElementById('chatInput');
    if (!input) return;
    
    const message = input.value.trim();
    if (!message) return;

    console.log('Sending message:', message);
    vscode.postMessage({ type: 'sendMessage', message });
    input.value = '';
    hideSuggestions();
}

function insertCommand(command) {
    const input = document.getElementById('chatInput');
    if (input) {
        input.value = command + ' ';
        input.focus();
    }
}

function getCodeFromBlock(blockId) {
    // const codeBlock = document.getElementById(blockId);
    // if (!codeBlock) return null;
    
    // const codeElement = codeBlock.querySelector('code');
    // if (!codeElement) return null;
    
    // // Get the raw code from data attribute or text content
    // let code = codeElement.getAttribute('data-code') || codeElement.textContent;
    // // Unescape HTML entities
    // const textarea = document.createElement('textarea');
    // textarea.innerHTML = code;
    // return textarea.value;
    return window.codeBlocks[blockId] || '';
}

function applyInEditor(blockId) {
    const code = getCodeFromBlock(blockId);
    if (code) {
        vscode.postMessage({ 
            type: 'applyInEditor', 
            code: code 
        });
    }
}

function insertAtCursor(blockId) {
    const code = getCodeFromBlock(blockId);
    if (code) {
        vscode.postMessage({ 
            type: 'insertCode', 
            code: code 
        });
    }
}
function showCodeActions(blockId) {
    const actions = document.getElementById('actions-' + blockId);
    if (actions) {
        actions.style.display = 'flex';
    }
}

function hideCodeActions(blockId) {
    const actions = document.getElementById('actions-' + blockId);
    if (actions) {
        actions.style.display = 'none';
    }
}

function copyCode(blockId) {
    const code = getCodeFromBlock(blockId);
    if (code) {
        // Use clipboard API if available
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code).then(() => {
                showToast('Code copied to clipboard');
            });
        } else {
            vscode.postMessage({ 
                type: 'copyCode', 
                code: code 
            });
        }
    }
}
function createNewFile(blockId, language) {
    const code = getCodeFromBlock(blockId);
    if (code) {
        vscode.postMessage({ 
            type: 'createNewFile', 
            code: code,
            language: language 
        });
    }
}
function insertIntoNewFile(blockId, language) {
    const code = getCodeFromBlock(blockId);
    if (code) {
        vscode.postMessage({ 
            type: 'createNewFile', 
            code: code,
            language: language 
        });
    }
}
function insertIntoTerminal(blockId) {
    const code = getCodeFromBlock(blockId);
    if (code) {
        vscode.postMessage({ 
            type: 'insertIntoTerminal', 
            code: code 
        });
    }
}
function showToast(message) {
    // Simple toast notification
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('show');
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => document.body.removeChild(toast), 300);
        }, 2000);
    }, 10);
}

function openDiff(blockId) {
    const code = getCodeFromBlock(blockId);
    if (code) {
        vscode.postMessage({ 
            type: 'openDiff', 
            code: code 
        });
    }
}

function showContextMenu(evt) {
    const menu = document.createElement('div');
    menu.style.position = 'absolute';
    menu.style.background = 'var(--vscode-menu-background)';
    menu.style.border = '1px solid var(--vscode-menu-border)';
    menu.style.borderRadius = '2px';
    menu.style.padding = '4px 0';
    menu.style.zIndex = '1000';
    menu.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';

    const options = [
        { label: 'Add Current File', value: 'file' },
        { label: 'Add Selection', value: 'selection' },
        { label: 'Add Workspace Context', value: 'workspace' }
    ];

    options.forEach(opt => {
        const item = document.createElement('div');
        item.textContent = opt.label;
        item.style.padding = '4px 12px';
        item.style.cursor = 'pointer';
        item.style.fontSize = '12px';
        item.onmouseover = () => { item.style.background = 'var(--vscode-menu-selectionBackground)'; };
        item.onmouseout = () => { item.style.background = 'transparent'; };
        item.onclick = () => {
            vscode.postMessage({ type: 'addContext', contextType: opt.value });
            document.body.removeChild(menu);
        };
        menu.appendChild(item);
    });

    const btn = evt.currentTarget;
    const rect = btn.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 5) + 'px';

    document.body.appendChild(menu);

    // Close menu when clicking outside
    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (menu.parentNode && !menu.contains(e.target)) {
                document.body.removeChild(menu);
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 100);
}

function removeContext(index) {
    vscode.postMessage({ type: 'removeContext', index });
}

window.codeBlocks = window.codeBlocks || {};
function copyCode(blockId) {
    const code = window.codeBlocks[blockId];
    if (!code) {
        console.error('No code found for block:', blockId);
        return;
    }
    
    // Send to VS Code for copying
    vscode.postMessage({ 
        type: 'copyCode', 
        code: code 
    });
}

function insertCode(code) {
    vscode.postMessage({ type: 'insertCode', code });
}

function showTypingIndicator() {
    const el = document.getElementById('typingIndicator');
    if (el) el.classList.add('active');
}

function hideTypingIndicator() {
    const el = document.getElementById('typingIndicator');
    if (el) el.classList.remove('active');
}

function showSelectionHint(lines) {
    console.log('Selection available:', lines);
}

function handleInputChange(value) {
    const lastWord = value.split(' ').pop() || '';
    if (lastWord.startsWith('/') || lastWord.startsWith('@') || lastWord.startsWith('#')) {
        showSuggestions(lastWord);
    } else {
        hideSuggestions();
    }
}

function showSuggestions(prefix) {
    const suggestionsEl = document.getElementById('suggestions');
    if (!suggestionsEl) return;
    
    const filtered = commandSuggestions.filter(s => 
        s.trigger.toLowerCase().startsWith(prefix.toLowerCase())
    );
    
    if (filtered.length === 0) {
        hideSuggestions();
        return;
    }

    suggestionsEl.innerHTML = filtered.map(s => \`
        <div class="suggestion-item" onclick="applySuggestion('\${s.trigger}')">
            <span class="suggestion-icon">\${s.trigger[0]}</span>
            <span>\${s.trigger}</span>
            <span style="opacity: 0.6; margin-left: auto;">\${s.description}</span>
        </div>
    \`).join('');
    suggestionsEl.classList.add('active');
}

function hideSuggestions() {
    const el = document.getElementById('suggestions');
    if (el) el.classList.remove('active');
}

function applySuggestion(suggestion) {
    const input = document.getElementById('chatInput');
    if (!input) return;
    
    const words = input.value.split(' ');
    words[words.length - 1] = suggestion + ' ';
    input.value = words.join(' ');
    input.focus();
    hideSuggestions();
}

function getWelcomeMessage() {
    return \`
        <div class="welcome-message">
            <h3>Welcome to Sidekick Pro Chat</h3>
            <p>Ask questions about your code or use commands:</p>
            <div class="quick-commands">
                <button class="quick-command" onclick="insertCommand('/explain')">/explain</button>
                <button class="quick-command" onclick="insertCommand('/fix')">/fix</button>
                <button class="quick-command" onclick="insertCommand('/tests')">/tests</button>
                <button class="quick-command" onclick="insertCommand('/docs')">/docs</button>
                <button class="quick-command" onclick="insertCommand('@workspace')">@workspace</button>
            </div>
        </div>
    \`;
}

function updateMessages(msgs) {
    messages = msgs;
    const container = document.getElementById('messages');
    if (!container) return;

    if (!messages || messages.length === 0) {
        container.innerHTML = getWelcomeMessage();
        return;
    }

    container.innerHTML = messages.map(msg => {
        const icon = msg.role === 'user' ? '👤' : '🤖';
        const content = formatMessageContent(msg.content);
        const references = formatReferences(msg.references);
        return \`
            <div class="message \${msg.role}">
                <div class="message-header">
                    <span>\${icon}</span>
                    <span>\${msg.role === 'user' ? 'You' : 'Assistant'}</span>
                </div>
                <div class="message-content">\${content}</div>
                \${references}
            </div>
        \`;
    }).join('');

    container.scrollTop = container.scrollHeight;
}

function formatMessageContent(content) {
    // Handle code blocks
    const codeBlockRegex = /\`\`\`(\\w+)?\\n([\\s\\S]*?)\`\`\`/g;
    let formatted = content.replace(codeBlockRegex, (match, lang, code) => {
        const language = lang || 'plaintext';
        const cleanCode = (code || '').trim();
        const escapedCode = escapeHtml(cleanCode);
        const blockId = 'code-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        // Escape quotes properly for onclick
        const codeForCopy = escapedCode.replace(/'/g, "\\'").replace(/"/g, '\\"');
        if (!window.codeBlocks) window.codeBlocks = {};
        window.codeBlocks[blockId] = cleanCode;
        return \`
            <div class="code-block" id="\${blockId}" onmouseenter="showCodeActions('\${blockId}')" onmouseleave="hideCodeActions('\${blockId}')">
                <div class="code-block-header">
                    <span class="code-block-language">\${language}</span>
                    <div class="code-actions" id="actions-\${blockId}" style="display: none;">
                        <button class="code-action" onclick="insertAtCursor('\${blockId}')" title="Insert at cursor">
                            \${ICON_INSERT}
                        </button>
                        <button class="code-action" onclick="copyCode('\${blockId}')" title="Copy">
                            \${ICON_COPY}
                        </button>
                        </button>
                        <button class="code-action" onclick="insertIntoNewFile('\${blockId}', '\${language}')" title="Insert into new file">
                            \${ICON_NEWFILE}
                        </button>
                        <button class="code-action" onclick="insertIntoTerminal('\${blockId}')" title="Insert into terminal">
                            \${ICON_TERMINAL}
                        </button>
                    </div>
                </div>
                <pre><code>\${escapedCode}</code></pre>
            </div>
        \`;
    });

    // Handle inline code
    formatted = formatted.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    // Handle newlines
    formatted = formatted.split('\\n').join('<br>');
    return formatted;
}


function formatReferences(references) {
    if (!references || references.length === 0) return '';
    const items = references.map(ref => 
        \`<div class="reference-item">\${ref.file}:\${ref.lines}</div>\`
    ).join('');
    return \`
        <div class="references">
            <details>
                <summary>Used \${references.length} reference\${references.length > 1 ? 's' : ''}</summary>
                <div class="references-list">\${items}</div>
            </details>
        </div>
    \`;
}

function updateContextBadges(contexts) {
    currentContext = contexts || [];
    const container = document.getElementById('contextBadges');
    if (!container) return;

    if (currentContext.length === 0) {
        container.innerHTML = '<span style="opacity: 0.6; font-size: 11px;">No context added</span>';
        return;
    }

    container.innerHTML = currentContext.map((ctx, index) => \`
        <span class="context-badge">
            \${ctx.name}
            <span class="remove" onclick="removeContext(\${index})">×</span>
        </span>
    \`).join('');
}

function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text ?? '').replace(/[&<>"']/g, m => map[m]);
}

// Initialize event listeners when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('chatInput');
    const modelSelector = document.getElementById('modelSelector');
    
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        input.addEventListener('input', (e) => {
            handleInputChange(e.target.value);
        });
    }

    if (modelSelector) {
        modelSelector.addEventListener('change', (e) => {
            vscode.postMessage({
                type: 'switchModel',
                model: e.target.value
            });
        });
    }
});

// Handle messages from extension
window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
        case 'updateMessages':
            updateMessages(message.messages);
            break;
        case 'updateContext':
            updateContextBadges(message.context);
            break;
        case 'showTyping':
            showTypingIndicator();
            break;
        case 'hideTyping':
            hideTypingIndicator();
            break;
        case 'selectionAvailable':
            showSelectionHint(message.lines);
            break;
    }
});
</script>
</body>
</html>`;
  }
}
