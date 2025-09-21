import * as vscode from 'vscode';
import { ModelService } from '../services/modelService';

export class EnhancedChatProvider {
    private modelService: ModelService;
    private env: any;
    private panel: vscode.WebviewPanel | undefined;
    
    constructor(private context: vscode.ExtensionContext, env?: any) {
        this.modelService = new ModelService(this.context);
        this.env = env || {};
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
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        
        this.panel.webview.html = this.getWebviewContent();
        
        this.panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'sendMessage':
                        await this.handleMessage(message.text);
                        break;
                    case 'switchModel':
                        await this.switchModel();
                        break;
                }
            },
            undefined,
            this.context.subscriptions
        );
        
        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }
    
    private async handleMessage(text: string) {
        if (!this.panel) return;
        
        // Get repository context
        const context = await this.modelService.getRepositoryContext(text);
        
        // Get AI response with context
        const response = await this.modelService.getCompletion(text, context);
        
        // Send response back to webview
        this.panel.webview.postMessage({
            command: 'addMessage',
            text: response,
            isUser: false
        });
    }
    
    private async switchModel() {
        const models = ['openai', 'local'];
        const selected = await vscode.window.showQuickPick(models, {
            placeHolder: 'Select model provider'
        });
        
        if (selected) {
            const config = vscode.workspace.getConfiguration('sidekick-pro');
            await config.update('model.provider', selected, true);
            
            if (selected === 'openai') {
                const currentKey = config.get('api.openaiKey', '');
                if (!currentKey) {
                    const key = await vscode.window.showInputBox({
                        prompt: 'Enter OpenAI API key',
                        password: true,
                        placeHolder: 'sk-...'
                    });
                    if (key) {
                        await config.update('api.openaiKey', key, true);
                    }
                }
            }
            
            vscode.window.showInformationMessage(`Switched to ${selected}`);
        }
    }
    
    private getWebviewContent(): string {
        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { 
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    height: 100vh;
                    display: flex;
                    flex-direction: column;
                }
                #messages {
                    flex: 1;
                    overflow-y: auto;
                    margin-bottom: 20px;
                    border: 1px solid var(--vscode-panel-border);
                    padding: 10px;
                }
                .message {
                    margin: 10px 0;
                    padding: 10px;
                    border-radius: 5px;
                }
                .user { background: var(--vscode-editor-selectionBackground); }
                .assistant { background: var(--vscode-editor-inactiveSelectionBackground); }
                #input-area {
                    display: flex;
                    gap: 10px;
                }
                #input {
                    flex: 1;
                    padding: 10px;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                }
                button {
                    padding: 10px 20px;
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    cursor: pointer;
                }
                #model-info {
                    padding: 5px;
                    text-align: right;
                    font-size: 0.9em;
                    opacity: 0.7;
                }
            </style>
        </head>
        <body>
            <div id="model-info">
                <button onclick="switchModel()">Switch Model</button>
            </div>
            <div id="messages"></div>
            <div id="input-area">
                <input type="text" id="input" placeholder="Ask anything...">
                <button onclick="sendMessage()">Send</button>
            </div>
            
            <script>
                const vscode = acquireVsCodeApi();
                const messages = document.getElementById('messages');
                const input = document.getElementById('input');
                
                function sendMessage() {
                    const text = input.value.trim();
                    if (!text) return;
                    
                    addMessage(text, true);
                    vscode.postMessage({ command: 'sendMessage', text });
                    input.value = '';
                }
                
                function addMessage(text, isUser) {
                    const div = document.createElement('div');
                    div.className = 'message ' + (isUser ? 'user' : 'assistant');
                    div.textContent = text;
                    messages.appendChild(div);
                    messages.scrollTop = messages.scrollHeight;
                }
                
                function switchModel() {
                    vscode.postMessage({ command: 'switchModel' });
                }
                
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') sendMessage();
                });
                
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'addMessage') {
                        addMessage(message.text, message.isUser);
                    }
                });
            </script>
        </body>
        </html>`;
    }
}
