// // providers/InlineCompletionProvider.ts
// import * as vscode from 'vscode';
// import { LocalAIProvider } from './LocalAIProvider';
// import { CodeIndexer } from '../indexer/CodeIndexer';
// import { PrivacyGuard } from '../security/PrivacyGuard';

// export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
//     private debounceTimer: NodeJS.Timeout | undefined;
//     private lastCompletionPosition: vscode.Position | undefined;

//     constructor(
//         private localAI: LocalAIProvider,
//         private indexer: CodeIndexer,
//         private privacyGuard: PrivacyGuard
//     ) {}

//     async provideInlineCompletionItems(
//         document: vscode.TextDocument,
//         position: vscode.Position,
//         context: vscode.InlineCompletionContext,
//         token: vscode.CancellationToken
//     ): Promise<vscode.InlineCompletionItem[]> {

//         // Don't trigger on every keystroke
//         // if (this.shouldSkipCompletion(document, position, context)) {
//         //     return [];
//         // }

//         // Get current line and context
//         const linePrefix = document.lineAt(position.line).text.substring(0, position.character);

//         // Skip if line is too short
//         if (linePrefix.trim().length < 3) {
//             return [];
//         }

//         // Skip if in middle of word
//         if (position.character > 0) {
//             const charBefore = document.lineAt(position.line).text[position.character - 1];
//             if (/\w/.test(charBefore)) {
//                 return [];
//             }
//         }
//         console.log('Getting completion for:', linePrefix);

//         // Sanitize code before processing
//         const sanitizedContext = await this.privacyGuard.sanitizeCode(
//             this.getDocumentContext(document, position)
//         );

//         // Get relevant context from indexed files
//         const semanticContext = await this.indexer.getRelevantContext(
//             document.uri,
//             position,
//             500  // max tokens
//         );

//         // Generate completion
//         const completion = await this.localAI.generateCompletion(
//             linePrefix,
//             `${sanitizedContext}\n\n${semanticContext}`,
//             100
//         );

//         if (!completion || token.isCancellationRequested) {
//             return [];
//         }

//         // Record for privacy tracking
//         this.privacyGuard.recordLocalInference('completion', completion.length);

//         return [{
//             insertText: completion,
//             range: new vscode.Range(position, position)
//         }];
//     }

//     private shouldSkipCompletion(
//         document: vscode.TextDocument,
//         position: vscode.Position,
//         context: vscode.InlineCompletionContext
//     ): boolean {
//         // Skip if in comment or string
//         const lineText = document.lineAt(position.line).text;
//         const beforeCursor = lineText.substring(0, position.character);

//         if (this.isInComment(beforeCursor) || this.isInString(beforeCursor)) {
//             return true;
//         }

//         // Skip if just typed a space or newline
//         if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
//             const lastChar = beforeCursor[beforeCursor.length - 1];
//             if (lastChar === ' ' || lastChar === '\n') {
//                 return true;
//             }
//         }

//         return false;
//     }

//     private isInComment(text: string): boolean {
//         // Simple heuristic for common comment patterns
//         return text.includes('//') || text.includes('#') || text.includes('/*');
//     }

//     private isInString(text: string): boolean {
//         // Count quotes to determine if we're in a string
//         const singleQuotes = (text.match(/'/g) || []).length;
//         const doubleQuotes = (text.match(/"/g) || []).length;
//         return singleQuotes % 2 === 1 || doubleQuotes % 2 === 1;
//     }

//     private getDocumentContext(document: vscode.TextDocument, position: vscode.Position): string {
//         const startLine = Math.max(0, position.line - 50);
//         const endLine = Math.min(document.lineCount - 1, position.line + 10);

//         const lines = [];
//         for (let i = startLine; i <= endLine; i++) {
//             lines.push(document.lineAt(i).text);
//         }

//         return lines.join('\n');
//     }
// }

import * as vscode from "vscode";
import { LocalAIProvider } from "./LocalAIProvider";
import { CodeIndexer } from "../indexer/CodeIndexer";
import { PrivacyGuard } from "../security/PrivacyGuard";

