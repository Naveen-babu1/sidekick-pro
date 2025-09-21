import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

export class ModelService {
    private config: any = {};
    private contextKeeperUrl!: string;
    
    constructor(private context: vscode.ExtensionContext) {
        this.loadEnvironment();
    }
    
    private loadEnvironment() {
        // Load .env from workspace root
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const envPath = path.join(workspaceFolder.uri.fsPath, '.env');
            if (fs.existsSync(envPath)) {
                const envConfig = dotenv.parse(fs.readFileSync(envPath));
                process.env = { ...process.env, ...envConfig };
            }
        }
        
        // Load from project root as fallback
        const projectEnvPath = path.join(__dirname, '../../..', '.env');
        if (fs.existsSync(projectEnvPath)) {
            dotenv.config({ path: projectEnvPath });
        }
        
        // Set config from environment or VS Code settings
        const settings = vscode.workspace.getConfiguration('sidekick-pro');
        
        this.config = {
            provider: process.env.DEFAULT_MODEL_PROVIDER || 
                     settings.get('model.provider', 'local'),
            openaiKey: process.env.OPENAI_API_KEY || 
                      settings.get('api.openaiKey', ''),
            anthropicKey: process.env.ANTHROPIC_API_KEY || 
                         settings.get('api.anthropicKey', ''),
            model: process.env.DEFAULT_MODEL_NAME || 
                  settings.get('model.name', 'gpt-3.5-turbo'),
            llamaEndpoint: `http://${process.env.LLAMA_CPP_HOST || 'localhost'}:${process.env.LLAMA_CPP_PORT || '8080'}`
        };
        
        this.contextKeeperUrl = process.env.CONTEXT_KEEPER_URL || 'http://localhost:8000';
    }
    
    async getCompletion(prompt: string, context?: string): Promise<string> {
        const enhancedPrompt = context ? 
            `Repository context:\n${context}\n\nQuery: ${prompt}` : prompt;
        
        switch (this.config.provider) {
            case 'openai':
                return this.getOpenAICompletion(enhancedPrompt);
            case 'anthropic':
                return this.getAnthropicCompletion(enhancedPrompt);
            case 'local':
                return this.getLocalCompletion(enhancedPrompt);
            default:
                return 'Model provider not configured';
        }
    }
    
    private async getOpenAICompletion(prompt: string): Promise<string> {
        if (!this.config.openaiKey) {
            const setupKey = await vscode.window.showWarningMessage(
                'OpenAI API key not found in .env file',
                'Add Key to .env',
                'Enter Key Now'
            );
            
            if (setupKey === 'Add Key to .env') {
                vscode.window.showInformationMessage(
                    'Add OPENAI_API_KEY=your-key to .env file in project root'
                );
                return '';
            } else if (setupKey === 'Enter Key Now') {
                const key = await vscode.window.showInputBox({
                    prompt: 'Enter OpenAI API key (will be saved to .env)',
                    password: true
                });
                if (key) {
                    await this.saveToEnvFile('OPENAI_API_KEY', key);
                    this.config.openaiKey = key;
                }
            }
            return '';
        }
        
        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.openaiKey}`
                },
                body: JSON.stringify({
                    model: this.config.model || 'gpt-3.5-turbo',
                    messages: [
                        {
                            role: 'system',
                            content: 'You are a helpful coding assistant with access to repository context.'
                        },
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    max_tokens: 500,
                    temperature: 0.7
                })
            });
            
            if (!response.ok) {
                const error = await response.json();
                const errorMessage = (error as any)?.error?.message || 'OpenAI API error';
                throw new Error(errorMessage);
            }
            
            const data = await response.json() as { choices: { message: { content: string } }[] };
            return data.choices[0].message.content;
        } catch (error: any) {
            console.error('OpenAI error:', error);
            return `Error: ${error.message}`;
        }
    }
    
    private async getAnthropicCompletion(prompt: string): Promise<string> {
        if (!this.config.anthropicKey) {
            vscode.window.showWarningMessage('Anthropic API key not found in .env file');
            return '';
        }
        
        try {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': this.config.anthropicKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-3-sonnet-20240229',
                    max_tokens: 500,
                    messages: [{
                        role: 'user',
                        content: prompt
                    }]
                })
            });
            
            const data = await response.json() as { content: { text: string }[] };
            return data.content[0].text;
        } catch (error: any) {
            return `Anthropic error: ${error.message}`;
        }
    }
    
    private async getLocalCompletion(prompt: string): Promise<string> {
        try {
            const response = await fetch(`${this.config.llamaEndpoint}/v1/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: prompt,
                    max_tokens: 500,
                    temperature: 0.7
                })
            });
            
            const data = await response.json() as { choices?: { text: string }[] };
            return data.choices?.[0]?.text || 'Local model not responding';
        } catch {
            return 'Local model not available. Start llama.cpp server.';
        }
    }
    
    private async saveToEnvFile(key: string, value: string) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;
        
        const envPath = path.join(workspaceFolder.uri.fsPath, '.env');
        let envContent = '';
        
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf8');
        }
        
        // Update or add the key
        const regex = new RegExp(`^${key}=.*$`, 'gm');
        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
            envContent += `\n${key}=${value}`;
        }
        
        fs.writeFileSync(envPath, envContent);
    }
    
    async getRepositoryContext(query: string): Promise<string> {
        try {
            const response = await fetch(`${this.contextKeeperUrl}/api/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, limit: 3 })
            });
            
            if (response.ok) {
                const data = await response.json() as { sources?: { timestamp: string; message: string; author: string }[] };
                if (data.sources && data.sources.length > 0) {
                    return data.sources.map((s: any) => 
                        `[${s.timestamp}] ${s.message} - ${s.author}`
                    ).join('\n');
                }
            }
        } catch (error) {
            console.error('Context Keeper error:', error);
        }
        return '';
    }
}
