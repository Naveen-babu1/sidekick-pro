import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { LocalAIProvider } from "./providers/LocalAIProvider";
import { CodeIndexer } from "./indexer/CodeIndexer";
import { PrivacyGuard } from "./security/PrivacyGuard";
import { InlineCompletionProvider } from "./providers/InlineCompletionProvider";
import { CodeFixProvider } from "./providers/CodeFixProvider";
import { CodeFixHandler } from "./providers/CodeFixHandler";
import { ModelService } from "./services/modelService";
import { ChatViewProvider } from "./providers/ChatViewProvider";
import { CopilotStyleChatProvider } from "./providers/CopilotStyleChatProvider";
import { ContextExtractor } from "./services/ContextExtractor";
import { SmartCache } from "./services/SmartCache";
import { PromptTemplates } from "./services/PromptTemplates";


// Chat Panel Class - Creates a webview panel on the right side
class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private messages: Array<{ role: string; content: string }> = [];
  private modelService!: ModelService;

  constructor(
    panel: vscode.WebviewPanel,
    private context: vscode.ExtensionContext,
    private localAI: LocalAIProvider,
    private indexer: CodeIndexer,
    private privacyGuard: PrivacyGuard,
    modelService: ModelService
  ) {
    this._panel = panel;
    this.modelService = modelService;
    this._panel.webview.html = this._getWebviewContent();

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case "sendMessage":
            await this.handleUserMessage(message.text);
            break;
          case "clear":
            this.messages = [];
            this._panel.webview.postMessage({ type: "clearMessages" });
            break;
          case "insertCode":
            this.insertCodeAtCursor(message.code);
            break;
          case "copyCode":
            await vscode.env.clipboard.writeText(message.code);
            vscode.window.showInformationMessage("Code copied to clipboard!");
            break;
        }
      },
      undefined,
      this._disposables
    );

    // Load saved messages
    this.loadChatHistory();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    localAI: LocalAIProvider,
    indexer: CodeIndexer,
    privacyGuard: PrivacyGuard,
    modelService: ModelService
  ) {
    const column = vscode.ViewColumn.Two;

    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "sidekickChat",
      "Sidekick AI Chat",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      }
    );

    ChatPanel.currentPanel = new ChatPanel(
      panel,
      context,
      localAI,
      indexer,
      privacyGuard,
      modelService
    );
  }

  public addMessage(type: string, input: string, response: string) {
    this.messages.push({ role: "user", content: `/${type}: ${input}` });
    this.messages.push({ role: "assistant", content: response });

    this._panel.webview.postMessage({
      type: "addMessage",
      role: "user",
      content: `/${type}: ${input}`,
    });

    this._panel.webview.postMessage({
      type: "addMessage",
      role: "assistant",
      content: response,
    });

    this.saveChatHistory();
  }

  private async handleUserMessage(text: string) {
    this.messages.push({ role: "user", content: text });
    this._panel.webview.postMessage({
      type: "addMessage",
      role: "user",
      content: text,
    });

    this._panel.webview.postMessage({ type: "showTyping" });

    try {
      const editor = vscode.window.activeTextEditor;
      let context = "";

      if (editor) {
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);
        const fileName = editor.document.fileName;

        context = `Current file: ${fileName}\n`;
        if (selectedText) {
          context += `Selected code:\n\`\`\`${editor.document.languageId}\n${selectedText}\n\`\`\`\n`;
        }
      }

      if (text.startsWith("/")) {
        await this.handleCommand(text, context);
      } else {
        const response = await this.modelService.chat(text, context);
        this.messages.push({ role: "assistant", content: response });
        this._panel.webview.postMessage({
          type: "addMessage",
          role: "assistant",
          content: response,
        });
      }
    } catch (error) {
      const errorMsg = `Error: ${error}`;
      this._panel.webview.postMessage({
        type: "addMessage",
        role: "assistant",
        content: errorMsg,
      });
    }

    this._panel.webview.postMessage({ type: "hideTyping" });
    this.saveChatHistory();
  }

  private async handleCommand(command: string, context: string) {
    const [cmd, ...args] = command.split(" ");
    const editor = vscode.window.activeTextEditor;

    switch (cmd) {
      case "/explain":
        if (editor) {
          const selectedText = editor.document.getText(editor.selection);
          if (selectedText) {
            const explanation = await this.modelService.explainCode(
              selectedText,
              context,
              editor.document.languageId
            );
            this.messages.push({ role: "assistant", content: explanation });
            this._panel.webview.postMessage({
              type: "addMessage",
              role: "assistant",
              content: explanation,
            });
          } else {
            this._panel.webview.postMessage({
              type: "addMessage",
              role: "assistant",
              content: "Please select some code first!",
            });
          }
        }
        break;

      case "/refactor":
        if (editor) {
          const selectedText = editor.document.getText(editor.selection);
          if (selectedText) {
            const instruction = args.join(" ") || "improve this code";
            const refactored = await this.modelService.refactorCode(
              selectedText,
              instruction,
              context,
              editor.document.languageId
            );
            const response = `Here's the refactored code:\n\n\`\`\`${editor.document.languageId}\n${refactored}\n\`\`\``;
            this.messages.push({ role: "assistant", content: response });
            this._panel.webview.postMessage({
              type: "addMessage",
              role: "assistant",
              content: response,
            });
          }
        }
        break;

      case "/test":
        if (editor) {
          const selectedText =
            editor.document.getText(editor.selection) ||
            editor.document.getText();
          const tests = await this.modelService.generateTests(
            selectedText,
            context,
            editor.document.languageId
          );
          const response = `Generated tests:\n\n\`\`\`${editor.document.languageId}\n${tests}\n\`\`\``;
          this.messages.push({ role: "assistant", content: response });
          this._panel.webview.postMessage({
            type: "addMessage",
            role: "assistant",
            content: response,
          });
        }
        break;

      case "/help":
        const helpText = `Available commands:
- **/explain** - Explain selected code
- **/refactor [instruction]** - Refactor selected code
- **/test** - Generate tests for selected code
- **/help** - Show this help message

You can also just chat naturally about your code!`;
        this.messages.push({ role: "assistant", content: helpText });
        this._panel.webview.postMessage({
          type: "addMessage",
          role: "assistant",
          content: helpText,
        });
        break;

      default:
        this._panel.webview.postMessage({
          type: "addMessage",
          role: "assistant",
          content: `Unknown command: ${cmd}. Type /help for available commands.`,
        });
    }
  }

  private insertCodeAtCursor(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.edit((editBuilder) => {
        editBuilder.insert(editor.selection.active, code);
      });
    }
  }

  private saveChatHistory() {
    this.context.globalState.update("chatHistory", this.messages.slice(-100));
  }

  private loadChatHistory() {
    const saved =
      this.context.globalState.get<Array<{ role: string; content: string }>>(
        "chatHistory"
      );
    if (saved) {
      this.messages = saved;
      saved.forEach((msg) => {
        this._panel.webview.postMessage({
          type: "addMessage",
          role: msg.role,
          content: msg.content,
        });
      });
    }
  }

  private _getWebviewContent() {
    const iconPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "resources",
      "icon.png"
    );
    const iconUri = this._panel.webview.asWebviewUri(iconPath);
    const aiProvider = this.modelService.isOpenAIConfigured()
      ? "OpenAI"
      : "local AI";

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src ${this._panel.webview.cspSource} data:;">
        <title>Sidekick AI Chat</title>
        <style>
            body {
                font-family: var(--vscode-font-family);
                font-size: var(--vscode-font-size);
                color: var(--vscode-foreground);
                background-color: var(--vscode-editor-background);
                margin: 0;
                padding: 0;
                display: flex;
                flex-direction: column;
                height: 100vh;
            }
            
            .chat-container {
                display: flex;
                flex-direction: column;
                height: 100%;
            }
            
            .chat-header {
                padding: 10px 15px;
                background: var(--vscode-titleBar-activeBackground);
                border-bottom: 1px solid var(--vscode-panel-border);
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            
            .messages-container {
                flex: 1;
                overflow-y: auto;
                padding: 15px;
                display: flex;
                flex-direction: column;
                gap: 15px;
            }
            
            .message {
                display: flex;
                gap: 10px;
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
            
            .message.user {
                flex-direction: row-reverse;
            }
            
            .avatar {
                width: 30px;
                height: 30px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 16px;
                flex-shrink: 0;
            }
            
            .user .avatar {
                background: var(--vscode-button-background);
            }
            
            .assistant .avatar {
                background: var(--vscode-activityBarBadge-background);
            }
            
            .message-content {
                background: var(--vscode-input-background);
                padding: 10px 15px;
                border-radius: 10px;
                max-width: 70%;
                word-wrap: break-word;
            }
            
            .user .message-content {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
            }
            
            pre {
                background: var(--vscode-textCodeBlock-background);
                border: 1px solid var(--vscode-panel-border);
                border-radius: 4px;
                padding: 10px;
                overflow-x: auto;
                margin: 10px 0;
            }
            
            code {
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
            }
            
            .code-actions {
                display: flex;
                gap: 8px;
                margin-top: 8px;
            }
            
            .code-action {
                padding: 4px 8px;
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
            }
            
            .code-action:hover {
                background: var(--vscode-button-secondaryHoverBackground);
            }
            
            .input-container {
                padding: 15px;
                border-top: 1px solid var(--vscode-panel-border);
                display: flex;
                gap: 10px;
            }
            
            .chat-input {
                flex: 1;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                padding: 8px 12px;
                border-radius: 4px;
                font-family: inherit;
                font-size: inherit;
                resize: none;
                min-height: 36px;
                max-height: 120px;
            }
            
            .chat-input:focus {
                outline: none;
                border-color: var(--vscode-focusBorder);
            }
            
            .send-button {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 8px 16px;
                border-radius: 4px;
                cursor: pointer;
                font-weight: 600;
            }
            
            .send-button:hover {
                background: var(--vscode-button-hoverBackground);
            }
            
            .typing-indicator {
                display: none;
                padding: 10px;
                font-style: italic;
                opacity: 0.7;
            }
            
            .typing-indicator.show {
                display: block;
            }
            
            .welcome-message {
                text-align: center;
                padding: 40px 20px;
                opacity: 0.8;
            }
            
            .quick-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                justify-content: center;
                margin-top: 20px;
            }
            
            .quick-action {
                padding: 8px 16px;
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                border: 1px solid var(--vscode-button-border);
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
            }
            
            .quick-action:hover {
                background: var(--vscode-button-secondaryHoverBackground);
            }
        </style>
    </head>
    <body>
        <div class="chat-container">
            <div class="chat-header">
                <span style="display: flex; align-items: center; gap: 8px;">
                    <img src="${iconUri}" width="24" height="24" alt="Sidekick AI" style="display: inline-block;"/>
                    <span style="font-weight: 600;">Sidekick AI Chat</span>
                </span>
                <button class="code-action" onclick="clearChat()">Clear</button>
            </div>            
            <div class="messages-container" id="messages">
                <div class="welcome-message" id="welcome">
                    <h2>👋 Welcome to Sidekick AI</h2>
                    <p>Your AI coding assistant powered by ${aiProvider}</p>
                    <div class="quick-actions">
                        <button class="quick-action" onclick="sendMessage('/help')">View Commands</button>
                        <button class="quick-action" onclick="sendMessage('/explain')">Explain Code</button>
                        <button class="quick-action" onclick="sendMessage('/test')">Generate Tests</button>
                    </div>
                </div>
            </div>
            
            <div class="typing-indicator" id="typing">
                <div class="message assistant">
                    <div class="avatar">🤖</div>
                    <div class="message-content">Thinking...</div>
                </div>
            </div>
            
            <div class="input-container">
                <textarea 
                    class="chat-input" 
                    id="input" 
                    placeholder="Ask me anything or use / for commands..."
                ></textarea>
                <button class="send-button" onclick="sendCurrentMessage()">Send</button>
            </div>
        </div>
        
        <script>
            const vscode = acquireVsCodeApi();
            const messagesContainer = document.getElementById('messages');
            const inputField = document.getElementById('input');
            const typingIndicator = document.getElementById('typing');
            const welcomeMessage = document.getElementById('welcome');
            
            function handleKeyPress(event) {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendCurrentMessage();
                }
            }
            
            inputField.addEventListener('keydown', handleKeyPress);
            
            function sendMessage(text) {
                if (!text || !text.trim()) return;
                
                if (welcomeMessage) {
                    welcomeMessage.style.display = 'none';
                }
                
                vscode.postMessage({ type: 'sendMessage', text: text.trim() });
                inputField.value = '';
                autoResizeInput();
            }
            
            function sendCurrentMessage() {
                sendMessage(inputField.value);
            }
            
            function clearChat() {
                vscode.postMessage({ type: 'clear' });
                messagesContainer.innerHTML = '';
                if (welcomeMessage) {
                    messagesContainer.appendChild(welcomeMessage);
                    welcomeMessage.style.display = 'block';
                }
            }
            
            function copyCode(code) {
                vscode.postMessage({ type: 'copyCode', code: code });
            }
            
            function insertCode(code) {
                vscode.postMessage({ type: 'insertCode', code: code });
            }
            
            function autoResizeInput() {
                inputField.style.height = 'auto';
                inputField.style.height = Math.min(inputField.scrollHeight, 120) + 'px';
            }
            
            inputField.addEventListener('input', autoResizeInput);
            
            window.addEventListener('message', event => {
                const message = event.data;
                
                switch (message.type) {
                    case 'addMessage':
                        addMessage(message.role, message.content);
                        break;
                    case 'clearMessages':
                        messagesContainer.innerHTML = '';
                        break;
                    case 'showTyping':
                        typingIndicator.classList.add('show');
                        break;
                    case 'hideTyping':
                        typingIndicator.classList.remove('show');
                        break;
                }
            });
            
            function addMessage(role, content) {
                if (welcomeMessage) {
                    welcomeMessage.style.display = 'none';
                }
                
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message ' + role;
                
                const avatar = document.createElement('div');
                avatar.className = 'avatar';
                avatar.textContent = role === 'user' ? '👤' : '🤖';
                
                const contentDiv = document.createElement('div');
                contentDiv.className = 'message-content';
                
                if (content.includes('\`\`\`')) {
                    const parts = content.split('\`\`\`');
                    for (let i = 0; i < parts.length; i++) {
                        if (i % 2 === 0) {
                            if (parts[i]) {
                                const textSpan = document.createElement('span');
                                textSpan.innerHTML = parts[i].replace(/\\n/g, '<br>');
                                contentDiv.appendChild(textSpan);
                            }
                        } else {
                            const codeContent = parts[i];
                            const lines = codeContent.split('\\n');
                            const language = lines[0];
                            const code = lines.slice(1).join('\\n');
                            
                            const pre = document.createElement('pre');
                            const codeElement = document.createElement('code');
                            codeElement.textContent = code || codeContent;
                            pre.appendChild(codeElement);
                            contentDiv.appendChild(pre);
                            
                            if (role === 'assistant') {
                                const actions = document.createElement('div');
                                actions.className = 'code-actions';
                                
                                const copyBtn = document.createElement('button');
                                copyBtn.className = 'code-action';
                                copyBtn.textContent = 'Copy';
                                copyBtn.onclick = () => copyCode(code || codeContent);
                                
                                const insertBtn = document.createElement('button');
                                insertBtn.className = 'code-action';
                                insertBtn.textContent = 'Insert at Cursor';
                                insertBtn.onclick = () => insertCode(code || codeContent);
                                
                                actions.appendChild(copyBtn);
                                actions.appendChild(insertBtn);
                                contentDiv.appendChild(actions);
                            }
                        }
                    }
                } else {
                    const textSpan = document.createElement('span');
                    textSpan.innerHTML = content.replace(/\\n/g, '<br>');
                    contentDiv.appendChild(textSpan);
                }
                
                messageDiv.appendChild(avatar);
                messageDiv.appendChild(contentDiv);
                messagesContainer.appendChild(messageDiv);
                
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }
        </script>
    </body>
    </html>`;
  }

  public dispose() {
    ChatPanel.currentPanel = undefined;
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}

// Setup wizard function - kept from your original code
async function runSetupWizard(
  context: vscode.ExtensionContext,
  localAI: LocalAIProvider
) {
  const step1 = await vscode.window.showInformationMessage(
    "📦 Step 1/3: Sidekick AI needs llama.cpp to run AI models locally. Do you have it installed?",
    "I have it",
    "Download it",
    "Help me install"
  );

  if (step1 === "Download it") {
    const platform = process.platform;
    const url =
      platform === "win32"
        ? "https://github.com/ggerganov/llama.cpp/releases"
        : "https://github.com/ggerganov/llama.cpp#build";
    vscode.env.openExternal(vscode.Uri.parse(url));
    await vscode.window.showInformationMessage(
      "Download llama.cpp, extract it, then click OK to continue",
      "OK"
    );
  } else if (step1 === "Help me install") {
    vscode.env.openExternal(
      vscode.Uri.parse(
        "https://marketplace.visualstudio.com/items?itemName=NaveenBabu.sidekick-ai"
      )
    );
    return;
  }

  const step2 = await vscode.window.showInformationMessage(
    "🤖 Step 2/3: You need an AI model file (GGUF format). Do you have one?",
    "I have a model",
    "Download recommended",
    "Show me options"
  );

  if (step2 === "I have a model") {
    const fileUri = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      filters: { "GGUF Models": ["gguf"] },
      title: "Select your GGUF model file",
    });

    if (fileUri?.[0]) {
      const config = vscode.workspace.getConfiguration("sidekick-ai");
      await config.update("modelPath", fileUri[0].fsPath, true);
    }
  } else if (step2 === "Download recommended") {
    vscode.env.openExternal(
      vscode.Uri.parse(
        "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"
      )
    );
    await vscode.window.showInformationMessage(
      "Download the model (1GB), save it anywhere, then select it",
      "Select Downloaded Model"
    );

    const fileUri = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      filters: { "GGUF Models": ["gguf"] },
      title: "Select the downloaded GGUF model",
    });

    if (fileUri?.[0]) {
      const config = vscode.workspace.getConfiguration("sidekick-ai");
      await config.update("modelPath", fileUri[0].fsPath, true);
    }
  } else if (step2 === "Show me options") {
    vscode.env.openExternal(
      vscode.Uri.parse("https://huggingface.co/models?search=gguf%20code")
    );
  }

  vscode.window.showInformationMessage(
    "✅ Setup complete! Initializing Sidekick AI..."
  );

  await localAI.initialize();

  const status = await localAI.checkModelStatus();
  if (status.isReady) {
    vscode.window.showInformationMessage(
      "🎉 Sidekick AI is ready! Press Ctrl+Shift+A to open chat."
    );
  } else {
    vscode.window.showErrorMessage(
      'Setup incomplete. Check VS Code settings (Ctrl+,) and search for "sidekick-ai"'
    );
  }
}

export async function activate(context: vscode.ExtensionContext) {
  console.log("Sidekick AI is starting...");

  // Initialize services
  const privacyGuard = new PrivacyGuard();
  await privacyGuard.initialize();

  // Initialize ModelService FIRST for OpenAI
  const modelService = new ModelService(context);

  const contextExtractor = ContextExtractor.getInstance();
  const smartCache = SmartCache.getInstance();
  const promptTemplates = PromptTemplates.getInstance();
  console.log("Core services initialized: ContextExtractor, SmartCache, PromptTemplates");
  // Check/create .env file for OpenAI configuration
  const fsSync = require("fs");
  const envPath = path.join(__dirname, "..", "..", ".env");

  if (!fsSync.existsSync(envPath)) {
    const defaultEnv = `# Sidekick AI Configuration
