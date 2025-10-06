// import * as vscode from "vscode";
// import { ModelService } from "../services/modelService";
// import { CodeIndexer } from "../indexer/CodeIndexer";
// import { ContextExtractor, ExtractedContext } from "../services/ContextExtractor";
// import { SmartCache } from "../services/SmartCache";
// import { PromptTemplates } from "../services/PromptTemplates";

// export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
//   private modelService: ModelService;
//   private codeIndexer: CodeIndexer;

//   private contextExtractor = ContextExtractor.getInstance();
//   private cache = SmartCache.getInstance();
//   private promptTemplates = PromptTemplates.getInstance();
  
//   // Deduplication and throttling
//   private activeRequests = new Map<string, Promise<vscode.InlineCompletionItem[] | undefined>>();
//   private lastCompletionPosition: vscode.Position | undefined;
//   private lastCompletionTime = 0;
//   private readonly MIN_DELAY_MS = 500;
  
//   // Track rejected completions
//   private rejectedCompletions = new Map<string, Set<string>>();
//   private readonly REJECTION_CACHE_TTL = 60000; // 1 minute
  
//   // Request tracking
//   private requestCount = 0;
//   private requestResetTime = Date.now();
//   private readonly MAX_REQUESTS_PER_MINUTE = 15;
  
//   // Debouncing
//   private debounceTimer: NodeJS.Timeout | undefined;
//   private readonly DEBOUNCE_DELAY = 800;

//   // Track last suggestion to avoid repeats
//   private lastSuggestion = "";
//   private lastSuggestionPosition: vscode.Position | undefined;

//   constructor(modelService: ModelService, codeIndexer: CodeIndexer) {
//     this.modelService = modelService;
//     this.codeIndexer = codeIndexer;
//     console.log("InlineCompletionProvider initialized - FIXED version");
//   }

//   async provideInlineCompletionItems(
//     document: vscode.TextDocument,
//     position: vscode.Position,
//     context: vscode.InlineCompletionContext,
//     token: vscode.CancellationToken
//   ): Promise<vscode.InlineCompletionItem[] | undefined> {
    
//     // Check if we've moved significantly from last position
//     if (this.lastSuggestionPosition && 
//         this.lastSuggestionPosition.line === position.line &&
//         Math.abs(this.lastSuggestionPosition.character - position.character) < 3) {
//       // User is still typing in same area where they rejected a completion
//       console.log("User still typing after rejection - skipping");
//       return undefined;
//     }
    
//     // Throttle rapid requests
//     const now = Date.now();
//     if (now - this.lastCompletionTime < this.MIN_DELAY_MS) {
//       console.log("Throttling - too soon since last request");
//       return undefined;
//     }
    
//     const lineText = document.lineAt(position.line).text;
//     const textBeforeCursor = lineText.substring(0, position.character);
//     const textAfterCursor = lineText.substring(position.character);
    
//     console.log(`Completion triggered at ${position.line}:${position.character}`);
//     console.log(`Text before cursor: "${textBeforeCursor}"`);
    
//     // Skip if text too short
//     if (textBeforeCursor.trim().length < 2) {
//       console.log("Skipping - text too short");
//       return undefined;
//     }
    
//     // Skip if we're in the middle of a word
//     if (this.isInMiddleOfWord(textBeforeCursor, textAfterCursor)) {
//       console.log("Skipping - in middle of word");
//       return undefined;
//     }

//     // Check if this completion was already rejected
//     if (this.wasRejected(document.fileName, textBeforeCursor)) {
//       console.log("Skipping - completion was previously rejected");
//       return undefined;
//     }

//     // Rate limiting check
//     if (!this.checkRateLimit()) {
//       console.log("Rate limit exceeded");
//       return undefined;
//     }
    
//     // Create a unique request key
//     const requestKey = `${document.fileName}:${position.line}:${position.character}:${textBeforeCursor}`;
    
//     // Check if we already have an active request for this exact position
//     if (this.activeRequests.has(requestKey)) {
//       console.log("Reusing active request");
//       return this.activeRequests.get(requestKey);
//     }
    
//     // Create the completion promise
//     const completionPromise = this.generateCompletion(
//       document,
//       position,
//       textBeforeCursor,
//       token
//     );
    
//     // Store the active request
//     this.activeRequests.set(requestKey, completionPromise);
    
//     // Clean up after completion
//     completionPromise.finally(() => {
//       this.activeRequests.delete(requestKey);
//     });
    
//     // Update last position and time
//     this.lastCompletionPosition = position;
//     this.lastCompletionTime = now;
    
//     // Track completion acceptance/rejection
//     completionPromise.then(items => {
//       if (items && items.length > 0) {
//         // Monitor for acceptance/rejection
//         this.monitorCompletion(document.fileName, textBeforeCursor, items[0].insertText.toString(), position);
//       }
//     });
    
