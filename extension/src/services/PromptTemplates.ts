// src/services/PromptTemplates.ts
import { ExtractedContext } from './ContextExtractor';

export interface PromptOptions {
    maxTokens?: number;
    temperature?: number;
    style?: 'concise' | 'detailed' | 'educational';
    includeExamples?: boolean;
    targetFramework?: string;
}

export class PromptTemplates {
    private static instance: PromptTemplates;
    
    private constructor() {}
    
    static getInstance(): PromptTemplates {
        if (!this.instance) {
            this.instance = new PromptTemplates();
        }
        return this.instance;
    }
    
    /**
     * Generate completion prompt with rich context
     */
    completionPrompt(
        context: ExtractedContext,
        options: PromptOptions = {}
    ): string {
        const parts: string[] = [];
        
        // System context
        parts.push(this.systemContext(context, 'completion'));
        
        // File and language context
        parts.push(`Language: ${context.language}`);
        parts.push(`File: ${context.fileName}`);
        
        // Imports if available
        if (context.imports.length > 0) {
            parts.push(`Available imports: ${context.imports.join(', ')}`);
        }
        
        // Current scope context
        if (context.currentFunction) {
            parts.push(`Current function: ${context.currentFunction.name}(${context.currentFunction.parameters.join(', ')})`);
            if (context.currentFunction.returnType) {
                parts.push(`Return type: ${context.currentFunction.returnType}`);
            }
        }
        
        if (context.currentClass) {
            parts.push(`Current class: ${context.currentClass.name}`);
            if (context.currentClass.extends) {
                parts.push(`Extends: ${context.currentClass.extends}`);
            }
        }
        
        // Local variables
        if (context.localVariables.length > 0) {
            const vars = context.localVariables.map(v => `${v.name}: ${v.type || 'any'}`);
            parts.push(`Local variables: ${vars.join(', ')}`);
        }
        
        // Code context with cursor position
        parts.push('\n--- Code Context ---');
        parts.push(context.prefix);
        parts.push('<CURSOR>');
        parts.push(context.suffix);
        parts.push('--- End Context ---\n');
        
        // Instructions
        parts.push(this.completionInstructions(context, options));
        
        return parts.join('\n');
    }
    
    /**
     * Generate explanation prompt
     */
    explainPrompt(
        code: string,
        context: ExtractedContext,
        options: PromptOptions = {}
    ): string {
        const style = options.style || 'concise';
        const parts: string[] = [];
        
        parts.push(this.systemContext(context, 'explain'));
        
        parts.push(`Explain this ${context.language} code:`);
        parts.push('```' + context.language);
        parts.push(code);
        parts.push('```');
        
        // Add context about where this code appears
        if (context.currentFunction) {
            parts.push(`\nContext: This code is inside the function "${context.currentFunction.name}".`);
        }
        if (context.currentClass) {
            parts.push(`It's part of the class "${context.currentClass.name}".`);
        }
        
        // Related symbols for better understanding
        if (context.relatedSymbols.length > 0) {
            const symbols = context.relatedSymbols.slice(0, 5).map(s => s.name);
            parts.push(`Related code elements: ${symbols.join(', ')}`);
        }
        
        // Style-specific instructions
        switch (style) {
            case 'concise':
                parts.push('\nProvide a clear, concise explanation in 2-3 sentences.');
                break;
            case 'detailed':
                parts.push('\nProvide a comprehensive explanation including:');
                parts.push('1. What the code does');
                parts.push('2. How it works step-by-step');
                parts.push('3. Any important considerations or edge cases');
                break;
            case 'educational':
                parts.push('\nExplain this code as if teaching a junior developer:');
                parts.push('- Start with the overall purpose');
                parts.push('- Break down each important part');
                parts.push('- Mention best practices or improvements if relevant');
                break;
        }
        
        return parts.join('\n');
    }
    
