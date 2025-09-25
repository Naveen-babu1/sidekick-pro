// security/PrivacyGuard.ts
import * as vscode from 'vscode';

export class PrivacyGuard {
    private blockedRequests = 0;
    private localInferences = 0;
    private dataProcessed = 0;
    private allowedDomains = [
        '127.0.0.1',
        'localhost',
        'api.openai.com',  // Add OpenAI API
        'platform.openai.com'  // Add OpenAI platform
    ];
    private sensitivePatterns: RegExp[] = [
        /api[_-]?key/gi,
        /secret/gi,
        /password/gi,
        /token/gi,
        /private[_-]?key/gi,
        /AWS[A-Z0-9]{16,}/g,
        /[a-z0-9]{32,}/g,  // Generic long tokens
        /https?:\/\/[^\s]+/g,  // URLs
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g  // Emails
    ];
    
    async initialize() {
        const originalFetch = global.fetch;
        
        global.fetch = async (input: any | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input.toString();
            // Check if URL is allowed
            const isAllowed = this.allowedDomains.some(domain => url.includes(domain));
            
            if (isAllowed) {
                return originalFetch(input, init);
            }
            
            // Block everything else
            console.warn(`Privacy Guard: Blocked external request to ${url}`);
            throw new Error('External network request blocked by Privacy Guard');
        };
        
        console.log('Privacy Guard initialized - OpenAI API allowed');
    }
    
    private setupNetworkInterceptor() {
        const originalFetch = global.fetch;
        global.fetch = async (input: any, init?: any) => {
            const url = typeof input === 'string' ? input : input.url;
            
            // Check if URL is in allowed list
            const isAllowed = this.allowedDomains.some(domain => 
                url.includes(domain)
            );
            
            if (!isAllowed) {
                // Check if we're using OpenAI and should allow it
                const config = vscode.workspace.getConfiguration('sidekick-ai');
                const fs = require('fs');
                const path = require('path');
                
                // Check multiple possible .env locations
                const possibleEnvPaths = [
                    path.join(__dirname, '..', '..', '.env'),
                    path.join(__dirname, '..', '..', '..', '.env'),
                    path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.env'),
                    'd:/projects/sidekick-pro/.env'
                ];
                
                let usingOpenAI = false;
                for (const envPath of possibleEnvPaths) {
                    if (fs.existsSync(envPath)) {
                        const envContent = fs.readFileSync(envPath, 'utf8');
                        if (envContent.includes('DEFAULT_MODEL_PROVIDER=openai') && 
                            envContent.includes('OPENAI_API_KEY=sk-')) {
                            usingOpenAI = true;
                            break;
                        }
                    }
                }
                
                // If using OpenAI and the request is to OpenAI, allow it
                if (usingOpenAI && url.includes('api.openai.com')) {
                    return originalFetch(input, init);
                }
                
                // Otherwise block the request
                this.blockedRequests++;
                console.log('Privacy Guard blocked request to:', url);
                throw new Error('External network request blocked by Privacy Guard');
            }
            
            return originalFetch(input, init);
        };
    }
    
    private async initializeSecureStorage() {
        // Setup encrypted local storage for sensitive data
        // In production, use proper encryption
    }
    
    async sanitizeCode(code: string): Promise<string> {
        let sanitized = code;
        
        // Replace sensitive patterns
        for (const pattern of this.sensitivePatterns) {
            sanitized = sanitized.replace(pattern, (match) => {
                // Keep structure but anonymize content
                if (match.includes('api') || match.includes('key')) {
                    return 'REDACTED_API_KEY';
                }
                if (match.includes('secret')) {
                    return 'REDACTED_SECRET';
                }
                if (match.includes('password')) {
                    return 'REDACTED_PASSWORD';
                }
                if (match.includes('@')) {
                    return 'user@example.com';
                }
                if (match.startsWith('http')) {
                    return 'https://example.com';
                }
                return 'REDACTED';
            });
        }
        
        // Remove comments that might contain sensitive info
        sanitized = this.removeComments(sanitized);
        
        return sanitized;
    }
    
    private removeComments(code: string): string {
        // Remove single-line comments
        code = code.replace(/\/\/.*$/gm, '');
        // Remove multi-line comments
        code = code.replace(/\/\*[\s\S]*?\*\//g, '');
        // Remove Python comments
        code = code.replace(/#.*$/gm, '');
        
        return code;
    }
    
    recordLocalInference(type: string, dataSize: number) {
        this.localInferences++;
        this.dataProcessed += dataSize;
    }
    
    getPrivacyReport() {
        // Check what model is actually being used
        const fs = require('fs');
        const path = require('path');
        let activeModel = 'deepseek-coder:6.7b (local)';
        
        const possibleEnvPaths = [
            path.join(__dirname, '..', '..', '.env'),
            path.join(__dirname, '..', '..', '..', '.env'),
            'd:/projects/sidekick-pro/.env'
        ];
        
        for (const envPath of possibleEnvPaths) {
            if (fs.existsSync(envPath)) {
                const envContent = fs.readFileSync(envPath, 'utf8');
                if (envContent.includes('DEFAULT_MODEL_PROVIDER=openai')) {
                    activeModel = 'OpenAI GPT-3.5-turbo';
                    break;
                }
            }
        }
        
        return {
            blockedRequests: this.blockedRequests,
            localInferences: this.localInferences,
            dataProcessed: `${(this.dataProcessed / 1024).toFixed(2)} KB`,
            activeModel: activeModel,
            indexedFiles: 0,  // Will be updated by indexer
            excludedPatterns: [
                'node_modules/**',
                '.git/**',
                '*.env',
                '*.key',
                '*.pem',
                'secrets/**'
            ]
        };
    }
    
    async checkFileSafety(uri: vscode.Uri): Promise<boolean> {
        const fileName = uri.fsPath;
        
        // Never index sensitive files
        const sensitiveFiles = [
            '.env',
            '.env.local',
            '.env.production',
            'secrets',
            'credentials',
            '.aws',
            '.ssh',
            'private',
            '.key',
            '.pem',
            '.cert'
        ];
        
        for (const sensitive of sensitiveFiles) {
            if (fileName.includes(sensitive)) {
                return false;
            }
        }
        
        return true;
    }
}