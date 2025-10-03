// src/services/ContextExtractor.ts
import * as vscode from 'vscode';
import * as ts from 'typescript';
import * as path from 'path';

export interface ExtractedContext {
    // Core context
    prefix: string;           // Code before cursor (1.5KB)
    suffix: string;           // Code after cursor (500B)
    
    // File metadata
    language: string;
    fileName: string;
    relativePath: string;
    
    // Semantic context
    imports: string[];
    currentFunction?: FunctionContext;
    currentClass?: ClassContext;
    relatedSymbols: Symbol[];
    
    // Scope information
    localVariables: Variable[];
    availableTypes: string[];
    
    // Performance metrics
    extractionTime: number;
    contextSize: number;
}

interface FunctionContext {
    name: string;
    parameters: string[];
    returnType?: string;
    startLine: number;
    endLine: number;
}

interface ClassContext {
    name: string;
    methods: string[];
    properties: string[];
    extends?: string;
}

interface Symbol {
    name: string;
    kind: string;
    location: vscode.Location;
}

interface Variable {
    name: string;
    type?: string;
    value?: string;
}

export class ContextExtractor {
    private static instance: ContextExtractor;
    private cache: Map<string, { context: ExtractedContext; timestamp: number }> = new Map();
    private readonly CACHE_TTL = 5000; // 5 seconds
    private readonly MAX_PREFIX_SIZE = 1500;
    private readonly MAX_SUFFIX_SIZE = 500;
    
    private constructor() {}
    
    static getInstance(): ContextExtractor {
        if (!this.instance) {
            this.instance = new ContextExtractor();
        }
        return this.instance;
    }
    
    /**
     * Extract comprehensive context for any AI operation
     */
    async extractContext(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<ExtractedContext> {
        const startTime = Date.now();
        
        // Check cache first
        const cacheKey = this.getCacheKey(document, position);
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            return cached.context;
        }
        
        // Extract all context components in parallel
        const [
            prefix,
            suffix,
            imports,
            functionContext,
            classContext,
            symbols,
            variables,
            types
        ] = await Promise.all([
            this.extractPrefix(document, position),
            this.extractSuffix(document, position),
            this.extractImports(document),
            this.extractCurrentFunction(document, position),
            this.extractCurrentClass(document, position),
            this.extractRelatedSymbols(document, position),
            this.extractLocalVariables(document, position),
            this.extractAvailableTypes(document)
        ]);
        
        const context: ExtractedContext = {
            prefix,
            suffix,
            language: document.languageId,
            fileName: path.basename(document.fileName),
            relativePath: vscode.workspace.asRelativePath(document.fileName),
            imports,
            currentFunction: functionContext,
            currentClass: classContext,
            relatedSymbols: symbols,
            localVariables: variables,
            availableTypes: types,
            extractionTime: Date.now() - startTime,
            contextSize: prefix.length + suffix.length
        };
        
        // Cache the result
        this.cache.set(cacheKey, { context, timestamp: Date.now() });
        
        // Clean old cache entries
        this.cleanCache();
        
        return context;
    }
    
    /**
     * Extract code before cursor (with smart truncation)
     */
    private extractPrefix(
        document: vscode.TextDocument,
        position: vscode.Position
    ): string {
        const startLine = Math.max(0, position.line - 50);
        const range = new vscode.Range(
            new vscode.Position(startLine, 0),
            position
        );
        
        let prefix = document.getText(range);
        
        // Smart truncation - keep complete lines/statements
        if (prefix.length > this.MAX_PREFIX_SIZE) {
            prefix = this.smartTruncate(prefix, this.MAX_PREFIX_SIZE, 'prefix');
        }
        
        return prefix;
    }
    
    /**
     * Extract code after cursor
     */
    private extractSuffix(
        document: vscode.TextDocument,
        position: vscode.Position
    ): string {
        const endLine = Math.min(document.lineCount - 1, position.line + 20);
        const range = new vscode.Range(
            position,
            new vscode.Position(endLine, Number.MAX_VALUE)
        );
        
        let suffix = document.getText(range);
        
        if (suffix.length > this.MAX_SUFFIX_SIZE) {
            suffix = this.smartTruncate(suffix, this.MAX_SUFFIX_SIZE, 'suffix');
        }
        
        return suffix;
    }
    
