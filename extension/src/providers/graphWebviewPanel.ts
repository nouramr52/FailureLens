import * as vscode from 'vscode';
import * as fs from 'fs';
import { KnowledgeGraphService } from '../services/knowledgeGraphService';

export class GraphWebviewPanel {
  public static currentPanel: GraphWebviewPanel | undefined;
  public static readonly viewType = 'failurelens.knowledgeGraphViewer';

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri, knowledgeService: KnowledgeGraphService) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (GraphWebviewPanel.currentPanel) {
      GraphWebviewPanel.currentPanel._panel.reveal(column);
      GraphWebviewPanel.currentPanel.update(knowledgeService);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      GraphWebviewPanel.viewType,
      'FailureLens Knowledge Graph',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          extensionUri,
          vscode.Uri.file(knowledgeService.getWorkspaceRoot() || '')
        ]
      }
    );

    GraphWebviewPanel.currentPanel = new GraphWebviewPanel(panel, extensionUri, knowledgeService);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    private readonly _knowledgeService: KnowledgeGraphService
  ) {
    this._panel = panel;
    this.update(this._knowledgeService);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage((message) => {
      if (message?.command === 'initGraph') {
        vscode.commands.executeCommand('failurelens.initKnowledgeGraph');
      }
    }, null, this._disposables);

    this._knowledgeService.onGraphChanged(() => {
      this.update(this._knowledgeService);
    });
  }

  public update(knowledgeService: KnowledgeGraphService) {
    const htmlPath = knowledgeService.getGraphHtmlPath();
    if (htmlPath && fs.existsSync(htmlPath)) {
      try {
        let content = fs.readFileSync(htmlPath, 'utf-8');
        const summary = knowledgeService.getSummary();
        const detail = summary
          ? `${summary.nodes} components · ${summary.edges} links · ${summary.communities} features`
          : 'Repository knowledge graph';
        const strip = `<div id="failurelens-strip" style="padding:10px 12px;border-bottom:1px solid var(--border);background:var(--panel);color:var(--text);font-size:12px;line-height:1.4;"><div style="font-weight:700;">FailureLens</div><div style="color:var(--text-2);">${detail}</div></div>`;
        if (content.includes('<div id="sidebar">')) {
          content = content.replace('<div id="sidebar">', `<div id="sidebar">${strip}`);
        }
        content += `\n<!-- updated: ${Date.now()} -->`;
        this._panel.webview.html = content;
        return;
      } catch (err) {
        console.error('[FailureLens] Error loading graph.html into webview:', err);
      }
    }

    // Fallback if graph is not yet initialized
    this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      text-align: center;
      padding: 24px;
    }
    h2 { font-weight: 600; margin-bottom: 8px; }
    p {
      color: var(--vscode-descriptionForeground);
      max-width: 420px;
      line-height: 1.5;
      margin-bottom: 20px;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
  </style>
</head>
<body>
  <h2>Knowledge graph not initialized</h2>
  <p>FailureLens has not scanned this repository yet. Initialize it to map feature communities, symbols, and blast radius.</p>
  <button id="init-btn" type="button">Initialize repository knowledge</button>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('init-btn').addEventListener('click', function () {
      vscode.postMessage({ command: 'initGraph' });
    });
  </script>
</body>
</html>`;
  }

  public dispose() {
    GraphWebviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}
