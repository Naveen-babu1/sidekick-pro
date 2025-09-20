"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const contextKeeperClient_1 = require("./services/contextKeeperClient");
// Import your original Sidekick extension
const sidekickExtension = require('./extension.original');
let contextKeeper;
async function activate(context) {
    console.log('🚀 Activating Sidekick Pro (Integrated)...');
    // Start Context Keeper
    contextKeeper = new contextKeeperClient_1.ContextKeeperClient(context);
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Starting Sidekick Pro",
            cancellable: false
        }, async (progress) => {
            progress.report({ message: "Starting Context Keeper..." });
            await contextKeeper.start();
            progress.report({ message: "Initializing Sidekick AI..." });
            // Activate original Sidekick
            await sidekickExtension.activate(context);
            // Index current workspace
            if (vscode.workspace.workspaceFolders) {
                progress.report({ message: "Indexing repository..." });
                const repoPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
                await contextKeeper.indexRepository(repoPath).catch(console.error);
            }
        });
        // Add Context Keeper search command
        const searchCommand = vscode.commands.registerCommand('sidekick.search', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Search repository history',
                placeHolder: 'e.g., Why did we change this function?'
            });
            if (query) {
                const results = await contextKeeper.searchRepository(query);
                // Show results
                vscode.window.showInformationMessage(`Found ${results.sources?.length || 0} results`);
            }
        });
        context.subscriptions.push(searchCommand);
        // Make Context Keeper available globally
        global.contextKeeper = contextKeeper;
        vscode.window.showInformationMessage('✨ Sidekick Pro is ready with Context Keeper!');
    }
    catch (error) {
        vscode.window.showErrorMessage(`Failed to start Sidekick Pro: ${error}`);
    }
}
async function deactivate() {
    if (contextKeeper) {
        contextKeeper.dispose();
    }
    if (sidekickExtension.deactivate) {
        await sidekickExtension.deactivate();
    }
}
//# sourceMappingURL=integrationExtension.js.map