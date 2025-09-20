import * as vscode from 'vscode';
import { ContextKeeperClient } from './services/contextKeeperClient';

export async function activate(context: vscode.ExtensionContext) {
    console.log('Activating Sidekick Pro Test...');
    
    const contextKeeper = new ContextKeeperClient(context);
    
    // Add test command
    const testCommand = vscode.commands.registerCommand('sidekick.test', async () => {
        try {
            await contextKeeper.start();
            const stats = await contextKeeper.getStats();
            vscode.window.showInformationMessage(`Context Keeper Stats: ${JSON.stringify(stats)}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error: ${error.message}`);
        }
    });
    
    context.subscriptions.push(testCommand);
    
    vscode.window.showInformationMessage('Sidekick Pro Test Ready - Run "Sidekick: Test" command');
}

export function deactivate() {}