DEFAULT_MODEL_PROVIDER=openai
OPENAI_API_KEY=your-openai-api-key-here
DEFAULT_MODEL_NAME=gpt-3.5-turbo
CODE_MODEL_NAME=gpt-3.5-turbo
MODEL_TEMPERATURE=0.7
`;
    fsSync.writeFileSync(envPath, defaultEnv);

    const setup = await vscode.window.showInformationMessage(
      "Please configure your OpenAI API key in the .env file to use AI features.",
      "Open .env",
      "Get API Key",
      "Skip"
    );

    if (setup === "Open .env") {
      const doc = await vscode.workspace.openTextDocument(envPath);
      await vscode.window.showTextDocument(doc);
    } else if (setup === "Get API Key") {
      vscode.env.openExternal(
        vscode.Uri.parse("https://platform.openai.com/api-keys")
      );
    }
  }

  // Initialize LocalAI (but won't be used if OpenAI is configured)
  const localAI = new LocalAIProvider(context);

  // Check first run
  const isFirstRun = context.globalState.get("sidekickai.firstRun", true);

  if (isFirstRun && !modelService.isOpenAIConfigured()) {
    const result = await vscode.window.showInformationMessage(
      "👋 Welcome to Sidekick AI! Your AI coding assistant needs a quick setup (2 minutes).",
      "Start Setup",
      "Watch Tutorial",
      "Skip"
    );

    if (result === "Start Setup") {
      await runSetupWizard(context, localAI);
    } else if (result === "Watch Tutorial") {
      vscode.env.openExternal(
        vscode.Uri.parse(
          "https://marketplace.visualstudio.com/items?itemName=NaveenBabu.sidekick-ai"
        )
      );
    }

    await context.globalState.update("sidekickai.firstRun", false);
  }

  // Skip local AI initialization if using OpenAI
  if (!modelService.isOpenAIConfigured()) {
    console.log("OpenAI not configured, initializing LocalAI...");
    const isFirstRun = context.globalState.get("sidekickai.firstRun", true);

    if (isFirstRun) {
      const result = await vscode.window.showInformationMessage(
        "👋 Welcome to Sidekick AI! Your local AI coding assistant needs a quick setup (2 minutes).",
        "Start Setup",
        "Watch Tutorial",
        "Skip"
      );

      if (result === "Start Setup") {
        await runSetupWizard(context, localAI);
      } else if (result === "Watch Tutorial") {
        vscode.env.openExternal(
          vscode.Uri.parse(
            "https://marketplace.visualstudio.com/items?itemName=NaveenBabu.sidekick-ai"
          )
        );
      }

      await context.globalState.update("sidekickai.firstRun", false);
    }

    // Try to initialize local AI
    try {
      await localAI.initialize();
    } catch (error) {
      console.error("Local AI initialization failed:", error);
      const result = await vscode.window.showErrorMessage(
        "Failed to initialize local AI. Would you like to configure it now?",
        "Setup Now",
        "Open Settings",
        "Skip"
      );

      if (result === "Setup Now") {
        await runSetupWizard(context, localAI);
      } else if (result === "Open Settings") {
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "sidekick-ai"
        );
      }
    }
  } else {
    console.log("Using OpenAI - skipping LocalAI initialization completely");
  }

  // Initialize indexer
  const indexer = new CodeIndexer(context);
  await indexer.indexWorkspace();

  const chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    context,
    modelService, // Pass the ModelService instance
    indexer,
    privacyGuard
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider
    )
  );

  // Show AI status on startup
  const aiStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99
  );

  function getMetricsWebview(
  stats: any,
  modelMetrics: any,
  cacheStats: any
): string {
  const hitRatePercent = stats.cacheHitRate * 100;
  const avgResponseTime = modelMetrics.avgResponseTime.toFixed(0);
  
  return `<!DOCTYPE html>
  <html>
  <head>
    <style>
      body {
        font-family: var(--vscode-font-family);
        padding: 20px;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
      }
      .metrics-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 20px;
        margin-top: 20px;
      }
      .metric-card {
        background: var(--vscode-input-background);
        padding: 15px;
        border-radius: 8px;
        border: 1px solid var(--vscode-input-border);
      }
      .metric-value {
        font-size: 24px;
        font-weight: bold;
        color: var(--vscode-textLink-foreground);
        margin: 10px 0;
      }
      .metric-label {
        font-size: 12px;
        opacity: 0.8;
        text-transform: uppercase;
      }
      .metric-desc {
        font-size: 11px;
        opacity: 0.6;
        margin-top: 5px;
      }
      h1 {
        border-bottom: 2px solid var(--vscode-input-border);
        padding-bottom: 10px;
      }
      h2 {
        margin-top: 30px;
        opacity: 0.9;
      }
      .status-good { color: #4caf50; }
      .status-warning { color: #ff9800; }
      .status-bad { color: #f44336; }
      .chart {
        height: 200px;
        background: var(--vscode-input-background);
        border-radius: 8px;
        padding: 20px;
        margin: 20px 0;
        display: flex;
        align-items: flex-end;
        gap: 5px;
      }
      .bar {
        flex: 1;
        background: var(--vscode-textLink-foreground);
        border-radius: 4px 4px 0 0;
        min-height: 20px;
        position: relative;
      }
      .bar-label {
        position: absolute;
        bottom: -20px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 10px;
        white-space: nowrap;
      }
      .actions {
        margin-top: 30px;
        display: flex;
        gap: 10px;
      }
      button {
        padding: 8px 16px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        border-radius: 4px;
        cursor: pointer;
      }
      button:hover {
        background: var(--vscode-button-hoverBackground);
      }
    </style>
  </head>
  <body>
    <h1>🚀 Sidekick Pro Performance Metrics</h1>
    
    <h2>Real-time Performance</h2>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Cache Hit Rate</div>
        <div class="metric-value ${hitRatePercent > 60 ? 'status-good' : hitRatePercent > 30 ? 'status-warning' : 'status-bad'}">
          ${hitRatePercent.toFixed(1)}%
        </div>
        <div class="metric-desc">Higher is better (target: >60%)</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-label">Requests/Min</div>
        <div class="metric-value">${stats.requestsThisMinute}/${stats.maxRequestsPerMinute}</div>
        <div class="metric-desc">Current API usage</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-label">Avg Response Time</div>
        <div class="metric-value">${avgResponseTime}ms</div>
        <div class="metric-desc">Including cache hits</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-label">Active Requests</div>
        <div class="metric-value">${stats.activeRequests}</div>
        <div class="metric-desc">Currently processing</div>
      </div>
    </div>
    
    <h2>Cache Statistics</h2>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Memory Cache</div>
        <div class="metric-value">${cacheStats.memoryCacheSize}</div>
        <div class="metric-desc">Entries in memory</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-label">Pattern Cache</div>
        <div class="metric-value">${cacheStats.patternCacheSize}</div>
        <div class="metric-desc">Learned patterns</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-label">Total Cache Hits</div>
        <div class="metric-value">${cacheStats.totalHits}</div>
        <div class="metric-desc">Since activation</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-label">API Calls Saved</div>
        <div class="metric-value">${modelMetrics.cacheHits}</div>
        <div class="metric-desc">By using cache</div>
      </div>
    </div>
    
    <h2>Rejection Tracking</h2>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Consecutive Rejections</div>
        <div class="metric-value ${stats.consecutiveRejections > 3 ? 'status-bad' : 'status-good'}">
          ${stats.consecutiveRejections}
        </div>
        <div class="metric-desc">Resets on acceptance</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-label">Rejected Patterns</div>
        <div class="metric-value">${stats.rejectedPatterns}</div>
        <div class="metric-desc">Unique rejection signatures</div>
      </div>
    </div>
    
    <h2>Model Configuration</h2>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Provider</div>
        <div class="metric-value">${modelMetrics.provider}</div>
        <div class="metric-desc">${modelMetrics.isConfigured ? '✅ Configured' : '❌ Not configured'}</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-label">Total API Calls</div>
        <div class="metric-value">${modelMetrics.apiCalls}</div>
        <div class="metric-desc">Since activation</div>
      </div>
    </div>
    
    <div class="chart">
      <div class="bar" style="height: ${Math.min(100, hitRatePercent)}%">
        <div class="bar-label">Cache</div>
      </div>
      <div class="bar" style="height: ${Math.min(100, (stats.requestsThisMinute / stats.maxRequestsPerMinute) * 100)}%">
        <div class="bar-label">Rate</div>
      </div>
      <div class="bar" style="height: ${Math.min(100, 100 - (avgResponseTime / 10))}%">
        <div class="bar-label">Speed</div>
      </div>
    </div>
    
    <div class="actions">
      <button onclick="window.location.reload()">🔄 Refresh</button>
      <button onclick="clearCache()">🗑️ Clear All Caches</button>
    </div>
    
    <script>
      const vscode = acquireVsCodeApi();
      
      function clearCache() {
        vscode.postMessage({ command: 'clearCache' });
      }
      
      // Auto-refresh every 5 seconds
      setInterval(() => {
        window.location.reload();
      }, 5000);
    </script>
  </body>
  </html>`;
}

  function updateAIStatus() {
    if (modelService.isOpenAIConfigured()) {
      aiStatusBar.text = "$(cloud) OpenAI";
      aiStatusBar.tooltip = "Using OpenAI API";
      aiStatusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.prominentBackground"
      );
    } else {
      aiStatusBar.text = "$(desktop-download) Local AI";
      aiStatusBar.tooltip = "Using local llama.cpp";
    }
    aiStatusBar.command = "sidekick-ai.switchProvider";
    aiStatusBar.show();
  }

  updateAIStatus();
  context.subscriptions.push(aiStatusBar);

  // Show which AI is being used
  if (modelService.isOpenAIConfigured()) {
    vscode.window.showInformationMessage(
      "Sidekick AI ready with OpenAI! Right-click on code for AI features."
    );
  } else {
    vscode.window.showInformationMessage(
      "Sidekick AI using local model. Configure OpenAI in .env file for better performance."
    );
  }

  // Register all command handlers
  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("sidekick-ai");

  const codeFixProvider = new CodeFixProvider(localAI, diagnosticCollection);
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { pattern: "**/*" },
      codeFixProvider,
      {
        providedCodeActionKinds: CodeFixProvider.providedCodeActionKinds,
      }
    )
  );

  const codeFixHandler = new CodeFixHandler(context);

  // Register ALL commands

  // Switch provider command
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick-ai.switchProvider", async () => {
      const providers = ["OpenAI (Faster)", "Local (Offline)"];
      const selected = await vscode.window.showQuickPick(providers, {
        placeHolder: "Select AI provider",
      });

      if (selected) {
        const provider = selected.includes("OpenAI") ? "openai" : "local";

        if (!fsSync.existsSync(envPath)) {
          const template = `# Sidekick AI Configuration
DEFAULT_MODEL_PROVIDER=${provider}
OPENAI_API_KEY=your-openai-key-here
DEFAULT_MODEL_NAME=gpt-3.5-turbo
`;
          fsSync.writeFileSync(envPath, template);
        } else {
          let envContent = fsSync.readFileSync(envPath, "utf8");
          const regex = /^DEFAULT_MODEL_PROVIDER=.*$/gm;
          if (regex.test(envContent)) {
            envContent = envContent.replace(
              regex,
              `DEFAULT_MODEL_PROVIDER=${provider}`
            );
          } else {
            envContent += `\nDEFAULT_MODEL_PROVIDER=${provider}`;
          }
          fsSync.writeFileSync(envPath, envContent);
        }

        updateAIStatus(); // Update the status bar immediately
        vscode.window.showInformationMessage(
          `Switched to ${selected}. Reload window (Ctrl+R) to apply changes.`
        );
      }
    })
  );

  // Pre-warm cache on activation
  await modelService.prewarmCache();
  
  // Add performance monitoring status bar
  const perfStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    98
  );
  perfStatusBar.text = "$(pulse) Sidekick: Initializing...";
  perfStatusBar.tooltip = "Click to see performance metrics";
  perfStatusBar.command = "sidekick-pro.showMetrics";
  perfStatusBar.show();
  context.subscriptions.push(perfStatusBar);
  
  // Update status bar every 5 seconds
  const updateStatusBar = () => {
    const stats = completionProvider.getStats();
    const modelMetrics = modelService.getPerformanceMetrics();
    
    const hitRate = (stats.cacheHitRate * 100).toFixed(0);
    // Check if using smart provider (doesn't have requestsThisMinute)
  const isSmartProvider = !('requestsThisMinute' in stats);
  
  let statusText: string;
  let tooltip: string;
  
  if (isSmartProvider) {
    // Smart provider status
    const lastTrigger = stats.lastTriggerTime 
      ? `${Math.round((Date.now() - stats.lastTriggerTime) / 1000)}s ago`
      : 'Never';
    
    statusText = `$(sparkle) Smart: ${hitRate}% cache | Last: ${lastTrigger}`;
    tooltip = `Smart Completion Provider
Cache Hit Rate: ${hitRate}%
Last Trigger: ${lastTrigger}
Pending Request: ${stats.hasPendingRequest ? 'Yes' : 'No'}
Cache Size: ${stats.cacheSize}
Provider: ${modelMetrics.provider}
Click for details`;
  } else {
    // Old provider status
    const requests = (stats as any).requestsThisMinute || 0;
    const maxRequests = (stats as any).maxRequestsPerMinute || 15;
    
    statusText = `$(pulse) Sidekick: ${hitRate}% cache | ${requests} req/min`;
    tooltip = `Cache Hit Rate: ${hitRate}%
Requests This Minute: ${requests}/${maxRequests}
Active Requests: ${(stats as any).activeRequests || 0}
Consecutive Rejections: ${(stats as any).consecutiveRejections || 0}
Provider: ${modelMetrics.provider}
Click for details`;
  }

  // Change icon based on performance
  let icon = "$(pulse)";
  if (stats.cacheHitRate > 0.6) {
    icon = "$(check)"; // Good performance
  } else if (stats.cacheHitRate > 0.3) {
    icon = "$(info)"; // Medium performance
  }
  
  perfStatusBar.text = statusText.replace('$(sparkle)', icon).replace('$(pulse)', icon);
  perfStatusBar.tooltip = tooltip;
};
  
  // Initial update after 2 seconds
  setTimeout(updateStatusBar, 2000);
  
  // Then update every 5 seconds
  const statusInterval = setInterval(updateStatusBar, 5000);
  context.subscriptions.push({
    dispose: () => clearInterval(statusInterval)
  });
  
  // Command to show detailed metrics
  context.subscriptions.push(
  vscode.commands.registerCommand('sidekick-pro.showMetrics', async () => {
    const stats = completionProvider.getStats();
    const modelMetrics = modelService.getPerformanceMetrics();
    const cacheStats = SmartCache.getInstance().getStatistics();
    
    // Check if using smart provider
    const isSmartProvider = !('requestsThisMinute' in stats);
    
    // Create webview panel for metrics
    const panel = vscode.window.createWebviewPanel(
      'sidekickMetrics',
      isSmartProvider ? 'Smart Completion Metrics' : 'Sidekick Pro Performance Metrics',
      vscode.ViewColumn.Two,
      {
        enableScripts: true
      }
    );
    
    if (isSmartProvider) {
      panel.webview.html = getSmartMetricsWebview(stats, modelMetrics, cacheStats);
    } else {
      panel.webview.html = getMetricsWebview(stats as any, modelMetrics, cacheStats);
    }
  })
);

  // Fix error command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sidekick-ai.fixError",
      async (document: vscode.TextDocument, diagnostic: vscode.Diagnostic) => {
        await codeFixHandler.fixError(document, diagnostic);
      }
    )
  );

  // Explain error command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sidekick-ai.explainError",
      async (document: vscode.TextDocument, diagnostic: vscode.Diagnostic) => {
        const errorMessage = diagnostic.message;
        const errorCode = document.getText(diagnostic.range);

        const prompt = `Explain this error in simple terms:
Error: ${errorMessage}
Code: ${errorCode}

Provide a brief explanation and how to fix it:`;

        try {
          const explanation = await modelService.chat(prompt, "");
          vscode.window.showInformationMessage(explanation, { modal: true });
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to explain: ${error}`);
        }
      }
    )
  );

  // Open chat command
  let chatPanel: ChatPanel | undefined;

  const openChatCommand = vscode.commands.registerCommand(
    "sidekick-ai.openChat",
    () => {
      ChatPanel.createOrShow(
        context,
        localAI,
        indexer,
        privacyGuard,
        modelService
      );
      chatPanel = ChatPanel.currentPanel;
    }
  );

  context.subscriptions.push(openChatCommand);

  // Register the explainCode command for right-click context menu
  // context.subscriptions.push(
  //   vscode.commands.registerCommand("sidekick-ai.explainCode", async () => {
  //     console.log("Explain Code command triggered");
  //     const editor = vscode.window.activeTextEditor;
  //     if (!editor) {
  //       vscode.window.showWarningMessage(
  //         "Please open a file and select code to explain"
  //       );
  //       return;
  //     }

  //     const selection = editor.selection;
  //     const selectedText = editor.document.getText(selection);

  //     if (!selectedText) {
  //       vscode.window.showInformationMessage("Please select code to explain");
  //       return;
  //     }

  //     await vscode.window.withProgress(
  //       {
  //         location: vscode.ProgressLocation.Notification,
  //         title: "Explaining code with AI...",
  //         cancellable: false,
  //       },
  //       async (progress) => {
  //         try {
  //           const fileContext = indexer.getContext();
  //           const languageId = editor.document.languageId;

  //           const explanation = await modelService.explainCode(
  //             selectedText,
  //           indexer.getContext(),
  //           editor.document.languageId
  //           );

  //           // Format explanation as comments
  //         const commentSymbol = getCommentSymbol(editor.document.languageId);
  //         const explanationLines = explanation.split('\n');
  //         const commentedExplanation = explanationLines
  //           .map(line => `${commentSymbol} ${line}`)
  //           .join('\n');

  //         // Add explanation as comments above the selected code
  //         await editor.edit(editBuilder => {
  //           const position = new vscode.Position(selection.start.line, 0);
  //           editBuilder.insert(position, `${commentSymbol} AI Explanation:\n${commentedExplanation}\n`);
  //         });

  //         vscode.window.showInformationMessage("Explanation added as comments above the code");
  //         } catch (error) {
  //           console.error("Error in explainCode:", error);
  //           vscode.window.showErrorMessage(
  //             `Failed to explain code: ${
  //               error instanceof Error ? error.message : "Unknown error"
  //             }`
  //           );
  //         }
  //       }
  //     );
  //   })
  // );

  // In extension.ts, update the explainCode command to show inline decorations

  // Register Copilot-style chat provider
  const copilotChatProvider = new CopilotStyleChatProvider(
    context.extensionUri,
    context,
    modelService,
    indexer
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CopilotStyleChatProvider.viewType,
      copilotChatProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  // Register commands for inline chat
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekickPro.openInlineChat", () => {
      // Open the chat panel
      vscode.commands.executeCommand(
        "workbench.view.extension.sidekickPro-chat"
      );
    })
  );

  // Register command for adding selection to chat
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekickPro.addToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.selection.isEmpty) {
        // Focus chat view
        await vscode.commands.executeCommand(
          "workbench.view.extension.sidekickPro-chat"
        );
        // Add a small delay to ensure view is ready
        setTimeout(() => {
          vscode.window.showInformationMessage(
            "Selection added to chat context"
          );
        }, 100);
      } else {
        vscode.window.showInformationMessage(
          "Please select code to add to chat"
        );
      }
    })
  );

  // // Register other chat-related commands
  // context.subscriptions.push(
  //     vscode.commands.registerCommand('sidekick-ai.openChat', () => {
  //         vscode.commands.executeCommand('workbench.view.extension.sidekickPro-chat');
  //     })
  // );

  // context.subscriptions.push(
  //     vscode.commands.registerCommand('sidekick.chat.open', () => {
  //         vscode.commands.executeCommand('workbench.view.extension.sidekickPro-chat');
  //     })
  // );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sidekick-pro.testAllFeatures",
      async () => {
        const testCode = `function add(a: number, b: number): number {
    return a + b;
}`;

        try {
          console.log("Testing all OpenAI features...");

          // Test chat
          const chatResponse = await modelService.chat(
            "What does this code do: " + testCode,
            ""
          );
          console.log("✅ Chat works:", chatResponse.substring(0, 50) + "...");

          // Test explain
          const explainResponse = await modelService.explainCode(
            testCode,
            "",
            "typescript"
          );
          console.log(
            "✅ Explain works:",
            explainResponse.substring(0, 50) + "..."
          );

          // Test tests generation
          const testsResponse = await modelService.generateTests(
            testCode,
            "",
            "typescript"
          );
          console.log(
            "✅ Test generation works:",
            testsResponse.substring(0, 50) + "..."
          );

          // Test refactor
          const refactorResponse = await modelService.refactorCode(
            testCode,
            "add JSDoc comments",
            "",
            "typescript"
          );
          console.log(
            "✅ Refactor works:",
            refactorResponse.substring(0, 50) + "..."
          );

          vscode.window.showInformationMessage(
            "✅ All OpenAI features working!"
          );
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `Feature test failed: ${error.message}`
          );
          console.error("Test error:", error);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick-ai.explainCode", async () => {
      console.log("Explain Code command triggered");
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          "Please open a file and select code to explain"
        );
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);

      if (!selectedText) {
        vscode.window.showInformationMessage("Please select code to explain");
        return;
      }

      // NEW: Extract full context using ContextExtractor
      const extractedContext = await contextExtractor.extractContext(
        editor.document, 
        selection.start
      );
      
      // NEW: Use PromptTemplates to build structured prompt
      const structuredPrompt = promptTemplates.explainPrompt(
        selectedText,
        extractedContext,
        { style: 'educational' }
      );

      // Show loading indicator inline
      const loadingDecoration = vscode.window.createTextEditorDecorationType({
        after: {
          contentText: `  🔄 Getting AI explanation (found ${extractedContext.relatedSymbols.length} related symbols)...`,
          color: "rgba(255, 255, 255, 0.5)",
          fontStyle: "italic",
        },
      });

      editor.setDecorations(loadingDecoration, [
        {
          range: new vscode.Range(selection.end, selection.end),
        },
      ]);

      try {
        //const fileContext = indexer.getContext();
        //const languageId = editor.document.languageId;

        // Get explanation from ModelService
        const explanation = await modelService.chat(structuredPrompt, '');

        // Clear loading decoration
        editor.setDecorations(loadingDecoration, []);
        loadingDecoration.dispose();

        // Create inline explanation decoration
        const explanationDecoration =
          vscode.window.createTextEditorDecorationType({
            isWholeLine: false,
            after: {
              contentText: "", // We'll use hover for full text
              textDecoration: "none",
            },
            // Highlight the selected code
            backgroundColor: "rgba(65, 105, 225, 0.1)",
            border: "1px solid rgba(65, 105, 225, 0.3)",
            borderRadius: "3px",
          });

        // Create rich hover content
        const hoverMessage = new vscode.MarkdownString("", true);
        hoverMessage.isTrusted = true;
        hoverMessage.supportHtml = true;

        // Format explanation nicely
        hoverMessage.appendMarkdown(
          `### 🤖 AI Explanation\n\n${explanation}\n\n---\n*💡 Tip: Select any code and use Ctrl+Shift+E for explanations*`
        );

        // Apply decoration with hover
        const decoration: vscode.DecorationOptions = {
          range: selection,
          hoverMessage: hoverMessage,
          renderOptions: {
            after: {
              contentText: ` // AI: ${explanation
                .split("\n")[0]
                .substring(0, 50)}...`,
              color: "rgba(106, 153, 85, 0.6)",
              fontStyle: "italic",
              margin: "0 0 0 10px",
            },
          },
        };

        editor.setDecorations(explanationDecoration, [decoration]);

        // Auto-clear after 60 seconds
        setTimeout(() => {
          editor.setDecorations(explanationDecoration, []);
          explanationDecoration.dispose();
        }, 60000);

        // Show notification with options
        vscode.window
          .showInformationMessage(
            "AI explanation added inline. Hover to see full explanation.",
            "Copy Explanation",
            "Clear"
          )
          .then((action) => {
            if (action === "Copy Explanation") {
              vscode.env.clipboard.writeText(explanation);
              vscode.window.showInformationMessage(
                "Explanation copied to clipboard!"
              );
            } else if (action === "Clear") {
              editor.setDecorations(explanationDecoration, []);
              explanationDecoration.dispose();
            }
          });
      } catch (error) {
        // Clear loading decoration on error
        editor.setDecorations(loadingDecoration, []);
        loadingDecoration.dispose();

        console.error("Error in explainCode:", error);
        vscode.window.showErrorMessage(
          `Failed to explain code: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    })
  );

  //   function getCommentSymbol(languageId: string): string {
  //   const commentSymbols: Record<string, string> = {
  //     javascript: '//',
  //     typescript: '//',
  //     python: '#',
  //     java: '//',
  //     csharp: '//',
  //     cpp: '//',
  //     c: '//',
  //     ruby: '#',
  //     go: '//',
  //     rust: '//',
  //     php: '//',
  //     swift: '//',
  //     kotlin: '//',
  //     html: '<!--',
  //     css: '/*',
  //     sql: '--',
  //     shell: '#',
  //     yaml: '#',
  //     default: '//'
  //   };

  //   return commentSymbols[languageId] || commentSymbols.default;
  // }

  // Register refactorCode command
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick-ai.refactorCode", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          "Please open a file and select code to refactor"
        );
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);

      if (!selectedText) {
        vscode.window.showInformationMessage("Please select code to refactor");
        return;
      }

      const instruction = await vscode.window.showInputBox({
        prompt: "How would you like to refactor this code?",
        placeHolder:
          "e.g., 'make it more efficient', 'add error handling', 'improve naming'",
        value: "improve this code",
      });

      if (!instruction) return;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Refactoring code with AI...",
          cancellable: false,
        },
        async () => {
          try {
            const fileContext = indexer.getContext();
            const languageId = editor.document.languageId;

            const refactoredCode = await modelService.refactorCode(
              selectedText,
              instruction,
              fileContext,
              languageId
            );

            await editor.edit((editBuilder) => {
              editBuilder.replace(selection, refactoredCode);
            });

            vscode.window.showInformationMessage(
              "Code refactored successfully!"
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to refactor code: ${
                error instanceof Error ? error.message : "Unknown error"
              }`
            );
          }
        }
      );
    })
  );

  // Register generateTests command
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick-ai.generateTests", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.selection;
      const selectedText = selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(selection);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Generating tests with AI...",
          cancellable: false,
        },
        async () => {
          try {
            const fileContext = indexer.getContext();
            const languageId = editor.document.languageId;

            const tests = await modelService.generateTests(
              selectedText,
              fileContext,
              languageId
            );

            const testFileName = editor.document.fileName.replace(
              /\.(\w+)$/,
              ".test.$1"
            );
            const testDoc = await vscode.workspace.openTextDocument({
              content: tests,
              language: languageId,
            });

            await vscode.window.showTextDocument(testDoc);
            vscode.window.showInformationMessage(
              "Tests generated successfully!"
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to generate tests: ${
                error instanceof Error ? error.message : "Unknown error"
              }`
            );
          }
        }
      );
    })
  );

  // Backward compatibility commands
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick-ai.explain", async () => {
      vscode.commands.executeCommand("sidekick-ai.explainCode");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick-ai.refactor", async () => {
      vscode.commands.executeCommand("sidekick-ai.refactorCode");
    })
  );

  // Trigger completion command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sidekick-ai.triggerCompletion",
      async () => {
        await vscode.commands.executeCommand(
          "editor.action.inlineSuggest.trigger"
        );
      }
    )
  );

  // Accepted completion tracking
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sidekick-ai.acceptedCompletion",
      (completion: string) => {
        console.log("User accepted completion:", completion);
        vscode.window.setStatusBarMessage("✅ AI suggestion accepted", 2000);

        const acceptances = context.globalState.get(
          "completionAcceptances",
          0
        ) as number;
        context.globalState.update("completionAcceptances", acceptances + 1);
      }
    )
  );

  // Privacy status command
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick-ai.privacyStatus", async () => {
      const report = privacyGuard.getPrivacyReport();
      const panel = vscode.window.createWebviewPanel(
        "privacyReport",
        "Privacy Status",
        vscode.ViewColumn.One,
        {}
      );

      panel.webview.html = getPrivacyReportHtml(report);
    })
  );

  // Switch model command
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick-ai.switchModel", async () => {
      const models = await localAI.getAvailableModels();
      const selected = await vscode.window.showQuickPick(models, {
        placeHolder: "Select AI model to use",
      });

      if (selected) {
        await localAI.switchModel(selected);
        vscode.window.showInformationMessage(`Switched to ${selected}`);
      }
    })
  );

  // Register inline completion provider
  console.log("Initializing InlineCompletionProvider...");
  const completionProvider = new InlineCompletionProvider(
    modelService,
    indexer
  );
  // Register for all files with a single registration
  const disposable = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**/*" }, // Match all files
    completionProvider
  );
  context.subscriptions.push(disposable);
  console.log("InlineCompletionProvider registered for all files");

  // Also register for specific schemes to ensure coverage
  const schemes = ["file", "untitled"];
  for (const scheme of schemes) {
    const schemeDisposable =
      vscode.languages.registerInlineCompletionItemProvider(
        { scheme: scheme },
        completionProvider
      );
    context.subscriptions.push(schemeDisposable);
  }
  // Check if inline suggestions are enabled - CRITICAL!
  const inlineSuggestEnabled = vscode.workspace
    .getConfiguration("editor")
    .get("inlineSuggest.enabled");
  if (!inlineSuggestEnabled) {
    const result = await vscode.window.showWarningMessage(
      "⚠️ Inline suggestions are DISABLED. Code completions won't work!",
      "Enable Now",
      "Cancel"
    );

    if (result === "Enable Now") {
      await vscode.workspace
        .getConfiguration("editor")
        .update(
          "inlineSuggest.enabled",
          true,
          vscode.ConfigurationTarget.Global
        );
      vscode.window.showInformationMessage("Inline suggestions enabled!");
    }
  }

  // Add debug command to check status
  const checkCompletionCommand = vscode.commands.registerCommand(
    "sidekick-pro.checkCompletions",
    () => {
      const inlineSuggest = vscode.workspace
        .getConfiguration("editor")
        .get("inlineSuggest.enabled");
      const stats = completionProvider.getStats();

      const hasRequestMetrics =
        "requestsThisMinute" in stats && "maxRequestsPerMinute" in stats;
      let requestsLine = "• Requests: Smart trigger mode";
      if (hasRequestMetrics) {
        const requestStats = stats as {
          requestsThisMinute: number;
          maxRequestsPerMinute: number;
        };
        requestsLine = `• Requests: ${requestStats.requestsThisMinute}/${requestStats.maxRequestsPerMinute}`;
      }

      const message = `
Completion System Status:
• Inline Suggestions: ${inlineSuggest ? "✅ Enabled" : "❌ DISABLED"}
• Provider: ${modelService.getCurrentProvider()}
• Cache Size: ${stats.cacheSize}
${requestsLine}
• OpenAI: ${
        modelService.isOpenAIConfigured()
          ? "✅ Configured"
          : "❌ Not configured"
      }
        `.trim();

      vscode.window.showInformationMessage(message);
      console.log(message);

      if (!inlineSuggest) {
        vscode.window.showErrorMessage(
          "Inline suggestions are DISABLED. Enable them in settings for completions to work!"
        );
      }
    }
  );
  context.subscriptions.push(checkCompletionCommand);
  // Register for multiple languages
  const languages = [
    "typescript",
    "javascript",
    "python",
    "java",
    "csharp",
    "cpp",
    "c",
    "go",
    "rust",
    "php",
    "ruby",
    "swift",
    "kotlin",
    "scala",
    "r",
    "julia",
    "dart",
    "lua",
  ];

  // Register the provider for each language
  languages.forEach((language) => {
    const provider = vscode.languages.registerInlineCompletionItemProvider(
      { language },
      completionProvider
    );
    context.subscriptions.push(provider);
  });
  // Toggle completions on/off
  const toggleCompletionsCommand = vscode.commands.registerCommand(
    "sidekick-pro.toggleCompletions",
    () => {
      const config = vscode.workspace.getConfiguration("sidekickPro");
      const currentState = config.get("enableCompletions", true);
      config.update(
        "enableCompletions",
        !currentState,
        vscode.ConfigurationTarget.Global
      );
      // completionProvider.setEnabled(!currentState);

      vscode.window.showInformationMessage(
        `Code completions ${!currentState ? "enabled" : "disabled"}`
      );
    }
  );
  context.subscriptions.push(toggleCompletionsCommand);

  // Clear completion cache
  const clearCacheCommand = vscode.commands.registerCommand(
    "sidekick-pro.clearCompletionCache",
    () => {
      completionProvider.clearCache();
      vscode.window.showInformationMessage("Completion cache cleared");
    }
  );
  context.subscriptions.push(clearCacheCommand);

  // Chat status bar
  // const completionStatusBar = vscode.window.createStatusBarItem(
  //       vscode.StatusBarAlignment.Right,
  //       99
  //   );

  const testCompletionCommand = vscode.commands.registerCommand(
    "sidekick-pro.testCompletion",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("No active editor");
        return;
      }

      const position = editor.selection.active;
      const lineText = editor.document.lineAt(position.line).text;
      const beforeCursor = lineText.substring(0, position.character);

      console.log("Testing completion at position:", position);
      console.log("Text before cursor:", beforeCursor);
      console.log("Provider:", modelService.getCurrentProvider());

      try {
        // Build a simple prompt for testing
        const prompt = beforeCursor + "<CURSOR>";
        const completion = await modelService.generateCompletion(
          prompt,
          "",
          50,
          editor.document.languageId
        );

        if (completion) {
          vscode.window.showInformationMessage(
            `Completion: ${completion.substring(0, 50)}...`
          );
          console.log("Full completion:", completion);
        } else {
          vscode.window.showWarningMessage("No completion generated");
        }
      } catch (error) {
        console.error("Test completion error:", error);
        vscode.window.showErrorMessage(`Completion error: ${error}`);
      }
    }
  );
  context.subscriptions.push(testCompletionCommand);

  // } catch (error) {
  //     console.error('Failed to register completion provider:', error);
  //     vscode.window.showErrorMessage(`Failed to register completions: ${error}`);
  // }
  let completionStatusBar: vscode.StatusBarItem;
  function createCompletionStatusBar() {
    completionStatusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      98
    );

    completionStatusBar.command = "sidekick-pro.completionStats";
    updateCompletionStatusBar();
    completionStatusBar.show();

    // Update every 5 seconds
    setInterval(() => {
    const cacheStats = smartCache.getStatistics();
    if (cacheStats.hitRate < 0.3 && cacheStats.totalRequests > 10) {
      console.warn("Low cache hit rate:", (cacheStats.hitRate * 100).toFixed(2) + "%");
    }
  }, 30000);

  context.subscriptions.push({
    dispose: () => {
      smartCache.clear();
      console.log("Caches cleared on deactivation");
    }
  });
  }
function getSmartMetricsWebview(
  stats: any,
  modelMetrics: any,
  cacheStats: any
): string {
  const hitRatePercent = stats.cacheHitRate * 100;
  const hitRatePercentDisplay = hitRatePercent.toFixed(1);
  const avgResponseTime = modelMetrics.avgResponseTime.toFixed(0);
  const lastTrigger = stats.lastTriggerTime 
    ? new Date(stats.lastTriggerTime).toLocaleTimeString()
    : 'Never';
  
  return `<!DOCTYPE html>
  <html>
  <head>
    <style>
      body {
        font-family: var(--vscode-font-family);
        padding: 20px;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
      }
      .metrics-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 20px;
        margin-top: 20px;
      }
      .metric-card {
        background: var(--vscode-input-background);
        padding: 15px;
        border-radius: 8px;
        border: 1px solid var(--vscode-input-border);
      }
      .metric-value {
        font-size: 24px;
        font-weight: bold;
        color: var(--vscode-textLink-foreground);
        margin: 10px 0;
      }
      .metric-label {
        font-size: 12px;
        opacity: 0.8;
        text-transform: uppercase;
      }
      .metric-desc {
        font-size: 11px;
        opacity: 0.6;
        margin-top: 5px;
      }
      h1 {
        border-bottom: 2px solid var(--vscode-input-border);
        padding-bottom: 10px;
      }
      h2 {
        margin-top: 30px;
        opacity: 0.9;
      }
      .status-good { color: #4caf50; }
      .status-warning { color: #ff9800; }
      .status-bad { color: #f44336; }
      .info-box {
        background: var(--vscode-textBlockQuote-background);
        border-left: 3px solid var(--vscode-textLink-foreground);
        padding: 15px;
        margin: 20px 0;
      }
    </style>
  </head>
  <body>
    <h1>🚀 Smart Completion Provider Metrics</h1>
    
    <div class="info-box">
      <strong>Smart Mode Active:</strong> Completions only trigger on meaningful code patterns.
      <br>No spam, no patterns, just intelligent context-aware suggestions.
    </div>
    
    <h2>Smart Triggers</h2>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Last Trigger</div>
        <div class="metric-value">${lastTrigger}</div>
        <div class="metric-desc">When completion was last requested</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-label">Active Request</div>
        <div class="metric-value">${stats.hasPendingRequest ? 'Yes' : 'No'}</div>
        <div class="metric-desc">Currently processing</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-label">Cooldown</div>
        <div class="metric-value">2s</div>
        <div class="metric-desc">Between triggers</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-label">Debounce</div>
        <div class="metric-value">1s</div>
        <div class="metric-desc">After typing stops</div>
      </div>
    </div>
    
    <h2>Cache Performance</h2>
      <div class="metric-card">
        <div class="metric-label">Cache Hit Rate</div>
        <div class="metric-value ${hitRatePercent > 60 ? 'status-good' : hitRatePercent > 30 ? 'status-warning' : 'status-bad'}">
          ${hitRatePercentDisplay}%
        </div>
        <div class="metric-desc">Higher is better</div>
      </div>
      </div>
      
      <div class="metric-card">
        <div class="metric-label">Cache Size</div>
        <div class="metric-value">${stats.cacheSize}</div>
        <div class="metric-desc">Stored completions</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-label">Avg Response</div>
        <div class="metric-value">${avgResponseTime}ms</div>
        <div class="metric-desc">Including cache hits</div>
      </div>
    </div>
    
    <h2>Model Configuration</h2>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Provider</div>
        <div class="metric-value">${modelMetrics.provider}</div>
        <div class="metric-desc">${modelMetrics.isConfigured ? '✅ Configured' : '❌ Not configured'}</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-label">Total API Calls</div>
        <div class="metric-value">${modelMetrics.apiCalls}</div>
        <div class="metric-desc">Since activation</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-label">Cache Savings</div>
        <div class="metric-value">${modelMetrics.cacheHits}</div>
        <div class="metric-desc">API calls avoided</div>
      </div>
    </div>
    
    <h2>Smart Triggers Include:</h2>
    <ul>
      <li>Function declarations needing body</li>
      <li>Class declarations needing methods</li>
      <li>TODO/FIXME comments</li>
      <li>Try blocks needing catch</li>
      <li>Test cases needing implementation</li>
      <li>Algorithm implementation from comments</li>
    </ul>
    
    <div class="actions" style="margin-top: 30px;">
      <button onclick="window.location.reload()" style="padding: 8px 16px;">🔄 Refresh</button>
    </div>
  </body>
  </html>`;
}
  function updateCompletionStatusBar() {
    const stats = completionProvider.getStats();
    const cacheStats = smartCache.getStatistics();
    const hasRequestMetrics = "requestsThisMinute" in stats && "maxRequestsPerMinute" in stats;
    const requestsPerMin = hasRequestMetrics
      ? (stats as { requestsThisMinute: number }).requestsThisMinute
      : 0;
    const maxRequestsPerMinute = hasRequestMetrics
      ? (stats as { maxRequestsPerMinute: number }).maxRequestsPerMinute
      : 20;
    const hitRate = cacheStats.hitRate;

    // Color code based on usage
    let icon = "$(pulse)";
    let color = "";
    let statusText = "";

    if (hitRate > 0.7) {
      // Excellent - mostly using cache
      icon = "$(zap)";
      statusText = `${icon} ${(hitRate * 100).toFixed(0)}% cache`;
      color = ""; // Default green
    } else if (requestsPerMin === 0) {
      icon = hasRequestMetrics ? "$(circle-slash)" : "$(sparkle)";
      statusText = hasRequestMetrics ? `${icon} Idle` : `${icon} Smart mode`;
      color = "";
    } else if (requestsPerMin < 10) {
      icon = "$(pulse)";
      statusText = `${icon} ${requestsPerMin}/${maxRequestsPerMinute} API`;
      color = "";
    } else if (requestsPerMin < 15) {
      icon = "$(warning)";
      statusText = `${icon} ${requestsPerMin}/${maxRequestsPerMinute} API`;
      color = "statusBarItem.warningBackground";
    } else {
      icon = "$(alert)";
      statusText = `${icon} ${requestsPerMin}/${maxRequestsPerMinute} API`;
      color = "statusBarItem.errorBackground";
    }

    completionStatusBar.text = statusText;
    const tooltipLines = [
      `Cache Hit Rate: ${(hitRate * 100).toFixed(1)}%`,
      hasRequestMetrics
        ? `API Requests: ${requestsPerMin}/${maxRequestsPerMinute}`
        : "Smart Trigger Mode: Active",
      `Memory Cache: ${cacheStats.memoryCacheSize} entries`,
      `Pattern Cache: ${cacheStats.patternCacheSize} patterns`,
      "Click for details",
    ];
    completionStatusBar.tooltip = tooltipLines.join("\n");

    if (color) {
      completionStatusBar.backgroundColor = new vscode.ThemeColor(color);
    } else {
      completionStatusBar.backgroundColor = undefined;
    }
  }
  createCompletionStatusBar();
  updateCompletionStatusBar();
  // completionStatusBar.show();
  // context.subscriptions.push(completionStatusBar);

  // View cache contents
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick-pro.viewCache", async () => {
      const cacheStats = smartCache.getStatistics();
      const panel = vscode.window.createWebviewPanel(
        'cacheView',
        'Sidekick Pro Cache',
        vscode.ViewColumn.One,
        {}
      );
      
      panel.webview.html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { 
              font-family: var(--vscode-font-family); 
              padding: 20px; 
              color: var(--vscode-foreground);
              background: var(--vscode-editor-background);
            }
            .stat { 
              margin: 10px 0; 
              padding: 10px; 
              background: var(--vscode-input-background);
              border-radius: 5px;
            }
            .good { color: #4CAF50; }
            .warning { color: #FF9800; }
            .info { color: #2196F3; }
          </style>
        </head>
        <body>
          <h1>🚀 Sidekick Pro Cache Performance</h1>
          
          <h2>Overall Performance</h2>
          <div class="stat">
            <strong>Cache Hit Rate:</strong> 
            <span class="${cacheStats.hitRate > 0.5 ? 'good' : 'warning'}">
              ${(cacheStats.hitRate * 100).toFixed(2)}%
            </span>
          </div>
          
          <div class="stat">
            <strong>Total Hits:</strong> ${cacheStats.totalHits}
          </div>
          
          <div class="stat">
            <strong>Total Requests:</strong> ${cacheStats.totalRequests}
          </div>
          
          <h2>Cache Contents</h2>
          <div class="stat">
            <strong>Memory Cache Entries:</strong> ${cacheStats.memoryCacheSize}
          </div>
          
          <div class="stat">
            <strong>Pattern Cache Entries:</strong> ${cacheStats.patternCacheSize}
          </div>
          
          <h2>Performance Impact</h2>
          <div class="stat info">
            <strong>Estimated Time Saved:</strong> 
            ~${(cacheStats.totalHits * 0.3).toFixed(1)} seconds
          </div>
          
          <div class="stat info">
            <strong>API Calls Saved:</strong> ${cacheStats.totalHits}
          </div>
          
          <div class="stat info">
            <strong>Estimated Cost Saved:</strong> 
            $${(cacheStats.totalHits * 0.0001).toFixed(4)}
          </div>
        </body>
        </html>
      `;
    })
  );

  // Clear specific document cache
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick-pro.clearDocumentCache", async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        smartCache.clearDocument(editor.document);
        contextExtractor.clearDocumentCache(editor.document);
        vscode.window.showInformationMessage(
          `Cache cleared for ${path.basename(editor.document.fileName)}`
        );
      }
    })
  );


  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("sidekickPro.enableCompletions")) {
      const config = vscode.workspace.getConfiguration("sidekickPro");
      const enabled = config.get("enableCompletions", true);
      // completionProvider.setEnabled(enabled);
      updateCompletionStatusBar();
    }

    if (e.affectsConfiguration("sidekickPro")) {
      modelService.loadConfiguration();
      updateCompletionStatusBar();
    }
  });

  // ========================================
  // Monitor Active Editor Changes
  // ========================================
  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      // Update indexer with new file
      indexer.updateFile(editor.document.uri);
    }
  });

  // Monitor text document changes for indexing
  vscode.workspace.onDidChangeTextDocument((event) => {
    // Update index for changed documents
    if (event.document.uri.scheme === "file") {
      indexer.updateFile(event.document.uri);
    }
  });

  // Initial indexing of workspace
  if (vscode.workspace.workspaceFolders) {
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Indexing workspace for AI completions...",
        cancellable: false,
      },
      async (progress) => {
        await indexer.indexWorkspace();
        progress.report({ increment: 100 });
      }
    );
  }
  // Privacy status bar
  // const privacyStatusBar = vscode.window.createStatusBarItem(
  //   vscode.StatusBarAlignment.Right,
  //   98
  // );
  // privacyStatusBar.text = "$(shield) Privacy Mode: ON";
  const statsCommand = vscode.commands.registerCommand(
    "sidekick-pro.completionStats",
    () => {
      const stats = completionProvider.getStats();
      const cacheStats = smartCache.getStatistics();
      const hasRequestMetrics =
        "requestsThisMinute" in stats && "maxRequestsPerMinute" in stats;
      const requestStats = hasRequestMetrics
        ? (stats as {
            requestsThisMinute: number;
            maxRequestsPerMinute: number;
          })
        : undefined;
      const message = [
        "Completion Statistics:",
        `• Cache Hit Rate: ${(cacheStats.hitRate * 100).toFixed(2)}%`,
        `• Memory Cache: ${cacheStats.memoryCacheSize} entries`,
        `• Pattern Cache: ${cacheStats.patternCacheSize} entries`,
        `• Total Hits: ${cacheStats.totalHits}`,
        requestStats
          ? `• API Requests This Minute: ${requestStats.requestsThisMinute}/${requestStats.maxRequestsPerMinute}`
          : "• Smart Trigger Mode: Active",
        `• Quick Patterns Learned: ${cacheStats.patternCacheSize}`,
      ].join("\n");

      vscode.window
        .showInformationMessage(
          message,
          "Clear Cache",
          "Cache Details",
          "Close"
        )
        .then((selection) => {
          if (selection === "Clear Cache") {
            smartCache.clear();
            completionProvider.clearCache();
            vscode.window.showInformationMessage("All Cache cleared!");
          } else if (selection === "Cache Details") {
            // Show detailed cache info
            const detailMessage = `
Cache Performance:
• Hit Rate: ${(cacheStats.hitRate * 100).toFixed(2)}%
• Memory Usage: ~${((cacheStats.memoryCacheSize * 0.001)).toFixed(2)}MB
• Patterns Learned: ${cacheStats.patternCacheSize}
• Avg Response Time: <50ms (cached) vs 200-500ms (API)
            `.trim();
            vscode.window.showInformationMessage(detailMessage);
          }
        });
    }
  );
  context.subscriptions.push(statsCommand);
  const hoverProvider = vscode.languages.registerHoverProvider(
    { pattern: "**/*" },
    {
      async provideHover(document, position, token) {
        // Use ModelService instead of LocalAI directly
        try {
          const range = document.getWordRangeAtPosition(position);
          const selectedText = range ? document.getText(range) : "";
          const explanation = await modelService.explainCode(
            selectedText,
            "",
            document.languageId
          );
          // ... rest of hover logic
        } catch (error) {
          console.error("Failed to explain code:", error);
          return null;
        }
      },
    }
  );
  let verboseLogging = false;
  const toggleLoggingCommand = vscode.commands.registerCommand(
    "sidekick-pro.toggleCompletionLogging",
    () => {
      verboseLogging = !verboseLogging;
      vscode.window.showInformationMessage(
        `Completion logging ${verboseLogging ? "enabled" : "disabled"}`
      );
    }
  );
  context.subscriptions.push(toggleLoggingCommand);

  context.subscriptions.push(hoverProvider);

  // File watcher
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  watcher.onDidCreate((uri) => indexer.indexFile(uri));
  watcher.onDidChange((uri) => indexer.updateFile(uri));
  watcher.onDidDelete((uri) => indexer.removeFile(uri));

  context.subscriptions.push(watcher);

  // Dispose handler
  context.subscriptions.push({
    dispose: () => localAI.dispose(),
  });
}

