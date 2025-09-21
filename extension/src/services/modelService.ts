// src/services/ModelService.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { LocalAIProvider } from '../providers/LocalAIProvider';

export class ModelService {
    private config: any = {};
    private localAI: LocalAIProvider;
    private contextKeeperUrl: string = '';
    
    constructor(private context: vscode.ExtensionContext) {
        this.loadEnvironment();
        this.localAI = new LocalAIProvider(context);
    }
    
    private loadEnvironment() {
        // Load .env from workspace or project root
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const envPaths = [
            workspaceFolder ? path.join(workspaceFolder.uri.fsPath, '.env') : null,
            path.join(__dirname, '../../..', '.env'),
            path.join(__dirname, '../..', '.env')
        ].filter(Boolean);
        
        for (const envPath of envPaths) {
            if (envPath && fs.existsSync(envPath)) {
                const envConfig = dotenv.parse(fs.readFileSync(envPath));
                Object.assign(process.env, envConfig);
                break;
            }
        }
        
        this.config = {
            provider: process.env.DEFAULT_MODEL_PROVIDER || 'openai',
            openaiKey: process.env.OPENAI_API_KEY || '',
            model: process.env.DEFAULT_MODEL_NAME || 'gpt-3.5-turbo',
            codeModel: process.env.CODE_MODEL_NAME || 'gpt-3.5-turbo',
            temperature: parseFloat(process.env.MODEL_TEMPERATURE || '0.7')
        };
        
        this.contextKeeperUrl = process.env.CONTEXT_KEEPER_URL || 'http://localhost:8000';
    }
    
    // Main chat method
    async chat(message: string, context: string): Promise<string> {
        if (this.shouldUseOpenAI()) {
            return this.chatWithOpenAI(message, context);
        }
        return this.localAI.chat(message, context);
    }
    
    // Code completion
    async generateCompletion(prompt: string, context: string, maxTokens: number = 150): Promise<string> {
        if (this.shouldUseOpenAI()) {
            return this.getOpenAICodeCompletion(prompt, maxTokens);
        }
        return this.localAI.generateCompletion(prompt, context, maxTokens);
    }
    
    // Explain code
    async explainCode(code: string, context: string): Promise<string> {
        if (this.shouldUseOpenAI()) {
            const prompt = `Explain this code in simple terms:\n\n${code}`;
            return this.chatWithOpenAI(prompt, context);
        }
        return this.localAI.explainCode(code, context);
    }
    
    // Refactor code
    async refactorCode(code: string, instruction: string, context: string): Promise<string> {
        if (this.shouldUseOpenAI()) {
            const prompt = `Refactor this code${instruction ? ` to ${instruction}` : ''}:\n\n${code}\n\nReturn only the refactored code:`;
            const response = await this.chatWithOpenAI(prompt, context);
            return this.cleanCodeResponse(response);
        }
        return this.localAI.refactorCode(code, instruction, context);
    }
    
    // Generate tests
    async generateTests(code: string, context: string): Promise<string> {
        if (this.shouldUseOpenAI()) {
            const prompt = `Generate comprehensive unit tests for this code:\n\n${code}\n\nProvide complete test code:`;
            const response = await this.chatWithOpenAI(prompt, context);
            return this.cleanCodeResponse(response);
        }
        return this.localAI.generateTests(code, context);
    }
    
    // Fix errors
    async fixError(code: string, error: string, fullContext: string): Promise<string> {
        const prompt = `Fix this error in the code:\n\nError: ${error}\n\nCode:\n${code}\n\nFull context:\n${fullContext}\n\nReturn only the fixed code:`;
        
        if (this.shouldUseOpenAI()) {
            const response = await this.chatWithOpenAI(prompt, '');
            return this.cleanCodeResponse(response);
        }
        
        const response = await this.localAI.chat(prompt, fullContext);
        return this.cleanCodeResponse(response);
    }
    
    private shouldUseOpenAI(): boolean {
        return this.config.provider === 'openai' && 
               this.config.openaiKey && 
               this.config.openaiKey !== 'your-openai-key-here';
    }
    
    private async chatWithOpenAI(prompt: string, context: string): Promise<string> {
        try {
            const messages = [
                {
                    role: 'system',
                    content: 'You are a helpful AI coding assistant.'
                }
            ];
            
            if (context) {
                messages.push({
                    role: 'system',
                    content: `Context: ${context}`
                });
            }
            
            messages.push({
                role: 'user',
                content: prompt
            });
            
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.openaiKey}`
                },
                body: JSON.stringify({
                    model: this.config.model,
                    messages,
                    max_tokens: 1000,
                    temperature: this.config.temperature
                })
            });
            
            if (!response.ok) {
                const error = await response.json();
                if (error instanceof Error) {
                    throw new Error((error as any)?.error?.message || 'OpenAI API error');
                }
                throw new Error('OpenAI API error');
            }
            
            const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
            return data.choices?.[0]?.message?.content || '';
        } catch (error) {
            console.error('OpenAI error:', error);
            // Fallback to local AI
            return this.localAI.chat(prompt, context);
        }
    }
    
    private async getOpenAICodeCompletion(prompt: string, maxTokens: number): Promise<string> {
        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.openaiKey}`
                },
                body: JSON.stringify({
                    model: this.config.codeModel,
                    messages: [
                        {
                            role: 'system',
                            content: 'You are a code completion assistant. Provide only the code to complete, no explanations or markdown.'
                        },
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    max_tokens: maxTokens,
                    temperature: 0.2,
                    stop: ['\n\n', '```']
                })
            });
            
            const data = await response.json() as { choices?: { message?: { content?: string } }[] };
            return data.choices?.[0]?.message?.content?.trim() || '';
        } catch (error) {
            console.error('OpenAI completion error:', error);
            return '';
        }
    }
    
    private cleanCodeResponse(response: string): string {
        // Remove markdown code blocks
        return response
            .replace(/^```[\w]*\n?/gm, '')
            .replace(/\n?```$/gm, '')
            .trim();
    }
    
    async getRepositoryContext(query: string): Promise<string> {
        try {
            const response = await fetch(`${this.contextKeeperUrl}/api/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, limit: 3 })
            });
            
            if (response.ok) {
                const data = await response.json() as { sources?: { timestamp: string, message: string, author: string }[] };
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
    
    getCurrentProvider(): string {
        return this.config.provider;
    }
    
    isOpenAIConfigured(): boolean {
        return this.shouldUseOpenAI();
    }
    
    async ensureInitialized(): Promise<void> {
        if (this.config.provider === 'local') {
            await this.localAI.ensureServerRunning();
        }
    }
}