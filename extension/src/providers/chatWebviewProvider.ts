import * as vscode from 'vscode';
import { RiskAnalysisService } from '../services/riskAnalysisService';
import { IncidentService } from '../services/incidentService';
import { DockerRunnerService } from '../services/dockerRunnerService';
import { KnowledgeGraphService } from '../services/knowledgeGraphService';

interface ChatCitation {
  id: string;
  title: string;
  match?: number;
  file?: string;
  line?: number;
  kind?: 'code' | 'incident';
}

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'failurelens.views.chat';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly riskService: RiskAnalysisService,
    private readonly incidentService: IncidentService,
    private readonly dockerService: DockerRunnerService,
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
          this.openIncident(data.incidentId);
          break;
        case 'jumpCode':
          vscode.commands.executeCommand('failurelens.jumpToCode', data.file, data.line);
          break;
      }
    });
  }

  private openIncident(incidentId: string) {
    const config = vscode.workspace.getConfiguration('failurelens');
    const baseUrl = config.get<string>('dashboardUrl', 'https://app.failurelens.io');
    vscode.env.openExternal(vscode.Uri.parse(`${baseUrl}/incidents/${incidentId}`));
  }

  private handleUserQuestion(question: string) {
    if (!this._view) {
      return;
    }

    const qLower = question.toLowerCase();
    let reply = '';
    let citationHeading = 'Related';
    let citations: ChatCitation[] = [];

    const risk = this.riskService.getRisk();
    const affected = this.riskService.getAffectedComponents();
    const summary = this.knowledgeService?.getSummary();
    const hypotheses = this.riskService.getHypotheses();

    if (qLower.includes('critical') || qLower.includes('hub') || qLower.includes('central') || qLower.includes('backbone') || qLower.includes('god')) {
      const critNodes = summary?.criticalNodes || summary?.criticalHubs || summary?.godNodes;
      if (critNodes && critNodes.length > 0) {
        const topNodes = critNodes.slice(0, 4).map(g => `• <strong>${esc(g.label)}</strong> (<code>${esc(g.filePath)}</code>) — ${g.inDegree} callers`).join('<br/>');
        reply = `Top <strong>critical nodes</strong> with the highest blast radius in this project:<br/>${topNodes}`;
        citations = critNodes.slice(0, 4).map(g => ({
          id: g.nodeId || g.label,
          title: `${g.label} — ${g.filePath}`,
          file: g.filePath,
          line: 1,
          kind: 'code' as const
        }));
        citationHeading = 'Open in editor';
      } else {
        reply = 'No critical nodes identified yet. Initialize the knowledge graph to calculate node centrality.';
      }
    } else if (qLower.includes('feature')) {
      if (summary) {
        reply = `FailureLens identified <strong>${summary.communities} feature domains</strong> connecting <strong>${summary.nodes} components</strong> and <strong>${summary.edges} dependency links</strong> in this repository.`;
      } else {
        reply = 'Knowledge graph is not initialized yet. Run FailureLens: Initialize Project Knowledge Graph.';
      }
    } else if (qLower.includes('blast') || qLower.includes('radius') || qLower.includes('impact') || qLower.includes('affect')) {
      if (affected.length > 0) {
        const direct = affected.filter(a => a.level === 'DIRECT').map(a => `<code>${esc(a.filePath)}:${a.line}</code>`).join(', ');
        reply = `Current changes affect <strong>${affected.length} component(s)</strong> in the blast radius.<br/>Direct impact: ${direct || 'None'}.`;
        citations = affected.slice(0, 6).map((a, i) => ({
          id: `BLAST-${i + 1}`,
          title: `${a.filePath}:${a.line} (${a.level})`,
          match: a.couplingScore,
          file: a.filePath,
          line: a.line,
          kind: 'code' as const
        }));
        citationHeading = 'Blast radius';
      } else {
        reply = 'Working tree is clean. Modify or stage files to trace a live blast radius.';
      }
    } else if (qLower.includes('docker') || qLower.includes('staging') || qLower.includes('container') || qLower.includes('validation')) {
      const ready = this.dockerService.isAvailable();
      const waiting = hypotheses.length;
      if (ready) {
        reply = waiting > 0
          ? `Docker is ready and can validate <strong>${waiting}</strong> hypothesis(es).`
          : 'Docker is ready. No active changes need a container run.';
      } else {
        reply = waiting > 0
          ? `Docker is standing by, so the local sandboxed runner is active. <strong>${waiting}</strong> hypothesis(es) can still be checked.`
          : 'Docker is standing by, so the local sandboxed runner is active. No active changes need a run.';
      }
    } else if (this.knowledgeService && (qLower.includes('depend') || qLower.includes('call') || qLower.includes('who') || qLower.includes('what') || qLower.includes('where'))) {
      reply = this.knowledgeService.queryGraph(question);
    } else if (qLower.includes('why') || qLower.includes('block') || qLower.includes('risk') || qLower.includes('score')) {
      if (risk && (risk.stagedFilesCount > 0 || risk.decision !== 'DEPLOY')) {
        reply = `Stage readiness is <strong>${risk.score}% (${esc(risk.decision)})</strong>. ${esc(risk.summary)}`;
      } else if (risk) {
        reply = `Release risk is <strong>${risk.score}% (${esc(risk.decision)})</strong>. ${esc(risk.summary)}`;
      } else {
        reply = 'No release analysis yet. Refresh the cockpit after staging a change.';
      }
      citations = affected.slice(0, 4).map((a, i) => ({
        id: `BLAST-${i + 1}`,
        title: `${a.filePath}:${a.line} (${a.level})`,
        match: a.couplingScore,
        file: a.filePath,
        line: a.line,
        kind: 'code' as const
      }));
      citationHeading = 'Affected code';
    } else if (qLower.includes('incident') || qLower.includes('p1') || qLower.includes('outage')) {
      const active = this.incidentService.getActiveIncident();
      if (active) {
        reply = `Active incident <strong>${esc(active.id)} (${esc(active.severity)})</strong>: ${esc(active.title)}.`;
        citations = [
          { id: active.id, title: `Open ${active.id}`, kind: 'incident' as const },
          ...(active.rootCauses || []).map(rc => ({
            id: `RC-${rc.rank}`,
            title: `#${rc.rank} ${rc.title}`,
            match: rc.confidence,
            file: rc.filePath,
            line: rc.line,
            kind: 'code' as const
          }))
        ];
        citationHeading = 'Incident';
      } else {
        reply = 'No active production incident. Services are operating normally.';
      }
    } else {
      const scope = summary ? `${summary.nodes} components across ${summary.communities} feature groups` : 'this repository';
      reply = `FailureLens can answer questions about ${scope}. Ask about features, callers, blast radius, or release risk.`;
    }

    this._view.webview.postMessage({
      type: 'botResponse',
      reply,
      citations,
      citationHeading
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
      line-height: 1.45;
    }
    button { font-family: inherit; }
    button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
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
      line-height: 1.45;
      user-select: text;
    }
    .user-msg {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      align-self: flex-end;
      max-width: 85%;
    }
    .bot-msg {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
      color: var(--vscode-foreground);
      align-self: flex-start;
      max-width: 95%;
    }
    .citations-box {
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
    }
    .citation-title {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .citation-item {
      background: none;
      border: none;
      padding: 0;
      color: var(--vscode-textLink-foreground);
      font-size: inherit;
      cursor: pointer;
      text-align: left;
      text-decoration: underline;
    }
    .citation-item:hover { color: var(--vscode-textLink-activeForeground); }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
    }
    .chip {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
      padding: 3px 8px;
      border-radius: 12px;
      font-size: inherit;
      cursor: pointer;
    }
    .chip:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .input-row {
      display: flex;
      gap: 6px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    }
    input {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.35));
      padding: 6px 8px;
      border-radius: 3px;
      outline: none;
      font-size: inherit;
      font-family: inherit;
    }
    input:focus { border-color: var(--vscode-focusBorder); }
    .ask-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      border-radius: 3px;
      cursor: pointer;
    }
    .ask-btn:hover { background: var(--vscode-button-hoverBackground); color: var(--vscode-button-foreground); }
  </style>
