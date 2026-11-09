import * as vscode from 'vscode';
import { RiskAnalysisService } from '../services/riskAnalysisService';
import { IncidentService } from '../services/incidentService';
import { ProjectService } from '../services/projectService';
import { KnowledgeGraphService } from '../services/knowledgeGraphService';

export class DashboardWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'failurelens.views.dashboard';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly riskService: RiskAnalysisService,
    private readonly incidentService: IncidentService,
    private readonly projectService: ProjectService,
    private readonly knowledgeService?: KnowledgeGraphService
  ) {
    this.riskService.onRiskChanged(() => this.postStateUpdate());
    this.riskService.onHypothesesChanged(() => this.postStateUpdate());
    this.riskService.onComponentsChanged(() => this.postStateUpdate());
    this.incidentService.onIncidentChanged(() => this.postStateUpdate());
    this.projectService.onProjectChanged(() => this.postStateUpdate());
    this.knowledgeService?.onGraphChanged(() => this.postStateUpdate());
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
        case 'ready':
          this.postStateUpdate();
          break;
        case 'refreshRisk':
          vscode.commands.executeCommand('failurelens.checkReleaseRisk');
          break;
        case 'openKnowledgeGraph':
          vscode.commands.executeCommand('failurelens.openKnowledgeGraph');
          break;
        case 'runHypothesisInDocker':
          vscode.commands.executeCommand('failurelens.runHypothesisInDocker', {
            hypothesis: { id: message.id, title: message.title, testScripts: message.tests }
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
        case 'runAllTests':
          vscode.commands.executeCommand('failurelens.runAllTests');
          break;
        case 'stageSafeFiles':
          vscode.commands.executeCommand('failurelens.stageSafeFiles', message.files, message.hypothesisId);
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postStateUpdate();
      }
    });

    this.postStateUpdate();
  }

  private postStateUpdate() {
    if (!this._view) {
      return;
    }
    const affected = this.riskService.getAffectedComponents();
    const clearedCount = affected.filter((c) => c.isCleared).length;
    const state = {
      project: this.projectService.getActiveProject()?.name || 'FailureLens',
      risk: this.riskService.getRisk(),
      hypotheses: this.riskService.getHypotheses(),
      componentCount: affected.length,
      clearedCount,
      clearedFiles: Array.from(this.knowledgeService?.getClearedFiles() || []),
      incident: this.incidentService.getActiveIncident()
    };
    this._view.webview.postMessage({ type: 'stateUpdate', data: state });
  }

  private openDashboardUrl(subPath: string) {
    const config = vscode.workspace.getConfiguration('failurelens');
    const baseUrl = config.get<string>('dashboardUrl', 'https://app.failurelens.io');
    const targetUrl = subPath ? `${baseUrl}/${subPath}` : baseUrl;
    vscode.env.openExternal(vscode.Uri.parse(targetUrl));
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
      --border: var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --btn-sec-bg: var(--vscode-button-secondaryBackground);
      --btn-sec-fg: var(--vscode-button-secondaryForeground);
      --btn-sec-hover: var(--vscode-button-secondaryHoverBackground);
      --focus: var(--vscode-focusBorder);
      --red: var(--vscode-testing-iconFailed, #f14c4c);
      --green: var(--vscode-testing-iconPassed, #89d185);
      --yellow: var(--vscode-charts-yellow, #cca700);
      --orange: var(--vscode-charts-orange, #d18616);
      --blue: var(--vscode-textLink-foreground);
      --font: var(--vscode-font-family);
      --mono: var(--vscode-editor-font-family, monospace);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    [hidden] { display: none !important; }

    body {
      font-family: var(--font);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background: var(--bg);
      padding: 10px 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      line-height: 1.4;
    }

    button { font-family: inherit; }
    button:focus-visible {
      outline: 1px solid var(--focus);
      outline-offset: 1px;
    }

    .icon {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      display: block;
    }

    .header-row {
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .project-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: transparent;
      border: none;
      color: var(--fg);
      font-weight: 600;
      font-size: var(--vscode-font-size);
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
    }
    .project-btn:hover { color: var(--blue); }

    .risk-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .risk-top, .risk-actions, .incident-header, .hypo-top, .section-title, .hypo-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .empty-label {
      color: var(--muted);
      font-weight: 600;
    }
    .decision-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 3px;
    }
    .chip-block {
      background: color-mix(in srgb, var(--red) 16%, transparent);
      color: var(--red);
      border: 1px solid var(--red);
    }
    .chip-caution {
      background: color-mix(in srgb, var(--yellow) 16%, transparent);
      color: var(--yellow);
      border: 1px solid var(--yellow);
    }
    .chip-review {
      background: color-mix(in srgb, var(--orange) 16%, transparent);
      color: var(--orange);
      border: 1px solid var(--orange);
    }
    .chip-deploy {
      background: color-mix(in srgb, var(--green) 16%, transparent);
      color: var(--green);
      border: 1px solid var(--green);
    }
    .diff-stats, .code, .result {
      font-family: var(--mono);
      font-size: 0.92em;
    }
    .diff-stats { color: var(--muted); }
    .summary { color: var(--fg); }
    .summary, .hypo-title, .result, .code, .diff-stats,
    #incident-name, #cause-label, #incident-kicker, #project-name {
      user-select: text;
    }
    .link-btn {
      background: none;
      border: none;
      color: var(--blue);
      cursor: pointer;
      padding: 0;
      font-size: var(--vscode-font-size);
      text-align: left;
    }
    .link-btn:hover { text-decoration: underline; }
    .code { word-break: break-all; }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--btn-sec-bg);
      color: var(--btn-sec-fg);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 3px 8px;
      font-size: var(--vscode-font-size);
      font-weight: 500;
      letter-spacing: normal;
      text-transform: none;
      cursor: pointer;
    }
    .btn:hover { background: var(--btn-sec-hover); color: var(--btn-sec-fg); }
    .btn-primary {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
    }
    .btn-primary:hover { background: var(--btn-hover); color: var(--btn-fg); }
    .btn:disabled { opacity: 0.55; cursor: default; }
    .btn-stage {
      background: color-mix(in srgb, var(--green) 18%, transparent);
      color: var(--green);
      border: 1px solid var(--green);
      font-weight: 600;
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 3px;
      cursor: pointer;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .btn-stage:hover {
      background: color-mix(in srgb, var(--green) 32%, transparent);
      color: var(--green);
    }
    .hypo-actions {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 4px;
      flex-shrink: 0;
    }

    .incident-banner {
      background: color-mix(in srgb, var(--red) 12%, transparent);
      border: 1px solid var(--red);
      border-radius: 4px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .incident-kicker {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--red);
      font-weight: 700;
    }
    .incident-cause {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .section-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .hypo-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .hypo-item {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .hypo-item.confirmed { border-left: 3px solid var(--red); }
    .hypo-item.rejected { border-left: 3px solid var(--green); }
    .hypo-item.untested { border-left: 3px solid var(--muted); }
    .hypo-title { font-weight: 600; min-width: 0; }
    .status {
      font-size: 11px;
      font-weight: 650;
      white-space: nowrap;
      letter-spacing: normal;
      text-transform: none;
    }
    .status-confirmed { color: var(--red); }
    .status-rejected { color: var(--green); }
    .status-untested { color: var(--muted); }
    .result.good { color: var(--green); }
    .result.bad { color: var(--red); }
    .result.mid { color: var(--yellow); }
    .result.muted { color: var(--muted); }
    .empty {
      color: var(--muted);
      font-size: 0.95em;
    }
  </style>
</head>
<body>
  <div class="header-row">
    <button class="project-btn" id="project-btn" title="Switch project" type="button">
      <span id="project-name">FailureLens</span>
      <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4.2 6.2 8 10l3.8-3.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
  </div>

  <section class="risk-card" aria-label="Release decision">
    <div class="risk-top">
      <div class="decision-chip chip-deploy" id="decision-chip" hidden>
        <span id="decision-symbol">●</span>
        <span id="decision-text">DEPLOY</span>
      </div>
      <span class="empty-label" id="empty-analysis">No analysis yet</span>
      <span class="diff-stats" id="diff-stats" hidden></span>
    </div>
    <p class="summary" id="risk-summary" hidden></p>
    <div class="risk-actions">
      <button class="link-btn" id="blast-link" type="button" hidden>Blast radius: 0</button>
      <button class="btn" id="refresh-btn" type="button">
        <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M13.2 8a5.2 5.2 0 1 1-1.35-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M13.4 2.6v2.8H10.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Refresh
      </button>
    </div>
  </section>

  <section id="incident-section" hidden>
    <div class="incident-banner">
      <div class="incident-header">
        <span class="incident-kicker">
          <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
            <path fill="currentColor" d="M8 1.4 2.6 3.3v4.1c0 3.1 2.1 5.7 5.4 6.3 3.3-.6 5.4-3.2 5.4-6.3V3.3L8 1.4zm.7 3.3v3.6H7.3V4.7h1.4zm0 4.6v1.4H7.3V9.3h1.4z"/>
          </svg>
          <span id="incident-kicker"></span>
        </span>
        <button class="link-btn" id="war-room-btn" type="button">War Room</button>
      </div>
      <p id="incident-name"></p>
      <div class="incident-cause" id="incident-cause">
        <div id="cause-label"></div>
        <button class="link-btn code" id="cause-link" type="button"></button>
      </div>
      <div>
        <button class="btn btn-primary" id="replay-btn" type="button">
          <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
            <path fill="currentColor" d="M5 3.2v9.6l7.2-4.8z"/>
          </svg>
          Replay
        </button>
      </div>
    </div>
  </section>

  <div class="section-title">
    <span id="hypo-heading">Hypotheses (0)</span>
    <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
      <button class="btn btn-stage" id="stage-all-safe-btn" type="button" hidden>
        <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>
        Stage safe files
      </button>
      <button class="btn btn-primary" id="run-all-btn" type="button">Run all</button>
    </div>
  </div>
  <p class="empty" id="hypo-empty" hidden>No hypotheses. Stage a change and refresh.</p>
  <div class="hypo-list" id="hypotheses-list"></div>

  <script>
    const vscode = acquireVsCodeApi();

    // Restore cached state immediately so the view never flickers or resets to empty
    const previousState = vscode.getState();
    if (previousState) {
      try {
        renderState(previousState);
      } catch (err) {
        console.error('Failed to restore previous webview state:', err);
      }
    }

    function sendMessage(command, payload) {
      vscode.postMessage(Object.assign({ command: command }, payload || {}));
    }

    // Signal host that DOM and message listener are ready to receive freshest state
    sendMessage('ready');

    document.getElementById('project-btn').addEventListener('click', function () {
      sendMessage('selectProject');
    });
    document.getElementById('refresh-btn').addEventListener('click', function () {
      sendMessage('refreshRisk');
    });
    document.getElementById('blast-link').addEventListener('click', function () {
      sendMessage('openKnowledgeGraph');
    });
    document.getElementById('run-all-btn').addEventListener('click', function () {
      sendMessage('runAllTests');
    });

    window.addEventListener('message', function (event) {
      const msg = event.data;
      if (msg && msg.type === 'stateUpdate') {
        const stateData = msg.data || {};
        try {
          vscode.setState(stateData);
        } catch (err) {
          console.error('Failed to save state to vscode.setState:', err);
        }
        renderState(stateData);
      }
    });

    function playIcon() {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('class', 'icon');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', 'currentColor');
      path.setAttribute('d', 'M5 3.2v9.6l7.2-4.8z');
      svg.appendChild(path);
      return svg;
    }

    function statusView(status) {
      const value = String(status || 'UNTESTED').toUpperCase();
      if (value === 'CONFIRMED') {
        return { text: 'Failure confirmed', cls: 'status-confirmed', item: 'confirmed' };
      }
      if (value === 'REJECTED') {
        return { text: 'Ruled out', cls: 'status-rejected', item: 'rejected' };
      }
      return { text: 'Not run', cls: 'status-untested', item: 'untested' };
    }

    function renderState(data) {
      document.getElementById('project-name').textContent = data.project || 'FailureLens';
      renderRisk(data.risk, data.componentCount || 0, data.clearedCount || 0);
      renderIncident(data.incident);
      renderHypotheses(data.hypotheses || []);
    }

    function renderRisk(risk, componentCount, clearedCount) {
      const chip = document.getElementById('decision-chip');
      const empty = document.getElementById('empty-analysis');
      const diff = document.getElementById('diff-stats');
      const summary = document.getElementById('risk-summary');
      const blast = document.getElementById('blast-link');

      if (!risk) {
        chip.hidden = true;
        empty.hidden = false;
        diff.hidden = true;
        summary.hidden = true;
        blast.hidden = true;
        return;
      }

      const decision = String(risk.decision || 'DEPLOY').toUpperCase();
      const symbols = { BLOCK: '■', REVIEW: '◆', CAUTION: '▼', DEPLOY: '●' };
      chip.hidden = false;
      chip.className = 'decision-chip chip-' + decision.toLowerCase();
      document.getElementById('decision-symbol').textContent = symbols[decision] || '●';
      document.getElementById('decision-text').textContent = risk.score + '% ' + decision;
      empty.hidden = true;

      diff.hidden = false;
      diff.textContent = '+' + risk.linesAdded + ' / -' + risk.linesDeleted + ' (' + risk.stagedFilesCount + ' files)';
      summary.hidden = false;
      summary.textContent = risk.summary || '';
      blast.hidden = false;
      const noun = componentCount === 1 ? 'component' : 'components';
      const safeSuffix = clearedCount > 0 ? ' (' + clearedCount + ' safe to push)' : '';
      blast.textContent = 'Blast radius: ' + componentCount + ' ' + noun + safeSuffix;
    }

    function renderIncident(incident) {
      const section = document.getElementById('incident-section');
      if (!incident) {
        section.hidden = true;
        return;
      }

      section.hidden = false;
      document.getElementById('incident-kicker').textContent = incident.id + ' (' + incident.severity + ')';
      document.getElementById('incident-name').textContent = incident.title || '';
      document.getElementById('war-room-btn').onclick = function () {
        sendMessage('openDashboard', { path: 'incidents/' + incident.id });
      };

      const causes = incident.rootCauses || [];
      const top = causes.length ? causes[0] : null;
      const causeRow = document.getElementById('incident-cause');
      if (!top) {
        causeRow.hidden = true;
      } else {
        causeRow.hidden = false;
        document.getElementById('cause-label').textContent = '#' + top.rank + ' (' + top.confidence + '%): ' + (top.title || '');
        const link = document.getElementById('cause-link');
        link.textContent = (top.filePath || '') + ':' + top.line;
        link.onclick = function () {
          sendMessage('jumpToCode', { file: top.filePath, line: top.line });
        };
      }

      const rank = top ? top.rank : 1;
      document.getElementById('replay-btn').onclick = function () {
        sendMessage('replayIncidentInDocker', { rank: rank });
      };
    }

    function renderHypotheses(hypos) {
      const list = document.getElementById('hypotheses-list');
      const empty = document.getElementById('hypo-empty');
      const runAll = document.getElementById('run-all-btn');
      list.textContent = '';
      document.getElementById('hypo-heading').textContent = 'Hypotheses (' + hypos.length + ')';
      empty.hidden = hypos.length > 0;

      const runnable = hypos.some(function (h) {
        return (h.testScripts || []).length > 0;
      });
      runAll.disabled = !runnable;
      runAll.title = runnable ? 'Run every hypothesis that has a test script' : 'No test script covers these issues';

      const anyPassed = hypos.some(function (h) {
        return typeof h.passPercent === 'number' && (h.failedCount || 0) === 0 && (h.passedCount > 0 || h.passPercent === 100);
      });
      const stageAllBtn = document.getElementById('stage-all-safe-btn');
      if (stageAllBtn) {
        stageAllBtn.hidden = !anyPassed;
        stageAllBtn.onclick = function () {
          const allSafe = [];
          hypos.forEach(function (h) {
            if (typeof h.passPercent === 'number' && (h.failedCount || 0) === 0 && (h.passedCount > 0 || h.passPercent === 100)) {
              if (h.affectedComponent && !allSafe.includes(h.affectedComponent)) allSafe.push(h.affectedComponent);
              if (h.changedComponent && !allSafe.includes(h.changedComponent)) allSafe.push(h.changedComponent);
            }
          });
          sendMessage('stageSafeFiles', { files: allSafe });
        };
      }

      hypos.forEach(function (h) {
        const view = statusView(h.status);
        const item = document.createElement('article');
        item.className = 'hypo-item ' + view.item;

        const top = document.createElement('div');
        top.className = 'hypo-top';
        const title = document.createElement('div');
        title.className = 'hypo-title';
        title.textContent = h.title || '';
        const status = document.createElement('span');
        status.className = 'status ' + view.cls;
        status.textContent = view.text;
        top.appendChild(title);
        top.appendChild(status);

        const result = document.createElement('div');
        const ran = typeof h.passPercent === 'number';
        if (ran) {
          const failed = Number(h.failedCount || 0);
          const bits = [];
          if (typeof h.passedCount === 'number') bits.push(h.passedCount + ' passed');
          if (failed) bits.push(failed + ' failed');
          if (h.skippedCount) bits.push(h.skippedCount + ' skipped');
          result.className = 'result ' + (failed > 0 ? 'bad' : h.passPercent === 100 ? 'good' : 'mid');
          result.textContent = bits.join(', ') || (h.passPercent + '% passed');
        } else {
          result.className = 'result muted';
          result.textContent = 'Not run';
        }

        const meta = document.createElement('div');
        meta.className = 'hypo-meta';
        const anchor = document.createElement('button');
        anchor.type = 'button';
        anchor.className = 'link-btn code';
        anchor.textContent = h.affectedComponent || '';
        if (h.affectedComponent) {
          anchor.addEventListener('click', function () {
            sendMessage('jumpToCode', { file: h.affectedComponent, line: 1 });
          });
        } else {
          anchor.hidden = true;
        }

        const scripts = Array.isArray(h.testScripts) ? h.testScripts : [];
        const names = scripts.map(function (test) {
          const file = String((test && test.file) || '');
          const parts = file.split('/');
          return parts[parts.length - 1] || file;
        }).filter(Boolean);
        const scriptTitle = scripts.map(function (test) {
          const file = String((test && test.file) || '');
          const reason = test && test.reason ? ' — ' + test.reason : '';
          return file + reason;
        }).join('\\n');

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-primary';
        button.appendChild(playIcon());
        button.appendChild(document.createTextNode('Run'));
        if (names.length === 0) {
          button.disabled = true;
          button.title = 'No test script covers this issue';
        } else {
          button.title = 'Runs ' + scriptTitle;
          button.addEventListener('click', function () {
            sendMessage('runHypothesisInDocker', { id: h.id, title: h.title, tests: scripts });
          });
        }

        const actions = document.createElement('div');
        actions.className = 'hypo-actions';

        const passed = ran && (h.failedCount || 0) === 0 && (h.passedCount > 0 || h.passPercent === 100);
        if (passed) {
          const stageBtn = document.createElement('button');
          stageBtn.type = 'button';
          stageBtn.className = 'btn btn-stage';
          stageBtn.title = 'Stage confirmed safe file(s) in Git';
          stageBtn.innerHTML = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg> Stage safe';
          stageBtn.addEventListener('click', function () {
            const filesToStage = [h.affectedComponent, h.changedComponent].filter(Boolean);
            sendMessage('stageSafeFiles', { files: filesToStage, hypothesisId: h.id });
          });
          actions.appendChild(stageBtn);
        }

        actions.appendChild(button);

        meta.appendChild(anchor);
        meta.appendChild(actions);
        item.appendChild(top);
        item.appendChild(result);
        item.appendChild(meta);
        list.appendChild(item);
      });
    }
  </script>
</body>
</html>`;
  }
}
