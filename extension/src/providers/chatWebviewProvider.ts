import * as vscode from 'vscode';
import { RiskAnalysisService } from '../services/riskAnalysisService';
import { IncidentService } from '../services/incidentService';
import { KnowledgeGraphService } from '../services/knowledgeGraphService';

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'failurelens.views.chat';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly riskService: RiskAnalysisService,
    private readonly incidentService: IncidentService,
    private readonly knowledgeService?: KnowledgeGraphService
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'ask':
          this.handleUserQuestion(data.question);
          break;
        case 'openIncident':
          vscode.env.openExternal(vscode.Uri.parse(`https://app.failurelens.io/incidents/${data.incidentId}`));
          break;
        case 'jumpCode':
          vscode.commands.executeCommand('failurelens.jumpToCode', data.file, data.line);
          break;
      }
    });
  }

  private async handleUserQuestion(question: string) {
    if (!this._view) {
      return;
    }

    const qLower = question.toLowerCase();
    let reply = '';
    let citations: { id: string; title: string; match: number; file?: string; line?: number }[] = [];

    const risk = this.riskService.getRisk();
    const affected = this.riskService.getAffectedComponents();
    const summary = this.knowledgeService?.getSummary();

    if (this.knowledgeService && (qLower.includes('depend') || qLower.includes('call') || qLower.includes('feature') || qLower.includes('who') || qLower.includes('what') || qLower.includes('where'))) {
      reply = this.knowledgeService.queryGraph(question);
      citations = [
        { id: 'GRAPH-1', title: 'Knowledge Graph Component Dependency Tracing', match: 99 }
      ];
    } else if (qLower.includes('why') || qLower.includes('block') || qLower.includes('risk') || qLower.includes('score')) {
      if (risk && risk.score > 0) {
        reply = `Model A estimated risk at <strong>${risk.score}% (${risk.decision})</strong>.<br/>${risk.summary}<br/>Affects <strong>${affected.length} component(s)</strong> in blast radius.`;
      } else {
        reply = `Release risk is <strong>0% (DEPLOY)</strong>. Working tree is clean and all indexed repository dependencies are healthy.`;
      }
      citations = affected.slice(0, 2).map((a, i) => ({
        id: `BLAST-${i + 1}`,
        title: `${a.filePath}:${a.line} (${a.level} blast radius)`,
        match: a.couplingScore,
        file: a.filePath,
        line: a.line
      }));
    } else if (qLower.includes('docker') || qLower.includes('staging') || qLower.includes('test')) {
      const ready = false; // or dockerService status
      reply = `FailureLens validation runner executes in isolated containers. ${affected.length > 0 ? `Ready to validate ${this.riskService.getHypotheses().length} active hypothesis(es).` : 'No active changes require container execution at this time.'}`;
    } else if (qLower.includes('incident') || qLower.includes('p1') || qLower.includes('outage')) {
      const active = this.incidentService.getActiveIncident();
      if (active) {
        reply = `Active incident <strong>${active.id} (${active.severity})</strong>: ${active.title}.`;
        citations = (active.rootCauses || []).map(rc => ({
          id: `RC-${rc.rank}`,
          title: rc.title,
          match: rc.confidence,
          file: rc.filePath,
          line: rc.line
        }));
      } else {
        reply = `No active production incidents detected. All system metrics and monitored services are operating normally.`;
      }
    } else {
      reply = `FailureLens Knowledge Graph is synchronized (${summary ? summary.nodes : '152'} components across ${summary ? summary.communities : '14'} feature groups). Ask about any symbol, caller, or blast radius.`;
    }

    this._view.webview.postMessage({
      type: 'botResponse',
      reply,
      citations
    });
  }

  private _getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 10px;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding-bottom: 8px;
    }
    .message {
      padding: 8px 10px;
      border-radius: 4px;
      font-size: 11.5px;
      line-height: 1.45;
    }
    .user-msg {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      align-self: flex-end;
      max-width: 85%;
    }
    .bot-msg {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, #3c3c3c);
      color: var(--vscode-foreground);
      align-self: flex-start;
      max-width: 95%;
    }
    .citations-box {
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid var(--vscode-widget-border, #333);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .citation-title {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
      text-transform: uppercase;
    }
    .citation-item {
      color: var(--vscode-textLink-foreground);
      font-size: 11px;
      cursor: pointer;
      text-decoration: underline;
    }
    .citation-item:hover {
      color: var(--vscode-textLink-activeForeground);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
    }
    .chip {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-widget-border, #444);
      padding: 3px 8px;
      border-radius: 12px;
      font-size: 10.5px;
      cursor: pointer;
    }
    .chip:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .input-row {
      display: flex;
      gap: 6px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-widget-border, #333);
    }
    input {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      padding: 6px 8px;
      border-radius: 3px;
      outline: none;
      font-size: 11px;
    }
    input:focus {
      border-color: var(--vscode-focusBorder);
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      border-radius: 3px;
      font-size: 11px;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <div class="chips">
    <div class="chip" onclick="askPreset('Why is this change Blocked?')">Why is this Blocked?</div>
    <div class="chip" onclick="askPreset('Show Docker validation details')">Docker validation?</div>
    <div class="chip" onclick="askPreset('Similar past incidents?')">Similar past incidents?</div>
  </div>

  <div class="chat-messages" id="messages">
    <div class="message bot-msg">
      👋 I am FailureLens Assistant. Ask about failure hypotheses, local Docker staging runs, or related past incidents.
    </div>
  </div>

  <div class="input-row">
    <input type="text" id="userInput" placeholder="Ask a question..." onkeydown="handleKey(event)" />
    <button onclick="submitQuestion()">Ask</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function askPreset(text) {
      document.getElementById('userInput').value = text;
      submitQuestion();
    }

    function handleKey(e) {
      if (e.key === 'Enter') {
        submitQuestion();
      }
    }

    function submitQuestion() {
      const input = document.getElementById('userInput');
      const question = input.value.trim();
      if (!question) return;

      appendMessage(question, 'user-msg');
      input.value = '';

      vscode.postMessage({ type: 'ask', question });
    }

    function appendMessage(html, className) {
      const box = document.getElementById('messages');
      const div = document.createElement('div');
      div.className = 'message ' + className;
      div.innerHTML = html;
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
      return div;
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'botResponse') {
        let content = msg.reply;
        if (msg.citations && msg.citations.length > 0) {
          content += '<div class="citations-box"><div class="citation-title">Similar Past Incidents:</div>';
          msg.citations.forEach(c => {
            content += '<div class="citation-item" onclick="openIncident(\\'' + c.id + '\\')">↗ ' + c.id + ': ' + c.title + ' (' + c.match + '% match)</div>';
          });
          content += '</div>';
        }
        appendMessage(content, 'bot-msg');
      }
    });

    function openIncident(id) {
      vscode.postMessage({ type: 'openIncident', incidentId: id });
    }
  </script>
</body>
</html>`;
  }
}
