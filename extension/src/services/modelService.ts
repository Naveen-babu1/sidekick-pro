// src/services/ModelService.ts
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { LocalAIProvider } from "../providers/LocalAIProvider";
import { ContextExtractor, ExtractedContext } from "../services/ContextExtractor";
import { SmartCache } from "../services/SmartCache";
import { PromptTemplates } from "../services/PromptTemplates";


export class ModelService {
  private config: any = {};
  private localAI: LocalAIProvider | null = null;
  private contextKeeperUrl: string = "";
  private currentProvider: "openai" | "local" | "claude" | "anthropic" = "local";

  private contextExtractor = ContextExtractor.getInstance();
  private cache = SmartCache.getInstance();
  private promptTemplates = PromptTemplates.getInstance();

  // Add performance metrics
  private metrics = {
    apiCalls: 0,
    cacheHits: 0,
    totalRequests: 0,
    avgResponseTime: 0
  };

  private _onDidChangeProvider = new vscode.EventEmitter<string>();
  public readonly onDidChangeProvider = this._onDidChangeProvider.event;

  constructor(private context: vscode.ExtensionContext) {
    this.context = context;
    this.loadEnvironment();
    this.loadConfiguration();

    if (this.isOpenAIConfigured()) {
            this.currentProvider = 'openai';
        } else {
            this.currentProvider = 'local';
            // Initialize LocalAI if using local provider
            this.localAI = new LocalAIProvider(this.context);
            this.localAI.initialize();
        }
  }

  private getProviderDisplayName(provider: string): string {
    const names: Record<string, string> = {
      'openai': 'OpenAI GPT',
      'local': 'Local AI (Offline)',
      'claude': 'Claude (Anthropic)',
      'anthropic': 'Claude (Anthropic)'
    };
    return names[provider] || provider;
  }

  private async configureOpenAI(): Promise<void> {
    const apiKey = await vscode.window.showInputBox({
      prompt: 'Enter your OpenAI API key',
      placeHolder: 'sk-...',
      password: true,
      validateInput: (value) => {
        if (!value || !value.startsWith('sk-')) {
          return 'Invalid API key format';
        }
        return null;
      }
    });
    
    if (apiKey) {
      // Update VS Code settings
      const config = vscode.workspace.getConfiguration('sidekickPro');
      await config.update('openaiApiKey', apiKey, vscode.ConfigurationTarget.Global);
      
      // Update internal config
      this.config.openaiKey = apiKey;
      this.config.provider = 'openai';
      
      // Also update .env file if it exists
      this.updateEnvFile('OPENAI_API_KEY', apiKey);
      
      vscode.window.showInformationMessage('OpenAI API key configured successfully');
    }
  }

  private isAnthropicConfigured(): boolean {
    const config = vscode.workspace.getConfiguration('sidekickPro');
    const anthropicKey = config.get<string>('anthropicApiKey') || 
                        process.env.ANTHROPIC_API_KEY || 
                        this.config.anthropicKey;
    
    return !!(anthropicKey && anthropicKey.startsWith('sk-'));
  }

  private async updateProviderConfiguration(provider: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('sidekickPro');
    await config.update('preferredProvider', provider, vscode.ConfigurationTarget.Global);
    
    // Update .env file if it exists
    this.updateEnvFile('DEFAULT_MODEL_PROVIDER', provider);
    
    // Reload configuration
    this.loadConfiguration();
  }

  private updateEnvFile(key: string, value: string): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const envPaths = [
      path.join(__dirname, "..", "..", ".env"),
      workspaceFolder ? path.join(workspaceFolder.uri.fsPath, ".env") : null
    ].filter(Boolean) as string[];
    