</head>
<body>
  <div class="chips">
    <button class="chip" type="button" data-ask="What features exist in this repo?">Features</button>
    <button class="chip" type="button" data-ask="What are the critical nodes?">Critical nodes</button>
    <button class="chip" type="button" data-ask="What is the current blast radius?">Blast radius</button>
    <button class="chip" type="button" data-ask="Why is this change blocked?">Why is this blocked?</button>
    <button class="chip" type="button" data-ask="Show Docker validation details">Docker validation</button>
    <button class="chip" type="button" data-ask="Is there an active incident?">Active incident</button>
  </div>

  <div class="chat-messages" id="messages">
    <div class="message bot-msg">
      Ask about architecture, blast radius, release risk, or an active incident. Replies stay in this thread.
    </div>
  </div>

  <div class="input-row">
    <input type="text" id="userInput" placeholder="Ask a question..." />
    <button class="ask-btn" id="ask-btn" type="button">Ask</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('userInput');

    let chatHistory = [];
    const savedState = vscode.getState();
    if (savedState && Array.isArray(savedState.messages)) {
      chatHistory = savedState.messages;
      chatHistory.forEach(function (item) {
        if (item.type === 'user') {
          appendMessage(item.content, 'user-msg', false, false);
        } else if (item.type === 'bot') {
          renderBotMessage(item.reply, item.citations, item.citationHeading, false);
        }
      });
    }

    document.querySelectorAll('.chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        input.value = chip.getAttribute('data-ask') || '';
        submitQuestion();
      });
    });

    document.getElementById('ask-btn').addEventListener('click', submitQuestion);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        submitQuestion();
      }
    });

    function submitQuestion() {
      const question = input.value.trim();
      if (!question) return;
      appendMessage(question, 'user-msg', false, true);
      input.value = '';
      vscode.postMessage({ type: 'ask', question: question });
    }

    function appendMessage(content, className, asHtml, save) {
      const box = document.getElementById('messages');
      const div = document.createElement('div');
      div.className = 'message ' + className;
      if (asHtml) {
        div.innerHTML = content;
      } else {
        div.textContent = content;
      }
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
      if (save && className === 'user-msg') {
        chatHistory.push({ type: 'user', content: content });
        vscode.setState({ messages: chatHistory });
      }
      return div;
    }

    function renderBotMessage(reply, citations, citationHeading, save) {
      const div = appendMessage(reply || '', 'bot-msg', true, false);
      const cList = citations || [];
      if (cList.length) {
        const box = document.createElement('div');
        box.className = 'citations-box';
        const title = document.createElement('div');
        title.className = 'citation-title';
        title.textContent = citationHeading || 'Related';
        box.appendChild(title);

        cList.forEach(function (citation) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'citation-item';
          const match = typeof citation.match === 'number' ? ' (' + citation.match + '%)' : '';
          button.textContent = (citation.title || citation.id) + match;
          button.addEventListener('click', function () {
            if (citation.file) {
              vscode.postMessage({ type: 'jumpCode', file: citation.file, line: citation.line || 1 });
            } else if (citation.kind === 'incident') {
              vscode.postMessage({ type: 'openIncident', incidentId: citation.id });
            }
          });
          box.appendChild(button);
        });

        div.appendChild(box);
      }
      if (save) {
        chatHistory.push({ type: 'bot', reply: reply, citations: cList, citationHeading: citationHeading });
        vscode.setState({ messages: chatHistory });
      }
    }

    window.addEventListener('message', function (event) {
      const msg = event.data;
      if (!msg || msg.type !== 'botResponse') return;
      renderBotMessage(msg.reply || '', msg.citations || [], msg.citationHeading || 'Related', true);
    });
  </script>
</body>
</html>`;
  }
}

function esc(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
