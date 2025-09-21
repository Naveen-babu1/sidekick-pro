// providers/InlineCompletionProvider.ts
import * as vscode from "vscode";
import { ModelService } from "../services/modelService";
import { CodeIndexer } from "../indexer/CodeIndexer";
import { PrivacyGuard } from "../security/PrivacyGuard";

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private modelService: ModelService;
  private lastCompletionTime = 0;
  private minDelay = 300;

  constructor(
    private context: vscode.ExtensionContext,
    private indexer: CodeIndexer,
    private privacyGuard: PrivacyGuard
  ) {
    this.modelService = new ModelService(context);
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {
    
    const now = Date.now();
    if (now - this.lastCompletionTime < this.minDelay) {
      return [];
    }
    this.lastCompletionTime = now;
    
    const line = document.lineAt(position.line);
    const linePrefix = line.text.substring(0, position.character);
    
    if (linePrefix.trim().length < 2) {
      return [];
    }
    
    const lineSuffix = line.text.substring(position.character);
    if (lineSuffix.trim().length > 0) {
      return [];
    }
    
    const contextLines = this.getContext(document, position);
    const prompt = `${contextLines}\n${linePrefix}`;
    
    try {
      const completion = await this.modelService.generateCompletion(
        prompt,
        this.indexer.getContext(),
        150
      );
      
      if (token.isCancellationRequested || !completion) {
        return [];
      }
      
      const item = new vscode.InlineCompletionItem(
        completion,
        new vscode.Range(position, position)
      );
      
      return [item];
    } catch (error) {
      console.error("Completion error:", error);
      return [];
    }
  }
  
  private getContext(document: vscode.TextDocument, position: vscode.Position): string {
    const startLine = Math.max(0, position.line - 10);
    const endLine = position.line;
    
    const lines = [];
    for (let i = startLine; i < endLine; i++) {
      lines.push(document.lineAt(i).text);
    }
    
    return lines.join("\n");
  }
}