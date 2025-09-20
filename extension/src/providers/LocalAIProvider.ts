import * as vscode from "vscode";
import { exec, spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { LanguageService } from "../languages/LanguageService";

const execAsync = promisify(exec);

interface LlamaCppResponse {
  content?: string;
  generation_settings?: any;
  model?: string;
  prompt?: string;
  stop?: boolean;
  stopped_eos?: boolean;
  stopped_limit?: boolean;
  stopped_word?: boolean;
  stopping_word?: string;
  timings?: {
    predicted_ms?: number;
    predicted_n?: number;
    predicted_per_second?: number;
    prompt_ms?: number;
    prompt_n?: number;
  };
  tokens_cached?: number;
  tokens_evaluated?: number;
  tokens_predicted?: number;
  truncated?: boolean;
}

interface ModelConfig {
  name: string;
  path: string;
  contextSize: number;
  format: "gguf" | "ggml";
  useGpu?: boolean;
}

export class LocalAIProvider {
  private get llamaEndpoint(): string {
    const config = vscode.workspace.getConfiguration("sidekick-ai");
    const port = config.get<number>("port") || 8080;
    return `http://localhost:${port}`;
  }
  private llamaProcess: ChildProcess | null = null;
  private context!: vscode.ExtensionContext;
  private modelCache: Map<string, string> = new Map();
  private isServerRunning = false;
  private serverStartAttempts = 0;
  private maxStartAttempts = 3;

  private serverCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastHealthCheck = Date.now();

  // Configure your model here
  private currentModel: ModelConfig = {
    name: "qwen2.5-coder-1.5b",
    path: "", // Will be set to model path
    contextSize: 4096,
    format: "gguf",
    useGpu: false, // Set to true if you have CUDA/Metal support
  };

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.startHealthMonitoring();
  }

  private async initializeLlamaCpp() {
    // Check if llama.cpp server is already running
    try {
      const response = await fetch(`${this.llamaEndpoint}/health`);
      if (response.ok) {
        this.isServerRunning = true;
        console.log("llama.cpp server is already running");
        return;
      }
    } catch (error) {
      // Server not running, we'll start it
    }

    // Get or download model
    const modelPath = await this.ensureModel();
    if (!modelPath) {
      vscode.window.showErrorMessage(
        "Failed to initialize llama.cpp model. Please check the model path."
      );
      return;
    }

    this.currentModel.path = modelPath;

    // Start llama.cpp server
    await this.startLlamaCppServer();
  }

  private async runFirstTimeSetup(): Promise<boolean> {
    const result = await vscode.window.showInformationMessage(
      "🚀 Welcome to Sidekick AI! Let's set it up (one-time setup, 2 minutes)",
      "Start Setup",
      "Skip"
    );
    
    if (result !== "Start Setup") {
      return false;
    }
    
    // Step 1: Find or download llama.cpp
    const llamaPath = await this.setupLlamaCpp();
    if (!llamaPath) {
      vscode.window.showErrorMessage("Setup incomplete: llama.cpp not found");
      return false;
    }
    
    // Step 2: Find or download model
    const modelPath = await this.setupModel();
    if (!modelPath) {
      vscode.window.showErrorMessage("Setup incomplete: Model not found");
      return false;
    }
    
    // Save configuration
    const config = vscode.workspace.getConfiguration("sidekick-ai");
    await config.update("llamaPath", llamaPath, true);
    await config.update("modelPath", modelPath, true);
    
    vscode.window.showInformationMessage(
      "✅ Setup complete! Sidekick AI will now start automatically whenever you use it."
    );
    
    return true;
  }
  
  private async setupLlamaCpp(): Promise<string | null> {
    // First, try to auto-detect
    const autoDetected = await this.autoDetectLlamaCpp();
    if (autoDetected) {
      const useDetected = await vscode.window.showInformationMessage(
        `Found llama.cpp at: ${autoDetected}. Use this?`,
        "Yes",
        "Browse for another"
      );
      if (useDetected === "Yes") {
        return autoDetected;
      }
    }
    
    // If not found, guide user
    const action = await vscode.window.showInformationMessage(
      "llama.cpp is required to run AI models locally. Do you have it installed?",
      "I have it - let me select it",
      "Download it",
      "Help"
    );
    
    if (action === "I have it - let me select it") {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        filters: process.platform === "win32" 
          ? { "Executable": ["exe"] }
          : { "All Files": ["*"] },
        title: "Select llama-server executable"
      });
      
      if (fileUri?.[0]) {
        return fileUri[0].fsPath;
      }
    } else if (action === "Download it") {
      const platform = process.platform;
      const url = platform === "win32"
        ? "https://github.com/ggerganov/llama.cpp/releases"
        : "https://github.com/ggerganov/llama.cpp#build";
      vscode.env.openExternal(vscode.Uri.parse(url));
      
      await vscode.window.showInformationMessage(
        "After downloading and extracting llama.cpp, click OK",
        "OK"
      );
      
      return this.setupLlamaCpp(); // Recursive call to select after download
    }
    
    return null;
  }

  private async autoDetectLlamaCpp(): Promise<string | null> {
    const possiblePaths = [
      // Windows paths
      "C:\\llama.cpp\\llama-server.exe",
      "D:\\llama.cpp\\llama-server.exe",
      path.join(os.homedir(), "llama.cpp", "llama-server.exe"),
      path.join(os.homedir(), "Downloads", "llama.cpp", "llama-server.exe"),
      // Unix paths
      "/usr/local/bin/llama-server",
      "/opt/llama.cpp/llama-server",
      path.join(os.homedir(), "llama.cpp", "llama-server"),
    ];
    
    for (const p of possiblePaths) {
      try {
        await fs.access(p);
        return p;
      } catch {
        // Continue checking
      }
    }
    
    // Try to find in PATH
    try {
      const { stdout } = await promisify(exec)(
        process.platform === "win32" ? "where llama-server" : "which llama-server"
      );
      return stdout.trim();
    } catch {
      return null;
    }
  }

  private async setupModel(): Promise<string | null> {
    const action = await vscode.window.showInformationMessage(
      "Now you need an AI model file (GGUF format, ~1-2GB)",
      "I have a model",
      "Download recommended model",
      "Show options"
    );
    
    if (action === "I have a model") {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        filters: { "GGUF Models": ["gguf"] },
        title: "Select your GGUF model file"
      });
      
      if (fileUri?.[0]) {
        return fileUri[0].fsPath;
      }
    } else if (action === "Download recommended model") {
      vscode.env.openExternal(vscode.Uri.parse(
        "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"
      ));
      
      await vscode.window.showInformationMessage(
        "Download the model file (1GB), save it anywhere, then click OK",
        "OK"
      );
      
      return this.setupModel(); // Recursive call to select after download
    } else if (action === "Show options") {
      vscode.env.openExternal(vscode.Uri.parse(
        "https://huggingface.co/models?search=gguf%20code"
      ));
    }
    
    return null;
  }

  public async ensureServerRunning(): Promise<boolean> {
    // Check if already running
    if (await this.checkServerHealth()) {
      this.isServerRunning = true;
      return true;
    }
    
    // Get configuration
    const config = vscode.workspace.getConfiguration("sidekick-ai");
    let modelPath = config.get<string>("modelPath");
    let llamaPath = config.get<string>("llamaPath");
    
    if (!modelPath || !llamaPath) {
      const setupResult = await this.runFirstTimeSetup();
      if (!setupResult) {
        return false;
      }
      // Get updated config after setup
      const configUpdated = vscode.workspace.getConfiguration("sidekick-ai");
      modelPath = configUpdated.get<string>("modelPath");
      llamaPath = configUpdated.get<string>("llamaPath");
    
      if (!modelPath || !llamaPath) {
        return false;
      }
    }
    
    // Start the server
    return await this.startServer(llamaPath, modelPath);
  }

  private async startServer(llamaPath: string, modelPath: string): Promise<boolean> {
    if (this.serverStartAttempts >= this.maxStartAttempts) {
      vscode.window.showErrorMessage(
        "Failed to start AI server after multiple attempts. Please check your configuration."
      );
      return false;
    }
    
    this.serverStartAttempts++;
    
    try {
      const config = vscode.workspace.getConfiguration("sidekick-ai");
      const port = config.get<number>("port") || 8080;
      const contextSize = config.get<number>("contextSize") || 4096;
      const useGpu = config.get<boolean>("useGpu") || false;
      
      const args = [
        "-m", modelPath,
        "-c", contextSize.toString(),
        "--port", port.toString(),
        "--host", "127.0.0.1",
        "-ngl", useGpu ? "99" : "0",
        "--mlock",
        "--no-mmap",
        "-t", "4"
      ];
      
      console.log(`Starting server: ${llamaPath} ${args.join(" ")}`);
      
      // Kill any existing process
      if (this.llamaProcess) {
        this.llamaProcess.kill();
        this.llamaProcess = null;
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for process to die
      }
      
      // Start new process
      this.llamaProcess = spawn(llamaPath, args, {
        stdio: ["ignore", "pipe", "pipe"]
      });
      
      this.llamaProcess.stdout?.on("data", (data: Buffer) => {
        console.log(`llama.cpp: ${data.toString()}`);
      });
      
      this.llamaProcess.stderr?.on("data", (data: Buffer) => {
        console.error(`llama.cpp error: ${data.toString()}`);
      });
      
      this.llamaProcess.on("error", (error) => {
        console.error("Failed to start llama.cpp:", error);
        this.isServerRunning = false;
        vscode.window.showErrorMessage(
          `Failed to start AI server: ${error.message}`
        );
      });
      
      this.llamaProcess.on("close", (code) => {
        console.log(`llama.cpp exited with code ${code}`);
        this.isServerRunning = false;
        
        // Auto-restart if it crashed unexpectedly
        if (code !== 0 && code !== null) {
          setTimeout(() => {
            this.ensureServerRunning();
          }, 5000);
        }
      });
      
      // Wait for server to be ready
      const ready = await this.waitForServer();
      if (ready) {
        this.isServerRunning = true;
        this.serverStartAttempts = 0; // Reset counter on success
        vscode.window.setStatusBarMessage("✅ Sidekick AI ready!", 3000);
        return true;
      }
      
      return false;
    } catch (error) {
      console.error("Error starting server:", error);
      return false;
    }
  }
  

  private async ensureModel(): Promise<string | null> {
    const config = vscode.workspace.getConfiguration("sidekick-ai");
    const knownModelPath = config.get<string>("modelPath");
    if (!knownModelPath) {
      // Guide user through setup instead of using a default path
      return await this.setupModelPath();
    }
    if (knownModelPath) {
      try {
        await fs.access(knownModelPath);
        console.log(`Found model at: ${knownModelPath}`);
        return knownModelPath;
      } catch {
        vscode.window.showErrorMessage(
          "Configured model path no longer exists"
        );
        // Model not at known location
      }
    }
    // Check for model in workspace or global storage
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return null;

    if (workspaceFolder) {
      const modelsDir = path.join(workspaceFolder.uri.fsPath, ".models");

      try {
        const files = await fs.readdir(modelsDir);
        const ggufFile = files.find((f) => f.endsWith(".gguf"));
        if (ggufFile) {
          const fullPath = path.join(modelsDir, ggufFile);
          // Save it to config for next time
          await config.update("modelPath", fullPath, true);
          return fullPath;
        }
        return null;
      } catch (error) {
        console.error("Error ensuring model:", error);
        return null;
      }
    }
    return await this.setupModelPath();
  }

  private async setupModelPath(): Promise<string | null> {
    const result = await vscode.window.showInformationMessage(
      "No AI model configured. Sidekick AI needs a GGUF model file to work.",
      "Select Model File",
      "Download Model",
      "Setup Guide"
    );

    if (result === "Select Model File") {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        filters: { "GGUF Models": ["gguf"] },
        title: "Select your GGUF model file",
      });

      if (fileUri?.[0]) {
        const config = vscode.workspace.getConfiguration("sidekick-ai");
        await config.update("modelPath", fileUri[0].fsPath, true);
        return fileUri[0].fsPath;
      }
    } else if (result === "Download Model") {
      vscode.env.openExternal(
        vscode.Uri.parse(
          "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"
        )
      );
      vscode.window.showInformationMessage(
        "Download the model file, then come back and select it using 'Select Model File'"
      );
    } else if (result === "Setup Guide") {
      vscode.env.openExternal(
        vscode.Uri.parse(
          "https://marketplace.visualstudio.com/items?itemName=NaveenBabu.sidekick-ai"
        )
      );
    }
    return null;
  }

  private async startLlamaCppServer(): Promise<void> {
    if (this.isServerRunning) return;

    const platform = os.platform();
    let serverCommand = "";

    // Determine the llama.cpp server command based on platform
    if (platform === "win32") {
      serverCommand = "server.exe";
    } else if (platform === "darwin") {
      serverCommand = "./server";
    } else {
      serverCommand = "./server";
    }

    // Build command arguments
    const args = [
      "-m",
      this.currentModel.path,
      "-c",
      this.currentModel.contextSize.toString(),
      "--port",
      this.llamaEndpoint.split(":").pop() || "8080",
      "--host",
      "127.0.0.1",
      "-ngl",
      this.currentModel.useGpu ? "99" : "0", // GPU layers
      "--mlock", // Lock model in memory
      "--no-mmap", // Don't use memory mapping
      "-t",
      "4", // Number of threads
      "--ctx-size",
      this.currentModel.contextSize.toString(),
      "--verbose",
    ];

    try {
      // Try to find llama.cpp server executable
      const possiblePaths = [
        path.join(os.homedir(), "llama.cpp", serverCommand),
        path.join(os.homedir(), ".local", "bin", serverCommand),
        path.join("/usr", "local", "bin", serverCommand),
        serverCommand, // Try PATH
      ];

      let serverPath = await this.findLlamaExecutable();
      if (!serverPath) {
        return; // findLlamaExecutable already shows error messages
      }

      console.log(`Starting llama.cpp server: ${serverPath} ${args.join(" ")}`);

      // Start the server
      this.llamaProcess = spawn(serverPath, args);

      if (this.llamaProcess.stdout) {
        this.llamaProcess.stdout.on("data", (data: Buffer) => {
          console.log(`llama.cpp: ${data.toString()}`);
        });
      }

      if (this.llamaProcess.stderr) {
        this.llamaProcess.stderr.on("data", (data: Buffer) => {
          console.error(`llama.cpp error: ${data.toString()}`);
        });
      }

      this.llamaProcess.on("close", (code: number) => {
        console.log(`llama.cpp server exited with code ${code}`);
        this.isServerRunning = false;
      });

      // Wait for server to be ready
      await this.waitForServer();

      this.isServerRunning = true;
    } catch (error) {
      console.error("Failed to start llama.cpp server:", error);
      vscode.window.showErrorMessage(
        "Failed to start llama.cpp server. Check the console for details."
      );
    }
  }

  private async findLlamaExecutable(): Promise<string | null> {
    const config = vscode.workspace.getConfiguration("sidekick-ai");
    const configuredPath = config.get<string>("llamaPath");

    if (configuredPath) {
      try {
        await fs.access(configuredPath);
        return configuredPath;
      } catch {
        vscode.window.showWarningMessage(
          "Configured llama.cpp path not found. Please reconfigure."
        );
      }
    }

    // Platform-specific executable names
    const platform = os.platform();
    const execNames =
      platform === "win32"
        ? ["llama-server.exe", "server.exe", "llama.cpp.exe"]
        : ["llama-server", "server", "llama.cpp"];

    // Common installation locations to check
    const searchPaths = [
      path.join(os.homedir(), "llama.cpp"),
      path.join(os.homedir(), ".llama.cpp"),
      path.join(os.homedir(), "Downloads", "llama.cpp"),
      path.join("C:", "llama.cpp"), // Windows common location
      path.join("D:", "llama.cpp"), // Windows alternative
      "/usr/local/bin", // macOS/Linux
      "/opt/llama.cpp", // Linux alternative
    ];

    // Check each combination
    for (const dir of searchPaths) {
      for (const exe of execNames) {
        const fullPath = path.join(dir, exe);
        try {
          await fs.access(fullPath);
          // Found it! Save for next time
          await config.update("llamaPath", fullPath, true);
          vscode.window.showInformationMessage(
            `Found llama.cpp at ${fullPath}`
          );
          return fullPath;
        } catch {
          // Continue searching
        }
      }
    }

    // Try system PATH
    for (const cmd of execNames) {
      try {
        const { stdout } = await execAsync(
          platform === "win32" ? `where ${cmd}` : `which ${cmd}`
        );
        const path = stdout.trim().split("\n")[0]; // First result
        if (path) {
          await config.update("llamaPath", path, true);
          return path;
        }
      } catch {
        // Not in PATH
      }
    }

    // Not found - guide user with better instructions
    const result = await vscode.window.showErrorMessage(
      "llama.cpp not found. You need to install it for Sidekick AI to work.",
      "Download llama.cpp",
      "Select Executable",
      "Setup Instructions"
    );

    if (result === "Download llama.cpp") {
      const downloadUrl =
        platform === "win32"
          ? "https://github.com/ggerganov/llama.cpp/releases"
          : "https://github.com/ggerganov/llama.cpp#build";
      vscode.env.openExternal(vscode.Uri.parse(downloadUrl));
      vscode.window.showInformationMessage(
        "After downloading, extract it and select the llama-server executable"
      );
    } else if (result === "Select Executable") {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        filters:
          platform === "win32"
            ? { Executable: ["exe"] }
            : { "All Files": ["*"] },
        title: "Select llama-server executable",
      });

      if (fileUri?.[0]) {
        await config.update("llamaPath", fileUri[0].fsPath, true);
        return fileUri[0].fsPath;
      }
    } else if (result === "Setup Instructions") {
      vscode.env.openExternal(
        vscode.Uri.parse(
          "https://marketplace.visualstudio.com/items?itemName=NaveenBabu.sidekick-ai"
        )
      );
    }

    return null;
  }

  private async waitForServer(maxAttempts = 30): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`${this.llamaEndpoint}/health`);
        if (await this.checkServerHealth()) {
          console.log("llama.cpp server is ready");
          return true;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }
  private async checkServerHealth(): Promise<boolean> {
    try {
      const config = vscode.workspace.getConfiguration("sidekick-ai");
      const port = config.get<number>("port") || 8080;
      const response = await fetch(`http://localhost:${port}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
  private startHealthMonitoring(): void {
    // Check server health every 30 seconds
    this.serverCheckInterval = setInterval(async () => {
      if (Date.now() - this.lastHealthCheck > 30000) {
        const healthy = await this.checkServerHealth();
        if (!healthy && this.isServerRunning) {
          console.log("Server health check failed, attempting restart...");
          this.isServerRunning = false;
          await this.ensureServerRunning();
        }
        this.lastHealthCheck = Date.now();
      }
    }, 30000);
  }

  async generateCompletion(
    prompt: string,
    context: string,
    maxTokens: number = 150,
    languageId?: string
  ): Promise<string> {
    console.log("🚀 generateCompletion called with llama.cpp");

    // Check cache
    const cacheKey = prompt.trim().substring(prompt.length - 50);
    if (this.modelCache.has(cacheKey)) {
      console.log("Using cached completion");
      return this.modelCache.get(cacheKey) || "";
    }

    // Try quick completion first
    const quickCompletion = this.getQuickCompletion(prompt);
    if (quickCompletion) {
      console.log("Using quick completion:", quickCompletion);
      return quickCompletion;
    }

    if (!this.isServerRunning) {
      console.log("Server not running, using fallback");
      await this.ensureServerRunning();
      return "";
    }

    try {
      const lines = prompt.split("\n");
      const currentLine = lines[lines.length - 1];
      const contextLines = lines.slice(-10, -1).join("\n");

      // Build FIM (Fill-In-Middle) prompt for code completion
      // Different models use different FIM tokens
      let fimPrompt = "";

      if (this.currentModel.name.includes("deepseek")) {
        // DeepSeek format
        fimPrompt = `${contextLines}
${currentLine}<｜fim▁hole｜>`;
      } else if (this.currentModel.name.includes("starcoder")) {
        // StarCoder format
        fimPrompt = `<fim_prefix>${contextLines}
${currentLine}<fim_suffix><fim_middle>`;
      } else if (this.currentModel.name.includes("codellama")) {
        // CodeLlama format
        fimPrompt = ` <PRE> ${contextLines}
${currentLine} <SUF> <MID>`;
      } else {
        // Generic format - just continue the code
        fimPrompt = `${contextLines}
${currentLine}`;
      }

      console.log("Requesting completion from llama.cpp...");
      const startTime = Date.now();

      const response = await fetch(`${this.llamaEndpoint}/completion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: fimPrompt,
          n_predict: 50, // Very short for inline completion
          temperature: 0.2,
          top_k: 40,
          top_p: 0.95,
          repeat_penalty: 1.1,
          stop: [
            "\n",
            "<｜fim",
            "```",
            "\nfunction",
            "\nclass",
            "\nconst",
            "\nlet",
            "\nvar",
            "\ndef ",
            "\nif ",
            "\nfor ",
            "\nwhile ",
          ],
          cache_prompt: true, // Cache for faster subsequent completions
          stream: false,
        }),
      });

      const responseTime = Date.now() - startTime;
      console.log("Response time:", responseTime, "ms");

      if (!response.ok) {
        console.error("llama.cpp error:", response.status);
        return this.getFallbackCompletion(prompt);
      }

      const data = (await response.json()) as LlamaCppResponse;
      let completion = data.content?.trim() || "";

      console.log("Raw response:", completion);
      console.log("Tokens predicted:", data.tokens_predicted);
      console.log("Speed:", data.timings?.predicted_per_second, "tokens/sec");

      // Clean the completion
      completion = this.cleanCompletion(completion, currentLine);

      if (!completion) {
        return this.getFallbackCompletion(prompt);
      }

      console.log("✅ Final completion:", completion);

      // Cache it
      this.modelCache.set(cacheKey, completion);
      if (this.modelCache.size > 100) {
        const firstKey = this.modelCache.keys().next().value;
        if (firstKey !== undefined) {
          this.modelCache.delete(firstKey);
        }
      }

      return completion;
    } catch (error) {
      console.error("llama.cpp completion error:", error);
      return this.getFallbackCompletion(prompt);
    }
  }

  private cleanCompletion(completion: string, currentLine: string): string {
    // Remove FIM tokens
    completion = completion.replace(/<｜fim[^｜]*｜>/g, "");
    completion = completion.replace(/<fim_[^>]+>/g, "");
    completion = completion.replace(/<(PRE|SUF|MID)>/g, "");

    // Remove current line if repeated
    if (completion.startsWith(currentLine)) {
      completion = completion.substring(currentLine.length);
    }

    // Take only the actual code completion (first line usually)
    const lines = completion.split("\n");
    completion = lines[0].trim();

    // Limit length for inline completion
    if (completion.length > 50) {
      const breakPoints = [";", "{", ")", "]", ","];
      for (const point of breakPoints) {
        const idx = completion.indexOf(point);
        if (idx > 0 && idx <= 50) {
          completion = completion.substring(0, idx + 1);
          break;
        }
      }
      if (completion.length > 50) {
        completion = completion.substring(0, 50);
      }
    }

    return completion;
  }

  private getQuickCompletion(prompt: string, languageId?: string): string {
    const trimmed = prompt.trim();
    const lastLine = trimmed.split("\n").pop() || "";

    // Get language-specific patterns
    const language = languageId || this.detectLanguage(prompt);
    const patterns = LanguageService.getCompletionPatterns(language);
    
    // Check language-specific patterns first
    for (const [pattern, completion] of Object.entries(patterns)) {
      if (lastLine.endsWith(pattern)) {
        return completion;
      }
    }
    
    // Generic patterns that work across languages
    const genericPatterns: Record<string, string> = {
      "{": "\n  ",
      "(": ")",
      "[": "]",
      '"': '"',
      "'": "'",
      "`": "`",
      ";": "\n  ",
      ":": "\n    ", // Python/YAML indentation
    };
    
    for (const [pattern, completion] of Object.entries(genericPatterns)) {
      if (lastLine.endsWith(pattern)) {
        return completion;
      }
    }

    return "";
  }

  private getFallbackCompletion(prompt: string): string {
    const lines = prompt.split("\n");
    const currentLine = lines[lines.length - 1];
    const trimmed = currentLine.trim();

    if (trimmed.endsWith(";")) return "\n  ";
    if (trimmed.endsWith("=")) return " ";
    if (trimmed.endsWith(".")) return "";
    if (trimmed.endsWith(",")) return " ";

    return "";
  }

  async stopServer() {
    if (this.llamaProcess) {
      this.llamaProcess.kill();
      this.llamaProcess = null;
      this.isServerRunning = false;
      console.log("llama.cpp server stopped");
    }
  }

  // Keep compatibility with existing methods
  async checkModelStatus(): Promise<{ isReady: boolean; models: string[] }> {
    return {
      isReady: this.isServerRunning,
      models: this.currentModel.path ? [this.currentModel.name] : [],
    };
  }

  async downloadModels(
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ) {
    progress.report({
      message: "Please download GGUF models manually",
      increment: 100,
    });
  }

  async explainCode(code: string, context: string, languageId?: string): Promise<string> {
    if (!this.isServerRunning) {
      await this.ensureServerRunning();
    }

    const language = languageId || this.detectLanguage(code);
    const prompt = LanguageService.generatePrompt(language, 'explain', code, "");

    try {
      const response = await fetch(`${this.llamaEndpoint}/completion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt,
          n_predict: 300,
          temperature: 0.3,
          top_k: 40,
          top_p: 0.95,
          stop: ["\n\n\n", "```", "\nCode:", "\nQuestion:"],
          cache_prompt: false,
          stream: false,
        }),
      });

      if (!response.ok) {
        return "Failed to explain code";
      }

      const data = (await response.json()) as LlamaCppResponse;
      let explanation = data.content?.trim() || "Unable to explain code";

      // Clean up the explanation
      explanation = explanation.replace(/^[\s\n]+/, "").replace(/[\s\n]+$/, "");

      return explanation;
    } catch (error) {
      console.error("Failed to explain code:", error);
      return "Unable to explain code";
    }
  }

  async refactorCode(
    code: string,
    instruction: string,
    context: string,
    languageId?: string
  ): Promise<string> {
    if (!this.isServerRunning) {
      await this.ensureServerRunning();
    }

    const language = languageId || this.detectLanguage(code);
    const prompt = LanguageService.generatePrompt(language, 'refactor', code, instruction);

    try {
      const response = await fetch(`${this.llamaEndpoint}/completion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt,
          n_predict: 500,
          temperature: 0.2,
          top_k: 30,
          top_p: 0.9,
          stop: ["```", "\n\n#", "\nOriginal", "\n\nInstruction"],
          cache_prompt: false,
          stream: false,
        }),
      });

      if (!response.ok) {
        return code;
      }

      const data = (await response.json()) as LlamaCppResponse;
      let refactored = data.content?.trim() || "";

      // Clean the response - remove any markdown or extra text
      refactored = refactored
        .replace(/^```[\w]*\n?/, "")
        .replace(/\n?```$/, "");
      refactored = refactored.trim();

      return refactored || code;
    } catch (error) {
      console.error("Failed to refactor code:", error);
      return code;
    }
  }

  async generateTests(code: string, context: string, languageId?: string): Promise<string> {
    if (!this.isServerRunning) {
      await this.ensureServerRunning();
    }

    const language = languageId || this.detectLanguage(code);
    const prompt = LanguageService.generatePrompt(language, 'test', code, "");

    try {
      const response = await fetch(`${this.llamaEndpoint}/completion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt,
          n_predict: 800,
          temperature: 0.3,
          top_k: 40,
          top_p: 0.95,
          stop: ["```", "\n\n#", "\n\nCode"],
          cache_prompt: false,
          stream: false,
        }),
      });

      if (!response.ok) {
        return "// Unable to generate tests";
      }

      const data = (await response.json()) as LlamaCppResponse;
      let tests = data.content?.trim() || "";

      // Clean the response
      tests = tests.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
      tests = tests.trim();

      if (!tests) {
        return "// Unable to generate tests";
      }

      // Add framework boilerplate if missing
      // const testImports = LanguageService.getTestImports(language);
      // if (typeof testImports === "string" && testImports) {
      //   const firstImportLine = (typeof testImports === 'string' && testImports) ? testImports.split('\n')[0] : '';
      //   if (!tests.includes(firstImportLine)) {
      //     tests = `${testImports}\n\n${tests}`;
      //   }
      // }

      return tests;
    } catch (error) {
      console.error("Failed to generate tests:", error);
      return "// Unable to generate tests";
    }
  }

  // Add this method to your LocalAIProvider class (in LocalAIProvider.ts)
  // Place it after the generateTests method

  async chat(message: string, context: string): Promise<string> {
    if (!this.isServerRunning) {
      // Check if server is running
      try {
        const started = await this.ensureServerRunning();
        if (!started) {
          return "⚠️ AI server is not running. Please check your configuration in VS Code settings (Ctrl+,) and search for 'sidekick-ai'";
        } else {
          return (
            "⚠️ AI server is not responding. Please check:\n\n" +
            "1. Is llama.cpp installed? If not, download from: https://github.com/ggerganov/llama.cpp/releases\n" +
            "2. Is the server running? Try starting it manually\n" +
            "3. Check VS Code settings (Ctrl+,) and search for 'sidekick-ai'\n\n" +
            "Need help? Visit: https://marketplace.visualstudio.com/items?itemName=NaveenBabu.sidekick-ai"
          );
        }
      } catch (error) {
        return (
          "⚠️ Cannot connect to AI server.\n\n" +
          "Quick fix:\n" +
          "1. Open settings (Ctrl+,)\n" +
          "2. Search for 'sidekick-ai'\n" +
          "3. Set your model and llama.cpp paths\n\n" +
          "Or visit setup guide: https://marketplace.visualstudio.com/items?itemName=NaveenBabu.sidekick-ai"
        );
      }
    }

    // Build a chat-style prompt
    const prompt = `You are a helpful AI coding assistant. Answer the user's question based on the context provided.

${context ? `Context:\n${context}\n` : ""}
User: ${message}
Assistant:`;

    try {
      console.log("Sending chat request to llama.cpp...");

      const response = await fetch(`${this.llamaEndpoint}/completion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt,
          n_predict: 500, // Reasonable length for chat responses
          temperature: 0.7, // More creative for chat
          top_k: 40,
          top_p: 0.95,
          repeat_penalty: 1.1,
          stop: [
            "\nUser:",
            "\nHuman:",
            "\n\n\n",
            "```\n\n",
            "\nAssistant:",
            "<|endoftext|>",
          ],
          cache_prompt: false,
          stream: false,
        }),
      });

      if (!response.ok) {
        console.error("llama.cpp chat error:", response.status);
        return `Server error: ${response.status}. Please check if the llama.cpp server is running properly.`;
      }

      const data = (await response.json()) as any;
      let chatResponse = data.content?.trim() || "";

      if (!chatResponse) {
        return "I couldn't generate a response. Please try again.";
      }

      // Clean up the response
      chatResponse = chatResponse.replace(/^(Assistant:|AI:)\s*/i, "");
      chatResponse = chatResponse.replace(/\n(User:|Human:).*$/s, "");
      chatResponse = chatResponse.trim();

      console.log("Chat response received:", chatResponse);

      return chatResponse;
    } catch (error) {
      console.error("Chat error:", error);
      return `Error connecting to AI: ${
        error instanceof Error ? error.message : "Unknown error"
      }. Please ensure the llama.cpp server is running.`;
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // Not implemented for llama.cpp yet
    return [];
  }

  async streamChat(
    message: string,
    context: string,
    onToken: (token: string) => void
  ): Promise<void> {
    // Not implemented for llama.cpp yet
  }

  async initialize(): Promise<void> {
    console.log("Initializing LocalAIProvider...");
    // Create a status bar item for Sidekick AI
    const statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    statusItem.text = "Sidekick AI: Initializing...";
    statusItem.show();

    // Check if we have saved configuration
    const config = vscode.workspace.getConfiguration("sidekick-ai");
    const modelPath = config.get<string>("modelPath");
    const llamaPath = config.get<string>("llamaPath");

    try {
      await this.initializeLlamaCpp();
      if (!modelPath) {
        const setupResult = await this.runFirstTimeSetup();
        if (!setupResult) {
          console.log("User skipped setup");
          return;
        }
      }
      // Always try to start the server automatically
      await this.ensureServerRunning();

      if (this.isServerRunning) {
        statusItem.text = "$(check) Sidekick AI";
        statusItem.tooltip =
          "Sidekick AI is ready - Ctrl+Shift+A for chat";
      } else {
        statusItem.text = "$(warning) Sidekick AI";
        statusItem.tooltip = "Click to setup";
        const result = await vscode.window.showWarningMessage(
          "Sidekick AI needs setup. Would you like to configure it now?",
          "Setup Now",
          "Later"
        );

        if (result === "Setup Now") {
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "@ext:NaveenBabu.sidekick-ai"
          );
        }
      }
    } catch (error) {
      statusItem.text = "$(error) Sidekick AI";
      statusItem.tooltip =
        "Initialization failed. Check the console for details.";
      console.error("Initialization failed:", error);
    }
  }

  async getAvailableModels(): Promise<string[]> {
    return this.currentModel.path ? [this.currentModel.name] : [];
  }

  async switchModel(modelName: string) {
    // Would need to restart server with new model
    console.log("Model switching not implemented for llama.cpp");
  }

  private detectLanguage(code: string): string {
    return LanguageService.detectLanguage(code);
  }

  private getTestFramework(language: string): string {
    const config = LanguageService.getLanguageConfig(language);
    return config?.testFramework || "unit tests";
  }

  dispose(): void {
    if (this.serverCheckInterval) {
      clearInterval(this.serverCheckInterval);
    }
    
    if (this.llamaProcess) {
      this.llamaProcess.kill();
      this.llamaProcess = null;
    }
  }
}
