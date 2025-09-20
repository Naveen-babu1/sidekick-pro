// providers/ChatViewProvider.ts
import * as vscode from 'vscode';
import { LocalAIProvider } from './LocalAIProvider';
import { CodeIndexer } from '../indexer/CodeIndexer';
import { PrivacyGuard } from '../security/PrivacyGuard';

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'sidekick-ai.chatView';
    private _view?: vscode.WebviewView;
    private messages: ChatMessage[] = [];
    
    constructor(
        private readonly _extensionUri: vscode.Uri,
        private context: vscode.ExtensionContext,
        private localAI: LocalAIProvider,
        private indexer: CodeIndexer,
        private privacyGuard: PrivacyGuard
    ) {
        // Load chat history from storage
        this.loadChatHistory();
    }
    
    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        
        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'sendMessage':
                    await this.handleUserMessage(data.message);
                    break;
                case 'clearChat':
                    this.clearChat();
                    break;
                case 'executeCommand':
                    await this.executeCommand(data.command, data.code);
                    break;
                case 'insertCode':
                    this.insertCodeAtCursor(data.code);
                    break;
                case 'copyCode':
                    await vscode.env.clipboard.writeText(data.code);
                    vscode.window.showInformationMessage('Code copied to clipboard!');
                    break;
            }
        });
        
        // Send existing messages to webview
        this.messages.forEach(msg => {
            this._view?.webview.postMessage({
                type: 'addMessage',
                message: msg
            });
        });
    }
    
    private async handleUserMessage(message: string) {
        // Add user message
        const userMessage: ChatMessage = {
            role: 'user',
            content: message,
            timestamp: new Date()
        };
        this.messages.push(userMessage);
        this.saveChatHistory();
        
        // Send user message to webview
        this._view?.webview.postMessage({
            type: 'addMessage',
            message: userMessage
        });
        
        // Show typing indicator
        this._view?.webview.postMessage({
            type: 'setTyping',
            isTyping: true
        });
        
        try {
            // Get current editor context
            const editor = vscode.window.activeTextEditor;
            let context = '';
            
            if (editor) {
                const selection = editor.selection;
                if (!selection.isEmpty) {
                    context = `Selected code:\n\`\`\`${editor.document.languageId}\n${editor.document.getText(selection)}\n\`\`\`\n\n`;
                } else {
                    // Get current function or class context
                    const position = editor.selection.active;
                    const document = editor.document;
                    const startLine = Math.max(0, position.line - 10);
                    const endLine = Math.min(document.lineCount - 1, position.line + 10);
                    const surroundingCode = document.getText(new vscode.Range(startLine, 0, endLine, Number.MAX_VALUE));
                    context = `Current context:\n\`\`\`${editor.document.languageId}\n${surroundingCode}\n\`\`\`\n\n`;
                }
            }
            
            // Get project context from indexer
            const projectContext = this.indexer.getContext();
            
            // Process message with AI
            const fullContext = `${projectContext}\n\n${context}`;
            
            // Check if message is a command
            if (message.startsWith('/')) {
                await this.handleCommand(message, fullContext);
            } else {
                // Regular chat message
                const response = await this.localAI.explainCode(message, fullContext);
                
                // Add assistant message
                const assistantMessage: ChatMessage = {
                    role: 'assistant',
                    content: response,
                    timestamp: new Date()
                };
                this.messages.push(assistantMessage);
                this.saveChatHistory();
                
                // Send assistant message to webview
                this._view?.webview.postMessage({
                    type: 'addMessage',
                    message: assistantMessage
                });
            }
        } catch (error) {
            const errorMessage: ChatMessage = {
                role: 'assistant',
                content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
                timestamp: new Date()
            };
            this.messages.push(errorMessage);
            this._view?.webview.postMessage({
                type: 'addMessage',
                message: errorMessage
            });
        } finally {
            // Hide typing indicator
            this._view?.webview.postMessage({
                type: 'setTyping',
                isTyping: false
            });
        }
    }
    
    private async handleCommand(command: string, context: string) {
        const [cmd, ...args] = command.split(' ');
        const arg = args.join(' ');
        
        let response = '';
        let code = '';
        
        switch (cmd) {
            case '/explain':
                const editor = vscode.window.activeTextEditor;
                if (editor && !editor.selection.isEmpty) {
                    const selectedCode = editor.document.getText(editor.selection);
                    response = await this.localAI.explainCode(selectedCode, context);
                } else {
                    response = 'Please select some code to explain.';
                }
                break;
                
            case '/refactor':
                if (editor && !editor.selection.isEmpty) {
                    const selectedCode = editor.document.getText(editor.selection);
                    code = await this.localAI.refactorCode(selectedCode, arg || 'improve this code', context);
                    response = `Here's the refactored code:\n\n\`\`\`javascript\n${code}\n\`\`\``;
                } else {
                    response = 'Please select some code to refactor.';
                }
                break;
                
            case '/test':
                if (editor && !editor.selection.isEmpty) {
                    const selectedCode = editor.document.getText(editor.selection);
                    code = await this.localAI.generateTests(selectedCode, context);
                    response = `Here are the tests:\n\n\`\`\`javascript\n${code}\n\`\`\``;
                } else {
                    response = 'Please select a function to generate tests.';
                }
                break;
                
            case '/fix':
                if (editor) {
                    const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
                    if (diagnostics.length > 0) {
                        const error = diagnostics[0];
                        const errorLine = editor.document.lineAt(error.range.start.line).text;
                        code = await this.localAI.refactorCode(errorLine, `fix this error: ${error.message}`, context);
                        response = `Here's the fix:\n\n\`\`\`javascript\n${code}\n\`\`\``;
                    } else {
                        response = 'No errors found in the current file.';
                    }
                }
                break;
                
            case '/help':
                response = `Available commands:
- **/explain** - Explain selected code
- **/refactor [instruction]** - Refactor selected code
- **/test** - Generate tests for selected function
- **/fix** - Fix errors in current file
- **/help** - Show this help message

You can also ask questions directly without commands!`;
                break;
                
            default:
                response = `Unknown command: ${cmd}. Type /help for available commands.`;
        }
        
        // Add assistant message
        const assistantMessage: ChatMessage = {
            role: 'assistant',
            content: response,
            timestamp: new Date()
        };
        this.messages.push(assistantMessage);
        this.saveChatHistory();
        
        // Send assistant message to webview
        this._view?.webview.postMessage({
            type: 'addMessage',
            message: assistantMessage
        });
    }
    
    private async executeCommand(command: string, code: string) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        
        switch (command) {
            case 'replace':
                // Replace selected text with generated code
                const selection = editor.selection;
                await editor.edit(editBuilder => {
                    editBuilder.replace(selection, code);
                });
                break;
                
            case 'insert':
                // Insert code at cursor position
                const position = editor.selection.active;
                await editor.edit(editBuilder => {
                    editBuilder.insert(position, code);
                });
                break;
        }
    }
    
    private insertCodeAtCursor(code: string) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        
        const position = editor.selection.active;
        editor.edit(editBuilder => {
            editBuilder.insert(position, code);
        });
    }
    
    private clearChat() {
        this.messages = [];
        this.saveChatHistory();
        this._view?.webview.postMessage({
            type: 'clearMessages'
        });
    }
    
    private loadChatHistory() {
        const history = this.context.globalState.get<ChatMessage[]>('chatHistory', []);
        this.messages = history.map(msg => ({
            ...msg,
            timestamp: new Date(msg.timestamp)
        }));
    }
    
    private saveChatHistory() {
        // Only keep last 100 messages
        const toSave = this.messages.slice(-100);
        this.context.globalState.update('chatHistory', toSave);
    }
    
    public addMessage(type: string, input: string, response: string) {
        // For compatibility with existing code
        const userMessage: ChatMessage = {
            role: 'user',
            content: input,
            timestamp: new Date()
        };
        const assistantMessage: ChatMessage = {
            role: 'assistant',
            content: response,
            timestamp: new Date()
        };
        
        this.messages.push(userMessage, assistantMessage);
        this.saveChatHistory();
        
        if (this._view) {
            this._view.webview.postMessage({
                type: 'addMessage',
                message: userMessage
            });
            this._view.webview.postMessage({
                type: 'addMessage',
                message: assistantMessage
            });
        }
    }
    
    private _getHtmlForWebview(webview: vscode.Webview) {
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.js'));
        
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Sidekick AI Chat</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                    margin: 0;
                    padding: 0;
                    height: 100vh;
                    display: flex;
                    flex-direction: column;
                }
                
                .chat-container {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                    overflow: hidden;
                }
                
                .chat-header {
                    padding: 12px 16px;
                    border-bottom: 1px solid var(--vscode-widget-border);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    background: var(--vscode-editor-background);
                }
                
                .chat-title {
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                
                .status-indicator {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: #4caf50;
                }
                
                .chat-actions {
                    display: flex;
                    gap: 8px;
                }
                
                .icon-button {
                    background: none;
                    border: none;
                    color: var(--vscode-foreground);
                    cursor: pointer;
                    padding: 4px;
                    border-radius: 4px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                
                .icon-button:hover {
                    background: var(--vscode-toolbar-hoverBackground);
                }
                
                .messages-container {
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
                    animation: slideIn 0.3s ease-out;
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
                
                .message-avatar {
                    width: 28px;
                    height: 28px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 12px;
                    flex-shrink: 0;
                }
                
                .user-avatar {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                
                .assistant-avatar {
                    background: var(--vscode-editorWidget-background);
                    border: 1px solid var(--vscode-widget-border);
                }
                
                .message-content {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                
                .message-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 12px;
                    opacity: 0.7;
                }
                
                .message-text {
                    line-height: 1.5;
                    word-wrap: break-word;
                }
                
                .message-text pre {
                    background: var(--vscode-textCodeBlock-background);
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 4px;
                    padding: 12px;
                    overflow-x: auto;
                    position: relative;
                    margin: 8px 0;
                }
                
                .message-text code {
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                }
                
                .code-actions {
                    position: absolute;
                    top: 8px;
                    right: 8px;
                    display: flex;
                    gap: 4px;
                    opacity: 0;
                    transition: opacity 0.2s;
                }
                
                pre:hover .code-actions {
                    opacity: 1;
                }
                
                .code-action {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 4px 8px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 11px;
                }
                
                .code-action:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                
                .typing-indicator {
                    display: none;
                    align-items: center;
                    gap: 4px;
                    padding: 8px 12px;
                }
                
                .typing-indicator.active {
                    display: flex;
                }
                
                .typing-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: var(--vscode-foreground);
                    opacity: 0.3;
                    animation: typing 1.4s infinite;
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
                    }
                    30% {
                        opacity: 1;
                    }
                }
                
                .input-container {
                    padding: 16px;
                    border-top: 1px solid var(--vscode-widget-border);
                    background: var(--vscode-editor-background);
                }
                
                .input-wrapper {
                    display: flex;
                    gap: 8px;
                    align-items: flex-end;
                }
                
                .input-field {
                    flex: 1;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px;
                    padding: 8px 12px;
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    resize: none;
                    min-height: 36px;
                    max-height: 120px;
                    overflow-y: auto;
                }
                
                .input-field:focus {
                    outline: none;
                    border-color: var(--vscode-focusBorder);
                }
                
                .send-button {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    border-radius: 4px;
                    padding: 8px 16px;
                    cursor: pointer;
                    font-weight: 500;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }
                
                .send-button:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                
                .send-button:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                
                .commands-hint {
                    font-size: 11px;
                    opacity: 0.7;
                    margin-top: 8px;
                }
                
                .welcome-message {
                    text-align: center;
                    padding: 32px;
                    opacity: 0.7;
                }
                
                .welcome-title {
                    font-size: 18px;
                    font-weight: 600;
                    margin-bottom: 16px;
                }
                
                .quick-actions {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                    justify-content: center;
                    margin-top: 24px;
                }
                
                .quick-action {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: 1px solid var(--vscode-button-border);
                    padding: 8px 16px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                }
                
                .quick-action:hover {
                    background: var(--vscode-button-secondaryHoverBackground);
                }
            </style>
        </head>
        <body>
            <div class="chat-container">
                <div class="chat-header">
                    <div class="chat-title">
                        <span class="status-indicator"></span>
                        <span>Sidekick AI</span>
                    </div>
                    <div class="chat-actions">
                        <button class="icon-button" onclick="clearChat()" title="Clear chat">
                            🗑️
                        </button>
                    </div>
                </div>
                
                <div class="messages-container" id="messages">
                    <div class="welcome-message" id="welcome">
                        <div class="welcome-title">👋 Welcome to Sidekick AI</div>
                        <p>I'm your local AI assistant. I can help you with:</p>
                        <div class="quick-actions">
                            <button class="quick-action" onclick="sendMessage('/help')">View Commands</button>
                            <button class="quick-action" onclick="sendMessage('/explain')">Explain Code</button>
                            <button class="quick-action" onclick="sendMessage('/refactor')">Refactor Code</button>
                            <button class="quick-action" onclick="sendMessage('/test')">Generate Tests</button>
                        </div>
                    </div>
                </div>
                
                <div class="typing-indicator" id="typing">
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                </div>
                
                <div class="input-container">
                    <div class="input-wrapper">
                        <textarea 
                            class="input-field" 
                            id="messageInput" 
                            placeholder="Ask me anything or type / for commands..."
                            rows="1"
                        ></textarea>
                        <button class="send-button" id="sendButton" onclick="sendCurrentMessage()">
                            Send ➤
                        </button>
                    </div>
                    <div class="commands-hint">
                        Type <strong>/</strong> to see available commands
                    </div>
                </div>
            </div>
            
            <script>
                const vscode = acquireVsCodeApi();
                const messagesContainer = document.getElementById('messages');
                const messageInput = document.getElementById('messageInput');
                const sendButton = document.getElementById('sendButton');
                const typingIndicator = document.getElementById('typing');
                const welcomeMessage = document.getElementById('welcome');
                
                // Auto-resize textarea
                messageInput.addEventListener('input', () => {
                    messageInput.style.height = 'auto';
                    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
                });
                
                // Send on Enter (Shift+Enter for new line)
                messageInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendCurrentMessage();
                    }
                });
                
                function sendCurrentMessage() {
                    const message = messageInput.value.trim();
                    if (!message) return;
                    
                    sendMessage(message);
                    messageInput.value = '';
                    messageInput.style.height = 'auto';
                }
                
                function sendMessage(message) {
                    vscode.postMessage({
                        type: 'sendMessage',
                        message: message
                    });
                }
                
                function clearChat() {
                    if (confirm('Clear all chat history?')) {
                        vscode.postMessage({
                            type: 'clearChat'
                        });
                    }
                }
                
                function copyCode(button) {
                    const pre = button.closest('pre');
                    const code = pre.querySelector('code').textContent;
                    vscode.postMessage({
                        type: 'copyCode',
                        code: code
                    });
                    
                    // Visual feedback
                    const originalText = button.textContent;
                    button.textContent = 'Copied!';
                    setTimeout(() => {
                        button.textContent = originalText;
                    }, 2000);
                }
                
                function insertCode(button) {
                    const pre = button.closest('pre');
                    const code = pre.querySelector('code').textContent;
                    vscode.postMessage({
                        type: 'insertCode',
                        code: code
                    });
                }
                
                function formatMessage(content) {
                    // Convert markdown code blocks to HTML
                    content = content.replace(/\`\`\`(\w+)?\n([\s\S]*?)\`\`\`/g, (match, lang, code) => {
                        return \`<pre><code class="language-\${lang || 'plaintext'}">\${escapeHtml(code.trim())}</code><div class="code-actions"><button class="code-action" onclick="copyCode(this)">Copy</button><button class="code-action" onclick="insertCode(this)">Insert</button></div></pre>\`;
                    });
                    
                    // Convert inline code
                    content = content.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
                    
                    // Convert bold
                    content = content.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');
                    
                    // Convert italic
                    content = content.replace(/\*([^\*]+)\*/g, '<em>$1</em>');
                    
                    // Convert line breaks
                    content = content.replace(/\n/g, '<br>');
                    
                    return content;
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
                
                function addMessage(message) {
                    // Hide welcome message
                    if (welcomeMessage) {
                        welcomeMessage.style.display = 'none';
                    }
                    
                    const messageEl = document.createElement('div');
                    messageEl.className = 'message';
                    
                    const time = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    
                    messageEl.innerHTML = \`
                        <div class="message-avatar \${message.role}-avatar">
                            \${message.role === 'user' ? 'U' : 'AI'}
                        </div>
                        <div class="message-content">
                            <div class="message-header">
                                <span>\${message.role === 'user' ? 'You' : 'Sidekick AI'}</span>
                                <span>\${time}</span>
                            </div>
                            <div class="message-text">
                                \${formatMessage(message.content)}
                            </div>
                        </div>
                    \`;
                    
                    messagesContainer.appendChild(messageEl);
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                }
                
                // Handle messages from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    
                    switch (message.type) {
                        case 'addMessage':
                            addMessage(message.message);
                            break;
                        case 'clearMessages':
                            messagesContainer.innerHTML = '';
                            if (welcomeMessage) {
                                messagesContainer.appendChild(welcomeMessage);
                                welcomeMessage.style.display = 'block';
                            }
                            break;
                        case 'setTyping':
                            typingIndicator.classList.toggle('active', message.isTyping);
                            if (message.isTyping) {
                                messagesContainer.scrollTop = messagesContainer.scrollHeight;
                            }
                            break;
                    }
                });
            </script>
        </body>
        </html>`;
    }
}