    /**
     * Generate fix prompt for errors
     */
    fixPrompt(
        error: string,
        code: string,
        context: ExtractedContext,
        options: PromptOptions = {}
    ): string {
        const parts: string[] = [];
        
        parts.push(this.systemContext(context, 'fix'));
        
        parts.push(`Fix this ${context.language} error:\n`);
        parts.push(`Error message: ${error}\n`);
        
        parts.push('Problematic code:');
        parts.push('```' + context.language);
        parts.push(code);
        parts.push('```\n');
        
        // Add available context
        if (context.imports.length > 0) {
            parts.push(`Available imports: ${context.imports.join(', ')}`);
        }
        
        if (context.availableTypes.length > 0) {
            parts.push(`Available types: ${context.availableTypes.slice(0, 10).join(', ')}`);
        }
        
        if (context.localVariables.length > 0) {
            const vars = context.localVariables.map(v => `${v.name}: ${v.type || 'any'}`);
            parts.push(`Variables in scope: ${vars.join(', ')}`);
        }
        
        parts.push('\nProvide:');
        parts.push('1. The fixed code');
        parts.push('2. Brief explanation of what was wrong');
        parts.push('3. How the fix resolves the issue');
        
        if (options.includeExamples) {
            parts.push('4. How to prevent this error in the future');
        }
        
        return parts.join('\n');
    }
    
    /**
     * Generate test generation prompt
     */
    testPrompt(
        code: string,
        context: ExtractedContext,
        options: PromptOptions = {}
    ): string {
        const framework = options.targetFramework || this.detectTestFramework(context);
        const parts: string[] = [];
        
        parts.push(this.systemContext(context, 'test'));
        
        parts.push(`Generate unit tests for this ${context.language} code:\n`);
        parts.push('```' + context.language);
        parts.push(code);
        parts.push('```\n');
        
        parts.push(`Test framework: ${framework}`);
        
        if (context.currentFunction) {
            parts.push(`Function to test: ${context.currentFunction.name}`);
            parts.push(`Parameters: ${context.currentFunction.parameters.join(', ')}`);
            if (context.currentFunction.returnType) {
                parts.push(`Return type: ${context.currentFunction.returnType}`);
            }
        }
        
        parts.push('\nGenerate comprehensive tests that cover:');
        parts.push('- Normal cases (happy path)');
        parts.push('- Edge cases');
        parts.push('- Error cases');
        parts.push('- Boundary conditions');
        
        if (framework === 'jest' || framework === 'vitest') {
            parts.push('\nUse describe blocks to organize tests and proper Jest/Vitest matchers.');
        } else if (framework === 'pytest') {
            parts.push('\nUse pytest fixtures and parametrize for multiple test cases.');
        }
        
        parts.push('\nEnsure the tests are complete and runnable.');
        
        return parts.join('\n');
    }
    
    /**
     * Generate refactoring prompt
     */
    refactorPrompt(
        code: string,
        context: ExtractedContext,
        options: PromptOptions = {}
    ): string {
        const parts: string[] = [];
        
        parts.push(this.systemContext(context, 'refactor'));
        
        parts.push(`Refactor this ${context.language} code for better quality:\n`);
        parts.push('```' + context.language);
        parts.push(code);
        parts.push('```\n');
        
        // Context about current code structure
        if (context.currentClass) {
            parts.push(`This code is part of the class "${context.currentClass.name}".`);
            if (context.currentClass.methods.length > 0) {
                parts.push(`Other methods in class: ${context.currentClass.methods.slice(0, 5).join(', ')}`);
            }
        }
        
        parts.push('\nRefactor the code to improve:');
        parts.push('1. Readability and clarity');
        parts.push('2. Performance (if applicable)');
        parts.push('3. Maintainability');
        parts.push('4. Following best practices and design patterns');
        parts.push('5. Error handling');
        
        parts.push('\nProvide:');
        parts.push('- The refactored code');
        parts.push('- List of improvements made');
        parts.push('- Brief explanation of why each change improves the code');
        
        if (context.language === 'typescript' || context.language === 'javascript') {
            parts.push('\nEnsure the refactored code:');
            parts.push('- Uses modern ES6+ features appropriately');
            parts.push('- Has proper TypeScript types (if applicable)');
            parts.push('- Follows common conventions');
        }
        
        return parts.join('\n');
    }
    
