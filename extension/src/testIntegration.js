"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const contextKeeperClient_1 = require("./services/contextKeeperClient");
async function activate(context) {
    console.log('Activating Sidekick Pro Test...');
    const contextKeeper = new contextKeeperClient_1.ContextKeeperClient(context);
    // Add test command
    const testCommand = vscode.commands.registerCommand('sidekick.test', async () => {
        try {
            await contextKeeper.start();
            const stats = await contextKeeper.getStats();
            vscode.window.showInformationMessage(`Context Keeper Stats: ${JSON.stringify(stats)}`);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Error: ${error.message}`);
        }
    });
    context.subscriptions.push(testCommand);
    vscode.window.showInformationMessage('Sidekick Pro Test Ready - Run "Sidekick: Test" command');
}
function deactivate() { }
//# sourceMappingURL=testIntegration.js.map