//     return completionPromise;
//   }

//   private async generateCompletion(
//     document: vscode.TextDocument,
//     position: vscode.Position,
//     textBeforeCursor: string,
//     token: vscode.CancellationToken
//   ): Promise<vscode.InlineCompletionItem[] | undefined> {
    
//     // Extract context
//     const extractedContext = await this.contextExtractor.extractContext(document, position);
//     console.log(`Context extracted in ${extractedContext.extractionTime}ms`);
    
//     // Build a better cache key that includes more context
//     const cacheKey = this.createDetailedCacheKey(document, position, textBeforeCursor, extractedContext);
    
//     // Skip cache for now to avoid stale completions
//     // const cached = await this.cache.get(cacheKey, extractedContext, 'completion');
//     // if (cached && !this.wasRejected(document.fileName, textBeforeCursor)) {
//     //   console.log("Using cached completion from SmartCache");
//     //   return [new vscode.InlineCompletionItem(cached)];
//     // }
    
//     // Check for quick patterns first
//     const quickPattern = this.getImprovedQuickPattern(textBeforeCursor, document.languageId);
//     if (quickPattern && quickPattern.length > 0) {
//       console.log("Quick pattern matched!");
//       return [new vscode.InlineCompletionItem(quickPattern)];
//     }
    
//     // Skip if in comment or string
//     if (this.shouldSkip(textBeforeCursor)) {
//       console.log("Skipping - in comment or string");
//       return undefined;
//     }
    
//     // Use debouncing for API calls
//     return new Promise((resolve) => {
//       if (this.debounceTimer) {
//         clearTimeout(this.debounceTimer);
//       }
      
//       this.debounceTimer = setTimeout(async () => {
//         console.log("Debounce fired - making API call");
        
//         if (token.isCancellationRequested) {
//           resolve(undefined);
//           return;
//         }
        
//         const result = await this.callModelService(
//           document, 
//           position, 
//           textBeforeCursor, 
//           extractedContext, 
//           cacheKey, 
//           token
//         );
//         resolve(result);
//       }, this.DEBOUNCE_DELAY);
//     });
//   }

//   private async callModelService(
//     document: vscode.TextDocument,
//     position: vscode.Position,
//     textBeforeCursor: string,
//     extractedContext: ExtractedContext,
//     cacheKey: string,
//     token: vscode.CancellationToken
//   ): Promise<vscode.InlineCompletionItem[] | undefined> {
    
//     try {
//       this.requestCount++;
      
//       // Build a much better prompt
//       const prompt = this.buildImprovedCompletionPrompt(textBeforeCursor, extractedContext, document, position);
      
//       console.log("Sending completion request to ModelService");
      
//       // Get completion with timeout
//       const completion = await Promise.race([
//         this.modelService.generateCompletion(
//           prompt, 
//           '', 
//           100, 
//           document.languageId
//         ),
//         new Promise<string>((_, reject) => 
//           setTimeout(() => reject(new Error('Timeout')), 2000)
//         )
//       ]) as string;
      
//       if (token.isCancellationRequested) {
//         return undefined;
//       }
      
//       if (completion && completion.trim()) {
//         const cleaned = this.improvedCleanCompletion(completion, textBeforeCursor, document.languageId);
        
//         if (cleaned && this.isValidCompletion(cleaned, textBeforeCursor)) {
//           // Don't cache for now to avoid issues
//           // await this.cache.set(cacheKey, cleaned, extractedContext, {
//           //   feature: 'completion',
//           //   language: document.languageId,
//           //   modelUsed: this.modelService.getCurrentProvider(),
//           //   ttl: 30000
//           // });
          
//           console.log(`Returning completion: "${cleaned.substring(0, 50)}..."`);
//           this.lastSuggestion = cleaned;
//           this.lastSuggestionPosition = position;
          
//           return [new vscode.InlineCompletionItem(cleaned)];
//         }
//       }
      
//       console.log("No valid completion generated");
//       return undefined;
      
//     } catch (error) {
//       console.error("Completion error:", error);
//       return undefined;
//     }
//   }

//   private buildImprovedCompletionPrompt(
//     textBeforeCursor: string,
//     context: ExtractedContext,
//     document: vscode.TextDocument,
//     position: vscode.Position
//   ): string {
//     const previousLines: string[] = [];
//     const nextLines: string[] = [];
    
//     // Get more context lines
//     for (let i = Math.max(0, position.line - 15); i < position.line; i++) {
//       previousLines.push(document.lineAt(i).text);
//     }
    
//     // Get following context
//     for (let i = position.line + 1; i < Math.min(document.lineCount, position.line + 5); i++) {
//       nextLines.push(document.lineAt(i).text);
//     }
    
//     // Analyze what the user is trying to write
//     const trimmed = textBeforeCursor.trim();
//     let intent = "complete the code";
    