    /**
     * Extract all imports from the document
     */
    private async extractImports(document: vscode.TextDocument): Promise<string[]> {
        const text = document.getText();
        const imports: string[] = [];
        
        // TypeScript/JavaScript imports
        if (document.languageId === 'typescript' || document.languageId === 'javascript') {
            const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
            let match;
            while ((match = importRegex.exec(text)) !== null) {
                imports.push(match[1]);
            }
        }
        
        // Python imports
        else if (document.languageId === 'python') {
            const importRegex = /(?:from\s+(\S+)\s+)?import\s+(.+)/g;
            let match;
            while ((match = importRegex.exec(text)) !== null) {
                imports.push(match[1] || match[2]);
            }
        }
        
        // Add other language patterns as needed
        
        return [...new Set(imports)]; // Remove duplicates
    }
    
    /**
     * Extract current function context using AST
     */
    private async extractCurrentFunction(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<FunctionContext | undefined> {
        if (document.languageId !== 'typescript' && document.languageId !== 'javascript') {
            return this.extractFunctionFallback(document, position);
        }
        
        const sourceFile = ts.createSourceFile(
            document.fileName,
            document.getText(),
            ts.ScriptTarget.Latest,
            true
        );
        
        const offset = document.offsetAt(position);
        let functionContext: FunctionContext | undefined;
        
        const visit = (node: ts.Node): void => {
            if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
                if (node.pos <= offset && offset <= node.end) {
                    const name = (node as any).name?.getText() || 'anonymous';
                    const parameters = this.extractParameters(node);
                    const returnType = this.extractReturnType(node);
                    
                    functionContext = {
                        name,
                        parameters,
                        returnType,
                        startLine: document.positionAt(node.pos).line,
                        endLine: document.positionAt(node.end).line
                    };
                }
            }
            ts.forEachChild(node, visit);
        };
        
        visit(sourceFile);
        return functionContext;
    }
    
    /**
     * Fallback function extraction for non-TS languages
     */
    private extractFunctionFallback(
        document: vscode.TextDocument,
        position: vscode.Position
    ): FunctionContext | undefined {
        const line = position.line;
        
        // Simple regex-based extraction
        for (let i = line; i >= Math.max(0, line - 50); i--) {
            const lineText = document.lineAt(i).text;
            
            // Match common function patterns
            const functionMatch = lineText.match(/(?:function|def|func|fn)\s+(\w+)\s*\(([^)]*)\)/);
            if (functionMatch) {
                return {
                    name: functionMatch[1],
                    parameters: functionMatch[2].split(',').map(p => p.trim()),
                    startLine: i,
                    endLine: line + 10 // Approximate
                };
            }
        }
        
