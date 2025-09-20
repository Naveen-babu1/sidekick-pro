import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { LocalAIProvider } from "./providers/LocalAIProvider";
import { CodeIndexer } from "./indexer/CodeIndexer";
import { PrivacyGuard } from "./security/PrivacyGuard";
import { InlineCompletionProvider } from "./providers/InlineCompletionProvider";
import { CodeFixProvider } from "./providers/CodeFixProvider";
import { CodeFixHandler } from "./providers/CodeFixHandler";
// import { InlineCodeFixProvider } from "./providers/InlineCodeFixProvider";

// Chat Panel Class - Creates a webview panel on the right side
class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private messages: Array<{ role: string; content: string }> = [];

  constructor(
    panel: vscode.WebviewPanel,
    private context: vscode.ExtensionContext,
    private localAI: LocalAIProvider,
    private indexer: CodeIndexer,
    private privacyGuard: PrivacyGuard
  ) {
    this._panel = panel;
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
    privacyGuard: PrivacyGuard
  ) {
    const column = vscode.ViewColumn.Two; // This makes it appear on the right

    // If we already have a panel, show it
    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel._panel.reveal(column);
      return;
    }

    // Create a new panel
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
      privacyGuard
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
    // Add user message
    this.messages.push({ role: "user", content: text });
    this._panel.webview.postMessage({
      type: "addMessage",
      role: "user",
      content: text,
    });

    // Show typing indicator
    this._panel.webview.postMessage({ type: "showTyping" });

    try {
      // Get current editor context
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

      // Check for commands
      if (text.startsWith("/")) {
        await this.handleCommand(text, context);
      } else {
        // Regular chat
        const response = await this.localAI.chat(text, context);
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

    // Hide typing indicator
    this._panel.webview.postMessage({ type: "hideTyping" });

    // Save chat history
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
            const explanation = await this.localAI.explainCode(
              selectedText,
              context
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
            const refactored = await this.localAI.refactorCode(
              selectedText,
              instruction,
              context
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
          const tests = await this.localAI.generateTests(selectedText, context);
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

  // Replace the _getWebviewContent() method in your ChatPanel class with this fixed version:

  private _getWebviewContent() {
    // Get the SVG URI
    const iconPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "resources",
      "icon.png"
    );
    const iconUri = this._panel.webview.asWebviewUri(iconPath);
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
                <span style ="font-weight: 600;">Sidekick AI Chat</span>
            </span>
            <button class="code-action" onclick="clearChat()">Clear</button>
        </div>            
            <div class="messages-container" id="messages">
                <div class="welcome-message" id="welcome">
                    <h2>👋 Welcome to Sidekick AI</h2>
                    <p>Your local AI coding assistant</p>
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
            
            // Define handleKeyPress function
            function handleKeyPress(event) {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendCurrentMessage();
                }
            }
            
            // Add event listener for keypress
            inputField.addEventListener('keydown', handleKeyPress);
            
            function sendMessage(text) {
                if (!text || !text.trim()) return;
                
                // Hide welcome message
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
                // Hide welcome message
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
                
                // Simple parsing for code blocks - avoiding regex issues
                if (content.includes('\`\`\`')) {
                    // Split by code blocks
                    const parts = content.split('\`\`\`');
                    for (let i = 0; i < parts.length; i++) {
                        if (i % 2 === 0) {
                            // Regular text
                            if (parts[i]) {
                                const textSpan = document.createElement('span');
                                textSpan.innerHTML = parts[i].replace(/\\n/g, '<br>');
                                contentDiv.appendChild(textSpan);
                            }
                        } else {
                            // Code block
                            const codeContent = parts[i];
                            const lines = codeContent.split('\\n');
                            const language = lines[0];
                            const code = lines.slice(1).join('\\n');
                            
                            const pre = document.createElement('pre');
                            const codeElement = document.createElement('code');
                            codeElement.textContent = code || codeContent;
                            pre.appendChild(codeElement);
                            contentDiv.appendChild(pre);
                            
                            // Add code actions for assistant messages
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
                    // No code blocks, just regular text
                    const textSpan = document.createElement('span');
                    textSpan.innerHTML = content.replace(/\\n/g, '<br>');
                    contentDiv.appendChild(textSpan);
                }
                
                messageDiv.appendChild(avatar);
                messageDiv.appendChild(contentDiv);
                messagesContainer.appendChild(messageDiv);
                
                // Scroll to bottom
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

async function runSetupWizard(
  context: vscode.ExtensionContext,
  localAI: LocalAIProvider
) {
  // Step 1: Check for llama.cpp
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

  // Step 2: Model selection
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

  // Step 3: Test setup
  vscode.window.showInformationMessage(
    "✅ Setup complete! Initializing Sidekick AI..."
  );

  // Reinitialize with new settings
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

  // Check if first run
  const isFirstRun = context.globalState.get("sidekickai.firstRun", true);

  // Initialize privacy guard
  const privacyGuard = new PrivacyGuard();
  await privacyGuard.initialize();

  // Check for local model availability
  const localAI = new LocalAIProvider(context);

  // ADD THIS: Show welcome message for first-time users
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

  // ADD THIS: Initialize with error handling
  try {
    await localAI.initialize();
  } catch (error) {
    console.error("Failed to initialize LocalAI:", error);
    const result = await vscode.window.showErrorMessage(
      "Sidekick AI needs configuration to work. Would you like to set it up now?",
      "Setup Now",
      "Open Settings",
      "Later"
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

  const modelStatus = await localAI.checkModelStatus();

  if (!modelStatus.isReady) {
    const download = await vscode.window.showInformationMessage(
      "No local AI models found. Would you like to download them now? (Required for offline operation)",
      "Download Models",
      "Later"
    );

    if (download === "Download Models") {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Downloading AI Models",
          cancellable: true,
        },
        async (progress, token) => {
          await localAI.downloadModels(progress, token);
        }
      );
    }
  }

  // const inlineFixProvider = new InlineCodeFixProvider(localAI);
  // context.subscriptions.push(
  //   vscode.languages.registerCodeActionsProvider(
  //     { pattern: "**/*" },
  //     inlineFixProvider,
  //     {
  //       providedCodeActionKinds: InlineCodeFixProvider.providedCodeActionKinds,
  //     }
  //   )
  // );

  // Quick fix command - applies fix directly
//   context.subscriptions.push(
//     vscode.commands.registerCommand(
//       "sidekick-ai.quickFix",
//       async (
//         document: vscode.TextDocument,
//         diagnostic: vscode.Diagnostic,
//         range: vscode.Range
//       ) => {
//         const editor = vscode.window.activeTextEditor;
//         if (!editor || editor.document !== document) {
//           return;
//         }

//         // Use FULL file as context
//             const fullFileContent = document.getText();
//             const errorText = document.getText(diagnostic.range);
            
//             const prompt = `Fix this code error with full file context.
// Error: ${diagnostic.message}
// Error text: "${errorText}"
// File type: ${document.languageId}

// Full file:
// \`\`\`
// ${fullFileContent}
// \`\`\`

// Return ONLY the text that should replace "${errorText}":`;

//         try {
//           // Show progress in status bar
//           vscode.window.setStatusBarMessage(
//             "$(sync~spin) Analyzing with full context...",
//             3000
//           );

//           // Get AI fix
//           const fix = await localAI.chat(prompt, fullFileContent);

//           // Clean the response
//           let cleanedFix = fix
//             .replace(/```[a-z]*\n?/g, "")
//             .replace(/```$/g, "")
//             .replace(/^["']|["']$/g, '')
//             .trim();

//           if (!cleanedFix) {
//             vscode.window.showWarningMessage("Could not generate fix");
//             return;
//           }

//           // Apply the fix
//           await editor.edit((editBuilder) => {
//             editBuilder.replace(diagnostic.range, cleanedFix);
//           });

//           vscode.window.setStatusBarMessage("✅ Fix applied!", 2000);
//         } catch (error) {
//           vscode.window.showErrorMessage(`Failed to fix: ${error}`);
//         }
//       }
//     )
//   );

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
          const explanation = await localAI.chat(prompt, "");

          // Show in hover or information message
          vscode.window.showInformationMessage(explanation, { modal: true });
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to explain: ${error}`);
        }
      }
    )
  );

  // Create diagnostic collection for tracking errors
  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("sidekick-ai");

  // Register code action provider for all languages
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

  // Register the fix command
  const codeFixHandler = new CodeFixHandler(localAI, context);
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sidekick-ai.fixError",
      async (document: vscode.TextDocument, diagnostic: vscode.Diagnostic) => {
        await codeFixHandler.fixError(document, diagnostic);
      }
    )
  );

  // Initialize code indexer for context awareness
  const indexer = new CodeIndexer(context);
  await indexer.indexWorkspace();

  // Create chat panel reference for other commands to use
  let chatPanel: ChatPanel | undefined;

  // Simple command to open chat as a side panel
  const openChatCommand = vscode.commands.registerCommand(
    "sidekick-ai.openChat",
    () => {
      ChatPanel.createOrShow(context, localAI, indexer, privacyGuard);
      chatPanel = ChatPanel.currentPanel;
    }
  );

  context.subscriptions.push(openChatCommand);

  // Initialize code indexer for context awareness
  // const indexer = new CodeIndexer(context);
  // await indexer.indexWorkspace();

  // Register inline completion provider
  const inlineProvider = new InlineCompletionProvider(
    localAI,
    indexer,
    privacyGuard
  );
  const inlineDisposable =
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**/*" },
      inlineProvider
    );

  context.subscriptions.push({
    dispose: () => localAI.dispose(),
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("sidekick-ai.explain", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("Please open a file first");
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);

      if (!selectedText) {
        vscode.window.showInformationMessage("Please select code to explain");
        return;
      }

      // Check if AI is ready
      const modelStatus = await localAI.checkModelStatus();
      if (!modelStatus.isReady) {
        const result = await vscode.window.showErrorMessage(
          "Sidekick AI is not configured. Please set it up first.",
          "Setup Now",
          "Cancel"
        );
        if (result === "Setup Now") {
          await runSetupWizard(context, localAI);
        }
        return;
      }

      // Show loading indicator
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

      // Get explanation
      const explanation = await localAI.explainCode(
        selectedText,
        indexer.getContext()
      );

      // Clear loading
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
      hoverMessage.appendMarkdown(`
  <div style="padding: 10px; max-width: 600px;">
  
  ### 🤖 AI Explanation
  
  ${explanation}
  
  ---
  *💡 Tip: Select any code and use Ctrl+Shift+E for explanations*
  
  </div>
      `);

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

      // Auto-clear after 30 seconds
      setTimeout(() => {
        editor.setDecorations(explanationDecoration, []);
        explanationDecoration.dispose();
      }, 30000);

      // Show notification
      vscode.window
        .showInformationMessage(
          "AI explanation added inline. Hover to see full explanation.",
          "Clear"
        )
        .then((action) => {
          if (action === "Clear") {
            editor.setDecorations(explanationDecoration, []);
            explanationDecoration.dispose();
          } else if (action === "Open Chat") {
            ChatPanel.createOrShow(context, localAI, indexer, privacyGuard);
            chatPanel = ChatPanel.currentPanel;
            if (chatPanel) {
              chatPanel.addMessage("explain", selectedText, explanation);
            }
          }
        });

      // Still add to chat
      // chatProvider.addMessage("explain", selectedText, explanation);
    }),

    vscode.commands.registerCommand("sidekick-ai.refactor", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection);
      const instruction = await vscode.window.showInputBox({
        prompt: "How would you like to refactor this code?",
        // placeholder: 'e.g., Extract to function, Add error handling, Optimize performance'
      });

      if (!instruction) return;

      const refactored = await localAI.refactorCode(
        selection,
        instruction,
        indexer.getContext()
      );

      // Apply edit
      editor.edit((editBuilder) => {
        editBuilder.replace(editor.selection, refactored);
      });
    }),

    vscode.commands.registerCommand(
      "sidekick-ai.triggerCompletion",
      async () => {
        await vscode.commands.executeCommand(
          "editor.action.inlineSuggest.trigger"
        );
      }
    ),

    vscode.commands.registerCommand(
      "sidekick-ai.acceptedCompletion",
      (completion: string) => {
        console.log("User accepted completion:", completion);
        vscode.window.setStatusBarMessage("✅ AI suggestion accepted", 2000);

        // Track acceptance rate
        const acceptances = context.globalState.get(
          "completionAcceptances",
          0
        ) as number;
        context.globalState.update("completionAcceptances", acceptances + 1);
      }
    ),

    vscode.commands.registerCommand("sidekick-ai.generateTests", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const code = editor.document.getText();
      const tests = await localAI.generateTests(code, indexer.getContext());

      // Create new file with tests
      const testDoc = await vscode.workspace.openTextDocument({
        content: tests,
        language: editor.document.languageId,
      });
      await vscode.window.showTextDocument(testDoc);
    }),

    vscode.commands.registerCommand("sidekick-ai.privacyStatus", async () => {
      const report = privacyGuard.getPrivacyReport();
      const panel = vscode.window.createWebviewPanel(
        "privacyReport",
        "Privacy Status",
        vscode.ViewColumn.One,
        {}
      );

      panel.webview.html = getPrivacyReportHtml(report);
    }),

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

  // Add a Chat button to the status bar with custom icon
  const chatStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99 // Priority
  );

  // For SVG icons in status bar, you need to use it as a background image
  // VS Code doesn't directly support SVG in status bar text, so we use codicon or text
  chatStatusBarItem.text = "$(comment-discussion) AI Chat";
  chatStatusBarItem.tooltip = "Open Sidekick AI Chat";
  chatStatusBarItem.command = "sidekick-ai.openChat";
  chatStatusBarItem.show();

  context.subscriptions.push(chatStatusBarItem);

  // Alternative: Create a custom webview button that can use SVG
  const createFloatingButton = () => {
    const button = vscode.window.createWebviewPanel(
      "sidekickButton",
      "Sidekick Button",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true }
    );

    const iconPath = vscode.Uri.joinPath(
      context.extensionUri,
      "resources",
      "public",
      "your-icon.svg"
    );
    const iconUri = button.webview.asWebviewUri(iconPath);

    button.webview.html = `
      <!DOCTYPE html>
      <html>
      <body style="padding: 0; margin: 0;">
        <button onclick="openChat()" style="
          background: transparent;
          border: none;
          cursor: pointer;
          padding: 10px;
        ">
          <img src="${iconUri}" width="24" height="24" alt="Open Chat"/>
        </button>
        <script>
          const vscode = acquireVsCodeApi();
          function openChat() {
            vscode.postMessage({ command: 'openChat' });
          }
        </script>
      </body>
      </html>
    `;

    button.webview.onDidReceiveMessage(
      (message) => {
        if (message.command === "openChat") {
          vscode.commands.executeCommand("sidekick-ai.openChat");
        }
      },
      undefined,
      context.subscriptions
    );
  };

  // Add hover provider for automatic explanations
  const hoverProvider = vscode.languages.registerHoverProvider(
    { pattern: "**/*" },
    {
      async provideHover(document, position, token) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const selection = editor.selection;

        // Only show if hovering over selected text
        if (selection.isEmpty || !selection.contains(position)) {
          return;
        }

        const selectedText = document.getText(selection);

        // Get cached explanation or generate new one
        const explanation = await localAI.explainCode(
          selectedText,
          indexer.getContext()
        );

        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;
        markdown.supportHtml = true;
        markdown.appendMarkdown(`### 🤖 AI Explanation\n\n${explanation}`);

        return new vscode.Hover(markdown, selection);
      },
    }
  );

  context.subscriptions.push(hoverProvider);

  // Register status bar item
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = "$(shield) Privacy Mode: ON";
  statusBarItem.tooltip =
    "All AI processing happens locally. Click for privacy report.";
  statusBarItem.command = "sidekick-ai.privacyStatus";
  statusBarItem.show();

  context.subscriptions.push(inlineDisposable, statusBarItem);

  // Watch for workspace changes
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  watcher.onDidCreate((uri) => indexer.indexFile(uri));
  watcher.onDidChange((uri) => indexer.updateFile(uri));
  watcher.onDidDelete((uri) => indexer.removeFile(uri));

  context.subscriptions.push(watcher);

  // vscode.window.showInformationMessage(
  //   "Privacy-First Copilot: Ready (100% Local Processing)"
  // );
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
            <div class="metric">Local Inferences: ${
              report.localInferences
            }</div>
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
  console.log("Privacy-First Copilot deactivated");
}