//     if (trimmed.startsWith("const ") && trimmed.endsWith("=")) {
//       intent = "provide an appropriate value or expression after the equals sign";
//     } else if (trimmed.startsWith("const ") && !trimmed.includes("=")) {
//       intent = "complete the variable declaration with = and a value";
//     } else if (trimmed.endsWith("= x +")) {
//       intent = "complete the arithmetic expression";
//     } else if (trimmed.endsWith("= x *")) {
//       intent = "complete the multiplication expression";
//     }
    
//     // Build a clearer prompt
//     let prompt = `You are completing ${context.language} code. ${intent}.\n\n`;
    
//     if (previousLines.length > 0) {
//       prompt += `Previous code:\n${previousLines.join('\n')}\n\n`;
//     }
    
//     prompt += `Current incomplete line: ${textBeforeCursor}<CURSOR>\n\n`;
    
//     if (nextLines.length > 0) {
//       prompt += `Following code:\n${nextLines.join('\n')}\n\n`;
//     }
    
//     // Look at existing variables
//     const existingVars = previousLines.join('\n').match(/const\s+(\w+)\s*=/g);
//     if (existingVars) {
//       const varNames = existingVars.map(v => v.match(/const\s+(\w+)/)?.[1]).filter(Boolean);
//       prompt += `Available variables: ${varNames.join(', ')}\n\n`;
//     }
    
//     prompt += `Instructions: 
// - Complete ONLY what comes after the cursor
// - Do NOT repeat "${textBeforeCursor}"
// - If completing a const declaration, provide a meaningful value
// - If variables x, y, z exist, you can use them in expressions
// - Be contextually aware and smart
// - Maximum 2 lines
// - No explanations, just code`;
    
//     return prompt;
//   }

//   private improvedCleanCompletion(completion: string, textBeforeCursor: string, language: string): string {
//     if (!completion) return "";
    
//     let cleaned = completion;
    
//     // Remove markdown code blocks
//     cleaned = cleaned.replace(/^```[\w]*\n?/gm, "").replace(/\n?```$/gm, "");
    
//     // Remove any instruction echoing
//     cleaned = cleaned.replace(/^(Complete|Here's|The completion|Instructions:).*/gim, "").trim();
//     cleaned = cleaned.replace(/<CURSOR>/gi, "").trim();
    
//     // Critical: Remove any duplication of the input
//     if (cleaned.startsWith(textBeforeCursor)) {
//       cleaned = cleaned.substring(textBeforeCursor.length);
//     }
    
//     // Remove partial duplications
//     const trimmedBefore = textBeforeCursor.trim();
    
//     // Special handling for const declarations
//     if (trimmedBefore.match(/^const\s+\w+\s*$/)) {
//       // User typed "const varname" - we should add "= value"
//       if (!cleaned.startsWith('=')) {
//         cleaned = '= ' + cleaned;
//       }
//     } else if (trimmedBefore.endsWith('=')) {
//       // User typed "const varname =" - just add the value
//       cleaned = cleaned.replace(/^\s*=\s*/, ' ').trim();
//     }
    
//     // Remove nonsensical patterns
//     if (cleaned === 'x + y;' && !textBeforeCursor.includes('z')) {
//       // This is too generic
//       return "";
//     }
    
//     // Limit to reasonable number of lines
//     const cleanedLines = cleaned.split("\n");
//     if (cleanedLines.length > 2) {
//       cleaned = cleanedLines.slice(0, 2).join("\n");
//     }
    
//     return cleaned.trim();
//   }

//   private wasRejected(fileName: string, textBeforeCursor: string): boolean {
//     const key = `${fileName}:${textBeforeCursor}`;
//     const rejectedSet = this.rejectedCompletions.get(key);
    
//     if (!rejectedSet) return false;
    
//     // Clean up old rejections
//     const now = Date.now();
//     this.cleanupRejections(now);
    
//     return rejectedSet && rejectedSet.size > 0;
//   }
  
//   private monitorCompletion(fileName: string, textBeforeCursor: string, suggestion: string, position: vscode.Position) {
//     // After a short delay, check if the user continued typing something different
//     setTimeout(() => {
//       const editor = vscode.window.activeTextEditor;
//       if (!editor || editor.document.fileName !== fileName) return;
      
//       const currentLine = editor.document.lineAt(position.line).text;
//       const expectedText = textBeforeCursor + suggestion;
      
//       // If the current line doesn't contain our suggestion, it was rejected
//       if (!currentLine.includes(suggestion.trim().substring(0, Math.min(10, suggestion.length)))) {
//         this.markAsRejected(fileName, textBeforeCursor, suggestion);
//       }
//     }, 1000);
//   }
  
//   private markAsRejected(fileName: string, textBeforeCursor: string, suggestion: string) {
//     const key = `${fileName}:${textBeforeCursor}`;
    