    /**
     * Generate chat prompt with context
     */
    chatPrompt(
        userMessage: string,
        context: ExtractedContext,
        conversationHistory: Array<{ role: string; content: string }> = [],
        options: PromptOptions = {}
    ): string {
        const parts: string[] = [];
        
        // Include conversation history if available
        if (conversationHistory.length > 0) {
            parts.push('Previous conversation:');
            for (const msg of conversationHistory.slice(-5)) { // Last 5 messages
                parts.push(`${msg.role}: ${msg.content}`);
            }
            parts.push('---\n');
        }
        
        // Current context
        parts.push('Current context:');
        parts.push(`- Working in: ${context.fileName} (${context.language})`);
        
        if (context.currentFunction) {
            parts.push(`- Current function: ${context.currentFunction.name}`);
        }
        if (context.currentClass) {
            parts.push(`- Current class: ${context.currentClass.name}`);
        }
        
        // Include relevant code context if the message seems to reference it
        if (this.messageReferencesCode(userMessage)) {
            parts.push('\nRelevant code:');
            parts.push('```' + context.language);
            parts.push(this.getRelevantCodeSnippet(context));
            parts.push('```');
        }
        
        parts.push('\nUser question:');
        parts.push(userMessage);
        
        parts.push('\nProvide a helpful response. If discussing code, use markdown code blocks with syntax highlighting.');
        
        return parts.join('\n');
    }
    
    /**
     * Generate system context based on operation
     */
    private systemContext(context: ExtractedContext, operation: string): string {
        const contexts: Record<string, string> = {
            completion: `You are an expert ${context.language} developer providing code completions. Follow the existing code style and conventions.`,
            explain: `You are an expert ${context.language} developer providing clear code explanations.`,
            fix: `You are an expert ${context.language} developer helping fix code errors. Provide working solutions.`,
            test: `You are an expert test engineer writing comprehensive unit tests in ${context.language}.`,
            refactor: `You are an expert ${context.language} developer improving code quality through refactoring.`,
            chat: `You are an expert programming assistant helping with ${context.language} development.`
        };
        
        return contexts[operation] || contexts.chat;
    }
    
    /**
     * Generate completion-specific instructions
     */
    private completionInstructions(context: ExtractedContext, options: PromptOptions): string {
        const instructions: string[] = [];
        
        instructions.push('Complete the code at <CURSOR> position.');
        instructions.push('Requirements:');
        instructions.push('- Follow the existing coding style and conventions');
        instructions.push('- Use appropriate variable names consistent with the codebase');
        instructions.push('- Complete the current statement or block logically');
        
        if (context.currentFunction?.returnType) {
            instructions.push(`- Ensure compatibility with return type: ${context.currentFunction.returnType}`);
        }
        
        if (context.availableTypes.length > 0) {
            instructions.push(`- You may use these types: ${context.availableTypes.slice(0, 5).join(', ')}`);
        }
        
        instructions.push('\nProvide ONLY the completion code, no explanations.');
        
        return instructions.join('\n');
    }
    