export class InlineCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  private debounceTimer: NodeJS.Timeout | undefined;
  private lastCompletionTime = 0;
    private minDelay = 500;

  constructor(
    private localAI: LocalAIProvider,
    private indexer: CodeIndexer,
    private privacyGuard: PrivacyGuard
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {

    // Debounce - don't trigger too often
        const now = Date.now();
        if (now - this.lastCompletionTime < this.minDelay) {
            return [];
        }
        this.lastCompletionTime = now;
        
        const line = document.lineAt(position.line);
    // Get current line
    const linePrefix = line.text.substring(0, position.character);

    // Skip if line is too short or just whitespace
    if (linePrefix.trim().length < 2) {
      console.log("Skipping - line too short");
      return [];
    }

    // Skip if typing in middle of line
        const lineSuffix = line.text.substring(position.character);
        if (lineSuffix.trim().length > 0) {
            return [];
        }

    // Skip if in middle of word
    if (position.character > 0) {
      const charBefore = document.lineAt(position.line).text[
        position.character - 1
      ];
      if (/\w/.test(charBefore)) {
        return [];
      }
    }

    console.log("Getting completion for:", linePrefix);

    // Get context from surrounding code
    const contextLines = this.getContext(document, position);

    // Build prompt
    const prompt = `${contextLines}\n${linePrefix}`;

    try {

      // Get context from surrounding code
    const contextLines = this.getContext(document, position);

    // Build prompt
    const prompt = `${contextLines}\n${linePrefix}`;


      // Get completion from AI
      const completion = await this.localAI.generateCompletion(
        prompt,
        this.indexer.getContext(),
        150 // max tokens
      );

      // Check if VS Code cancelled the request
        if (token.isCancellationRequested) {
            console.log("Cancelled by VS Code");
            return [];
        }

      if (!completion) {
        console.log("No completion or cancelled");
        return [];
      }

      console.log("AI suggested:", completion);

      // Create the inline completion item
      const item = new vscode.InlineCompletionItem(
        completion,
        new vscode.Range(position, position),
        {
          title: "AI Generated",
          command: "sidekick-ai.acceptedCompletion",
          arguments: [completion],
        }
      );

      console.log('📦 Returning completion item');

      // Return as inline completion
      return [item];
    } catch (error) {
      console.error("Completion error:", error);
      return [];
    }
  }

  private getContext(
    document: vscode.TextDocument,
    position: vscode.Position
  ): string {
    const startLine = Math.max(0, position.line - 10);
    const endLine = position.line;

    const lines = [];
    for (let i = startLine; i < endLine; i++) {
      lines.push(document.lineAt(i).text);
    }

    return lines.join("\n");
  }

//   private shouldTriggerCompletion(linePrefix: string): boolean {
//     // Common coding patterns that should trigger completion
//     const patterns = [
//         /\s+$/,           // After space
//         /[={(\[]$/,       // After =, {, (, [
//         />$/,             // After >
//         /:\s*$/,          // After colon
//         /\/\/\s*\w+/,     // After comment with text
//         /\breturn\s+$/,   // After return
//         /\bif\s*\(/,      // In if statement
//         /\bfor\s*\(/,     // In for loop
//         /\bwhile\s*\(/,   // In while loop
//         /\bfunction\s+\w+/, // After function name
//         /\bclass\s+\w+/,    // After class name
//         /\bconst\s+\w+\s*=\s*$/, // After const x =
//         /\blet\s+\w+\s*=\s*$/,   // After let x =
//     ];
    
//     return patterns.some(pattern => pattern.test(linePrefix));
// }

//   private async getMultiLineCompletion(
//     document: vscode.TextDocument,
//     position: vscode.Position
// ): Promise<string> {
//     // Get more context
//     const beforeLines = [];
//     for (let i = Math.max(0, position.line - 20); i < position.line; i++) {
//         beforeLines.push(document.lineAt(i).text);
//     }
    
//     const currentLine = document.lineAt(position.line).text.substring(0, position.character);
    
//     const prompt = beforeLines.join('\n') + '\n' + currentLine;
    
//     // Request longer completion
//     const completion = await this.localAI.generateCompletion(
//         prompt,
//         '',
//         200  // More tokens for multi-line
//     );
    
//     return completion;
// }
}
