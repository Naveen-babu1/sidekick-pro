import * as vscode from 'vscode';
import { LocalAIProvider } from './LocalAIProvider';

export class CodeFixProvider implements vscode.CodeActionProvider {
    constructor(
        private localAI: LocalAIProvider,
        private diagnosticCollection: vscode.DiagnosticCollection
    ) {}

    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    async provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.CodeAction[]> {
        const actions: vscode.CodeAction[] = [];
        
        // Get diagnostics (errors) at this location
        const diagnostics = context.diagnostics.filter(diagnostic => 
            diagnostic.severity === vscode.DiagnosticSeverity.Error
        );
        
        if (diagnostics.length === 0) {
            return actions;
        }
        
        // Create a fix action for each error
        for (const diagnostic of diagnostics) {
            const fixAction = this.createFixAction(document, diagnostic);
            if (fixAction) {
                actions.push(fixAction);
            }
        }
        
        return actions;
    }

    private createFixAction(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic
    ): vscode.CodeAction {
        const action = new vscode.CodeAction(
            'Fix with Sidekick AI',
            vscode.CodeActionKind.QuickFix
        );
        
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        
        // Command that will be executed when user clicks "Fix"
        action.command = {
            command: 'sidekick-ai.fixError',
            title: 'Fix Error',
            arguments: [document, diagnostic]
        };
        
        return action;
    }
}