    /**
     * Detect test framework from imports
     */
    private detectTestFramework(context: ExtractedContext): string {
        const imports = context.imports.join(' ').toLowerCase();
        
        if (imports.includes('jest') || imports.includes('@jest')) {
            return 'jest';
        }
        if (imports.includes('vitest')) {
            return 'vitest';
        }
        if (imports.includes('mocha')) {
            return 'mocha';
        }
        if (imports.includes('pytest')) {
            return 'pytest';
        }
        if (imports.includes('unittest')) {
            return 'unittest';
        }
        if (imports.includes('testing')) {
            return 'testing'; // Go
        }
        
        // Default based on language
        switch (context.language) {
            case 'typescript':
            case 'javascript':
                return 'jest';
            case 'python':
                return 'pytest';
            case 'go':
                return 'testing';
            case 'rust':
                return 'rust-test';
            default:
                return 'generic';
        }
    }
    
    /**
     * Check if message references code
     */
    private messageReferencesCode(message: string): boolean {
        const codeKeywords = [
            'this code', 'the code', 'this function', 'this method',
            'this class', 'above', 'below', 'current', 'selected',
            'this', 'that', 'it', 'here'
        ];
        
        const lowerMessage = message.toLowerCase();
        return codeKeywords.some(keyword => lowerMessage.includes(keyword));
    }
    
    /**
     * Get relevant code snippet for chat context
     */
    private getRelevantCodeSnippet(context: ExtractedContext): string {
        // If in a function, show the function
        if (context.currentFunction) {
            const functionStart = context.prefix.lastIndexOf('function') || 
                                context.prefix.lastIndexOf('const') ||
                                context.prefix.lastIndexOf('async');
            if (functionStart > -1) {
                return context.prefix.substring(functionStart) + context.suffix.split('\n')[0];
            }
        }
        
        // Otherwise show surrounding 10 lines
        const prefixLines = context.prefix.split('\n').slice(-5);
        const suffixLines = context.suffix.split('\n').slice(0, 5);
        
        return [...prefixLines, '// <-- cursor here', ...suffixLines].join('\n');
    }
    
    /**
     * Create a prompt for specific slash commands
     */
    slashCommandPrompt(
        command: string,
        args: string,
        context: ExtractedContext,
        selectedCode?: string
    ): string {
        const commands: Record<string, () => string> = {
            '/explain': () => this.explainPrompt(selectedCode || this.getRelevantCodeSnippet(context), context),
            '/fix': () => this.fixPrompt(args, selectedCode || this.getRelevantCodeSnippet(context), context),
            '/test': () => this.testPrompt(selectedCode || this.getRelevantCodeSnippet(context), context),
            '/refactor': () => this.refactorPrompt(selectedCode || this.getRelevantCodeSnippet(context), context),
            '/docs': () => this.documentationPrompt(selectedCode || this.getRelevantCodeSnippet(context), context)
        };
        
        const promptGenerator = commands[command];
        if (promptGenerator) {
            return promptGenerator();
        }
        
        // Default chat prompt for unknown commands
        return this.chatPrompt(`${command} ${args}`, context);
    }
    
    /**
     * Generate documentation prompt
     */
    private documentationPrompt(code: string, context: ExtractedContext): string {
        const parts: string[] = [];
        
        parts.push(this.systemContext(context, 'documentation'));
        parts.push(`Generate comprehensive documentation for this ${context.language} code:\n`);
        parts.push('```' + context.language);
        parts.push(code);
        parts.push('```\n');
        
        if (context.language === 'typescript' || context.language === 'javascript') {
            parts.push('Generate JSDoc comments including:');
            parts.push('- Description');
            parts.push('- @param tags for parameters');
            parts.push('- @returns tag');
            parts.push('- @throws tag if applicable');
            parts.push('- @example if helpful');
        } else if (context.language === 'python') {
            parts.push('Generate docstring following Google/NumPy style including:');
            parts.push('- Description');
            parts.push('- Args section');
            parts.push('- Returns section');
            parts.push('- Raises section if applicable');
            parts.push('- Examples section if helpful');
        }
        
        parts.push('\nEnsure documentation is:');
        parts.push('- Clear and concise');
        parts.push('- Technically accurate');
        parts.push('- Helpful for other developers');
        
        return parts.join('\n');
    }
}