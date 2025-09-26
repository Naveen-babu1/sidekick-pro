// // src/providers/InlineCompletionProvider.ts - Optimized version
// import * as vscode from "vscode";
// import { ModelService } from "../services/modelService";
// import { CodeIndexer } from "../indexer/CodeIndexer";

// export class InlineCompletionProvider
//   implements vscode.InlineCompletionItemProvider
// {
//   private modelService: ModelService;
//   private codeIndexer: CodeIndexer;
  
//   // Caching and deduplication
//   private completionCache = new Map<string, { completion: string, timestamp: number }>();
//   private pendingRequests = new Map<string, Promise<string>>();
//   private lastRequestKey: string = "";
//   private lastPosition: vscode.Position | null = null;
  
//   // Timing controls
//   private debounceTimer: NodeJS.Timeout | undefined;
//   private readonly DEBOUNCE_DELAY = 300; // Increased from 500ms
//   private readonly CACHE_TTL = 60000; // 1 minute cache
//   private readonly MIN_TYPING_PAUSE = 500; // Minimum pause before triggering
//   private lastKeystrokeTime = 0;
  
//   // Request limiting
//   private requestCount = 0;
//   private requestResetTime = Date.now();
//   private readonly MAX_REQUESTS_PER_MINUTE = 20;

//   constructor(modelService: ModelService, codeIndexer: CodeIndexer) {
//     this.modelService = modelService;
//     this.codeIndexer = codeIndexer;
//     console.log("InlineCompletionProvider initialized - debug version");
//   }

//   async provideInlineCompletionItems(
//     document: vscode.TextDocument,
//     position: vscode.Position,
//     context: vscode.InlineCompletionContext,
//     token: vscode.CancellationToken
//   ): Promise<vscode.InlineCompletionItem[] | undefined> {
    
//     // Rate limiting check
//     if (!this.checkRateLimit()) {
//       console.log("Rate limit exceeded, skipping completion");
//       return undefined;
//     }
    
//     const lineText = document.lineAt(position.line).text;
//     const textBeforeCursor = lineText.substring(0, position.character);
//     const textAfterCursor = lineText.substring(position.character);
//     console.log(`Completion triggered at ${position.line}:${position.character}`);
//     console.log(`Text before cursor: "${textBeforeCursor}"`);
//     // Skip if conditions aren't right
//     if (!this.shouldProvideCompletion(textBeforeCursor, position)) {
//       return undefined;
//     }
//     if (textBeforeCursor.trim().length < 2) {
//       console.log("Skipping - text too short");
//       return undefined;
//     }
    
//     // Create a unique key for this request
//     const requestKey = this.createRequestKey(document, position, textBeforeCursor);
    
//     // Check if this is the same as last request
//     if (requestKey === this.lastRequestKey) {
//       return undefined;
//     }
    
//     // Check cache first
//     const cached = this.getCachedCompletion(requestKey);
//     if (cached) {
//       console.log("Using cached completion");
//       return [new vscode.InlineCompletionItem(cached)];
//     }
    
//     // Check for quick patterns
//     const quickCompletion = this.getQuickPattern(textBeforeCursor, document.languageId);
//     if (quickCompletion) {
//       console.log("Using quick pattern completion");
//       return [new vscode.InlineCompletionItem(quickCompletion)];
//     }
    
//     // Check if we have a pending request for this key
//     if (this.pendingRequests.has(requestKey)) {
//       console.log("Reusing pending request");
//       try {
//         const completion = await this.pendingRequests.get(requestKey)!;
//         return completion ? [new vscode.InlineCompletionItem(completion)] : undefined;
//       } catch {
//         return undefined;
//       }
//     }
    
//     // Debounce the API call
//     return new Promise((resolve) => {
//       if (this.debounceTimer) {
//         clearTimeout(this.debounceTimer);
//       }
      
//       this.debounceTimer = setTimeout(async () => {
//         if (token.isCancellationRequested) {
//           resolve(undefined);
//           return;
//         }
        
//         // Create and store the pending request
//         const requestPromise = this.fetchCompletion(
//           document,
//           position,
//           textBeforeCursor,
//           textAfterCursor,
//           requestKey
//         );
        
//         this.pendingRequests.set(requestKey, requestPromise);
        
//         try {
//           const prompt = `Complete: ${textBeforeCursor}`;
//         console.log("Calling ModelService...");
        
//         const completion = await this.modelService.generateCompletion(
//           prompt, 
//           '', 
//           30, 
//           document.languageId
//         );
        
//         console.log(`Got completion: "${completion}"`);
          
