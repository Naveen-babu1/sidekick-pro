"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextKeeperClient = void 0;
const vscode = require("vscode");
const child_process_1 = require("child_process");
const path = require("path");
const fs = require("fs");
class ContextKeeperClient {
    constructor(context) {
        this.context = context;
        this.process = null;
        this.port = 8000; // Default port from your backend
        this.isReady = false;
        this.baseUrl = `http://localhost:${this.port}`;
    }
    async start() {
        const backendPath = path.join(this.context.extensionPath, '..', 'backend');
        const mainPy = path.join(backendPath, 'app', 'main.py');
        // Use Python from virtual environment
        const venvPython = process.platform === 'win32'
            ? path.join(backendPath, 'venv', 'Scripts', 'python.exe')
            : path.join(backendPath, 'venv', 'bin', 'python');
        if (!fs.existsSync(venvPython)) {
            vscode.window.showErrorMessage('Python virtual environment not found. Please set up the backend first.');
            throw new Error('Virtual environment not found');
        }
        if (!fs.existsSync(mainPy)) {
            throw new Error('Context Keeper backend not found');
        }
        console.log('Starting Context Keeper with:', venvPython);
        // Start the Python backend
        this.process = (0, child_process_1.spawn)(venvPython, [mainPy], {
            cwd: backendPath,
            env: {
                ...process.env,
                PYTHONPATH: backendPath,
                PYTHONUNBUFFERED: '1'
            }
        });
        this.process.stdout?.on('data', (data) => {
            const output = data.toString();
            console.log(`Context Keeper: ${output}`);
            if (output.includes('Uvicorn running')) {
                this.isReady = true;
            }
        });
        this.process.stderr?.on('data', (data) => {
            const output = data.toString();
            // Only log actual errors, not INFO messages
            if (!output.includes('INFO') && !output.includes('WARNING')) {
                console.error(`Context Keeper Error: ${output}`);
            }
        });
        // Wait for backend to be ready
        await this.waitForReady();
    }
    async waitForReady(maxAttempts = 30) {
        console.log('Waiting for Context Keeper to be ready...');
        for (let i = 0; i < maxAttempts; i++) {
            try {
                const response = await fetch(`${this.baseUrl}/health`);
                if (response.ok) {
                    this.isReady = true;
                    console.log('✅ Context Keeper is ready!');
                    vscode.window.showInformationMessage('Context Keeper connected successfully!');
                    return;
                }
            }
            catch (e) {
                // Not ready yet, wait
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        throw new Error('Context Keeper failed to start after 30 seconds');
    }
    async searchRepository(query) {
        if (!this.isReady) {
            throw new Error('Context Keeper not ready');
        }
        const response = await fetch(`${this.baseUrl}/api/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, limit: 10 })
        });
        if (!response.ok) {
            throw new Error(`Search failed: ${response.statusText}`);
        }
        return response.json();
    }
    async indexRepository(repoPath) {
        if (!this.isReady) {
            throw new Error('Context Keeper not ready');
        }
        console.log('Indexing repository:', repoPath);
        const response = await fetch(`${this.baseUrl}/api/ingest/git`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repo_path: repoPath,
                max_commits: 100
            })
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to index repository: ${error}`);
        }
        vscode.window.showInformationMessage('Repository indexed successfully!');
    }
    async getStats() {
        const response = await fetch(`${this.baseUrl}/api/stats`);
        return response.json();
    }
    dispose() {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
    }
}
exports.ContextKeeperClient = ContextKeeperClient;
//# sourceMappingURL=contextKeeperClient.js.map