        return undefined;
    }
    
    /**
     * Extract current class context
     */
    private async extractCurrentClass(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<ClassContext | undefined> {
        // Use VS Code's built-in symbol provider
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            document.uri
        );
        
        if (!symbols) return undefined;
        
        return this.findContainingClass(symbols, position);
    }
    
    /**
     * Find the class containing the position
     */
    private findContainingClass(
        symbols: vscode.DocumentSymbol[],
        position: vscode.Position
    ): ClassContext | undefined {
        for (const symbol of symbols) {
            if (symbol.kind === vscode.SymbolKind.Class && symbol.range.contains(position)) {
                const methods = symbol.children
                    .filter(child => child.kind === vscode.SymbolKind.Method)
                    .map(method => method.name);
                    
                const properties = symbol.children
                    .filter(child => child.kind === vscode.SymbolKind.Property)
                    .map(prop => prop.name);
                
                return {
                    name: symbol.name,
                    methods,
                    properties
                };
            }
            
            // Recursively check children
            if (symbol.children) {
                const found = this.findContainingClass(symbol.children, position);
                if (found) return found;
            }
        }
        
        return undefined;
    }
    
    /**
     * Extract related symbols (variables, functions, classes nearby)
     */
    private async extractRelatedSymbols(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<Symbol[]> {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            document.uri
        );
        
        if (!symbols) return [];
        
        const relatedSymbols: Symbol[] = [];
        const maxDistance = 50; // lines
        
        const collectNearbySymbols = (symbolList: vscode.DocumentSymbol[]) => {
            for (const symbol of symbolList) {
                const distance = Math.abs(symbol.range.start.line - position.line);
                if (distance <= maxDistance) {
                    relatedSymbols.push({
                        name: symbol.name,
                        kind: vscode.SymbolKind[symbol.kind],
                        location: new vscode.Location(document.uri, symbol.range)
                    });
                }
                
                if (symbol.children) {
                    collectNearbySymbols(symbol.children);
                }
            }
        };
        
        collectNearbySymbols(symbols);
        
        // Sort by distance from cursor
        relatedSymbols.sort((a, b) => {
            const distA = Math.abs(a.location.range.start.line - position.line);
            const distB = Math.abs(b.location.range.start.line - position.line);
            return distA - distB;
        });
        
        return relatedSymbols.slice(0, 10); // Top 10 nearest
    }
    
    /**
     * Extract local variables in scope
     */
    private async extractLocalVariables(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<Variable[]> {
        const variables: Variable[] = [];
        const startLine = Math.max(0, position.line - 30);
        
        for (let i = startLine; i < position.line; i++) {
            const lineText = document.lineAt(i).text;
            
            // Match variable declarations (simplified)
            const varMatch = lineText.match(/(?:const|let|var|val|auto)\s+(\w+)(?:\s*:\s*(\w+))?\s*=\s*(.+);?/);
            if (varMatch) {
                variables.push({
                    name: varMatch[1],
                    type: varMatch[2],
                    value: varMatch[3]?.substring(0, 50) // Truncate long values
                });
            }
        }
        
        return variables;
    }
    
    /**
     * Extract available types (interfaces, types, classes)
     */
    private async extractAvailableTypes(document: vscode.TextDocument): Promise<string[]> {
        const types: string[] = [];
        const text = document.getText();
        
        // TypeScript types
        if (document.languageId === 'typescript') {
            const typeRegex = /(?:interface|type|class|enum)\s+(\w+)/g;
            let match;
            while ((match = typeRegex.exec(text)) !== null) {
                types.push(match[1]);
            }
        }
        
        return [...new Set(types)];
    }
    
    /**
     * Smart truncation that preserves code structure
     */
    private smartTruncate(text: string, maxLength: number, type: 'prefix' | 'suffix'): string {
        if (text.length <= maxLength) return text;
        
        if (type === 'prefix') {
            // Keep the end, truncate from beginning
            // Try to break at line boundaries
            const lines = text.split('\n');
            let result = '';
            for (let i = lines.length - 1; i >= 0; i--) {
                if (result.length + lines[i].length > maxLength) break;
                result = lines[i] + '\n' + result;
            }
            return result;
        } else {
            // Keep the beginning, truncate from end
            const lines = text.split('\n');
            let result = '';
            for (const line of lines) {
                if (result.length + line.length > maxLength) break;
                result += line + '\n';
            }
            return result;
        }
    }
    
    /**
     * Extract parameters from a function node
     */
    private extractParameters(node: ts.Node): string[] {
        const parameters: string[] = [];
        
        if ('parameters' in node) {
            const funcNode = node as ts.FunctionLikeDeclaration;
            funcNode.parameters.forEach(param => {
                parameters.push(param.name?.getText() || '');
            });
        }
        
        return parameters;
    }
    
    /**
     * Extract return type from a function node
     */
    private extractReturnType(node: ts.Node): string | undefined {
        if ('type' in node) {
            const funcNode = node as ts.FunctionLikeDeclaration;
            return funcNode.type?.getText();
        }
        return undefined;
    }
    
    /**
     * Generate cache key for context
     */
    private getCacheKey(document: vscode.TextDocument, position: vscode.Position): string {
        return `${document.uri.toString()}_${position.line}_${position.character}`;
    }
    
    /**
     * Clean old cache entries
     */
    private cleanCache(): void {
        const now = Date.now();
        for (const [key, value] of this.cache.entries()) {
            if (now - value.timestamp > this.CACHE_TTL * 2) {
                this.cache.delete(key);
            }
        }
    }
    
    /**
     * Clear cache for a specific document
     */
    clearDocumentCache(document: vscode.TextDocument): void {
        for (const key of this.cache.keys()) {
            if (key.startsWith(document.uri.toString())) {
                this.cache.delete(key);
            }
        }
    }
}