//           if (completion && completion.trim()) {
//             this.lastRequestKey = requestKey;
//             resolve([new vscode.InlineCompletionItem(completion)]);
//           } else {
//             resolve(undefined);
//           }
//         } catch (error) {
//           console.error("Completion error:", error);
//           resolve(undefined);
//         } finally {
//           // Clean up pending request
//           this.pendingRequests.delete(requestKey);
//         }
//       }, this.DEBOUNCE_DELAY);
//     });
//   }
  
//   private shouldProvideCompletion(textBeforeCursor: string, position: vscode.Position): boolean {
//     // Don't complete empty lines or very short text
//     if (textBeforeCursor.trim().length < 2) {
//       return false;
//     }
    
//     // Skip if typing too fast (user is still actively typing)
//     const now = Date.now();
//     if (now - this.lastKeystrokeTime < this.MIN_TYPING_PAUSE) {
//       this.lastKeystrokeTime = now;
//       return false;
//     }
//     this.lastKeystrokeTime = now;
    
//     // Skip if cursor hasn't moved much
//     if (this.lastPosition && 
//         Math.abs(position.line - this.lastPosition.line) === 0 &&
//         Math.abs(position.character - this.lastPosition.character) <= 1) {
//       return false;
//     }
//     this.lastPosition = position;
    
//     // Skip comments and strings
//     const trimmed = textBeforeCursor.trim();
//     if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')) {
//       return false;
//     }
    
//     // Skip if inside a string (simple check)
//     const quotes = (textBeforeCursor.match(/["'`]/g) || []).length;
//     if (quotes % 2 !== 0) {
//       return false;
//     }
    
//     return true;
//   }
  
//   private checkRateLimit(): boolean {
//     const now = Date.now();
    
//     // Reset counter every minute
//     if (now - this.requestResetTime > 60000) {
//       this.requestCount = 0;
//       this.requestResetTime = now;
//     }
    
//     if (this.requestCount >= this.MAX_REQUESTS_PER_MINUTE) {
//       return false;
//     }
    
//     this.requestCount++;
//     return true;
//   }
  
//   private createRequestKey(
//     document: vscode.TextDocument,
//     position: vscode.Position,
//     textBeforeCursor: string
//   ): string {
//     // Create a unique key that represents this specific completion context
//     const contextLines = this.getContextLines(document, position, 3);
//     return `${document.fileName}:${position.line}:${textBeforeCursor}:${contextLines}`;
//   }
  
//   private getContextLines(
//     document: vscode.TextDocument,
//     position: vscode.Position,
//     lineCount: number
//   ): string {
//     const startLine = Math.max(0, position.line - lineCount);
//     const lines = [];
    
//     for (let i = startLine; i < position.line; i++) {
//       lines.push(document.lineAt(i).text.trim());
//     }
    
//     return lines.join('|');
//   }
  
//   private getCachedCompletion(key: string): string | null {
//     const cached = this.completionCache.get(key);
    
//     if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
//       return cached.completion;
//     }
    
//     // Clean up expired entry
//     if (cached) {
//       this.completionCache.delete(key);
//     }
    
//     return null;
//   }
  
//   private getQuickPattern(textBeforeCursor: string, languageId: string): string | null {
//     // Common patterns that don't need API calls
//     const patterns: Record<string, Array<[RegExp, string]>> = {
//       javascript: [
//         [/^if\s*\($/, 'condition) {\n    \n}'],
//         [/^for\s*\($/, 'let i = 0; i < array.length; i++) {\n    \n}'],
//         [/^while\s*\($/, 'condition) {\n    \n}'],
//         [/^function\s+\w+\s*\($/, ') {\n    \n}'],
//         [/^const\s+\w+\s*=\s*\[$/, '];'],
//         [/^const\s+\w+\s*=\s*\{$/, '\n    \n};'],
//         [/^return\s+$/, 'null;'],
//         [/^console\.$/, 'log();'],
//         [/^async\s+function\s+\w+\s*\($/, ') {\n    \n}'],
//         [/^}\s+catch\s*\($/, 'error) {\n    console.error(error);\n}'],
//       ],
//       typescript: [
//         [/^interface\s+\w+\s*\{?$/, ' {\n    \n}'],
//         [/^type\s+\w+\s*=\s*$/, '{\n    \n};'],
//         [/^enum\s+\w+\s*\{?$/, ' {\n    \n}'],
//         [/^class\s+\w+\s*(extends\s+\w+\s*)?\{?$/, ' {\n    constructor() {\n        \n    }\n}'],
//       ],
//       python: [
//         [/^def\s+\w+\s*\($/, '):\n    '],
//         [/^class\s+\w+(\([\w,\s]*\))?\s*:?$/, ':\n    def __init__(self):\n        '],
//         [/^if\s+.+:$/, '\n    '],
//         [/^for\s+\w+\s+in\s+.+:$/, '\n    '],
//         [/^while\s+.+:$/, '\n    '],
//         [/^try:$/, '\n    \nexcept Exception as e:\n    '],
//       ]
//     };
    
