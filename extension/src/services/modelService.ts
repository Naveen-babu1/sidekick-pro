// src/services/ModelService.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { LocalAIProvider } from '../providers/LocalAIProvider';

export class ModelService {
    private config: any = {};
    private localAI: LocalAIProvider | null = null;
    private contextKeeperUrl: string = '';
    private currentProvider: 'openai' | 'local' = 'local';
    
    constructor(private context: vscode.ExtensionContext) {
        this.context = context;
        this.loadEnvironment();
        // this.loadConfiguration();
        
        // Only initialize LocalAI if not using OpenAI
        // if (!this.isOpenAIConfigured()) {
        //     this.localAI = new LocalAIProvider(context);
        // }
    }
    
    private loadEnvironment() {
        // Load .env from workspace or project root
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const envPaths = [
            path.join(__dirname, '..', '..', '.env'),  // Check project root first
            path.join(__dirname, '..', '..', '..', '.env'),  // One more level up
            'd:/projects/sidekick-pro/.env',  // Direct path
            workspaceFolder ? path.join(workspaceFolder.uri.fsPath, '.env') : null,
            path.join(process.cwd(), '.env')
        ].filter(p => p !== null);
        
        for (const envPath of envPaths) {
            if (envPath && fs.existsSync(envPath)) {
                const envConfig = dotenv.parse(fs.readFileSync(envPath));
                Object.assign(process.env, envConfig);
                console.log(`Loaded .env from: ${envPath}`);
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
        console.log(`Model provider: ${this.config.provider}`);
        console.log(`OpenAI configured: ${this.isOpenAIConfigured()}`);
        // this.contextKeeperUrl = process.env.CONTEXT_KEEPER_URL || 'http://localhost:8000';
    }

    isOpenAIConfigured(): boolean {
        return this.config.provider === 'openai' && 
               this.config.openaiKey && 
               this.config.openaiKey !== 'your-openai-api-key-here' &&
               this.config.openaiKey.startsWith('sk-');
    }

    // Removed duplicate implementation of isOpenAIConfigured
    
    // Main chat method - add optional languageId
    async chat(message: string, context: string): Promise<string> {
        if (this.isOpenAIConfigured()) {
            return await this.chatWithOpenAI(message, context);
        } else {
            if (!this.localAI) {
                this.localAI = new LocalAIProvider(this.context);
                await this.localAI.initialize();
            }
            return await this.localAI.chat(message, context);
        }
    }
    
    // Code completion
    async generateCompletion(prompt: string, context: string, maxTokens: number = 150, languageId?: string): Promise<string> {
        if (this.isOpenAIConfigured()) {
            return await this.getOpenAICodeCompletion(prompt, maxTokens);
        } else {
            if (!this.localAI) {
                this.localAI = new LocalAIProvider(this.context);
                await this.localAI.initialize();
            }
            return await this.localAI.generateCompletion(prompt, context, maxTokens);
        }
    }
    
    // Explain code - already has languageId
    async explainCode(code: string, context: string, languageId: string): Promise<string> {
        if (this.isOpenAIConfigured()) {
            try {
                console.log('Using OpenAI for code explanation');
                return await this.explainWithOpenAI(code, context, languageId);
            } catch (error) {
                console.error('OpenAI failed:', error);
                throw error; // Don't fall back to local if OpenAI is configured
            }
        } else {
            if (!this.localAI) {
                this.localAI = new LocalAIProvider(this.context);
                await this.localAI.initialize();
            }
            return await this.localAI.explainCode(code, context);
        }
    }
    
    private async explainWithOpenAI(code: string, context: string, languageId: string): Promise<string> {
        const prompt = `Explain the following ${languageId} code in detail:\n\n${code}\n\nContext: ${context}`;
        
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.openaiKey}`
            },
            body: JSON.stringify({
                model: this.config.model,
                messages: [
                    {
                        role: 'system',
                        content: `You are an expert ${languageId} developer. Explain the following code clearly and concisely. 
                         Focus on:
                         1. What the code does
                         2. Its purpose and main functionality
                         3. Key patterns or techniques used
                         4. Any important details or edge cases
                         Keep the explanation clear but comprehensive.`
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                max_tokens: 500,
                temperature: this.config.temperature
            })
        });
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${error}`);
        }
        
