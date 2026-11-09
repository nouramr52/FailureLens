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

    this._knowledgeService.onGraphChanged(() => {
      this.update(this._knowledgeService);
    });
  }

  public update(knowledgeService: KnowledgeGraphService) {
    const htmlPath = knowledgeService.getGraphHtmlPath();
    if (htmlPath && fs.existsSync(htmlPath)) {
      try {
        let content = fs.readFileSync(htmlPath, 'utf-8');
        // Inject custom FailureLens style & top banner
        const banner = `
          <div style="position:fixed;top:10px;left:10px;z-index:9999;background:rgba(20,20,20,0.85);backdrop-filter:blur(6px);border:1px solid #3c3c3c;border-radius:6px;padding:6px 12px;color:#eee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;display:flex;align-items:center;gap:8px;box-shadow:0 4px 12px rgba(0,0,0,0.4);">
            <span style="color:#3794ff;font-weight:700;">🛡️ FailureLens</span>
            <span>Repository Knowledge Graph</span>
            <span style="color:#858585;font-size:11px;">(Interactive D3/Vis.js)</span>
          </div>
        `;
        content = content.replace('<body>', `<body>${banner}`);
        this._panel.webview.html = content;
        return;
      } catch (err) {
        console.error('[FailureLens] Error loading graph.html into webview:', err);
      }
    }

    // Fallback if graph is not yet initialized
    this._panel.webview.html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            background: #1e1e1e;
            color: #ccc;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            text-align: center;
          }
          h2 { color: #fff; margin-bottom: 8px; }
          p { color: #858585; max-width: 420px; line-height: 1.5; margin-bottom: 20px; }
          button {
            background: #007acc;
            color: #fff;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
          }
          button:hover { background: #0062a3; }
        </style>
      </head>
      <body>
        <h2>🛡️ Knowledge Graph Not Initialized</h2>
        <p>FailureLens has not scanned and indexed this repository yet. Run initialization to map feature communities, AST symbols, and blast radius connections.</p>
        <button onclick="vscode.postMessage({ command: 'initGraph' })">⚡ Initialize Repository Knowledge</button>
        <script>
          const vscode = acquireVsCodeApi();
        </script>
      </body>
      </html>
    `;
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