//     if (!this.rejectedCompletions.has(key)) {
//       this.rejectedCompletions.set(key, new Set());
//     }
    
//     this.rejectedCompletions.get(key)!.add(suggestion);
//     console.log(`Marked as rejected: "${suggestion}" for "${textBeforeCursor}"`);
//   }
  
//   private cleanupRejections(now: number) {
//     // Remove old rejections
//     for (const [key, _] of this.rejectedCompletions.entries()) {
//       // Simple TTL - clear after 1 minute
//       // In production, you'd track timestamps properly
//       if (this.rejectedCompletions.size > 100) {
//         this.rejectedCompletions.clear();
//       }
//     }
//   }

//   private isInMiddleOfWord(textBefore: string, textAfter: string): boolean {
//     if (textAfter.length === 0) return false;
    
//     const lastCharBefore = textBefore[textBefore.length - 1];
//     const firstCharAfter = textAfter[0];
    
//     return /\w/.test(lastCharBefore || '') && /\w/.test(firstCharAfter || '');
//   }

//   private checkRateLimit(): boolean {
//     const now = Date.now();
    
//     // Reset counter every minute
//     if (now - this.requestResetTime > 60000) {
//       this.requestCount = 0;
//       this.requestResetTime = now;
//     }
    
//     return this.requestCount < this.MAX_REQUESTS_PER_MINUTE;
//   }
  
//   private createDetailedCacheKey(
//     document: vscode.TextDocument,
//     position: vscode.Position,
//     textBeforeCursor: string,
//     context: ExtractedContext
//   ): string {
//     // Include more context in the cache key to avoid collisions
//     const components = [
//       document.fileName,
//       position.line,
//       position.character,
//       textBeforeCursor.trim(),
//       context.currentFunction?.name || 'global',
//       context.language
//     ];
    
//     return components.join('::');
//   }
  
//   private shouldSkip(text: string): boolean {
//     const trimmed = text.trim();
    
//     // Skip comments
//     if (trimmed.startsWith('//') || trimmed.startsWith('#') || 
//         trimmed.startsWith('/*') || trimmed.startsWith('*')) {
//       return true;
//     }
    
//     // Skip if in string
//     const singleQuotes = (text.match(/'/g) || []).length;
//     const doubleQuotes = (text.match(/"/g) || []).length;
//     const backticks = (text.match(/`/g) || []).length;
    
//     if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0 || backticks % 2 !== 0) {
//       return true;
//     }
    
//     return false;
//   }
  
//   private getImprovedQuickPattern(text: string, language: string): string | null {
//     const trimmedText = text.trim();
    
//     // Much more specific patterns
//     const patterns: Array<[RegExp, string | ((match: RegExpMatchArray) => string)]> = [
//       // For variable declarations that need values
//       [/^const\s+(\w+)\s*=$/, (match) => {
//         const varName = match[1];
//         // Provide contextual defaults based on variable name
//         if (varName.includes('count') || varName.includes('num')) return ' 0;';
//         if (varName.includes('name') || varName.includes('str')) return ' "";';
//         if (varName.includes('flag') || varName.includes('is')) return ' false;';
//         if (varName.includes('list') || varName.includes('array')) return ' [];';
//         if (varName.includes('obj') || varName.includes('data')) return ' {};';
//         return ' null;';
//       }],
      
//       // Control structures
//       [/^if\s*\($/, ') {\n    \n}'],
//       [/^for\s*\($/, 'let i = 0; i < array.length; i++) {\n    \n}'],
//       [/^function\s+(\w+)\s*\($/, ') {\n    \n}'],
      
//       // Only suggest these if nothing else matches
//       [/^return$/, ' '],
//       [/^throw\s+new$/, ' Error("");'],
//     ];
    
//     for (const [pattern, completion] of patterns) {
//       const match = pattern.exec(trimmedText);
//       if (match) {
//         const result = typeof completion === 'function' ? completion(match) : completion;
//         console.log(`Pattern matched: ${pattern}, returning: ${result}`);
//         return result;
//       }
//     }
    
//     return null;
//   }
  
//   private isValidCompletion(completion: string, textBeforeCursor: string): boolean {
//     // Check if completion is too short
//     if (completion.length < 1) {
//       return false;
//     }
    
//     // Check if it's just repeating the input
//     if (completion === textBeforeCursor || completion === textBeforeCursor.trim()) {
//       return false;
//     }
    
//     // Check for nonsensical patterns
//     const badPatterns = [
//       /^undefined$/,
//       /^null$/,
//       /^TODO/i,
//       /^\?+$/,
//     ];
    
//     for (const pattern of badPatterns) {
//       if (pattern.test(completion)) {
//         return false;
//       }
//     }
    
//     return true;
//   }
  