    for (const envPath of envPaths) {
      if (fs.existsSync(envPath)) {
        try {
          let content = fs.readFileSync(envPath, 'utf8');
          const regex = new RegExp(`^${key}=.*$`, 'gm');
          
          if (regex.test(content)) {
            content = content.replace(regex, `${key}=${value}`);
          } else {
            content += `\n${key}=${value}`;
          }
          
          fs.writeFileSync(envPath, content);
          console.log(`Updated ${key} in ${envPath}`);
          break;
        } catch (error) {
          console.error(`Failed to update .env file: ${error}`);
        }
      }
    }
  }

  public getAvailableProviders(): Array<{id: string, name: string, available: boolean}> {
    return [
      {
        id: 'openai',
        name: 'OpenAI GPT',
        available: this.isOpenAIConfigured()
      },
      {
        id: 'local',
        name: 'Local AI (Offline)',
        available: true // Always available, will download if needed
      },
      {
        id: 'claude',
        name: 'Claude (Anthropic)',
        available: this.isAnthropicConfigured()
      }
    ];
  }
  public async showProviderPicker(): Promise<void> {
    const providers = this.getAvailableProviders();
    
    const items = providers.map(p => ({
      label: p.name,
      description: p.id === this.currentProvider ? '✓ Current' : '',
      detail: p.available ? 'Available' : 'Not configured',
      id: p.id,
      available: p.available
    }));
    
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select AI Provider',
      title: 'Switch AI Provider'
    });
    
    if (selected && selected.available) {
      await this.switchProvider(selected.id as any);
    } else if (selected && !selected.available) {
      vscode.window.showWarningMessage(
        `${selected.label} is not configured. Please add API keys in settings.`
      );
    }
  }


  public async switchProvider(provider: "openai" | "local" | "claude" | "anthropic"): Promise<boolean> {
    console.log(`Switching provider from ${this.currentProvider} to ${provider}`);
    
    // Validate provider availability
    switch (provider) {
      case 'openai':
        if (!this.isOpenAIConfigured()) {
          const configure = await vscode.window.showWarningMessage(
            'OpenAI API key not configured. Would you like to configure it now?',
            'Configure',
            'Cancel'
          );
          
          if (configure === 'Configure') {
            await this.configureOpenAI();
          }
          return false;
        }
        break;
        
      case 'claude':
      case 'anthropic':
        // Check if Anthropic/Claude is configured
        if (!this.isAnthropicConfigured()) {
          vscode.window.showWarningMessage(
            'Anthropic API key not configured. Add ANTHROPIC_API_KEY to your settings.'
          );
          return false;
        }
        break;
        
      case 'local':
        // Initialize LocalAI if not already done
        if (!this.localAI) {
          this.localAI = new LocalAIProvider(this.context);
          await this.localAI.initialize();
        }
        
        // Check if local model is available
        const status = await this.localAI.checkModelStatus();
        if (!status.isReady) {
          const setup = await vscode.window.showWarningMessage(
            'Local AI model not found. Would you like to download it?',
            'Download',
            'Cancel'
          );
          
          if (setup === 'Download') {
            // await this.localAI.downloadModel();
          }
          return false;
        }
        break;
    }
    
    // Update current provider
    const previousProvider = this.currentProvider;
    this.currentProvider = provider;
    
    // Update configuration
    await this.updateProviderConfiguration(provider);
    
    // Clear cache when switching providers
    this.cache.clear();
    
    // Notify listeners
    this._onDidChangeProvider.fire(provider);
    
    // Show confirmation
    vscode.window.showInformationMessage(
      `✅ Switched to ${this.getProviderDisplayName(provider)}`
    );
    
    // Update status bar if it exists
    vscode.commands.executeCommand('sidekick-pro.updateStatusBar');
    
    console.log(`Provider switched successfully from ${previousProvider} to ${provider}`);
    return true;
  }

  // public getCurrentProvider(): string {
  //   return this.currentProvider;
  // }

  public loadConfiguration(): void {
        // First, keep existing environment variables
        this.loadEnvironment();
        
        // Then override with VS Code settings if they exist
        const vsConfig = vscode.workspace.getConfiguration('sidekickPro');
        
        // Check if OpenAI is configured in VS Code settings
        const openaiKey = vsConfig.get<string>('openaiApiKey');
        if (openaiKey && openaiKey.trim() !== '') {
            this.config.openaiKey = openaiKey;
        }

        // Check for Anthropic API key
        const anthropicKey = vsConfig.get<string>('anthropicApiKey');
        if (anthropicKey && anthropicKey.trim() !== '') {
            this.config.anthropicKey = anthropicKey;
        }
        
        // Check for model preference
        const openaiModel = vsConfig.get<string>('openaiModel');
        if (openaiModel) {
            this.config.model = openaiModel;
            this.config.codeModel = openaiModel; // Use same model for code completions
        }
        
        // Check if OpenAI is enabled
        const enableOpenAI = vsConfig.get<boolean>('enableOpenAI');
        if (enableOpenAI !== undefined) {
            if (enableOpenAI && this.config.openaiKey && this.config.openaiKey.startsWith('sk-')) {
                this.config.provider = 'openai';
            } else {
                this.config.provider = 'local';
            }
        }
        
        // Check for preferred provider setting
        const preferredProvider = vsConfig.get<string>('preferredProvider');
        if (preferredProvider && ['openai', 'local', 'claude', 'anthropic'].includes(preferredProvider)) {
            this.config.provider = preferredProvider;
        }
        
        // Get completion-specific settings
        const completionMaxTokens = vsConfig.get<number>('completionMaxTokens');
        if (completionMaxTokens) {
            this.config.completionMaxTokens = completionMaxTokens;
        }
        
        const completionTemperature = vsConfig.get<number>('completionTemperature');
        if (completionTemperature !== undefined) {
            this.config.completionTemperature = completionTemperature;
        }
        
        // Update current provider based on new configuration
        if (this.config.provider === 'openai' && this.isOpenAIConfigured()) {
            this.currentProvider = 'openai';
        } else if ((this.config.provider === 'claude' || this.config.provider === 'anthropic') && this.isAnthropicConfigured()) {
            this.currentProvider = 'claude';
        } else {
            this.currentProvider = 'local';
            // Initialize LocalAI if switching to local
            if (!this.localAI) {
                // this.initializeLocalAI();
                this.localAI = new LocalAIProvider(this.context);
                this.localAI.initialize();
            }
        }
        
        console.log(`Configuration loaded - Provider: ${this.currentProvider}, Model: ${this.config.model}`);
    }

  private loadEnvironment() {
    // Load .env from workspace or project root
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const envPaths = [
      path.join(__dirname, "..", "..", ".env"), // Check project root first
      path.join(__dirname, "..", "..", "..", ".env"), // One more level up
      "d:/projects/sidekick-pro/.env", // Direct path
      workspaceFolder ? path.join(workspaceFolder.uri.fsPath, ".env") : null,
      path.join(process.cwd(), ".env"),
    ].filter((p) => p !== null);

    for (const envPath of envPaths) {
      if (envPath && fs.existsSync(envPath)) {
        const envConfig = dotenv.parse(fs.readFileSync(envPath));
        Object.assign(process.env, envConfig);
        console.log(`Loaded .env from: ${envPath}`);
        break;
      }
    }

    this.config = {
      provider: process.env.DEFAULT_MODEL_PROVIDER || "openai",
      openaiKey: process.env.OPENAI_API_KEY || "",
      anthropicKey: process.env.ANTHROPIC_API_KEY || "",
      model: process.env.DEFAULT_MODEL_NAME || "gpt-4o-mini",
      codeModel: process.env.CODE_MODEL_NAME || "gpt-4o-mini",
      temperature: parseFloat(process.env.MODEL_TEMPERATURE || "0.7"),
      completionMaxTokens: parseInt(process.env.COMPLETION_MAX_TOKENS || '100'),
      completionTemperature: parseFloat(process.env.COMPLETION_TEMPERATURE || '0.2')
    };
    console.log(`Model provider: ${this.config.provider}`);
    console.log(`OpenAI configured: ${this.isOpenAIConfigured()}`);
    console.log(`Anthropic configured: ${this.isAnthropicConfigured()}`);
    this.contextKeeperUrl = process.env.CONTEXT_KEEPER_URL || 'http://localhost:8000';
  }

  isOpenAIConfigured(): boolean {
    return (
      this.config.provider === "openai" &&
      this.config.openaiKey &&
      this.config.openaiKey !== "your-openai-api-key-here" &&
      this.config.openaiKey.startsWith("sk-")
    );
  }

  // Removed duplicate implementation of isOpenAIConfigured

  // Main chat method - add optional languageId
  async chat(message: string, context: string, options?: any): Promise<string> {
    this.metrics.totalRequests++;
    const startTime = Date.now();
    
    try {
      let response: string;
      
      switch (this.currentProvider) {
        case 'openai':
          response = await this.chatWithOpenAI(message, context);
          break;
        case 'claude':
        case 'anthropic':
          response = await this.chatWithAnthropic(message, context, options);
          break;
        case 'local':
        default:
          response = await this.chatWithLocal(message, context);
          break;
      }
      
      // Update metrics
      const responseTime = Date.now() - startTime;
      this.metrics.avgResponseTime = 
        (this.metrics.avgResponseTime * (this.metrics.apiCalls) + responseTime) / 
        (this.metrics.apiCalls + 1);
      this.metrics.apiCalls++;
      
      return response;
    } catch (error) {
      console.error(`Chat error with ${this.currentProvider}:`, error);
      
      // Fallback to local if other providers fail
      if (this.currentProvider !== 'local') {
        vscode.window.showWarningMessage(
          `${this.getProviderDisplayName(this.currentProvider)} failed. Falling back to local AI.`
        );
        this.currentProvider = 'local';
        return this.chatWithLocal(message, context);
      }
      
      throw error;
    }
  }

  private async chatWithAnthropic(prompt: string, context: string, options?: any): Promise<string> {
    const requestBody = {
      model: options?.model || "claude-3-5-sonnet-20241022",
      messages: [
        { 
          role: "user", 
          content: `${context}\n\n${prompt}` 
        }
      ],
      max_tokens: options?.maxTokens || 2000,
      temperature: options?.temperature || this.config.temperature || 0.7,
    };

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.anthropicKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Anthropic API error: ${error}`);
      }

      const data = (await response.json()) as {
        content?: Array<{ text: string }>;
      };
      const text = data.content?.[0]?.text;
      if (!text) {
        throw new Error("Anthropic API returned an unexpected response shape");
      }
      return text;
    } catch (error) {
      console.error("Anthropic chat error:", error);
      throw error;
    }
  }

  /**
   * Chat with local AI model - NEW METHOD
   */
  private async chatWithLocal(prompt: string, context: string): Promise<string> {
    if (!this.localAI) {
      this.localAI = new LocalAIProvider(this.context);
      await this.localAI.initialize();
    }
    
    return this.localAI.chat(prompt, context);
  }

  // Code completion
  async generateCompletion(
    prompt: string,
    context: string,
    maxTokens: number = 100,
    languageId?: string
  ): Promise<string> {
    const startTime = Date.now();
    this.metrics.totalRequests++;
    // For completions, we want them to be FAST
    // Use a simpler prompt format for better speed
    // Check if this is a structured prompt from PromptTemplates
    const isStructuredPrompt = prompt.includes('Language:') && prompt.includes('Current context:');
    
    const cacheKey = `completion:${languageId}:${prompt.substring(0, 100)}`;
    
    // Check cache first
    const cached = await this.cache.get(cacheKey, { prompt, context }, 'completion');
    if (cached) {
      this.metrics.cacheHits++;
      console.log(`Cache hit! (${((this.metrics.cacheHits / this.metrics.totalRequests) * 100).toFixed(1)}% hit rate)`);
      return cached;
    }
    
    let result: string;
    
    if (this.currentProvider === "openai" && this.isOpenAIConfigured()) {
      try {
        this.metrics.apiCalls++;
        
        if (isStructuredPrompt) {
          result = await this.getOpenAICodeCompletionOptimized(prompt, maxTokens, languageId);
        } else {
          // Legacy path
          result = await this.getOpenAICodeCompletion(prompt, maxTokens, languageId);
        }
      } catch (error) {
        console.error("OpenAI completion failed:", error);
        // Try fallback to local if available
        if (this.localAI) {
          result = await this.localAI.generateCompletion(prompt, context, maxTokens);
        } else {
          result = "";
        }
      }
    } else {
      if (!this.localAI) {
        await this.initializeLocalAI();
      }
      result = await this.localAI!.generateCompletion(prompt, context, maxTokens);
    }
    
    // Cache successful results
    if (result) {
      await this.cache.set(cacheKey, result, { prompt, context }, {
        feature: 'completion',
        language: languageId || 'unknown',
        modelUsed: this.currentProvider,
        ttl: 60000 // 1 minute for completions
      });
    }
    
    // Update metrics
    const responseTime = Date.now() - startTime;
    this.metrics.avgResponseTime = 
      (this.metrics.avgResponseTime * (this.metrics.totalRequests - 1) + responseTime) / 
      this.metrics.totalRequests;
    
    console.log(`Response time: ${responseTime}ms, Cache hit rate: ${((this.metrics.cacheHits / this.metrics.totalRequests) * 100).toFixed(1)}%`);
    
    return result;
  }

  private async generateCompletionLegacy(
    prompt: string,
    context: string,
    maxTokens: number = 100,
    languageId?: string
  ): Promise<string> {
    // Your existing generateCompletion logic
    if (this.currentProvider === "openai" && this.isOpenAIConfigured()) {
      try {
        return await this.getOpenAICodeCompletion(prompt, maxTokens, languageId);
      } catch (error) {
        console.error("OpenAI completion failed:", error);
        return "";
      }
    } else {
      return await this.localAI!.generateCompletion(prompt, context, maxTokens);
    }
  }

  private async getOpenAICodeCompletionOptimized(
    structuredPrompt: string,
    maxTokens: number,
    languageId?: string
  ): Promise<string> {
    try {
      console.log('OpenAI optimized completion for:', languageId);
      
      // Extract the key parts from structured prompt
      const systemMessage = `You are an expert ${languageId || 'code'} completion assistant. 
Complete the code at <CURSOR> position following these rules:
1. Follow the existing code style exactly
2. Use the provided imports, variables, and types
3. Match the patterns used in the codebase
4. When you see Current context:, provide ONLY what should come after that point.
Do not repeat any code that comes before Current context:.
5. Be concise and contextually appropriate
6. Do NOT add explanations or markdown
7. Do NOT repeat the given code`;

      const messages = [
        {
          role: 'system',
          content: systemMessage
        },
        {
          role: 'user',
          content: structuredPrompt
        }
      ];
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.openaiKey}`
        },
        body: JSON.stringify({
          model: this.config.codeModel || this.config.model || 'gpt-4o-mini',
          messages: messages,
          max_tokens: maxTokens,
          temperature: 0.1,  // Very low for consistent completions
          top_p: 0.9,
          frequency_penalty: 0.5,  // Reduce repetition
          presence_penalty: 0.5,   // Encourage variety
          stop: ['\n\n', '```', '// End', '/* End', '<CURSOR>'],
          n: 1
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('OpenAI error:', errorText);
        return '';
      }
      
      const data = await response.json();
      const completion = (data as { choices?: { message?: { content: string } }[] })
        .choices?.[0]?.message?.content || '';
      
      return this.cleanCompletionResponse(completion);
      
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.debug('Completion timed out');
      } else {
        console.error('OpenAI completion error:', error);
      }
      return '';
    }
  }

  

  // Explain code - already has languageId
  async explainCode(
    code: string,
    context: string,
    languageId: string
  ): Promise<string> {
    // Create cache key for explanations
    const extractedContext: Partial<ExtractedContext> = {
      language: languageId,
      prefix: code,
      suffix: '',
      fileName: 'current-file',
      relativePath: '',
      imports: [],
      relatedSymbols: [],
      localVariables: [],
      availableTypes: [],
      extractionTime: 0,
      contextSize: code.length
    };
    
    // Use prompt template for better structure
    const prompt = this.promptTemplates.explainPrompt(
      code,
      extractedContext as ExtractedContext,
      { style: 'concise' }
    );
    
    // Create cache key
    const cacheKey = `explain:${languageId}:${code.substring(0, 100)}`;
    
    // Check cache
    const cached = await this.cache.get(cacheKey, { code, languageId }, 'explain');
    if (cached) {
      console.log("Using cached explanation");
      return cached;
    }
    
    let explanation: string;
    
    if (this.isOpenAIConfigured()) {
      try {
        explanation = await this.explainWithOpenAI(code, context, languageId);
      } catch (error) {
        console.error("OpenAI failed:", error);
        if (this.localAI) {
          explanation = await this.localAI.explainCode(code, context);
        } else {
          throw error;
        }
      }
    } else {
      if (!this.localAI) {
        await this.initializeLocalAI();
      }
      explanation = await this.localAI!.explainCode(code, context);
    }
    // Cache the explanation
    if (explanation) {
      await this.cache.set(cacheKey, explanation, { code, languageId }, {
        feature: 'explain',
        language: languageId,
        modelUsed: this.getCurrentProvider(),
        ttl: 300000 // 5 minutes
      });
    }

    return explanation;
  }

  // Add method to initialize local AI if needed
  private async initializeLocalAI(): Promise<void> {
    if (!this.localAI) {
      this.localAI = new LocalAIProvider(this.context);
      await this.localAI.initialize();
    }
  }

  private async explainWithOpenAI(
    code: string,
    context: string,
    languageId: string
  ): Promise<string> {
    const prompt = `Explain the following ${languageId} code in detail:\n\n${code}\n\nContext: ${context}`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.openaiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          {
            role: "system",
            content: `You are an expert ${languageId} developer. Explain the following code clearly and concisely. 
                         Focus on:
                         1. What the code does
                         2. Its purpose and main functionality
                         3. Key patterns or techniques used
                         4. Any important details or edge cases
                         Keep the explanation clear but comprehensive.`,
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        max_tokens: 500,
        temperature: this.config.temperature,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${error}`);
    }

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    return data.choices[0].message.content;
  }

  // Refactor code - fix parameter order and add languageId
  async refactorCode(
    code: string,
    instruction: string,
    context: string,
    languageId?: string
  ): Promise<string> {
    // Build context object for prompt template
    const extractedContext: ExtractedContext = {
      language: languageId || 'javascript',
      fileName: 'current-file',
      relativePath: '',
      prefix: code,
      suffix: '',
      imports: [],
      currentFunction: undefined,
      currentClass: undefined,
      relatedSymbols: [],
      localVariables: [],
      availableTypes: [],
      extractionTime: 0,
      contextSize: code.length
    };

    // Use prompt template for better structure
    const prompt = this.promptTemplates.refactorPrompt(
      code,
      extractedContext,
      { includeExamples: false }
    );
    
    // Create cache key
    const cacheKey = `refactor:${languageId}:${instruction}:${code.substring(0, 100)}`;
    
    // Check cache
    const cached = await this.cache.get(cacheKey, { code, instruction }, 'refactor');
    if (cached) {
      return cached;
    }
    
    let result: string;
    if (this.isOpenAIConfigured()) {
      const response = await this.chatWithOpenAI(prompt, context);
      return this.cleanCodeResponse(response);
    } else {
      if (!this.localAI) {
        this.localAI = new LocalAIProvider(this.context);
        await this.localAI.initialize();
      }
      return await this.localAI.refactorCode(code, instruction, context, languageId);
    }

    // Cache the result
    if (result) {
      await this.cache.set(cacheKey, result, { code, instruction }, {
        feature: 'refactor',
        language: languageId || 'unknown',
        modelUsed: this.currentProvider,
        ttl: 180000 // 3 minutes for refactoring
      });
    }
    
    return result;
  }

  // Add new method for performance stats:
  getPerformanceMetrics() {
    const cacheStats = this.cache.getStatistics();
    return {
      ...this.metrics,
      cache: cacheStats,
      provider: this.currentProvider,
      isConfigured: this.currentProvider === 'openai' ? this.isOpenAIConfigured() : true
    };
  }

  // Add method to pre-warm the cache with common patterns:
  async prewarmCache(): Promise<void> {
    console.log("Pre-warming cache with common patterns...");
    
    const commonPatterns = [
      { prompt: 'if (', language: 'javascript' },
      { prompt: 'for (', language: 'javascript' },
      { prompt: 'const ', language: 'javascript' },
      { prompt: 'def ', language: 'python' },
      { prompt: 'class ', language: 'python' },
    ];
    
    for (const pattern of commonPatterns) {
      const cacheKey = `pattern:${pattern.language}:${pattern.prompt}`;
      const completion = await this.getQuickCompletion(pattern.prompt, pattern.language);
      if (!completion) continue;
      
      await this.cache.set(cacheKey, completion, pattern, {
        feature: 'pattern',
        language: pattern.language,
        modelUsed: 'quick-pattern',
        ttl: 3600000 // 1 hour for patterns
      });
    }
  }

  // Generate tests - add languageId parameter
  async generateTests(
    code: string,
    context: string,
    languageId?: string
  ): Promise<string> {
    // Build context object
    const extractedContext: Partial<ExtractedContext> = {
      language: languageId || 'javascript',
      fileName: 'test-file',
      relativePath: '',
      prefix: '',
      suffix: '',
      imports: [],
      relatedSymbols: [],
      localVariables: [],
      availableTypes: [],
      extractionTime: 0,
      contextSize: code.length
    };

    // Use prompt template
    const structuredPrompt = this.promptTemplates.testPrompt(
      code,
      extractedContext as ExtractedContext,
      { includeExamples: true }
    );
    if (this.isOpenAIConfigured()) {
      const response = await this.chatWithOpenAI(structuredPrompt, context);
      return this.cleanCodeResponse(response);
    } else {
      if (!this.localAI) {
        this.localAI = new LocalAIProvider(this.context);
        await this.localAI.initialize();
      }
      return await this.localAI.generateTests(code, context);
    }
  }

  getCacheStatistics() {
    return this.cache.getStatistics();
  }

  // NEW: Method to clear all caches
  clearAllCaches() {
    this.cache.clear();
    console.log("All caches cleared");
  }

  // Fix errors - add languageId parameter
  async fixError(
    code: string,
    error: string,
    fullContext: string,
    languageId?: string
  ): Promise<string> {
    const prompt = `Fix this error in the ${
      languageId || "code"
    }:\n\nError: ${error}\n\nCode:\n${code}\n\nReturn only the fixed code without markdown or explanations:`;

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

  private async chatWithOpenAI(
    message: string,
    context: string
  ): Promise<string> {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.openaiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          {
            role: "system",
            content: "You are a helpful coding assistant.",
          },
          {
            role: "user",
            content: context ? `${context}\n\n${message}` : message,
          },
        ],
        max_tokens: 1000,
        temperature: this.config.temperature,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${errorText}`);
    }

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    return data.choices[0].message.content;
  }

  private async getOpenAICodeCompletion(prompt: string, maxTokens: number, languageId?: string): Promise<string> {
    try {
        console.log('OpenAI completion request for:', languageId);
        
        // Use a system message that prevents repetitive responses
        const systemMessage = `You are a code completion assistant. 
Rules:
1. Complete ONLY what comes next in the code
2. Do NOT repeat the given code
3. Do NOT add explanations or markdown
4. Be contextually appropriate
5. If completing a variable assignment, provide an appropriate value
6. If completing a function, provide the body
7. Keep completions concise and relevant`;

        const messages = [
            {
                role: 'system',
                content: systemMessage
            },
            {
                role: 'user',
                content: prompt
            }
        ];
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.openaiKey}`
            },
            body: JSON.stringify({
                model: this.config.codeModel || this.config.model || 'gpt-4o-mini',
                messages: messages,
                max_tokens: maxTokens,
                temperature: 0.1,  // Very low for consistent completions
                top_p: 0.9,
                frequency_penalty: 0.5,  // Reduce repetition
                presence_penalty: 0.5,   // Encourage variety
                stop: ['\n\n', '```', '// End', '/* End'],
                n: 1
            }),
            signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('OpenAI error:', errorText);
            return '';
        }
        
        const data = await response.json();
        const completion = (data as { choices?: { message?: { content: string } }[] }).choices?.[0]?.message?.content || '';
        
        console.log('Raw completion:', completion);
        
        // Clean the response
        return this.cleanCompletionResponse(completion);
        
    } catch (error: any) {
        if (error.name === 'AbortError') {
            console.debug('Completion timed out');
        } else {
            console.error('OpenAI completion error:', error);
        }
        return '';
    }
}

  private cleanCompletionResponse(completion: string): string {
    if (!completion) return '';
    
    // Remove any markdown formatting
    completion = completion.replace(/^```[\w]*\n?/gm, '').replace(/\n?```$/gm, '');
    
    // Remove common AI explanatory prefixes
    const prefixPatterns = [
        /^(Here's|Here is|The completion|The code|Complete with|You can complete)/i,
        /^(This completes|This would complete|To complete)/i,
    ];
    
    for (const pattern of prefixPatterns) {
        completion = completion.replace(pattern, '');
    }
    
    // Remove any lines that look like comments about the completion
    const lines = completion.split('\n').filter(line => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') || trimmed.includes('TODO') || trimmed.includes('FIXME');
    });
    
    completion = lines.join('\n').trim();
    
    // If the completion is the same repetitive pattern, return empty
    if (completion === '{ return a + b; }' || 
        completion === 'return a + b;' || 
        completion.includes('// Your code here')) {
        return '';
    }
    
    return completion;
}

  async getQuickCompletion(
    prefix: string,
    languageId: string
  ): Promise<string | null> {
    // This can return immediate completions for common patterns
    // without hitting any AI service

    const patterns: Record<
      string,
      Array<{ pattern: RegExp; completion: string }>
    > = {
      typescript: [
        { pattern: /import\s*{\s*$/, completion: " } from " },
        { pattern: /export\s+default\s+$/, completion: "function " },
        {
          pattern: /const\s+\w+\s*=\s*async\s*$/,
          completion: "() => {\n    \n}",
        },
        {
          pattern: /interface\s+\w+\s+extends\s+$/,
          completion: "BaseInterface {\n    \n}",
        },
        { pattern: /return\s+$/, completion: "null;" },
      ],
      python: [
        { pattern: /def\s+\w+\s*\(\s*self\s*$/, completion: "):\n        " },
        { pattern: /if\s+__name__\s*==\s*$/, completion: '"__main__":\n    ' },
        {
          pattern: /with\s+open\s*\(\s*$/,
          completion: '"filename", "r") as f:\n    ',
        },
        { pattern: /raise\s+$/, completion: 'Exception("")' },
      ],
    };

    const langPatterns = patterns[languageId] || [];

    for (const { pattern, completion } of langPatterns) {
      if (pattern.test(prefix)) {
        return completion;
      }
    }

    return null;
  }

  

  // Add method to pre-warm the completion API
  async prewarmCompletion(): Promise<void> {
    if (this.currentProvider === "openai" && this.isOpenAIConfigured()) {
      // Send a minimal request to establish connection
      try {
        await this.getOpenAICodeCompletion("// ", 1);
      } catch {
        // Ignore errors in prewarming
      }
    }
  }

  private cleanCodeResponse(response: string): string {
    // Remove markdown code blocks
    return response
      .replace(/^```[\w]*\n?/gm, "")
      .replace(/\n?```$/gm, "")
      .trim();
  }

  async getRepositoryContext(query: string): Promise<string> {
    try {
      const response = await fetch(`${this.contextKeeperUrl}/api/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: 3 }),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          sources?: { timestamp: string; message: string; author: string }[];
        };
        if (data.sources && data.sources.length > 0) {
          return data.sources
            .map((s: any) => `[${s.timestamp}] ${s.message} - ${s.author}`)
            .join("\n");
        }
      }
    } catch (error) {
      console.error("Context Keeper error:", error);
    }
    return "";
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
      javascript: "Jest",
      typescript: "Jest",
      python: "pytest",
      java: "JUnit",
      csharp: "NUnit",
      cpp: "Google Test",
      go: "testing package",
      rust: "cargo test",
      ruby: "RSpec",
      php: "PHPUnit",
    };
    return frameworks[languageId] || "appropriate testing framework";
  }
  public dispose() {
    this._onDidChangeProvider.dispose();
    if (this.localAI) {
      // Clean up local AI resources if needed
    }
  }
}
