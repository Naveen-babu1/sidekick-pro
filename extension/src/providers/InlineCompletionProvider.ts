
import * as vscode from "vscode";
import { LocalAIProvider } from "./LocalAIProvider";
import { CodeIndexer } from "../indexer/CodeIndexer";
import { PrivacyGuard } from "../security/PrivacyGuard";

export class InlineCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  private debounceTimer: NodeJS.Timeout | undefined;
  private lastCompletionTime = 0;
    private minDelay = 500;

  constructor(
    private localAI: LocalAIProvider,
    private indexer: CodeIndexer,
    private privacyGuard: PrivacyGuard
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {

    // Debounce - don't trigger too often
        const now = Date.now();
        if (now - this.lastCompletionTime < this.minDelay) {
            return [];
        }
        this.lastCompletionTime = now;
        
        const line = document.lineAt(position.line);
    // Get current line
    const linePrefix = line.text.substring(0, position.character);

    // Skip if line is too short or just whitespace
    if (linePrefix.trim().length < 2) {
      console.log("Skipping - line too short");
      return [];
    }

    // Skip if typing in middle of line
        const lineSuffix = line.text.substring(position.character);
        if (lineSuffix.trim().length > 0) {
            return [];
        }

    // Skip if in middle of word
    if (position.character > 0) {
      const charBefore = document.lineAt(position.line).text[
        position.character - 1
      ];
      if (/\w/.test(charBefore)) {
        return [];
      }
    }

    console.log("Getting completion for:", linePrefix);

    // Get context from surrounding code
    const contextLines = this.getContext(document, position);

    // Build prompt
    const prompt = `${contextLines}\n${linePrefix}`;

    try {

      // Get context from surrounding code
    const contextLines = this.getContext(document, position);

    // Build prompt
    const prompt = `${contextLines}\n${linePrefix}`;


      // Get completion from AI
      const completion = await this.localAI.generateCompletion(
        prompt,
        this.indexer.getContext(),
        150 // max tokens
      );

      // Check if VS Code cancelled the request
        if (token.isCancellationRequested) {
            console.log("Cancelled by VS Code");
            return [];
        }

      if (!completion) {
        console.log("No completion or cancelled");
        return [];
      }

      console.log("AI suggested:", completion);

      // Create the inline completion item
      const item = new vscode.InlineCompletionItem(
        completion,
        new vscode.Range(position, position),
        {
          title: "AI Generated",
          command: "sidekick-ai.acceptedCompletion",
          arguments: [completion],
        }
      );

      console.log('📦 Returning completion item');

      // Return as inline completion
      return [item];
    } catch (error) {
      console.error("Completion error:", error);
      return [];
    }
  }

  private getContext(
    document: vscode.TextDocument,
    position: vscode.Position
  ): string {
    const startLine = Math.max(0, position.line - 10);
    const endLine = position.line;

    const lines = [];
    for (let i = startLine; i < endLine; i++) {
      lines.push(document.lineAt(i).text);
    }

    return lines.join("\n");
  }
}