//   public clearCache() {
//     this.cache.clear();
//     this.activeRequests.clear();
//     this.rejectedCompletions.clear();
//     this.lastCompletionPosition = undefined;
//     this.requestCount = 0;
//     this.lastSuggestion = "";
//     this.lastSuggestionPosition = undefined;
//     console.log("Cache and tracking cleared");
//   }
  
//   public getStats() {
//     const cacheStats = this.cache.getStatistics();
//     return {
//       cacheSize: cacheStats.memoryCacheSize,
//       patternCacheSize: cacheStats.patternCacheSize,
//       hitRate: cacheStats.hitRate,
//       requestsThisMinute: this.requestCount,
//       maxRequestsPerMinute: this.MAX_REQUESTS_PER_MINUTE,
//       totalHits: cacheStats.totalHits,
//       totalRequests: cacheStats.totalRequests,
//       activeRequests: this.activeRequests.size,
//       rejectedCompletions: this.rejectedCompletions.size
//     };
//   }
// }

import * as vscode from "vscode";
import { ModelService } from "../services/modelService";
import { CodeIndexer } from "../indexer/CodeIndexer";
import { ContextExtractor, ExtractedContext } from "../services/ContextExtractor";
import { SmartCache } from "../services/SmartCache";
import { PromptTemplates } from "../services/PromptTemplates";

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private modelService: ModelService;
  private codeIndexer: CodeIndexer;

  private contextExtractor = ContextExtractor.getInstance();
  private cache = SmartCache.getInstance();
  private promptTemplates = PromptTemplates.getInstance();
  
  // Request management
  private activeRequests = new Map<string, Promise<vscode.InlineCompletionItem[] | undefined>>();
  private lastCompletionTime = 0;
  private readonly MIN_DELAY_MS = 300; // Reduced from 500ms for better UX
  
  // Rejection tracking with better memory management
  private rejectedCompletions = new Map<string, { patterns: Set<string>, timestamp: number }>();
  private readonly REJECTION_CACHE_TTL = 300000; // 5 minutes
  
  // Rate limiting with sliding window
  private requestTimestamps: number[] = [];
  private readonly MAX_REQUESTS_PER_MINUTE = 15;
  private readonly RATE_LIMIT_WINDOW = 60000; // 1 minute
  
  // Improved debouncing
  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly DEBOUNCE_DELAY = 600; // Reduced from 1000ms

  // Track last position more accurately
  private lastPosition: vscode.Position | undefined;
  private lastDocument: vscode.TextDocument | undefined;
  private lastPrefix = "";
  private consecutiveRejections = 0;

  constructor(modelService: ModelService, codeIndexer: CodeIndexer) {
    this.modelService = modelService;
    this.codeIndexer = codeIndexer;
    console.log("InlineCompletionProvider initialized - OPTIMIZED version v2");
    
    // Cleanup old rejections periodically
    setInterval(() => this.cleanupRejections(), 60000);
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    
    const lineText = document.lineAt(position.line).text;
    const textBeforeCursor = lineText.substring(0, position.character);
    const textAfterCursor = lineText.substring(position.character);
    
    // Early exit conditions
    if (!this.shouldProvideCompletion(document, position, textBeforeCursor, textAfterCursor)) {
      return undefined;
    }
    
    // Check for quick patterns first (instant response)
    const quickPattern = await this.getQuickPattern(textBeforeCursor, document.languageId);
    if (quickPattern) {
      console.log(`Quick pattern matched: ${quickPattern.substring(0, 30)}...`);
      return [new vscode.InlineCompletionItem(quickPattern)];
    }
    
    // Check cache with context-aware key
    const extractedContext = await this.contextExtractor.extractContext(document, position);
    const cacheKey = this.createContextAwareCacheKey(document, position, extractedContext);
    
    const cached = await this.cache.get(cacheKey, extractedContext, 'completion');
    if (cached && !this.wasRecentlyRejected(cached)) {
      console.log("Using cached completion");
      return [new vscode.InlineCompletionItem(cached)];
    }
    
    // Rate limiting with sliding window
    if (!this.checkRateLimit()) {
      console.log("Rate limit exceeded - using fallback");
      return this.getFallbackCompletion(textBeforeCursor, document.languageId);
    }
    
    // Create unique request key for deduplication
    const requestKey = `${document.fileName}:${position.line}:${position.character}:${textBeforeCursor}`;
    
    // Check for active request
    if (this.activeRequests.has(requestKey)) {
      console.log("Reusing active request");
      return this.activeRequests.get(requestKey);
    }
    
    // Create debounced completion promise
    const completionPromise = this.getDebouncedCompletion(
      document,
      position,
      textBeforeCursor,
      extractedContext,
      cacheKey,
      token
    );
    
    this.activeRequests.set(requestKey, completionPromise);
    completionPromise.finally(() => {
      this.activeRequests.delete(requestKey);
    });
    
    // Update tracking
    this.lastPosition = position;
    this.lastDocument = document;
    this.lastPrefix = textBeforeCursor;
    this.lastCompletionTime = Date.now();
    
    return completionPromise;
  }

  private shouldProvideCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    textBeforeCursor: string,
    textAfterCursor: string
  ): boolean {
    // Skip if same position and prefix
    if (this.lastPosition?.isEqual(position) && 
        this.lastPrefix === textBeforeCursor &&
        this.lastDocument?.uri.toString() === document.uri.toString()) {
      console.log("Skipping - duplicate request");
      return false;
    }
    
    // Skip if text too short
    if (textBeforeCursor.trim().length < 2) {
      return false;
    }
    
    // Skip if in middle of word
    if (this.isInMiddleOfWord(textBeforeCursor, textAfterCursor)) {
      return false;
    }
    
    // Skip if in comment or string
    if (this.isInCommentOrString(textBeforeCursor, document.languageId)) {
      return false;
    }
    
    // Skip if too many recent rejections
    if (this.consecutiveRejections > 3) {
      console.log("Too many consecutive rejections - backing off");
      this.consecutiveRejections = 0; // Reset after backing off
      return false;
    }
    
    // Throttle rapid requests
    const now = Date.now();
    if (now - this.lastCompletionTime < this.MIN_DELAY_MS) {
      return false;
    }
    
    return true;
  }

  private async getDebouncedCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    textBeforeCursor: string,
    extractedContext: ExtractedContext,
    cacheKey: string,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    
    return new Promise((resolve) => {
      // Clear existing timer
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      
      this.debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested) {
          resolve(undefined);
          return;
        }
        
        try {
          // Add to rate limit tracking
          this.requestTimestamps.push(Date.now());
          
          // Build optimized prompt using templates
          const prompt = this.promptTemplates.completionPrompt(extractedContext, {
            maxTokens: 100,
            temperature: 0.2,
            style: 'concise'
          });
          
          console.log("Sending completion request to ModelService");
          
          // Get completion with timeout
          const completion = await Promise.race([
            this.modelService.generateCompletion(
              prompt, 
              '', 
              100, 
              document.languageId
            ),
            new Promise<string>((_, reject) => 
              setTimeout(() => reject(new Error('Timeout')), 3000)
            )
          ]) as string;
          
          if (token.isCancellationRequested) {
            resolve(undefined);
            return;
          }
          
          if (completion && completion.trim()) {
            const cleaned = this.cleanCompletion(completion, textBeforeCursor, document.languageId);
            
            if (cleaned && this.isValidCompletion(cleaned, textBeforeCursor)) {
              // Cache the result
              await this.cache.set(cacheKey, cleaned, extractedContext, {
                feature: 'completion',
                language: document.languageId,
                modelUsed: this.modelService.getCurrentProvider(),
                ttl: 60000 // 1 minute cache
              });
              
              // Monitor for rejection
              this.monitorCompletion(document.fileName, textBeforeCursor, cleaned, position);
              
              resolve([new vscode.InlineCompletionItem(cleaned)]);
              return;
            }
          }
          
          resolve(undefined);
          
        } catch (error) {
          console.error("Completion error:", error);
          resolve(this.getFallbackCompletion(textBeforeCursor, document.languageId));
        }
      }, this.DEBOUNCE_DELAY);
    });
  }

  private async getQuickPattern(text: string, language: string): Promise<string | null> {
    const trimmed = text.trim();
    
    // Language-specific patterns
    const patterns = this.getLanguagePatterns(language);
    
    for (const [pattern, completion] of patterns) {
      const match = pattern.exec(trimmed);
      if (match) {
        const result = typeof completion === 'function' ? completion(match) : completion;
        return result;
      }
    }
    
    return null;
  }

  private getLanguagePatterns(language: string): Array<[RegExp, string | ((match: RegExpMatchArray) => string)]> {
    const commonPatterns: Array<[RegExp, string | ((match: RegExpMatchArray) => string)]> = [
      // Control structures
      [/^if\s*\($/, ') {\n    \n}'],
      [/^for\s*\($/, 'let i = 0; i < array.length; i++) {\n    \n}'],
      [/^while\s*\($/, 'condition) {\n    \n}'],
      [/^switch\s*\($/, 'expression) {\n    case value:\n        \n        break;\n}'],
      
      // Common patterns
      [/^console\.$/, 'log();'],
      [/^return\s*$/, ' '],
      [/^throw\s+new\s*$/, ' Error("");'],
    ];
    
    const languageSpecific: Record<string, Array<[RegExp, string | ((match: RegExpMatchArray) => string)]>> = {
      javascript: [
        ...commonPatterns,
        [/^(const|let|var)\s+(\w+)\s*=\s*$/, (match) => {
          const varName = match[2].toLowerCase();
          if (varName.includes('count') || varName.includes('num')) return '0;';
          if (varName.includes('name') || varName.includes('str')) return '"";';
          if (varName.includes('is') || varName.includes('has')) return 'false;';
          if (varName.includes('list') || varName.includes('arr')) return '[];';
          if (varName.includes('obj') || varName.includes('data')) return '{};';
          return 'null;';
        }],
        [/^import\s*$/, '{ } from "";'],
        [/^export\s+default\s*$/, ' '],
        [/^async\s+function\s+\w+\s*\($/, ') {\n    \n}'],
        [/^const\s+\w+\s*=\s*async\s*\($/, ') => {\n    \n}'],
      ],
      
      typescript: [
        ...commonPatterns,
        [/^(const|let|var)\s+(\w+)\s*:\s*$/, ' '],
        [/^interface\s+\w+\s*$/, ' {\n    \n}'],
        [/^type\s+\w+\s*=\s*$/, ' '],
        [/^class\s+\w+\s+implements\s*$/, ' '],
        [/^enum\s+\w+\s*$/, ' {\n    \n}'],
      ],
      
      python: [
        [/^def\s+\w+\s*\($/, '):\n    '],
        [/^class\s+\w+\s*$/, ':\n    def __init__(self):\n        '],
        [/^if\s+.+:\s*$/, '\n    '],
        [/^for\s+\w+\s+in\s*$/, ' '],
        [/^import\s*$/, ' '],
        [/^from\s+\w+\s+import\s*$/, ' '],
        [/^return\s*$/, ' None'],
        [/^raise\s*$/, ' Exception("")'],
        [/^with\s+open\s*\($/, ''],
      ],
    };
    
    return languageSpecific[language] || commonPatterns;
  }

  private cleanCompletion(completion: string, textBeforeCursor: string, language: string): string {
    if (!completion) return "";
    
    let cleaned = completion;
    
    // Remove markdown code blocks
    cleaned = cleaned.replace(/^```[\w]*\n?/gm, "").replace(/\n?```$/gm, "");
    
    // Remove instruction echoing
    cleaned = cleaned.replace(/^(Complete|Here's|The completion|Instructions:).*/gim, "").trim();
    cleaned = cleaned.replace(/<CURSOR>/gi, "").trim();
    
    // Remove duplication of input
    if (cleaned.toLowerCase().startsWith(textBeforeCursor.toLowerCase())) {
      cleaned = cleaned.substring(textBeforeCursor.length);
    }
    
    // Remove partial duplications
    const words = textBeforeCursor.split(/\s+/);
    const lastWord = words[words.length - 1];
    if (lastWord && cleaned.startsWith(lastWord)) {
      cleaned = cleaned.substring(lastWord.length);
    }
    
    // Language-specific cleaning
    if (language === 'javascript' || language === 'typescript') {
      // Ensure proper semicolons where needed
      if (!cleaned.endsWith(';') && 
          !cleaned.endsWith('{') && 
          !cleaned.endsWith('}') && 
          !cleaned.includes('\n') &&
          cleaned.match(/^[^{}\[\]()]*$/)) {
        // Only add semicolon for simple statements
        if (!cleaned.endsWith(',') && !cleaned.endsWith(':')) {
          cleaned += ';';
        }
      }
    }
    
    // Limit lines
    const lines = cleaned.split('\n');
    if (lines.length > 3) {
      cleaned = lines.slice(0, 3).join('\n');
    }
    
    return cleaned.trim();
  }

  private isValidCompletion(completion: string, textBeforeCursor: string): boolean {
    // Minimum length
    if (completion.length < 1) return false;
    
    // Not just repetition
    if (completion === textBeforeCursor || completion === textBeforeCursor.trim()) {
      return false;
    }
    
    // Not nonsensical patterns
    const badPatterns = [
      /^undefined$/,
      /^TODO/i,
      /^\?+$/,
      /^\/\/.*/,  // Just comments
      /^\s+$/,     // Just whitespace
    ];
    
    for (const pattern of badPatterns) {
      if (pattern.test(completion)) {
        return false;
      }
    }
    
    return true;
  }

  private isInMiddleOfWord(textBefore: string, textAfter: string): boolean {
    if (textAfter.length === 0) return false;
    
    const lastCharBefore = textBefore[textBefore.length - 1];
    const firstCharAfter = textAfter[0];
    
    return /\w/.test(lastCharBefore || '') && /\w/.test(firstCharAfter || '');
  }

  private isInCommentOrString(text: string, language: string): boolean {
    // Check for comments
    if (language === 'javascript' || language === 'typescript') {
      if (text.match(/\/\/[^\/]*$/) || text.match(/\/\*[^*]*$/)) {
        return true;
      }
    } else if (language === 'python') {
      if (text.match(/#[^#]*$/)) {
        return true;
      }
    }
    
    // Check for unclosed strings
    const singleQuotes = (text.match(/'/g) || []).length;
    const doubleQuotes = (text.match(/"/g) || []).length;
    const backticks = (text.match(/`/g) || []).length;
    
    return singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0 || backticks % 2 !== 0;
  }

  private checkRateLimit(): boolean {
    const now = Date.now();
    
    // Remove old timestamps outside the window
    this.requestTimestamps = this.requestTimestamps.filter(
      timestamp => now - timestamp < this.RATE_LIMIT_WINDOW
    );
    
    return this.requestTimestamps.length < this.MAX_REQUESTS_PER_MINUTE;
  }

  private getFallbackCompletion(textBeforeCursor: string, language: string): vscode.InlineCompletionItem[] | undefined {
    // Provide basic fallback completions for common patterns
    const trimmed = textBeforeCursor.trim();
    
    if (trimmed.endsWith('=')) {
      return [new vscode.InlineCompletionItem(' null;')];
    }
    
    if (trimmed.endsWith('(')) {
      return [new vscode.InlineCompletionItem(') {')];
    }
    
    return undefined;
  }

  private createContextAwareCacheKey(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: ExtractedContext
  ): string {
    const components = [
      document.fileName,
      position.line,
      position.character,
      context.prefix.substring(-50), // Last 50 chars
      context.currentFunction?.name || 'global',
      context.currentClass?.name || 'none',
      context.language
    ];
    
    return components.join('::');
  }

  private wasRecentlyRejected(completion: string): boolean {
    const now = Date.now();
    
    for (const [key, rejection] of this.rejectedCompletions.entries()) {
      // Check if rejection is still valid
      if (now - rejection.timestamp > this.REJECTION_CACHE_TTL) {
        this.rejectedCompletions.delete(key);
        continue;
      }
      
      // Check if this completion matches a rejected pattern
      if (rejection.patterns.has(completion)) {
        return true;
      }
    }
    
    return false;
  }

  private monitorCompletion(fileName: string, textBeforeCursor: string, suggestion: string, position: vscode.Position) {
    // Monitor if user accepts or rejects the completion
    setTimeout(() => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.fileName !== fileName) return;
      
      const currentLine = editor.document.lineAt(position.line).text;
      
      // Check if the suggestion was accepted
      if (currentLine.includes(suggestion.substring(0, Math.min(10, suggestion.length)))) {
        // Reset consecutive rejections on acceptance
        this.consecutiveRejections = 0;
        console.log("Completion accepted");
      } else {
        // Mark as rejected
        this.markAsRejected(fileName, textBeforeCursor, suggestion);
        this.consecutiveRejections++;
        console.log(`Completion rejected (consecutive: ${this.consecutiveRejections})`);
      }
    }, 1000);
  }

  private markAsRejected(fileName: string, textBeforeCursor: string, suggestion: string) {
    const key = `${fileName}:${textBeforeCursor.substring(-30)}`; // Use last 30 chars
    
    if (!this.rejectedCompletions.has(key)) {
      this.rejectedCompletions.set(key, {
        patterns: new Set(),
        timestamp: Date.now()
      });
    }
    
    this.rejectedCompletions.get(key)!.patterns.add(suggestion);
  }

  private cleanupRejections() {
    const now = Date.now();
    
    for (const [key, rejection] of this.rejectedCompletions.entries()) {
      if (now - rejection.timestamp > this.REJECTION_CACHE_TTL) {
        this.rejectedCompletions.delete(key);
      }
    }
    
    // Also cleanup if too many entries
    if (this.rejectedCompletions.size > 100) {
      // Keep only the 50 most recent
      const entries = Array.from(this.rejectedCompletions.entries());
      entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
      this.rejectedCompletions.clear();
      entries.slice(0, 50).forEach(([k, v]) => this.rejectedCompletions.set(k, v));
    }
  }

  public clearCache() {
    this.cache.clear();
    this.activeRequests.clear();
    this.rejectedCompletions.clear();
    this.lastPosition = undefined;
    this.lastDocument = undefined;
    this.lastPrefix = "";
    this.consecutiveRejections = 0;
    this.requestTimestamps = [];
    console.log("Cache and tracking cleared");
  }

  public getStats() {
    const cacheStats = this.cache.getStatistics();
    return {
      cacheSize: cacheStats.memoryCacheSize,
      patternCacheSize: cacheStats.patternCacheSize,
      cacheHitRate: cacheStats.hitRate,
      requestsThisMinute: this.requestTimestamps.filter(t => Date.now() - t < 60000).length,
      maxRequestsPerMinute: this.MAX_REQUESTS_PER_MINUTE,
      activeRequests: this.activeRequests.size,
      rejectedPatterns: this.rejectedCompletions.size,
      consecutiveRejections: this.consecutiveRejections
    };
  }
}