//     const langPatterns = [...(patterns[languageId] || []), ...(patterns.javascript || [])];
    
//     for (const [pattern, completion] of langPatterns) {
//       if (pattern.test(textBeforeCursor.trim())) {
//         return completion;
//       }
//     }
    
//     return null;
//   }
  
//   private async fetchCompletion(
//     document: vscode.TextDocument,
//     position: vscode.Position,
//     textBeforeCursor: string,
//     textAfterCursor: string,
//     requestKey: string
//   ): Promise<string> {
//     console.log(`Fetching completion for line ${position.line}`);
    
//     try {
//       // Get context
//       const contextLines = [];
//       const startLine = Math.max(0, position.line - 5);
      
//       for (let i = startLine; i < position.line; i++) {
//         contextLines.push(document.lineAt(i).text);
//       }
      
//       // Build focused prompt
//       const prompt = this.createCompletionPrompt(
//         contextLines.join('\n'),
//         textBeforeCursor,
//         textAfterCursor,
//         document.languageId
//       );
      
//       // Fetch with timeout
//       const completion = await Promise.race([
//         this.modelService.generateCompletion(prompt, '', 50, document.languageId),
//         new Promise<string>((_, reject) => 
//           setTimeout(() => reject(new Error('Timeout')), 2000)
//         )
//       ]) as string;
      
//       if (completion && completion.trim()) {
//         const cleaned = this.cleanCompletion(completion, textBeforeCursor);
        
//         // Cache the result
//         this.completionCache.set(requestKey, {
//           completion: cleaned,
//           timestamp: Date.now()
//         });
        
//         // Clean old cache entries
//         this.cleanCache();
        
//         return cleaned;
//       }
      
//     } catch (error) {
//       if (error instanceof Error && error.message === 'Timeout') {
//         console.log('Completion request timed out');
//       } else {
//         console.error('Completion fetch error:', error);
//       }
//     }
    
//     return '';
//   }

//   private createCompletionPrompt(
//     context: string,
//     textBeforeCursor: string,
//     textAfterCursor: string,
//     languageId: string
//   ): string {
//     // If there's text after cursor, we're doing middle completion
//     if (textAfterCursor.trim()) {
//       return `Language: ${languageId}

// Context:
// ${context}

// Complete the code between START and END markers. Only provide what goes in the middle:
// START: ${textBeforeCursor}
// MIDDLE: 
// END: ${textAfterCursor}

// Provide only the missing code that goes in MIDDLE, nothing else:`;
//     }

//     // Otherwise, complete from cursor position
//     return `Language: ${languageId}

// Context:
// ${context}

// Continue this line of code naturally:
// ${textBeforeCursor}

// Complete only the rest of this line or the immediate next statement. Be concise:`;
//   }

//   private cleanCompletion(
//     completion: string,
//     textBeforeCursor: string
//   ): string {
//     if (!completion) return "";

//     // Remove markdown code blocks
//     completion = completion
//       .replace(/^```[\w]*\n?/gm, "")
//       .replace(/\n?```$/gm, "");

//     // Remove any repetition of the prompt
//     if (completion.includes(textBeforeCursor)) {
//       const index = completion.lastIndexOf(textBeforeCursor);
//       completion = completion.substring(index + textBeforeCursor.length);
//     }

//     // Remove common prefixes that OpenAI might add
//     completion = completion.replace(
//       /^(MIDDLE:|Complete:|Completion:|Here's|The completion|The code)/i,
//       ""
//     );

//     // Trim but preserve leading spaces for indentation
//     completion = completion.trimEnd();

//     // Remove explanatory text
//     const explanationIndex = completion.search(
//       /\n\n(This |The |Note:|Explanation:)/i
//     );
//     if (explanationIndex > 0) {
//       completion = completion.substring(0, explanationIndex);
//     }

//     // Limit to reasonable length for inline completion
//     const lines = completion.split("\n");
//     if (lines.length > 5) {
//       completion = lines.slice(0, 5).join("\n");
//     }

//     return completion;
//   }
  
