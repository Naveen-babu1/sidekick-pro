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

      // Show loading indicator inline
      const loadingDecoration = vscode.window.createTextEditorDecorationType({
        after: {
          contentText: "  🔄 Getting AI explanation...",
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
        const fileContext = indexer.getContext();
        const languageId = editor.document.languageId;

        // Get explanation from ModelService
        const explanation = await modelService.explainCode(
          selectedText,
          fileContext,
          languageId
        );

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

      const message = `
Completion System Status:
• Inline Suggestions: ${inlineSuggest ? "✅ Enabled" : "❌ DISABLED"}
• Provider: ${modelService.getCurrentProvider()}
• Cache Size: ${stats.cacheSize}
• Requests: ${stats.requestsThisMinute}/${stats.maxRequestsPerMinute}
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
    setInterval(updateCompletionStatusBar, 5000);
  }
  function updateCompletionStatusBar() {
    const stats = completionProvider.getStats();
    const requestsPerMin = stats.requestsThisMinute;

    // Color code based on usage
    let icon = "$(pulse)";
    let color = "";

    if (requestsPerMin === 0) {
      icon = "$(circle-slash)";
      color = "statusBarItem.warningBackground";
    } else if (requestsPerMin < 10) {
      icon = "$(pulse)";
      color = ""; // Default color
    } else if (requestsPerMin < 15) {
      icon = "$(warning)";
      color = "statusBarItem.warningBackground";
    } else {
      icon = "$(alert)";
      color = "statusBarItem.errorBackground";
    }

    completionStatusBar.text = `${icon} ${requestsPerMin}/20`;
    completionStatusBar.tooltip = `API Requests: ${requestsPerMin}/20 this minute\nCache: ${stats.cacheSize} entries\nClick for details`;

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
  // privacyStatusBar.tooltip =
  //   "All AI processing happens locally. Click for privacy report.";
  // privacyStatusBar.command = "sidekick-ai.privacyStatus";
  // privacyStatusBar.show();

  // context.subscriptions.push(privacyStatusBar);

  // Register hover provider
  const statsCommand = vscode.commands.registerCommand(
    "sidekick-pro.completionStats",
    () => {
      const stats = completionProvider.getStats();
      const message = `
Completion Statistics:
• Cache Size: ${stats.cacheSize} entries
• Pending Requests: ${stats.pendingRequests}
• Requests This Minute: ${stats.requestsThisMinute}/20
• Cache Hit Rate: ${
        stats.cacheSize > 0
          ? (
              ((stats.cacheSize - stats.pendingRequests) / stats.cacheSize) *
              100
            ).toFixed(2)
          : "N/A"
      }%
        `.trim();

      vscode.window
        .showInformationMessage(message, "Clear Cache", "Close")
        .then((selection) => {
          if (selection === "Clear Cache") {
            completionProvider.clearCache();
            vscode.window.showInformationMessage("Cache cleared!");
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