        const data = await response.json() as { choices: { message: { content: string } }[] };
        return data.choices[0].message.content;
    }
    
    // Refactor code - fix parameter order and add languageId
    async refactorCode(code: string, instruction: string, context: string, languageId?: string): Promise<string> {
        if (this.isOpenAIConfigured()) {
            const prompt = `Refactor this ${languageId || 'code'}${instruction ? ` to ${instruction}` : ''}:\n\n${code}\n\nReturn only the refactored code without any markdown or explanations:`;
            const response = await this.chatWithOpenAI(prompt, context);
            return this.cleanCodeResponse(response);
        } else {
            if (!this.localAI) {
                this.localAI = new LocalAIProvider(this.context);
                await this.localAI.initialize();
            }
            return await this.localAI.refactorCode(code, instruction, context, languageId);
        }
    }
    
    // Generate tests - add languageId parameter
    async generateTests(code: string, context: string, languageId?: string): Promise<string> {
        if (this.isOpenAIConfigured()) {
            const testFramework = this.getTestFramework(languageId || 'javascript');
            const prompt = `Generate comprehensive unit tests using ${testFramework} for this ${languageId || 'code'}:\n\n${code}\n\nProvide complete test code without markdown formatting:`;
            const response = await this.chatWithOpenAI(prompt, context);
            return this.cleanCodeResponse(response);
        } else {
            if (!this.localAI) {
                this.localAI = new LocalAIProvider(this.context);
                await this.localAI.initialize();
            }
            return await this.localAI.generateTests(code, context);
        }
    }
    
    // Fix errors - add languageId parameter
    async fixError(code: string, error: string, fullContext: string, languageId?: string): Promise<string> {
        const prompt = `Fix this error in the ${languageId || 'code'}:\n\nError: ${error}\n\nCode:\n${code}\n\nReturn only the fixed code without markdown or explanations:`;
        
        if (this.isOpenAIConfigured()) {
            const response = await this.chatWithOpenAI(prompt, fullContext);
            return this.cleanCodeResponse(response);
        } else {
            if (!this.localAI) {
                this.localAI = new LocalAIProvider(this.context);
                await this.localAI.initialize();
            }
            const response = await this.localAI.chat(prompt, fullContext);
            return this.cleanCodeResponse(response);
        }
    }
    
    // private shouldUseOpenAI(): boolean {
    //     return this.config.provider === 'openai' && 
    //            this.config.openaiKey && 
    //            this.config.openaiKey !== 'your-openai-key-here';
    // }
    
    private async chatWithOpenAI(message: string, context: string): Promise<string> {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.openaiKey}`
            },
            body: JSON.stringify({
                model: this.config.model,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a helpful coding assistant.'
                    },
                    {
                        role: 'user',
                        content: context ? `${context}\n\n${message}` : message
                    }
                ],
                max_tokens: 1000,
                temperature: this.config.temperature
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenAI API error: ${errorText}`);
        }
        
        const data = await response.json() as { choices: { message: { content: string } }[] };
        return data.choices[0].message.content;
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
            
            if (!response.ok) {
                throw new Error(`OpenAI API error: ${response.statusText}`);
            }
            
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
    
    // isOpenAIConfigured(): boolean {
    //     return this.config.provider === 'openai' && 
    //            this.config.openaiKey && 
    //            this.config.openaiKey !== 'your-openai-api-key-here' &&
    //            this.config.openaiKey.startsWith('sk-');
    // }
    
    async ensureInitialized(): Promise<void> {
        if (!this.isOpenAIConfigured() && this.localAI) {
            await this.localAI.ensureServerRunning();
        }
    }
    
    // Helper method to get test framework based on language
    private getTestFramework(languageId: string): string {
        const frameworks: Record<string, string> = {
            javascript: 'Jest',
            typescript: 'Jest',
            python: 'pytest',
            java: 'JUnit',
            csharp: 'NUnit',
            cpp: 'Google Test',
            go: 'testing package',
            rust: 'cargo test',
            ruby: 'RSpec',
            php: 'PHPUnit'
        };
        return frameworks[languageId] || 'appropriate testing framework';
    }
}