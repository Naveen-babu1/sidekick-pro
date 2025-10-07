import * as vscode from "vscode";
import { ModelService } from "../services/modelService";
import { CodeIndexer } from "../indexer/CodeIndexer";
import {
  ContextExtractor,
  ExtractedContext,
} from "../services/ContextExtractor";
import { SmartCache } from "../services/SmartCache";
import { PromptTemplates } from "../services/PromptTemplates";

export class InlineCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  private modelService: ModelService;
  private codeIndexer: CodeIndexer;

  private contextExtractor = ContextExtractor.getInstance();
  private cache = SmartCache.getInstance();
  private promptTemplates = PromptTemplates.getInstance();

  // Smart triggering
  private readonly MEANINGFUL_TRIGGERS = [
    /^(async\s+)?function\s+\w+\s*\([^)]*\)\s*{?\s*$/, // Function declaration
    /^(const|let|var)\s+\w+\s*=\s*(async\s*)?\([^)]*\)\s*=>\s*{?\s*$/, // Arrow function
    /^class\s+\w+(\s+extends\s+\w+)?\s*{?\s*$/, // Class declaration
    /^if\s*\([^)]+\)\s*{?\s*$/, // If statement with condition
    /^(for|while)\s*\([^)]+\)\s*{?\s*$/, // Loops with condition
    /^try\s*{?\s*$/, // Try block
    /^switch\s*\([^)]+\)\s*{?\s*$/, // Switch statement
    /^\/\/\s*(TODO|FIXME|IMPLEMENT):\s*.+$/i, // TODO comments
    /^\s*\/\*\*?\s*$/, // Start of comment block
    /^(export\s+)?(default\s+)?class\s+/, // Export class
    /^(export\s+)?(default\s+)?function\s+/, // Export function
    /^import\s+.+\s+from\s+['"]/, // Import statement
    /^describe\s*\(['"]/, // Test suite
    /^(it|test)\s*\(['"]/, // Test case
    /^interface\s+\w+\s*{?\s*$/, // TypeScript interface
    /^type\s+\w+\s*=\s*$/, // TypeScript type
    /^enum\s+\w+\s*{?\s*$/, // TypeScript enum
  ];

  // Minimum context requirements
  private readonly MIN_INDENT_FOR_BLOCK = 2; // Spaces or equivalent
  private readonly MIN_LINES_IN_FUNCTION = 3;

  // Request management
  private activeRequest:
    | Promise<vscode.InlineCompletionItem[] | undefined>
    | undefined;
  private lastTriggerTime = 0;
  private readonly TRIGGER_COOLDOWN = 2000; // 2 seconds between triggers

  // Context awareness
  private lastSuggestionContext: string = "";
  private lastAcceptedSuggestion: string = "";

  // Debouncing
  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly DEBOUNCE_DELAY = 1000; // 1 second - longer for less intrusion

  constructor(modelService: ModelService, codeIndexer: CodeIndexer) {
    this.modelService = modelService;
    this.codeIndexer = codeIndexer;
    console.log(
      "Smart InlineCompletionProvider initialized - Context-aware version"
    );
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    // Check if we should provide completion
    if (!this.shouldProvideCompletion(document, position)) {
      return undefined;
    }

    // Clear any existing debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Return existing request if one is active
    if (this.activeRequest) {
      return this.activeRequest;
    }

    // Create debounced request
    this.activeRequest = new Promise((resolve) => {
      this.debounceTimer = setTimeout(async () => {
        const result = await this.generateSmartCompletion(
          document,
          position,
          token
        );
        resolve(result);
        this.activeRequest = undefined;
      }, this.DEBOUNCE_DELAY);
    });

    return this.activeRequest;
  }
  private async getFallbackCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    intent: any
  ): Promise<string> {
    // Simple, focused prompt that always works
    const line = document.lineAt(position.line);
    const textBefore = line.text.substring(0, position.character);

    let simplePrompt = "";

    if (intent.type === "function-body") {
      simplePrompt = `Complete this JavaScript function with a simple implementation:\n${textBefore}\n\nReturn the function body:`;
    } else if (intent.type === "error-handling") {
      simplePrompt = `Add error handling to this code:\n${textBefore}\n\nReturn the catch block:`;
    } else {
      simplePrompt = `Complete this code:\n${textBefore}\n\nReturn the next logical line:`;
    }

    const response = await this.modelService.generateCompletion(
      simplePrompt,
      "",
      50,
      document.languageId
    );

    return response || "";
  }

  private shouldProvideCompletion(
    document: vscode.TextDocument,
    position: vscode.Position
  ): boolean {
    // Check cooldown
    const now = Date.now();
    if (now - this.lastTriggerTime < this.TRIGGER_COOLDOWN) {
      return false;
    }

    const line = document.lineAt(position.line);
    const textBeforeCursor = line.text.substring(0, position.character);
    const textAfterCursor = line.text.substring(position.character);

    // Don't trigger in middle of typing
    if (this.isTypingInMiddle(textBeforeCursor, textAfterCursor)) {
      return false;
    }

    // Check if we're in a meaningful context
    const context = this.analyzeTriggerContext(document, position);

    if (!context.shouldTrigger) {
      return false;
    }

    // Additional smart checks
    if (context.triggerType === "block") {
      // For block completions, ensure we're at a good stopping point
      if (!this.isAtBlockBoundary(document, position)) {
        return false;
      }
    }

    console.log(
      `Smart trigger detected: ${context.triggerType} - ${context.reason}`
    );
    this.lastTriggerTime = now;

    return true;
  }

  private analyzeTriggerContext(
    document: vscode.TextDocument,
    position: vscode.Position
  ): {
    shouldTrigger: boolean;
    triggerType: "block" | "statement" | "comment" | "none";
    reason: string;
  } {
    const line = document.lineAt(position.line);
    const textBeforeCursor = line.text
      .substring(0, position.character)
      .trimEnd();

    // Empty line in a meaningful context (inside function, class, etc.)
    if (textBeforeCursor.trim() === "") {
      const indent = this.getIndentLevel(line.text);
      if (indent >= this.MIN_INDENT_FOR_BLOCK) {
        const surroundingContext = this.getSurroundingContext(
          document,
          position
        );
        if (surroundingContext.insideBlock) {
          return {
            shouldTrigger: true,
            triggerType: "block",
            reason: `Empty line inside ${surroundingContext.blockType}`,
          };
        }
      }
      return {
        shouldTrigger: false,
        triggerType: "none",
        reason: "Empty line without context",
      };
    }

    // Check for meaningful patterns
    for (const pattern of this.MEANINGFUL_TRIGGERS) {
      if (pattern.test(textBeforeCursor)) {
        return {
          shouldTrigger: true,
          triggerType: this.getTypeFromPattern(pattern),
          reason: `Pattern matched: ${pattern.source.substring(0, 30)}...`,
        };
      }
    }

    // Check for incomplete statements
    const incompleteStatement = this.checkForIncompleteStatement(
      document,
      position
    );
    if (incompleteStatement) {
      return {
        shouldTrigger: true,
        triggerType: "statement",
        reason: incompleteStatement,
      };
    }

    return {
      shouldTrigger: false,
      triggerType: "none",
      reason: "No trigger condition met",
    };
  }

  private async generateSmartCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    try {
      // Extract rich context
      const extractedContext = await this.contextExtractor.extractContext(
        document,
        position
      );

      // Analyze what kind of completion is needed
      const completionIntent = this.analyzeCompletionIntent(extractedContext);

      if (completionIntent.type === "none") {
        return undefined;
      }

      const projectContext = await this.codeIndexer.getRelevantContext(
        document.uri,
        position,
        500
      );

      // Create smart cache key based on semantic context
      const cacheKey = this.createSmartCacheKey(
        extractedContext,
        completionIntent
      );

      // Check cache
      const cached = await this.cache.get(
        cacheKey,
        extractedContext,
        "completion"
      );
      if (cached && this.isStillRelevant(cached, extractedContext)) {
        console.log("Using cached smart completion");
        return [new vscode.InlineCompletionItem(cached)];
      }

      // Build context-aware prompt
      const prompt = this.buildSmartPrompt(
        extractedContext,
        completionIntent,
        projectContext
      );

      console.log(`Requesting ${completionIntent.type} completion from LLM`);

      // Get completion from model
      let completion = await this.modelService.generateCompletion(
        prompt,
        "",
        completionIntent.expectedTokens,
        document.languageId
      );

      if (token.isCancellationRequested) {
        return undefined;
      }
      if (!completion || !completion.trim()) {
        // Try fallback with simpler prompt
        console.log(
          "Empty response from primary prompt, trying simplified prompt"
        );

        // Simplified prompt that always works
        const simplePrompt = `Complete this ${extractedContext.language} ${
          completionIntent.type
        }:\n\n${extractedContext.prefix.slice(
          -200
        )}\n\nProvide only the code to complete it:`;

        completion = await this.modelService.generateCompletion(
          simplePrompt,
          "",
          100,
          document.languageId
        );
      }

      if (completion && completion.trim()) {
        const cleaned = this.cleanSmartCompletion(
          completion,
          extractedContext,
          completionIntent
        );

        if (cleaned && this.validateCompletion(cleaned, extractedContext)) {
          // Cache the result
          await this.cache.set(cacheKey, cleaned, extractedContext, {
            feature: "smart-completion",
            language: document.languageId,
            modelUsed: this.modelService.getCurrentProvider(),
            ttl: 300000, // 5 minutes for smart completions
          });

          this.lastSuggestionContext = cacheKey;

          return [new vscode.InlineCompletionItem(cleaned)];
        }
      }

      return undefined;
    } catch (error) {
      console.error("Smart completion error:", error);
      return undefined;
    }
  }

  private analyzeCompletionIntent(context: ExtractedContext): {
    type:
      | "function-body"
      | "class-body"
      | "test"
      | "error-handling"
      | "algorithm"
      | "none";
    expectedTokens: number;
    focusOn: string[];
  } {
    const prefix = context.prefix.trim();
    const lastLines = prefix.split("\n").slice(-5).join("\n");

    // Function body needed
    if (
      context.currentFunction &&
      !this.hasFunctionBody(context.currentFunction)
    ) {
      return {
        type: "function-body",
        expectedTokens: 150,
        focusOn: ["parameters", "return type", "function name semantics"],
      };
    }

    // Class methods needed
    if (context.currentClass && lastLines.includes("class ")) {
      return {
        type: "class-body",
        expectedTokens: 200,
        focusOn: ["constructor", "methods", "properties"],
      };
    }

    // Test implementation needed
    if (lastLines.match(/(describe|it|test)\s*\(['"]/)) {
      return {
        type: "test",
        expectedTokens: 150,
        focusOn: ["assertions", "test logic", "mocking"],
      };
    }

    // Error handling needed
    if (lastLines.includes("try") || lastLines.includes("catch")) {
      return {
        type: "error-handling",
        expectedTokens: 100,
        focusOn: ["error types", "recovery", "logging"],
      };
    }

    // Algorithm implementation based on comments
    if (lastLines.match(/\/\/\s*(TODO|IMPLEMENT|FIXME):/i)) {
      return {
        type: "algorithm",
        expectedTokens: 200,
        focusOn: ["comment directive", "surrounding code", "project patterns"],
      };
    }

    return { type: "none", expectedTokens: 0, focusOn: [] };
  }

  private hasFunctionBody(
    func: NonNullable<ExtractedContext["currentFunction"]>
  ): boolean {
    const candidate = func as unknown as {
      body?: unknown;
      bodyRange?: unknown;
      range?: { start?: { line?: number }; end?: { line?: number } };
    };

    if (candidate.body) {
      return true;
    }

    if (candidate.bodyRange) {
      return true;
    }

    if (
      candidate.range &&
      typeof candidate.range.start?.line === "number" &&
      typeof candidate.range.end?.line === "number"
    ) {
      return candidate.range.end.line > candidate.range.start.line;
    }

    return false;
  }

  private buildSmartPrompt(
    context: ExtractedContext,
    intent: any,
    projectContext: string
  ): string {
    const projectPatterns =
      projectContext.trim().length > 0 ? projectContext.trim() : "none";

    let prompt = `You are an expert ${
      context.language
    } developer. Generate a smart, context-aware code completion.

Context:
- File: ${context.fileName}
- Language: ${context.language}
- Current function: ${context.currentFunction?.name || "global scope"}
- Current class: ${context.currentClass?.name || "none"}
- Completion type needed: ${intent.type}
- Focus on: ${intent.focusOn.join(", ")}

Relevant imports:
${context.imports.slice(0, 5).join("\n")}

Available symbols in scope:
${context.relatedSymbols.slice(0, 10).join(", ")}

Local variables:
${context.localVariables.slice(0, 10).join(", ")}

Code before cursor:
\`\`\`${context.language}
${context.prefix.slice(-500)}
\`\`\`

Code after cursor:
\`\`\`${context.language}
${context.suffix.slice(0, 200)}
\`\`\`

Project patterns found:
${projectPatterns}

Instructions:
1. Generate ONLY the code to be inserted at the cursor position
2. Make it consistent with the project's coding style
3. Include appropriate error handling if relevant
4. Use meaningful variable names from the context
5. Complete the logical unit of code (full function body, complete loop, etc.)
6. DO NOT include markdown formatting or explanations
7. The code should be production-ready and follow best practices

Generated completion:`;

    return prompt;
  }

  private cleanSmartCompletion(
    completion: string,
    context: ExtractedContext,
    intent: any
  ): string {
    let cleaned = completion;

    // Remove any markdown or code blocks
    cleaned = cleaned.replace(/^```[\w]*\n?/gm, "").replace(/\n?```$/gm, "");

    // Remove any explanation text
    cleaned = cleaned.replace(
      /^(\/\/|#)\s*(Generated|Here's|This|The).*/gim,
      ""
    );

    // Ensure proper indentation
    const baseIndent = this.getIndentFromContext(context);
    if (baseIndent) {
      cleaned = this.adjustIndentation(cleaned, baseIndent);
    }

    // For function bodies, ensure proper closing
    if (intent.type === "function-body" && !cleaned.includes("}")) {
      cleaned += "\n}";
    }

    // Trim excessive whitespace but preserve structure
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

    return cleaned.trim();
  }

  private validateCompletion(
    completion: string,
    context: ExtractedContext
  ): boolean {
    // Must be substantial
    if (completion.length < 10) {
      return false;
    }

    // Must not be just comments
    const withoutComments = completion
      .replace(/\/\/.*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    if (withoutComments.trim().length < 5) {
      return false;
    }

    // Must be syntactically plausible
    const openBraces = (completion.match(/{/g) || []).length;
    const closeBraces = (completion.match(/}/g) || []).length;
    if (Math.abs(openBraces - closeBraces) > 1) {
      return false;
    }

    // Should not duplicate existing code
    if (context.prefix.includes(completion.substring(0, 20))) {
      return false;
    }

    return true;
  }

  private createSmartCacheKey(context: ExtractedContext, intent: any): string {
    const components = [
      context.fileName,
      context.currentFunction?.name || "global",
      context.currentClass?.name || "none",
      intent.type,
      context.prefix.slice(-100).replace(/\s+/g, " ").substring(0, 50),
      context.localVariables.slice(0, 5).join(","),
      context.language,
    ];

    return components.join("::");
  }

  private isStillRelevant(cached: string, context: ExtractedContext): boolean {
    // Check if the cached suggestion still makes sense in current context
    const currentVarNames = new Set(
      context.localVariables
        .map((variable) =>
          typeof variable === "string" ? variable : variable?.name
        )
        .filter(
          (name): name is string => typeof name === "string" && name.length > 0
        )
    );
    const cachedVars = this.extractVariablesFromCode(cached);

    // If cached code references variables that don't exist anymore, it's not relevant
    for (const v of cachedVars) {
      if (!currentVarNames.has(v) && !this.isBuiltinOrImported(v, context)) {
        return false;
      }
    }

    return true;
  }

  private getSurroundingContext(
    document: vscode.TextDocument,
    position: vscode.Position
  ): {
    insideBlock: boolean;
    blockType: string;
  } {
    const lines = document.getText().split("\n");
    let braceCount = 0;
    let blockType = "unknown";

    for (let i = 0; i < position.line; i++) {
      const line = lines[i];

      // Detect block starts
      if (line.includes("function ")) blockType = "function";
      else if (line.includes("class ")) blockType = "class";
      else if (line.includes("if ")) blockType = "if-block";
      else if (line.includes("for ")) blockType = "loop";
      else if (line.includes("while ")) blockType = "loop";

      braceCount += (line.match(/{/g) || []).length;
      braceCount -= (line.match(/}/g) || []).length;
    }

    return {
      insideBlock: braceCount > 0,
      blockType: braceCount > 0 ? blockType : "none",
    };
  }

  private checkForIncompleteStatement(
    document: vscode.TextDocument,
    position: vscode.Position
  ): string | null {
    const line = document.lineAt(position.line);
    const text = line.text.trim();

    // Incomplete variable declaration
    if (text.match(/^(const|let|var)\s+\w+\s*=\s*$/)) {
      return "Incomplete variable assignment";
    }

    // Incomplete return statement
    if (text === "return" || text === "return ") {
      return "Incomplete return statement";
    }

    // Incomplete throw statement
    if (text === "throw" || text === "throw new") {
      return "Incomplete throw statement";
    }

    return null;
  }

  private isTypingInMiddle(before: string, after: string): boolean {
    // Don't complete if cursor is in middle of a word
    const lastCharBefore = before[before.length - 1];
    const firstCharAfter = after[0];

    return /\w/.test(lastCharBefore || "") && /\w/.test(firstCharAfter || "");
  }

  private isAtBlockBoundary(
    document: vscode.TextDocument,
    position: vscode.Position
  ): boolean {
    const line = document.lineAt(position.line);
    const nextLine =
      position.line < document.lineCount - 1
        ? document.lineAt(position.line + 1)
        : null;

    // At end of current line
    if (position.character === line.text.length) {
      return true;
    }

    // Next line is empty or closing brace
    if (
      nextLine &&
      (nextLine.text.trim() === "" || nextLine.text.trim() === "}")
    ) {
      return true;
    }

    return false;
  }

  private getTypeFromPattern(
    pattern: RegExp
  ): "block" | "statement" | "comment" {
    const source = pattern.source;

    if (
      source.includes("function") ||
      source.includes("class") ||
      source.includes("if") ||
      source.includes("for")
    ) {
      return "block";
    }

    if (source.includes("\\/\\/") || source.includes("\\/\\*")) {
      return "comment";
    }

    return "statement";
  }

  private getIndentLevel(text: string): number {
    const match = text.match(/^(\s*)/);
    return match ? match[1].length : 0;
  }

  private getIndentFromContext(context: ExtractedContext): string {
    const lines = context.prefix.split("\n");
    const lastNonEmptyLine = lines.reverse().find((l) => l.trim());

    if (lastNonEmptyLine) {
      const match = lastNonEmptyLine.match(/^(\s*)/);
      return match ? match[1] : "";
    }

    return "";
  }

  private adjustIndentation(code: string, baseIndent: string): string {
    return code
      .split("\n")
      .map((line, index) => {
        if (index === 0) return line;
        if (line.trim() === "") return "";
        return baseIndent + line;
      })
      .join("\n");
  }

  private extractVariablesFromCode(code: string): string[] {
    const varPattern = /\b([a-zA-Z_]\w*)\b/g;
    const matches = code.match(varPattern) || [];
    return [...new Set(matches)];
  }

  private isBuiltinOrImported(
    variable: string,
    context: ExtractedContext
  ): boolean {
    const builtins = [
      "console",
      "Math",
      "Object",
      "Array",
      "String",
      "Number",
      "Boolean",
      "Date",
      "Promise",
    ];

    if (builtins.includes(variable)) {
      return true;
    }

    return context.imports.some((imp) => imp.includes(variable));
  }

  public clearCache() {
    this.cache.clear();
    this.activeRequest = undefined;
    this.lastSuggestionContext = "";
    this.lastAcceptedSuggestion = "";
    console.log("Smart completion cache cleared");
  }

  public getStats() {
    const cacheStats = this.cache.getStatistics();
    return {
      cacheSize: cacheStats.memoryCacheSize,
      cacheHitRate: cacheStats.hitRate,
      lastTriggerTime: this.lastTriggerTime,
      hasPendingRequest: !!this.activeRequest,
    };
  }
}
