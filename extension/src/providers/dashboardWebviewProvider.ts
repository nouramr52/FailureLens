import * as vscode from 'vscode';
import { RiskAnalysisService } from '../services/riskAnalysisService';
import { DockerRunnerService } from '../services/dockerRunnerService';
import { IncidentService } from '../services/incidentService';
import { ProjectService } from '../services/projectService';
import { KnowledgeGraphService } from '../services/knowledgeGraphService';
import { ReleaseRisk, Hypothesis, ActiveIncident, AffectedComponent, PreventiveSuggestion } from '../types';

export class DashboardWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'failurelens.views.dashboard';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly riskService: RiskAnalysisService,
    private readonly dockerService: DockerRunnerService,
    private readonly incidentService: IncidentService,
    private readonly projectService: ProjectService,
    private readonly knowledgeService?: KnowledgeGraphService
  ) {
    // Listen for state changes to push instant updates to the webview
    this.riskService.onRiskChanged(() => this.postStateUpdate());
    this.riskService.onHypothesesChanged(() => this.postStateUpdate());
    this.riskService.onComponentsChanged(() => this.postStateUpdate());
    this.dockerService.onStatusChanged(() => this.postStateUpdate());
    this.incidentService.onIncidentChanged(() => this.postStateUpdate());
    this.projectService.onProjectChanged(() => this.postStateUpdate());
    if (this.knowledgeService) {
      this.knowledgeService.onGraphChanged(() => this.postStateUpdate());
    }
  }

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

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'refreshRisk':
          vscode.commands.executeCommand('failurelens.checkReleaseRisk');
          break;
        case 'initKnowledgeGraph':
          vscode.commands.executeCommand('failurelens.initKnowledgeGraph');
          break;
        case 'openKnowledgeGraph':
          vscode.commands.executeCommand('failurelens.openKnowledgeGraph');
          break;
        case 'runHypothesisInDocker':
          vscode.commands.executeCommand('failurelens.runHypothesisInDocker', {
            hypothesis: { id: message.id, title: message.title }
          });
          break;
        case 'confirmHypothesis':
          vscode.commands.executeCommand('failurelens.confirmHypothesis', {
            hypothesis: { id: message.id, title: message.title }
          });
          break;
        case 'rejectHypothesis':
          vscode.commands.executeCommand('failurelens.rejectHypothesis', {
            hypothesis: { id: message.id, title: message.title }
          });
          break;
        case 'replayIncidentInDocker':
          vscode.commands.executeCommand('failurelens.replayRootCauseInDocker', {
            rank: message.rank
          });
          break;
        case 'jumpToCode':
          vscode.commands.executeCommand('failurelens.jumpToCode', message.file, message.line);
          break;
        case 'openDashboard':
          this.openDashboardUrl(message.path || '');
          break;
        case 'selectProject':
          vscode.commands.executeCommand('failurelens.selectProject');
          break;
        case 'showDockerLogs':
          this.dockerService.showLogs();
          break;
        case 'chatAsk':
          this.handleChatQuestion(message.text);
          break;
      }
    });

    // Send initial state to webview
    this.postStateUpdate();
  }

  private postStateUpdate() {
    if (!this._view) {
      return;
    }
    const state = {
      project: this.projectService.getActiveProject()?.name || 'FailureLens',
      dockerReady: this.dockerService.isAvailable(),
      risk: this.riskService.getRisk(),
      hypotheses: this.riskService.getHypotheses(),
      components: this.riskService.getAffectedComponents(),
      suggestions: this.riskService.getSuggestions(),
      incident: this.incidentService.getActiveIncident(),
      knowledge: this.knowledgeService ? {
        isInitialized: this.knowledgeService.isInitialized(),
        summary: this.knowledgeService.getSummary()
      } : null
    };
    this._view.webview.postMessage({ type: 'stateUpdate', data: state });
  }

  private openDashboardUrl(subPath: string) {
    const config = vscode.workspace.getConfiguration('failurelens');
    const baseUrl = config.get<string>('dashboardUrl', 'https://app.failurelens.io');
    const targetUrl = subPath ? `${baseUrl}/${subPath}` : baseUrl;
    vscode.env.openExternal(vscode.Uri.parse(targetUrl));
  }

  private handleChatQuestion(question: string) {
    if (!this._view) {
      return;
    }
    const qLower = question.toLowerCase();
    let answer = '';
    let dashboardLink = 'reports/latest';
    let linkText = 'View Full Report on Web';

    const summary = this.knowledgeService?.getSummary();
    const risk = this.riskService.getRisk();
    const affected = this.riskService.getAffectedComponents();

    if (qLower.includes('critical') || qLower.includes('hub') || qLower.includes('central') || qLower.includes('backbone') || qLower.includes('god')) {
      const critNodes = summary?.criticalNodes || summary?.criticalHubs || summary?.godNodes;
      if (critNodes && critNodes.length > 0) {
        const topNodes = critNodes.slice(0, 4).map(g => `• <strong>${g.label}</strong> (<code>${g.filePath}</code>) — ${g.inDegree} callers`).join('<br/>');
        answer = `Top <strong>Critical Nodes</strong> with highest blast radius in this project:<br/>${topNodes}`;
      } else {
        answer = 'No critical nodes identified yet. Run repository initialization to calculate node centrality.';
      }
      dashboardLink = 'knowledge-hub';
      linkText = 'View in Knowledge Graph';
    } else if (qLower.includes('feature')) {
      if (summary) {
        answer = `FailureLens identified <strong>${summary.communities} feature domains</strong> connecting <strong>${summary.nodes} components</strong> and <strong>${summary.edges} dependency links</strong> in this repository.`;
      } else {
        answer = 'Knowledge Graph not yet initialized. Click "Initialize / Re-sync" to discover feature domains.';
      }
      dashboardLink = 'knowledge-hub';
      linkText = 'Explore Architecture';
    } else if (qLower.includes('blast') || qLower.includes('radius') || qLower.includes('impact') || qLower.includes('affect')) {
      if (affected.length > 0) {
        const direct = affected.filter(a => a.level === 'DIRECT').map(a => `<code>${a.filePath}:${a.line}</code>`).join(', ');
        answer = `Current changes affect <strong>${affected.length} component(s)</strong> in blast radius.<br/>Direct impact: ${direct || 'None'}.`;
      } else {
        answer = 'Working tree is clean. Modify or stage files to trace live blast radius through the Knowledge Graph.';
      }
      dashboardLink = 'reports/latest';
      linkText = 'View Blast Radius';
    } else if (this.knowledgeService && (qLower.includes('depend') || qLower.includes('call') || qLower.includes('who') || qLower.includes('what') || qLower.includes('where'))) {
      answer = this.knowledgeService.queryGraph(question);
      dashboardLink = 'knowledge-hub';
      linkText = 'Explore in Knowledge Graph';
    } else if (qLower.includes('why') || qLower.includes('risk') || qLower.includes('score')) {
      if (risk && risk.score > 0) {
        answer = `Risk score is <strong>${risk.score}/100 (${risk.decision})</strong>. ${risk.summary}`;
      } else {
        answer = 'Release risk is <strong>0% (DEPLOY)</strong>. Working tree is clean and all verified baseline dependencies are healthy.';
      }
      dashboardLink = 'reports/latest';
      linkText = 'Inspect Risk Analysis';
    } else if (qLower.includes('incident') || qLower.includes('p1') || qLower.includes('outage')) {
      const activeInc = this.incidentService.getActiveIncident();
      if (activeInc) {
        answer = `Active incident <strong>${activeInc.id} (${activeInc.severity})</strong>: ${activeInc.title}.`;
        dashboardLink = `incidents/${activeInc.id}`;
        linkText = 'Open Incident War Room';
      } else {
        answer = 'No active production incidents detected. All system metrics and services are operating normally.';
        dashboardLink = 'incidents';
        linkText = 'Incident History';
      }
    } else {
      answer = `Knowledge Graph is active across ${summary ? summary.nodes : 'all'} components. Ask about features, callers, blast radius, or risk.`;
      dashboardLink = 'knowledge-hub';
      linkText = 'Knowledge Hub';
    }

    this._view.webview.postMessage({
      type: 'chatResponse',
      answer,
      dashboardLink,
      linkText
    });
  }

  private _getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: var(--vscode-sideBar-background);
      --card-bg: var(--vscode-editor-background);
      --fg: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --btn-sec-bg: var(--vscode-button-secondaryBackground);
      --btn-sec-fg: var(--vscode-button-secondaryForeground);
      --red: var(--vscode-testing-iconFailed, #f48771);
      --red-bg: rgba(244, 135, 113, 0.12);
      --green: var(--vscode-testing-iconPassed, #89d185);
      --green-bg: rgba(137, 209, 133, 0.12);
      --yellow: var(--vscode-charts-yellow, #cca700);
      --yellow-bg: rgba(204, 167, 0, 0.12);
      --blue: var(--vscode-textLink-foreground, #3794ff);
      --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      --mono: var(--vscode-editor-font-family, "SF Mono", Monaco, Consolas, monospace);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    body {
      font-family: var(--font);
      font-size: 11.5px;
      color: var(--fg);
      background: var(--bg);
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    /* Top Compact Header */
    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--border);
    }
    .project-pill {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 600;
      color: var(--fg);
      cursor: pointer;
    }
    .project-pill:hover { color: var(--blue); }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .icon-btn {
      cursor: pointer;
      font-size: 12px;
      color: var(--muted);
      display: flex;
      align-items: center;
      transition: color 0.15s;
    }
    .icon-btn:hover { color: var(--fg); }

    /* Knowledge Card */
    .knowledge-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 7px 9px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    /* Active Incident Alert Banner */
    .incident-banner {
      background: var(--red-bg);
      border: 1px solid var(--red);
      border-radius: 4px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .incident-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      font-weight: 700;
      color: var(--red);
    }
    .incident-cause {
      font-size: 11px;
      color: var(--fg);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
    }
    .code-anchor {
      font-family: var(--mono);
      font-size: 10.5px;
      color: var(--blue);
      cursor: pointer;
      text-decoration: underline;
    }
    .incident-actions {
      display: flex;
      gap: 6px;
      margin-top: 2px;
    }

    /* Release Risk Card */
    .risk-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .risk-badge-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .decision-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
      font-size: 12px;
      padding: 3px 8px;
      border-radius: 3px;
    }
    .chip-block { background: var(--red-bg); color: var(--red); border: 1px solid var(--red); }
    .chip-deploy { background: var(--green-bg); color: var(--green); border: 1px solid var(--green); }
    .chip-caution { background: var(--yellow-bg); color: var(--yellow); border: 1px solid var(--yellow); }

    .diff-stats {
      font-size: 10.5px;
      color: var(--muted);
      font-family: var(--mono);
    }
    .web-link {
      font-size: 10.5px;
      color: var(--blue);
      text-decoration: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .web-link:hover { text-decoration: underline; }

    /* Hypotheses List */
    .section-title {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 2px;
    }
    .hypo-item {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .hypo-item.confirmed { border-left: 3px solid var(--red); }
    .hypo-item.untested { border-left: 3px solid var(--muted); }
    .hypo-item.rejected { border-left: 3px solid var(--green); }
    .hypo-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .hypo-title {
      font-weight: 600;
      font-size: 11px;
      color: var(--fg);
    }
    .status-pill {
      font-size: 9.5px;
      padding: 1px 5px;
      border-radius: 2px;
      font-weight: 600;
    }
    .pill-confirmed { background: var(--red-bg); color: var(--red); }
    .pill-untested { background: rgba(128,128,128,0.15); color: var(--muted); }
    .pill-rejected { background: var(--green-bg); color: var(--green); }

    .hypo-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10.5px;
    }
    .hypo-actions {
      display: flex;
      gap: 4px;
    }

    /* Mini Button */
    .btn-xs {
      background: var(--btn-sec-bg);
      color: var(--btn-sec-fg);
      border: 1px solid var(--border);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-weight: 500;
    }
    .btn-xs:hover { background: var(--btn-hover); color: #fff; }
    .btn-docker {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
    }

    /* Blast Radius & Suggestions Compact Chips */
    .chip-container {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .tag-chip {
      background: var(--card-bg);
      border: 1px solid var(--border);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-family: var(--mono);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .tag-chip:hover { border-color: var(--blue); color: var(--blue); }

    /* Ask FailureLens Mini Box */
    .chat-container {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .preset-chips {
      display: flex;
      gap: 4px;
      overflow-x: auto;
    }
    .preset-chip {
      background: rgba(128,128,128,0.15);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 2px 7px;
      font-size: 9.5px;
      cursor: pointer;
      white-space: nowrap;
    }
    .preset-chip:hover { background: var(--btn-hover); color: #fff; }

    .chat-bubble {
      font-size: 11px;
      line-height: 1.35;
      padding: 6px;
      background: rgba(128,128,128,0.08);
      border-radius: 3px;
      border-left: 2px solid var(--blue);
    }
    .chat-input-row {
      display: flex;
      gap: 4px;
    }
    .chat-input {
      flex: 1;
      background: var(--vscode-input-background, #2d2d2d);
      color: var(--vscode-input-foreground, #fff);
      border: 1px solid var(--border);
      padding: 4px 6px;
      font-size: 10.5px;
      border-radius: 3px;
      outline: none;
    }
    .chat-input:focus { border-color: var(--blue); }
  </style>
</head>
<body>

  <!-- Top Header Row -->
  <div class="header-row">
    <div class="project-pill" onclick="sendMessage('selectProject')" title="Switch project">
      <span>📦</span> <span id="project-name">FailureLens</span> <span>▾</span>
    </div>
    <div class="header-actions">
      <span class="icon-btn" onclick="sendMessage('showDockerLogs')" id="docker-pill" title="Local Docker Runner Status">🐳 Ready</span>
      <span class="icon-btn" onclick="sendMessage('refreshRisk')" title="Re-analyze staged changes">🔄</span>
      <span class="icon-btn" onclick="sendMessage('openDashboard', { path: '' })" title="Open FailureLens Website">↗</span>
    </div>
  </div>

  <!-- FailureLens Knowledge Base Card -->
  <div class="knowledge-card">
    <div style="display: flex; align-items: center; justify-content: space-between;">
      <span style="font-weight: 700; font-size: 11px; display: flex; align-items: center; gap: 4px;">
        <span id="knowledge-dot" style="color: var(--green);">●</span>
        <span>Knowledge Base</span>
      </span>
      <span class="web-link" onclick="sendMessage('openKnowledgeGraph')">View Graph ↗</span>
    </div>
    <div style="font-size: 10.5px; color: var(--muted);" id="knowledge-stats">
      Indexing codebase dependencies & blast radius...
    </div>
    <div style="display: flex; gap: 6px; margin-top: 2px;">
      <button class="btn-xs" onclick="sendMessage('initKnowledgeGraph')" id="btn-sync-graph">⚡ Initialize / Re-sync</button>
      <button class="btn-xs btn-docker" onclick="sendMessage('openKnowledgeGraph')">🌐 Open Visualizer</button>
    </div>
  </div>

  <!-- Dynamic Incident Alert (shown only when incident active) -->
  <div id="incident-section" style="display: none;">
    <div class="incident-banner">
      <div class="incident-header">
        <span id="incident-title">🔥 INC-1042 (P1)</span>
        <span class="web-link" onclick="sendMessage('openDashboard', { path: 'incidents/INC-1042' })">War Room ↗</span>
      </div>
      <div class="incident-cause">
        <span>#1 Cause (92%):</span>
        <span class="code-anchor" onclick="sendMessage('jumpToCode', { file: 'src/db/pool.py', line: 45 })">pool.py:45</span>
      </div>
      <div class="incident-actions">
        <button class="btn-xs btn-docker" onclick="sendMessage('replayIncidentInDocker', { rank: 1 })">▶ Replay in Docker</button>
      </div>
    </div>
  </div>

  <!-- Release Risk Card -->
  <div class="risk-card">
    <div class="risk-badge-row">
      <div class="decision-chip chip-deploy" id="decision-chip">
        <span id="decision-symbol">●</span> <span id="decision-text">0% DEPLOY</span>
      </div>
      <span class="diff-stats" id="diff-stats">Working tree clean</span>
    </div>
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <span style="font-size: 10px; color: var(--muted);" id="risk-summary">Knowledge Graph active and tracking changes</span>
      <span class="web-link" onclick="sendMessage('openDashboard', { path: 'reports/latest' })">Full Report ↗</span>
    </div>
  </div>

  <!-- Top Hypotheses (Single line, action-oriented) -->
  <div class="section-title">
    <span id="hypo-heading">Hypotheses (0)</span>
    <span class="web-link" onclick="sendMessage('openDashboard', { path: 'hypotheses' })">All ↗</span>
  </div>
  <div style="display: flex; flex-direction: column; gap: 5px;" id="hypotheses-list">
    <!-- Injected dynamically -->
  </div>

  <!-- Blast Radius & Suggestions (Glanceable Chips) -->
  <div class="section-title">
    <span id="radius-heading">Blast Radius (0)</span>
    <span style="color: var(--yellow);" id="rollout-badge">⚡ Baseline</span>
  </div>
  <div class="chip-container" id="components-list">
    <!-- Injected dynamically -->
  </div>

  <!-- Ask FailureLens (Ultra Compact) -->
  <div class="section-title">
    <span>Ask FailureLens</span>
    <span class="web-link" onclick="sendMessage('openKnowledgeGraph')">Graph Q&A ↗</span>
  </div>
  <div class="chat-container">
    <div class="preset-chips">
      <div class="preset-chip" onclick="askPreset('What features exist in this repo?')">Features</div>
      <div class="preset-chip" onclick="askPreset('What are the Critical Nodes?')">Critical Nodes</div>
      <div class="preset-chip" onclick="askPreset('What is the current blast radius?')">Blast Radius</div>
    </div>
    <div class="chat-bubble" id="chat-answer">
      💡 FailureLens Knowledge Graph is synchronized with your repository. Ask any question about codebase architecture, dependencies, or change impact.
    </div>
    <div class="chat-input-row">
      <input type="text" class="chat-input" id="chat-input" placeholder="Ask about architecture, blast radius, callers..." onkeydown="if(event.key==='Enter') sendChat()" />
      <button class="btn-xs btn-docker" onclick="sendChat()">Ask</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function sendMessage(command, payload = {}) {
      vscode.postMessage({ command, ...payload });
    }

    function askPreset(text) {
      document.getElementById('chat-input').value = text;
      sendChat();
    }

    function sendChat() {
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (!text) return;
      sendMessage('chatAsk', { text });
      input.value = '';
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'stateUpdate') {
        renderState(msg.data);
      } else if (msg.type === 'chatResponse') {
        const bubble = document.getElementById('chat-answer');
        bubble.innerHTML = msg.answer + (msg.linkText ? '<div style="margin-top:4px;"><a href="#" class="web-link" onclick="sendMessage(\\'openKnowledgeGraph\\')">↗ ' + msg.linkText + '</a></div>' : '');
      }
    });

    function renderState(data) {
      // 1. Project & Docker
      document.getElementById('project-name').textContent = data.project;
      const dockerPill = document.getElementById('docker-pill');
      if (data.dockerReady) {
        dockerPill.textContent = '🐳 Ready';
        dockerPill.style.color = 'var(--green)';
      } else {
        dockerPill.textContent = '🐳 Mock';
        dockerPill.style.color = 'var(--muted)';
      }

      // 2. Knowledge Base Stats
      const kDot = document.getElementById('knowledge-dot');
      const kStats = document.getElementById('knowledge-stats');
      if (data.knowledge && data.knowledge.isInitialized && data.knowledge.summary) {
        kDot.style.color = 'var(--green)';
        const s = data.knowledge.summary;
        kStats.textContent = s.nodes + ' components · ' + s.edges + ' links · ' + s.communities + ' features';
      } else {
        kDot.style.color = 'var(--yellow)';
        kStats.textContent = 'Not initialized. Click initialize to scan codebase.';
      }

      // 3. Incident Banner
      const incSec = document.getElementById('incident-section');
      if (data.incident) {
        incSec.style.display = 'block';
        document.getElementById('incident-title').textContent = '🔥 ' + data.incident.id + ' (' + data.incident.severity + ')';
      } else {
        incSec.style.display = 'none';
      }

      // 4. Release Risk Card
      if (data.risk) {
        const r = data.risk;
        const chip = document.getElementById('decision-chip');
        const symbol = document.getElementById('decision-symbol');
        const text = document.getElementById('decision-text');
        chip.className = 'decision-chip chip-' + r.decision.toLowerCase();

        if (r.decision === 'BLOCK') {
          symbol.textContent = '■';
          text.textContent = r.score + '% BLOCK';
        } else if (r.decision === 'CAUTION') {
          symbol.textContent = '▼';
          text.textContent = r.score + '% CAUTION';
        } else {
          symbol.textContent = '●';
          text.textContent = r.score + '% DEPLOY';
        }

        document.getElementById('diff-stats').textContent = '+' + r.linesAdded + ' / -' + r.linesDeleted + ' (' + r.stagedFilesCount + ' files)';
        document.getElementById('risk-summary').textContent = r.summary;
      }

      // 5. Hypotheses
      const hList = document.getElementById('hypotheses-list');
      hList.innerHTML = '';
      const hypos = data.hypotheses || [];
      document.getElementById('hypo-heading').textContent = 'Hypotheses (' + hypos.length + ')';

      hypos.forEach(h => {
        const div = document.createElement('div');
        div.className = 'hypo-item ' + (h.status ? h.status.toLowerCase() : 'untested');
        div.innerHTML = \`
          <div class="hypo-top">
            <span class="hypo-title">\${h.title}</span>
            <span class="status-pill pill-\${(h.status || 'untested').toLowerCase()}">\${h.status || 'UNTESTED'}</span>
          </div>
          <div class="hypo-meta">
            <span class="code-anchor" onclick="sendMessage('jumpToCode', { file: '\${h.affectedComponent}', line: 1 })">\${h.affectedComponent}</span>
            <div class="hypo-actions">
              <button class="btn-xs btn-docker" onclick="sendMessage('runHypothesisInDocker', { id: '\${h.id}', title: '\${h.title.replace(/'/g, "\\\\'")}' })">▶ Test</button>
            </div>
          </div>
        \`;
        hList.appendChild(div);
      });

      // 6. Blast Radius Components
      const cList = document.getElementById('components-list');
      cList.innerHTML = '';
      const comps = data.components || [];
      document.getElementById('radius-heading').textContent = 'Blast Radius (' + comps.length + ')';

      comps.slice(0, 8).forEach(c => {
        const tag = document.createElement('div');
        tag.className = 'tag-chip';
        const fileName = c.filePath.split('/').pop() || c.filePath;
        tag.innerHTML = \`<span>\${c.level === 'DIRECT' ? '🛑' : c.level === 'HIGH' ? '⚠️' : '🔹'}</span> \${fileName}:\${c.line}\`;
        tag.onclick = () => sendMessage('jumpToCode', { file: c.filePath, line: c.line });
        cList.appendChild(tag);
      });
    }
  </script>
</body>
</html>`;
  }
}
