"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodeFixProvider = void 0;
const vscode = require("vscode");
class CodeFixProvider {
    constructor(localAI, diagnosticCollection) {
        this.localAI = localAI;
        this.diagnosticCollection = diagnosticCollection;
    }
    async provideCodeActions(document, range, context, token) {
        const actions = [];
        // Get diagnostics (errors) at this location
        const diagnostics = context.diagnostics.filter(diagnostic => diagnostic.severity === vscode.DiagnosticSeverity.Error);
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
    createFixAction(document, diagnostic) {
        const action = new vscode.CodeAction('Fix with Sidekick AI', vscode.CodeActionKind.QuickFix);
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
exports.CodeFixProvider = CodeFixProvider;
CodeFixProvider.providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix
];
//# sourceMappingURL=CodeFixProvider.js.map