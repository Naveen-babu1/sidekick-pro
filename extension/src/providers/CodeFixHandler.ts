import * as vscode from "vscode";
import { LocalAIProvider } from "./LocalAIProvider";

export class CodeFixHandler {
  constructor(
    private localAI: LocalAIProvider,
    private context: vscode.ExtensionContext
  ) {}

  async fixError(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== document) {
      return;
    }

    // Get FULL file context
    const fullFileContent = document.getText();
    const errorText = document.getText(diagnostic.range);
    const errorLine = diagnostic.range.start.line;

    // Find the containing code block (function, object, etc.)
    const blockRange = this.findContainingBlock(document, errorLine);
    const blockText = document.getText(blockRange);

    // Prepare prompt for AI
    const prompt = `Fix the errors in this code block:

\`\`\`${document.languageId}
${blockText}
\`\`\`

Error: ${diagnostic.message} at line ${errorLine + 1}

Full file context:
\`\`\`${document.languageId}
${fullFileContent}
\`\`\`
Analyze the entire file context and provide ONLY the fixed code that should replace "${errorText}". Do not include explanations, just the corrected code:`;

    try {
      // Show progress
      const fix = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Analyzing error with full context...",
          cancellable: false,
        },
        async () => {
          // Ensure server is running
          if (!(await this.localAI.checkModelStatus().then((s) => s.isReady))) {
            await this.localAI.ensureServerRunning();
          }

          // Get AI fix
          const response = await this.localAI.chat(prompt, fullFileContent);

          // Clean the response
          let fixedCode = response
            .replace(/```[a-z]*\n?/g, "")
            .replace(/```$/g, "")
            .trim();

          return fixedCode;
        }
      );

      if (!fix) {
        vscode.window.showErrorMessage("Could not generate fix");
        return;
      }

      // Create a preview panel to show the fix
      this.showFixPreview(editor, blockRange, fix, blockText);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to fix: ${error}`);
    }
  }

  // Helper to find the containing code block
  private findContainingBlock(
    document: vscode.TextDocument,
    errorLine: number
  ): vscode.Range {
    let startLine = errorLine;
    let endLine = errorLine;
    let braceCount = 0;
    let foundStart = false;

    // Search backwards for block start
    for (let i = errorLine; i >= 0; i--) {
      const line = document.lineAt(i).text;

      // Count braces going backwards
      for (let j = line.length - 1; j >= 0; j--) {
        if (line[j] === "}") braceCount++;
        if (line[j] === "{") {
          braceCount--;
          if (braceCount === -1) {
            startLine = i;
            foundStart = true;
            break;
          }
        }
      }

      if (foundStart) break;

      // Also check for function/const/let/var declarations
      if (line.match(/^\s*(function|const|let|var|class|interface)\s+\w+/)) {
        startLine = i;
        break;
      }
    }

    // Search forwards for block end
    braceCount = 0;
    let foundEnd = false;

    for (let i = startLine; i < document.lineCount; i++) {
      const line = document.lineAt(i).text;

      for (let j = 0; j < line.length; j++) {
        if (line[j] === "{") braceCount++;
        if (line[j] === "}") {
          braceCount--;
          if (braceCount === 0 && i > startLine) {
            endLine = i;
            foundEnd = true;
            break;
          }
        }
      }

      if (foundEnd) break;
    }

    // If we have a semicolon after the closing brace, include it
    if (endLine < document.lineCount - 1) {
      const nextLine = document.lineAt(endLine + 1).text.trim();
      if (nextLine.startsWith(";")) {
        endLine++;
      }
    }

    return new vscode.Range(
      startLine,
      0,
      endLine,
      document.lineAt(endLine).text.length
    );
  }

  private showFixPreview(
    editor: vscode.TextEditor,
    replaceRange: vscode.Range,
    fixedCode: string,
    originalCode: string
  ) {
    // Store document URI to get fresh editor later
    const documentUri = editor.document.uri;

    const documentVersion = editor.document.version;
    
    // Store the range in closure so it can't be changed
    const rangeToReplace = new vscode.Range(
        replaceRange.start.line,
        replaceRange.start.character,
        replaceRange.end.line,
        replaceRange.end.character
    );

    // Create a webview panel to show the fix preview
    const panel = vscode.window.createWebviewPanel(
      "sidekickFix",
      "AI Code Fix",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
      }
    );

    panel.webview.html = this.getFixPreviewHtml(originalCode, fixedCode);

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "accept":
            // Get FRESH editor reference
            const currentEditor = vscode.window.visibleTextEditors.find(
              (e) => e.document.uri.toString() === documentUri.toString()
            );

            if (!currentEditor) {
              vscode.window.showErrorMessage("Original editor not found");
              panel.dispose();
              return;
            }

            // Apply fix to the specific range
            const success = await currentEditor.edit((editBuilder) => {
              editBuilder.replace(rangeToReplace, fixedCode);
            });

            if (success) {
              vscode.window.showInformationMessage("Fix applied!");
            } else {
              vscode.window.showErrorMessage("Failed to apply fix");
            }

            panel.dispose();
            break;

          case "reject":
            panel.dispose();
            break;
        }
      },
      undefined,
      this.context.subscriptions
    );
  }

  private getFixPreviewHtml(original: string, fixed: string): string {
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    color: var(--vscode-foreground);
                }
                .container {
                    display: flex;
                    flex-direction: column;
                    gap: 20px;
                }
                .code-block {
                    background: var(--vscode-textCodeBlock-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    padding: 15px;
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                    overflow-x: auto;
                }
                .original {
                    background: rgba(255, 0, 0, 0.1);
                }
                .fixed {
                    background: rgba(0, 255, 0, 0.1);
                }
                .label {
                    font-weight: bold;
                    margin-bottom: 10px;
                }
                .actions {
                    display: flex;
                    gap: 10px;
                    justify-content: center;
                    padding: 20px;
                }
                button {
                    padding: 8px 20px;
                    border-radius: 4px;
                    border: none;
                    cursor: pointer;
                    font-size: 14px;
                }
                .accept {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                .accept:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                .reject {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                h2 {
                    text-align: center;
                }
            </style>
        </head>
        <body>
            <h2>🤖 AI Suggested Fix</h2>
            <div class="container">
                <div>
                    <div class="label">❌ Original (with error):</div>
                    <pre class="code-block original">${this.escapeHtml(
                      original
                    )}</pre>
                </div>
                <div>
                    <div class="label">✅ Fixed:</div>
                    <pre class="code-block fixed">${this.escapeHtml(
                      fixed
                    )}</pre>
                </div>
            </div>
            <div class="actions">
                <button class="accept" onclick="acceptFix()">Accept Fix</button>
                <button class="reject" onclick="rejectFix()">Close</button>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                
                function acceptFix() {
                    vscode.postMessage({ command: 'accept' });
                }
                
                function rejectFix() {
                    vscode.postMessage({ command: 'reject' });
                }
            </script>
        </body>
        </html>`;
  }

  private escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }
}
