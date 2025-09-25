import * as vscode from 'vscode';
import { ModelService } from '../services/modelService';

export class EnhancedChatProvider {
    private modelService: ModelService;
    private panel: vscode.WebviewPanel | undefined;
    private messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    
    constructor(private context: vscode.ExtensionContext) {
        this.modelService = new ModelService(this.context);
        this.loadChatHistory();
    }
    
    public async show() {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;
            
        if (this.panel) {
            this.panel.reveal(column);
            return;
        }
        
        this.panel = vscode.window.createWebviewPanel(
            'sidekickChat',
            'Sidekick Pro Chat',
            column || vscode.ViewColumn.Two, // Show on the right side
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        
        this.panel.webview.html = this.getWebviewContent();
        
        // Send existing messages to webview
        this.messages.forEach(msg => {
            this.panel?.webview.postMessage({
                command: 'addMessage',
                text: msg.content,
                isUser: msg.role === 'user'
            });
        });
        
        // Send current provider status
        this.updateProviderStatus();
        
        this.panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'sendMessage':
                        await this.handleMessage(message.text);
                        break;
                    case 'switchModel':
                        await this.switchModel();
                        break;
                    case 'clearChat':
                        this.clearChat();
                        break;
                    case 'executeCommand':
                        await this.executeCommand(message.cmd, message.args);
                        break;
                }
            },
            undefined,
            this.context.subscriptions
        );
        
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.saveChatHistory();
        });
    }
    
    private async handleMessage(text: string) {
        if (!this.panel) return;
        
        // Add user message to history
        this.messages.push({ role: 'user', content: text });
        
        // Show typing indicator
        this.panel.webview.postMessage({ command: 'showTyping' });
        
        try {
            // Get editor context if available
            let editorContext = '';
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const selection = editor.selection;
                if (!selection.isEmpty) {
                    const selectedText = editor.document.getText(selection);
                    editorContext = `\nSelected code:\n\`\`\`${editor.document.languageId}\n${selectedText}\n\`\`\``;
                }
            }
            
            // Check for commands
            if (text.startsWith('/')) {
                await this.handleCommand(text, editorContext);
            } else {
                // Get repository context
                const repoContext = await this.modelService.getRepositoryContext(text);
                const fullContext = repoContext + editorContext;
                
                // Get AI response
                const response = await this.modelService.chat(text, fullContext);
                
                // Add to history and send to webview
                this.messages.push({ role: 'assistant', content: response });
                this.panel.webview.postMessage({
                    command: 'addMessage',
                    text: response,
                    isUser: false
                });
            }
        } catch (error: any) {
            const errorMsg = `Error: ${error.message || 'Something went wrong'}`;
            this.messages.push({ role: 'assistant', content: errorMsg });
            this.panel.webview.postMessage({
                command: 'addMessage',
                text: errorMsg,
                isUser: false
            });
        } finally {
            // Hide typing indicator
            this.panel.webview.postMessage({ command: 'hideTyping' });
            this.saveChatHistory();
        }
    }
    
    private async handleCommand(command: string, context: string) {
        const [cmd, ...args] = command.split(' ');
        const arg = args.join(' ');
        
        const editor = vscode.window.activeTextEditor;
        let response = '';
        
        switch (cmd) {
            case '/explain':
                if (editor && !editor.selection.isEmpty) {
                    const code = editor.document.getText(editor.selection);
                    const languageId = editor.document.languageId;
                    response = await this.modelService.explainCode(code, context, languageId);
                } else {
                    response = 'Please select some code first.';
                }
                break;
                
            case '/refactor':
                if (editor && !editor.selection.isEmpty) {
                    const code = editor.document.getText(editor.selection);
                    const refactored = await this.modelService.refactorCode(code, arg, context);
                    response = `Here's the refactored code:\n\n\`\`\`${editor.document.languageId}\n${refactored}\n\`\`\``;
                } else {
                    response = 'Please select code to refactor.';
                }
                break;
                
            case '/test':
                if (editor) {
                    const code = editor.selection.isEmpty ? 
                        editor.document.getText() : 
                        editor.document.getText(editor.selection);
                    const tests = await this.modelService.generateTests(code, context);
                    response = `Generated tests:\n\n\`\`\`${editor.document.languageId}\n${tests}\n\`\`\``;
                } else {
                    response = 'Please open a file first.';
                }
                break;
                
            case '/fix':
                if (editor) {
                    const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
                    if (diagnostics.length > 0) {
                        const error = diagnostics[0];
                        const errorCode = editor.document.getText(error.range);
                        const fullFile = editor.document.getText();
                        const fixed = await this.modelService.fixError(errorCode, error.message, fullFile);
                        response = `Fixed code:\n\n\`\`\`${editor.document.languageId}\n${fixed}\n\`\`\``;
                    } else {
                        response = 'No errors found in the current file.';
                    }
                } else {
                    response = 'Please open a file first.';
                }
                break;
                
            case '/help':
                response = `Available commands:
- **/explain** - Explain selected code
- **/refactor [instruction]** - Refactor selected code
- **/test** - Generate tests for selected code
- **/fix** - Fix errors in current file
- **/help** - Show this help message

You can also chat naturally about your code!`;
                break;
                
            default:
                response = `Unknown command: ${cmd}. Type /help for available commands.`;
        }
        
        this.messages.push({ role: 'assistant', content: response });
        this.panel?.webview.postMessage({
            command: 'addMessage',
            text: response,
            isUser: false
        });
    }
    
    private async switchModel() {
        const providers = ['OpenAI', 'Local (llama.cpp)'];
        const selected = await vscode.window.showQuickPick(providers, {
            placeHolder: 'Select AI provider'
        });
        
        if (selected) {
            const provider = selected.includes('OpenAI') ? 'openai' : 'local';
            
            // Update .env file
            const fs = require('fs');
            const path = require('path');
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            const envPath = workspaceFolder ? 
                path.join(workspaceFolder.uri.fsPath, '.env') :
                path.join(__dirname, '../..', '.env');
            
            if (fs.existsSync(envPath)) {
                let envContent = fs.readFileSync(envPath, 'utf8');
                const regex = /^DEFAULT_MODEL_PROVIDER=.*$/gm;
                if (regex.test(envContent)) {
                    envContent = envContent.replace(regex, `DEFAULT_MODEL_PROVIDER=${provider}`);
                } else {
                    envContent += `\nDEFAULT_MODEL_PROVIDER=${provider}`;
                }
                fs.writeFileSync(envPath, envContent);
            }
            
            vscode.window.showInformationMessage(
                `Switched to ${selected}. Reload window (Ctrl+R) to apply changes.`
            );
            
            this.updateProviderStatus();
        }
    }
    
    private async executeCommand(cmd: string, args: any) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        
        switch (cmd) {
            case 'insert':
                const position = editor.selection.active;
                await editor.edit(editBuilder => {
                    editBuilder.insert(position, args.code);
                });
                vscode.window.showInformationMessage('Code inserted!');
                break;
                
            case 'replace':
                await editor.edit(editBuilder => {
                    editBuilder.replace(editor.selection, args.code);
                });
                vscode.window.showInformationMessage('Code replaced!');
                break;
        }
    }
    
    private clearChat() {
        this.messages = [];
        this.saveChatHistory();
        this.panel?.webview.postMessage({ command: 'clearMessages' });
    }
    
    private updateProviderStatus() {
        const provider = this.modelService.getCurrentProvider();
        const isOpenAI = this.modelService.isOpenAIConfigured();
        
        this.panel?.webview.postMessage({
            command: 'updateStatus',
            provider: provider,
            configured: provider === 'openai' ? isOpenAI : true
        });
    }
    
    private saveChatHistory() {
        // Only save last 100 messages
        const toSave = this.messages.slice(-100);
        this.context.globalState.update('chatHistory', toSave);
    }
    
    private loadChatHistory() {
        const saved = this.context.globalState.get<typeof this.messages>('chatHistory');
        if (saved) {
            this.messages = saved;
        }
    }
    
    private getWebviewContent(): string {
        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { 
                    font-family: var(--vscode-font-family);
                    padding: 0;
                    margin: 0;
                    height: 100vh;
                    display: flex;
                    flex-direction: column;
                }
                
                #header {
                    padding: 10px 20px;
                    background: var(--vscode-titleBar-activeBackground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                
                #status {
                    font-size: 12px;
                    opacity: 0.8;
                    padding: 4px 8px;
                    background: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    border-radius: 4px;
                }
                
                #messages {
                    flex: 1;
                    overflow-y: auto;
                    padding: 20px;
                    display: flex;
                    flex-direction: column;
                    gap: 15px;
                }
                
                .message {
                    display: flex;
                    gap: 10px;
                    animation: fadeIn 0.3s;
                }
                
                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(10px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                
                .message.user {
                    flex-direction: row-reverse;
                }
                
                .message-content {
                    max-width: 70%;
                    padding: 10px 15px;
                    border-radius: 10px;
                    word-wrap: break-word;
                }
                
                .user .message-content {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                
                .assistant .message-content {
                    background: var(--vscode-editor-inactiveSelectionBackground);
                }
                
                pre {
                    background: var(--vscode-textBlockQuote-background);
                    border: 1px solid var(--vscode-textBlockQuote-border);
                    border-radius: 4px;
                    padding: 10px;
                    overflow-x: auto;
                    position: relative;
                }
                
                code {
                    font-family: var(--vscode-editor-font-family);
                }
                
                .code-actions {
                    position: absolute;
                    top: 5px;
                    right: 5px;
                    display: flex;
                    gap: 5px;
                }
                
                .code-action {
                    padding: 4px 8px;
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 11px;
                }
                
                .typing-indicator {
                    display: none;
                    padding: 10px 15px;
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    border-radius: 10px;
                    width: fit-content;
                }
                
                .typing-indicator.show {
                    display: block;
                }
                
                .typing-dot {
                    display: inline-block;
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: var(--vscode-foreground);
                    opacity: 0.4;
                    animation: typing 1.4s infinite;
                    margin: 0 2px;
                }
                
                .typing-dot:nth-child(2) { animation-delay: 0.2s; }
                .typing-dot:nth-child(3) { animation-delay: 0.4s; }
                
                @keyframes typing {
                    0%, 60%, 100% { opacity: 0.4; }
                    30% { opacity: 1; }
                }
                
                #input-area {
                    padding: 20px;
                    border-top: 1px solid var(--vscode-panel-border);
                    display: flex;
                    gap: 10px;
                }
                
                #input {
                    flex: 1;
                    padding: 10px;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px;
                    font-family: inherit;
                    resize: none;
                }
                
                button {
                    padding: 10px 20px;
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
            <div id="header">
                <h3 style="margin: 0;">Sidekick Pro Chat</h3>
                <div style="display: flex; gap: 10px; align-items: center;">
                    <span id="status">Checking...</span>
                    <button onclick="switchModel()">Switch Model</button>
                    <button onclick="clearChat()">Clear</button>
                </div>
            </div>
            
            <div id="messages"></div>
            
            <div class="typing-indicator" id="typing">
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
            </div>
            
            <div id="input-area">
                <textarea id="input" placeholder="Ask anything or type / for commands..." rows="1"></textarea>
                <button onclick="sendMessage()">Send</button>
            </div>
            
            <script>
                const vscode = acquireVsCodeApi();
                const messages = document.getElementById('messages');
                const input = document.getElementById('input');
                const typing = document.getElementById('typing');
                const status = document.getElementById('status');
                
                // Auto-resize textarea
                input.addEventListener('input', () => {
                    input.style.height = 'auto';
                    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
                });
                
                // Send on Enter
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                    }
                });
                
                function sendMessage() {
                    const text = input.value.trim();
                    if (!text) return;
                    
                    addMessage(text, true);
                    vscode.postMessage({ command: 'sendMessage', text });
                    input.value = '';
                    input.style.height = 'auto';
                }
                
                function addMessage(text, isUser) {
                    const div = document.createElement('div');
                    div.className = 'message ' + (isUser ? 'user' : 'assistant');
                    
                    const content = document.createElement('div');
                    content.className = 'message-content';
                    
                    // Parse markdown-like syntax
                    const html = parseMarkdown(text);
                    content.innerHTML = html;
                    
                    // Add code actions to code blocks
                    content.querySelectorAll('pre').forEach(pre => {
                        const actions = document.createElement('div');
                        actions.className = 'code-actions';
                        
                        const copyBtn = document.createElement('button');
                        copyBtn.className = 'code-action';
                        copyBtn.textContent = 'Copy';
                        copyBtn.onclick = () => {
                            const code = pre.querySelector('code').textContent;
                            navigator.clipboard.writeText(code);
                            copyBtn.textContent = 'Copied!';
                            setTimeout(() => copyBtn.textContent = 'Copy', 2000);
                        };
                        
                        const insertBtn = document.createElement('button');
                        insertBtn.className = 'code-action';
                        insertBtn.textContent = 'Insert';
                        insertBtn.onclick = () => {
                            const code = pre.querySelector('code').textContent;
                            vscode.postMessage({ command: 'executeCommand', cmd: 'insert', args: { code } });
                        };
                        
                        actions.appendChild(copyBtn);
                        if (!isUser) actions.appendChild(insertBtn);
                        pre.appendChild(actions);
                    });
                    
                    div.appendChild(content);
                    messages.appendChild(div);
                    messages.scrollTop = messages.scrollHeight;
                }
                
                function parseMarkdown(text) {
                    // Simple markdown parser
                    return text
                        .replace(/\`\`\`(\w+)?\\n([^\\x60]+)\`\`\`/g, '<pre><code class="language-$1">$2</code></pre>')
                        .replace(/\`([^\\x60]+)\`/g, '<code>$1</code>')
                        .replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>')
                        .replace(/\*([^\*]+)\*/g, '<em>$1</em>')
                        .replace(/\n/g, '<br>')
                        .replace(/•/g, '&bull;');
                }
                
                function switchModel() {
                    vscode.postMessage({ command: 'switchModel' });
                }
                
                function clearChat() {
                    if (confirm('Clear chat history?')) {
                        vscode.postMessage({ command: 'clearChat' });
                    }
                }
                
                // Handle messages from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.command) {
                        case 'addMessage':
                            addMessage(message.text, message.isUser);
                            break;
                        case 'clearMessages':
                            messages.innerHTML = '';
                            break;
                        case 'showTyping':
                            typing.classList.add('show');
                            messages.appendChild(typing);
                            messages.scrollTop = messages.scrollHeight;
                            break;
                        case 'hideTyping':
                            typing.classList.remove('show');
                            break;
                        case 'updateStatus':
                            if (message.provider === 'openai' && message.configured) {
                                status.textContent = 'OpenAI';
                                status.style.background = 'var(--vscode-testing-iconPassed)';
                            } else if (message.provider === 'local') {
                                status.textContent = 'Local AI';
                                status.style.background = 'var(--vscode-testing-iconQueued)';
                            } else {
                                status.textContent = 'Not configured';
                                status.style.background = 'var(--vscode-testing-iconFailed)';
                            }
                            break;
                    }
                });
            </script>
        </body>
        </html>`;
    }
}