//   private cleanCache() {
//     const now = Date.now();
//     const keysToDelete: string[] = [];
    
//     this.completionCache.forEach((value, key) => {
//       if (now - value.timestamp > this.CACHE_TTL) {
//         keysToDelete.push(key);
//       }
//     });
    
//     keysToDelete.forEach(key => this.completionCache.delete(key));
    
//     // Also limit cache size
//     if (this.completionCache.size > 100) {
//       const sortedEntries = Array.from(this.completionCache.entries())
//         .sort((a, b) => a[1].timestamp - b[1].timestamp);
      
//       // Keep only the 50 most recent
//       for (let i = 0; i < sortedEntries.length - 50; i++) {
//         this.completionCache.delete(sortedEntries[i][0]);
//       }
//     }
//   }

//   public clearCache() {
//     this.completionCache.clear();
//     this.pendingRequests.clear();
//     this.lastRequestKey = "";
//     this.requestCount = 0;
//     console.log("Completion cache cleared");
//   }
  
//   public setEnabled(enabled: boolean) {
//     if (!enabled) {
//       this.clearCache();
//       if (this.debounceTimer) {
//         clearTimeout(this.debounceTimer);
//       }
//     }
//   }
  
//   public getStats() {
//     return {
//       cacheSize: this.completionCache.size,
//       pendingRequests: this.pendingRequests.size,
//       requestsThisMinute: this.requestCount,
//       maxRequestsPerMinute: this.MAX_REQUESTS_PER_MINUTE
//     };
//   }
// }

