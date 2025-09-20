// src/languages/LanguageService.ts

interface LanguageConfig {
    id: string;
    displayName: string;
    fileExtensions: string[];
    lineComment: string;
    blockComment?: { start: string; end: string };
    testFramework: string;
    testImports: string;
    completionPatterns: Record<string, string | undefined>;
    keywords: string[];
}

export class LanguageService {
    private static languages: Map<string, LanguageConfig> = new Map([
        ['javascript', {
            id: 'javascript',
            displayName: 'JavaScript',
            fileExtensions: ['.js', '.jsx', '.mjs'],
            lineComment: '//',
            blockComment: { start: '/*', end: '*/' },
            testFramework: 'jest',
            testImports: "const { expect } = require('chai');",
            completionPatterns: {
                'console.': 'log()',
                'document.': 'getElementById()',
                'Math.': 'floor()',
                'Array.': 'isArray()',
                'JSON.': 'stringify()',
                'Object.': 'keys()',
                'Promise.': 'resolve()',
                'async ': 'function',
                'await ': '',
                'function ': 'name() {}',
                'const ': 'variable = ',
                'let ': 'variable = ',
                'if (': 'condition) {',
                'for (': 'let i = 0; i < array.length; i++) {',
                'while (': 'condition) {',
                'return ': 'value;'
            },
            keywords: ['const', 'let', 'var', 'function', 'class', 'if', 'else', 'for', 'while', 'return', 'async', 'await']
        }],
        
        ['typescript', {
            id: 'typescript',
            displayName: 'TypeScript',
            fileExtensions: ['.ts', '.tsx'],
            lineComment: '//',
            blockComment: { start: '/*', end: '*/' },
            testFramework: 'jest',
            testImports: "import { expect } from 'chai';",
            completionPatterns: {
                'console.': 'log()',
                'Math.': 'floor()',
                'Array.': 'isArray()',
                'interface ': 'Name {',
                'type ': 'Name = ',
                'enum ': 'Name {',
                'class ': 'Name {',
                'public ': 'property: ',
                'private ': 'property: ',
                'protected ': 'property: ',
                'readonly ': 'property: ',
                'async ': 'function',
                'await ': '',
                'function ': 'name(): void {',
                'const ': 'variable: type = '
            },
            keywords: ['const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'public', 'private', 'protected', 'async', 'await']
        }],
        
        ['python', {
            id: 'python',
            displayName: 'Python',
            fileExtensions: ['.py'],
            lineComment: '#',
            blockComment: { start: '"""', end: '"""' },
            testFramework: 'pytest',
            testImports: 'import pytest',
            completionPatterns: {
                'print': '()',
                'len': '()',
                'range': '()',
                'str': '()',
                'int': '()',
                'float': '()',
                'list': '()',
                'dict': '()',
                'def ': 'function_name():',
                'class ': 'ClassName:',
                'if ': 'condition:',
                'elif ': 'condition:',
                'else:': '\n    ',
                'for ': 'item in iterable:',
                'while ': 'condition:',
                'import ': '',
                'from ': 'module import ',
                'return ': '',
                'yield ': '',
                'with ': 'open() as f:',
                'try:': '\n    ',
                'except ': 'Exception as e:'
            },
            keywords: ['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'return', 'yield', 'with', 'try', 'except', 'finally']
        }],
        
        ['java', {
            id: 'java',
            displayName: 'Java',
            fileExtensions: ['.java'],
            lineComment: '//',
            blockComment: { start: '/*', end: '*/' },
            testFramework: 'JUnit',
            testImports: 'import org.junit.Test;\nimport static org.junit.Assert.*;',
            completionPatterns: {
                'System.out.': 'println()',
                'System.err.': 'println()',
                'String ': 'variable = ',
                'int ': 'variable = ',
                'double ': 'variable = ',
                'boolean ': 'variable = ',
                'public ': 'void methodName()',
                'private ': 'void methodName()',
                'protected ': 'void methodName()',
                'static ': 'void methodName()',
                'class ': 'ClassName {',
                'interface ': 'InterfaceName {',
                'if (': 'condition) {',
                'for (': 'int i = 0; i < length; i++) {',
                'while (': 'condition) {',
                'return ': ';',
                'new ': 'Object()'
            },
            keywords: ['public', 'private', 'protected', 'static', 'final', 'class', 'interface', 'extends', 'implements', 'if', 'else', 'for', 'while', 'return', 'new']
        }],
        
        ['cpp', {
            id: 'cpp',
            displayName: 'C++',
            fileExtensions: ['.cpp', '.cc', '.cxx', '.hpp', '.h'],
            lineComment: '//',
            blockComment: { start: '/*', end: '*/' },
            testFramework: 'Google Test',
            testImports: '#include <gtest/gtest.h>',
            completionPatterns: {
                'std::cout': ' << ',
                'std::cin': ' >> ',
                'std::': 'vector<>',
                'cout': ' << ',
                'cin': ' >> ',
                '#include ': '<iostream>',
                'using ': 'namespace std;',
                'int ': 'variable = ',
                'double ': 'variable = ',
                'char ': 'variable = ',
                'bool ': 'variable = ',
                'void ': 'functionName()',
                'class ': 'ClassName {',
                'struct ': 'StructName {',
                'if (': 'condition) {',
                'for (': 'int i = 0; i < n; i++) {',
                'while (': 'condition) {',
                'return ': ';'
            },
            keywords: ['int', 'double', 'char', 'bool', 'void', 'class', 'struct', 'public', 'private', 'protected', 'if', 'else', 'for', 'while', 'return']
        }],
        
        ['go', {
            id: 'go',
            displayName: 'Go',
            fileExtensions: ['.go'],
            lineComment: '//',
            blockComment: { start: '/*', end: '*/' },
            testFramework: 'go test',
            testImports: 'import "testing"',
            completionPatterns: {
                'fmt.': 'Println()',
                'func ': 'name() {',
                'if ': 'condition {',
                'for ': 'i := 0; i < n; i++ {',
                'range ': 'slice {',
                'var ': 'name type',
                'const ': 'name = ',
                'type ': 'Name struct {',
                'package ': 'main',
                'import ': '""',
                'return ': '',
                'defer ': '',
                'go ': 'func()'
            },
            keywords: ['func', 'if', 'else', 'for', 'range', 'var', 'const', 'type', 'package', 'import', 'return', 'defer', 'go']
        }],
        
        ['rust', {
            id: 'rust',
            displayName: 'Rust',
            fileExtensions: ['.rs'],
            lineComment: '//',
            blockComment: { start: '/*', end: '*/' },
            testFramework: 'cargo test',
            testImports: '#[cfg(test)]',
            completionPatterns: {
                'println!': '("")',
                'let ': 'variable = ',
                'let mut ': 'variable = ',
                'fn ': 'name() {',
                'if ': 'condition {',
                'for ': 'item in iterator {',
                'while ': 'condition {',
                'match ': 'value {',
                'struct ': 'Name {',
                'enum ': 'Name {',
                'impl ': 'Type {',
                'use ': 'std::',
                'mod ': 'name;',
                'pub ': 'fn name()'
            },
            keywords: ['let', 'mut', 'fn', 'if', 'else', 'for', 'while', 'match', 'struct', 'enum', 'impl', 'use', 'mod', 'pub']
        }],

        ['csharp', {
            id: 'csharp',
            displayName: 'C#',
            fileExtensions: ['.cs'],
            lineComment: '//',
            blockComment: { start: '/*', end: '*/' },
            testFramework: 'xUnit',
            testImports: 'using Xunit;',
            completionPatterns: {
                'Console.': 'WriteLine()',
                'System.': 'Console',
                'public ': 'void MethodName()',
                'private ': 'void MethodName()',
                'protected ': 'void MethodName()',
                'static ': 'void MethodName()',
                'class ': 'ClassName {',
                'interface ': 'IName {',
                'var ': 'variable = ',
                'string ': 'variable = ',
                'int ': 'variable = ',
                'if (': 'condition) {',
                'foreach (': 'var item in collection) {',
                'for (': 'int i = 0; i < length; i++) {',
                'while (': 'condition) {',
                'using ': 'System;'
            },
            keywords: ['public', 'private', 'protected', 'static', 'class', 'interface', 'var', 'string', 'int', 'if', 'else', 'foreach', 'for', 'while', 'using']
        }]
    ]);

    static getAllLanguageIds(): string[] {
        return Array.from(this.languages.keys());
    }

    static getLanguageConfig(languageId: string): LanguageConfig | undefined {
        return this.languages.get(languageId);
    }

    static generatePrompt(language: string, type: 'explain' | 'test' | 'refactor', code: string, instruction?: string): string {
        const config = this.languages.get(language);
        const langName = config?.displayName || language;

        switch (type) {
            case 'explain':
                return `Explain this ${langName} code clearly and concisely:

\`\`\`${language}
${code}
\`\`\`

Explanation:`;

            case 'test':
                const framework = config?.testFramework || 'unit test';
                return `Generate comprehensive ${framework} tests for this ${langName} code:

\`\`\`${language}
${code}
\`\`\`

Tests using ${framework}:
\`\`\`${language}`;

            case 'refactor':
                return `Refactor this ${langName} code according to the instruction.

Instruction: ${instruction || 'Improve code quality and readability'}

Original code:
\`\`\`${language}
${code}
\`\`\`

Refactored code:
\`\`\`${language}`;

            default:
                return `Process this ${langName} code:\n\`\`\`${language}\n${code}\n\`\`\``;
        }
    }

    static getCompletionPatterns(language: string): Record<string, string> {
        const config = this.languages.get(language);
        return Object.fromEntries(
            Object.entries(config?.completionPatterns || {}).filter(([_, value]) => value !== undefined)
        ) as Record<string, string>;
    }

    static getTestImports(language: string): string {
        const config = this.languages.get(language);
        return config?.testImports || '';
    }

    static detectLanguage(code: string): string {
        // Check for language-specific patterns
        const patterns: { [key: string]: RegExp[] } = {
            python: [/\bdef\s+\w+\s*\(/, /\bclass\s+\w+[:\(]/, /\bimport\s+\w+/, /\bfrom\s+\w+\s+import/, /\bprint\s*\(/, /\bif\s+.*:/, /\belif\s+/, /\bexcept\s+/],
            javascript: [/\bfunction\s+\w+\s*\(/, /\bconst\s+\w+\s*=/, /\blet\s+\w+\s*=/, /\bvar\s+\w+\s*=/, /=>/, /console\.\w+/, /\basync\s+function/, /\bawait\s+/],
            typescript: [/\binterface\s+\w+/, /\btype\s+\w+\s*=/, /:\s*(string|number|boolean|any|void)\b/, /\benum\s+\w+/, /\bnamespace\s+/, /\bpublic\s+\w+\s*:/],
            java: [/\bpublic\s+class\s+/, /\bimport\s+java\./, /\bprivate\s+\w+/, /\bprotected\s+/, /System\.out\./, /\bvoid\s+\w+\s*\(/, /\bstatic\s+/],
            cpp: [/#include\s*[<"]/, /std::/, /cout\s*<</, /cin\s*>>/, /\busing\s+namespace\s+/, /\btemplate\s*</, /\bvirtual\s+/],
            go: [/\bpackage\s+\w+/, /\bfunc\s+\w+\s*\(/, /\bfmt\./, /\bdefer\s+/, /\bgo\s+\w+/, /\bchan\s+/, /\brange\s+/],
            rust: [/\bfn\s+\w+\s*\(/, /\blet\s+mut\s+/, /\bpub\s+/, /\bimpl\s+/, /\bmatch\s+/, /println!/, /\bstruct\s+\w+/, /\benum\s+\w+/],
            csharp: [/\busing\s+System/, /\bnamespace\s+/, /\bpublic\s+class\s+/, /Console\./, /\bvar\s+\w+\s*=/, /\bforeach\s*\(/, /\basync\s+Task/]
        };

        // Count matches for each language
        let maxMatches = 0;
        let detectedLanguage = 'javascript'; // Default fallback

        for (const [lang, langPatterns] of Object.entries(patterns)) {
            const matches = langPatterns.filter(pattern => pattern.test(code)).length;
            if (matches > maxMatches) {
                maxMatches = matches;
                detectedLanguage = lang;
            }
        }

        return detectedLanguage;
    }
}