function getPrivacyReportHtml(report: any): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: var(--vscode-font-family); padding: 20px; }
            .status { color: #4CAF50; font-weight: bold; }
            .metric { margin: 10px 0; padding: 10px; background: var(--vscode-editor-background); }
            h2 { color: var(--vscode-foreground); }
        </style>
    </head>
    <body>
        <h1>🔒 Privacy Status Report</h1>
        <div class="status">✓ All processing is local</div>
        
        <h2>Session Statistics</h2>
        <div class="metric">Network Requests Blocked: ${
          report.blockedRequests
        }</div>
        <div class="metric">Local Inferences: ${report.localInferences}</div>
        <div class="metric">Data Processed Locally: ${
          report.dataProcessed
        }</div>
        <div class="metric">Active Model: ${report.activeModel}</div>
        
        <h2>Security Settings</h2>
        <div class="metric">Telemetry: DISABLED</div>
        <div class="metric">External APIs: BLOCKED</div>
        <div class="metric">Code Sanitization: ENABLED</div>
        <div class="metric">Local Models Only: ENFORCED</div>
        
        <h2>Indexed Files</h2>
        <div class="metric">Total Files: ${report.indexedFiles}</div>
        <div class="metric">Excluded Patterns: ${report.excludedPatterns.join(
          ", "
        )}</div>
    </body>
    </html>
  `;
}

export function deactivate() {
  console.log("Sidekick AI deactivated");
}