// src/providers/InlineCompletionProvider.ts - Enhanced debug version
import * as vscode from "vscode";
import { ModelService } from "../services/modelService";
import { CodeIndexer } from "../indexer/CodeIndexer";

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private modelService: ModelService;
  private codeIndexer: CodeIndexer;
  
  // Simplified caching for debugging
  private completionCache = new Map<string, { completion: string, timestamp: number }>();
  private lastRequestKey: string = "";
  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly DEBOUNCE_DELAY = 300; // Keep low for testing
  
  // Request tracking
  private requestCount = 0;
  private requestResetTime = Date.now();

  constructor(modelService: ModelService, codeIndexer: CodeIndexer) {
    this.modelService = modelService;
    this.codeIndexer = codeIndexer;
    console.log("InlineCompletionProvider initialized - debug version");
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    
    const lineText = document.lineAt(position.line).text;
    const textBeforeCursor = lineText.substring(0, position.character);
    
    console.log(`Completion triggered at ${position.line}:${position.character}`);
    console.log(`Text before cursor: "${textBeforeCursor}"`);
    
    // Check minimum length
    if (textBeforeCursor.trim().length < 2) {
      console.log("Skipping - text too short");
      return undefined;
    }
    
    // FIRST - Try quick patterns for immediate response
    const quickPattern = this.getQuickPattern(textBeforeCursor.trim(), document.languageId);
    if (quickPattern) {
      console.log(`Quick pattern matched! Returning: "${quickPattern.substring(0, 20)}..."`);
      return [new vscode.InlineCompletionItem(quickPattern)];
    }
    
    // Check if we should skip (comments/strings)
    if (this.shouldSkip(textBeforeCursor)) {
      console.log("Skipping - in comment or string");
      return undefined;
    }
    
    // Create cache key
    const cacheKey = `${document.fileName}:${position.line}:${textBeforeCursor}`;
    
    // Check cache
    const cached = this.completionCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < 60000)) {
      console.log("Returning cached completion");
      return [new vscode.InlineCompletionItem(cached.completion)];
    }
    
    // Skip if same as last request
    if (cacheKey === this.lastRequestKey) {
      console.log("Skipping duplicate request");
      return undefined;
    }
    
    // For debugging - try immediate completion without debounce
    if (textBeforeCursor.trim().endsWith("const") || 
        textBeforeCursor.trim().endsWith("let") ||
        textBeforeCursor.trim().endsWith("function")) {
      console.log("Triggering immediate API call for keyword");
      
      try {
        const prompt = `Complete: ${textBeforeCursor}`;
        console.log("Calling ModelService...");
        
        const completion = await this.modelService.generateCompletion(
          prompt, 
          '', 
          30, 
          document.languageId
        );
        
        console.log(`Got completion: "${completion}"`);
        
        if (completion && completion.trim()) {
          const cleaned = this.cleanCompletion(completion, textBeforeCursor);
          console.log(`Cleaned completion: "${cleaned}"`);
          
          if (cleaned) {
            // Cache it
            this.completionCache.set(cacheKey, {
              completion: cleaned,
              timestamp: Date.now()
            });
            
            this.lastRequestKey = cacheKey;
            return [new vscode.InlineCompletionItem(cleaned)];
          }
        }
      } catch (error) {
        console.error("API call error:", error);
      }
    }
    
    // Use debouncing for other cases
    return new Promise((resolve) => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      
      this.debounceTimer = setTimeout(async () => {
        console.log("Debounce fired - making API call");
        
        if (token.isCancellationRequested) {
          resolve(undefined);
          return;
        }
        
        try {
          this.requestCount++;
          this.lastRequestKey = cacheKey;
          
          // Get context
          const contextLines = [];
          const startLine = Math.max(0, position.line - 3);
          for (let i = startLine; i < position.line; i++) {
            contextLines.push(document.lineAt(i).text);
          }
          
          const prompt = `Language: ${document.languageId}
Context: ${contextLines.join('\n')}
Complete this line: ${textBeforeCursor}
Provide only the code completion:`;
          
          console.log("Sending prompt to API...");
          
          const completion = await Promise.race([
            this.modelService.generateCompletion(prompt, '', 50, document.languageId),
            new Promise<string>((_, reject) => 
              setTimeout(() => reject(new Error('Timeout')), 2000)
            )
          ]) as string;
          
          console.log(`API response: "${completion?.substring(0, 50)}..."`);
          
          if (completion && completion.trim()) {
            const cleaned = this.cleanCompletion(completion, textBeforeCursor);
            
            if (cleaned) {
              this.completionCache.set(cacheKey, {
                completion: cleaned,
                timestamp: Date.now()
              });
              
              resolve([new vscode.InlineCompletionItem(cleaned)]);
              return;
            }
          }
          
          console.log("No valid completion to return");
          resolve(undefined);
          
        } catch (error) {
          console.error("Completion error:", error);
          resolve(undefined);
        }
      }, this.DEBOUNCE_DELAY);
    });
  }
  
  private shouldSkip(text: string): boolean {
    const trimmed = text.trim();
    
    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')) {
      return true;
    }
    
    // Skip if in string
    const quotes = (text.match(/["'`]/g) || []).length;
    if (quotes % 2 !== 0) {
      return true;
    }
    
    return false;
  }
  
  private getQuickPattern(text: string, language: string): string | null {
    console.log(`Checking quick patterns for: "${text}"`);
    
    const patterns: Array<[RegExp, string]> = [
      [/^if\s*\($/, 'condition) {\n    \n}'],
      [/^for\s*\($/, 'let i = 0; i < array.length; i++) {\n    \n}'],
      [/^while\s*\($/, 'condition) {\n    \n}'],
      [/^function\s+\w+\s*\($/, ') {\n    \n}'],
      [/^console\.$/, 'log();'],
      [/^return$/, ' null;'],
      [/^else$/, ' if (condition) {\n    \n}'],
      [/^try$/, ' {\n    \n} catch (error) {\n    console.error(error);\n}'],
    ];
    
    for (const [pattern, completion] of patterns) {
      if (pattern.test(text)) {
        console.log(`Pattern matched: ${pattern}`);
        return completion;
      }
    }
    
    return null;
  }
  
  private cleanCompletion(completion: string, textBeforeCursor: string): string {
    if (!completion) return "";
    
    // Remove markdown
    completion = completion.replace(/^```[\w]*\n?/gm, "").replace(/\n?```$/gm, "");
    
    // Remove the prompt if it's repeated
    if (completion.includes(textBeforeCursor)) {
      const index = completion.indexOf(textBeforeCursor);
      completion = completion.substring(index + textBeforeCursor.length);
    }
    
    // Remove common AI prefixes
    completion = completion.replace(/^(Complete:|Here's|The completion|The code)/i, "").trim();
    
    // Limit length
    const lines = completion.split("\n");
    if (lines.length > 3) {
      completion = lines.slice(0, 3).join("\n");
    }
    
    console.log(`Cleaned completion: "${completion.substring(0, 30)}..."`);
    
    return completion;
  }
  
  public clearCache() {
    this.completionCache.clear();
    this.lastRequestKey = "";
    this.requestCount = 0;
    console.log("Cache cleared");
  }
  
  public setEnabled(enabled: boolean) {
    console.log(`Completions ${enabled ? 'enabled' : 'disabled'}`);
  }
  
  public getStats() {
    return {
      cacheSize: this.completionCache.size,
      requestsThisMinute: this.requestCount,
      maxRequestsPerMinute: 30,
      pendingRequests: 0
    };
  }
}