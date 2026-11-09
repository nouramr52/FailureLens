import * as vscode from 'vscode';
import { RiskAnalysisService } from '../services/riskAnalysisService';
import { IncidentService } from '../services/incidentService';
import { Hypothesis, AffectedComponent, IncidentRootCause } from '../types';

export class BaseTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsibleState);
  }
}

// ----------------------------------------------------
// 1. Release Risk Overview Tree Provider
// ----------------------------------------------------
export class ReleaseRiskTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private riskService: RiskAnalysisService) {
    this.riskService.onRiskChanged(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<vscode.TreeItem[]> {
    const risk = this.riskService.getRisk();
    if (!risk) {
      const empty = new BaseTreeItem('No release risk analysis yet. Click refresh to analyze.');
      empty.iconPath = new vscode.ThemeIcon('info');
      return Promise.resolve([empty]);
    }

    const items: vscode.TreeItem[] = [];

    // Decision badge item
    let iconName = 'check';
    let decisionLabel = '● DEPLOY (Safe)';
    if (risk.decision === 'BLOCK') {
      iconName = 'error';
      decisionLabel = `■ BLOCK — Risk Score: ${risk.score}/100`;
    } else if (risk.decision === 'CAUTION') {
      iconName = 'warning';
      decisionLabel = `▼ CAUTION — Risk Score: ${risk.score}/100`;
    } else if (risk.decision === 'REVIEW') {
      iconName = 'eye';
      decisionLabel = `◆ REVIEW — Risk Score: ${risk.score}/100`;
    }

    const decisionItem = new BaseTreeItem(decisionLabel);
    decisionItem.iconPath = new vscode.ThemeIcon(iconName);
    decisionItem.description = `Confidence: ${risk.confidence}`;
    decisionItem.tooltip = risk.summary;
    items.push(decisionItem);

    // Diff footprint item
    const diffItem = new BaseTreeItem(`Staged: +${risk.linesAdded}, -${risk.linesDeleted} (${risk.stagedFilesCount} files)`);
    diffItem.iconPath = new vscode.ThemeIcon('diff');
    diffItem.description = 'Git Staged Diff';
    items.push(diffItem);

    // Summary item
    const summaryItem = new BaseTreeItem(risk.summary);
    summaryItem.iconPath = new vscode.ThemeIcon('lightbulb');
    items.push(summaryItem);

    // Open Dashboard action
    const dashboardItem = new BaseTreeItem('Open Full Report in Dashboard ↗');
    dashboardItem.iconPath = new vscode.ThemeIcon('link-external');
    dashboardItem.command = {
      command: 'failurelens.openDashboard',
      title: 'Open in Dashboard'
    };
    items.push(dashboardItem);

    return Promise.resolve(items);
  }
}

// ----------------------------------------------------
// 2. Hypotheses Tree Provider
// ----------------------------------------------------
export class HypothesesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private riskService: RiskAnalysisService) {
    this.riskService.onHypothesesChanged(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!element) {
      const hypotheses = this.riskService.getHypotheses();
      const items = hypotheses.map((h) => {
        const item = new BaseTreeItem(h.title, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = 'hypothesis';
        (item as unknown as { hypothesis: Hypothesis }).hypothesis = h;

        if (h.status === 'CONFIRMED') {
          item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
          item.description = '[Confirmed in Docker]';
        } else if (h.status === 'REJECTED') {
          item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
          item.description = '[Rejected / Safe]';
        } else {
          item.iconPath = new vscode.ThemeIcon('circle-slash');
          item.description = '[Untested]';
        }

        item.tooltip = `${h.description}\nAffected: ${h.affectedComponent}\nImpact: ${h.impact}`;
        return item;
      });
      return Promise.resolve(items);
    }

    // Children details for an expanded hypothesis
    const hypothesis = (element as unknown as { hypothesis: Hypothesis }).hypothesis;
    if (hypothesis) {
      const details: vscode.TreeItem[] = [];

      const descItem = new BaseTreeItem(hypothesis.description);
      descItem.iconPath = new vscode.ThemeIcon('quote');
      details.push(descItem);

      if (hypothesis.evidence) {
        const evItem = new BaseTreeItem(`Evidence: ${hypothesis.evidence}`);
        evItem.iconPath = new vscode.ThemeIcon('file-binary');
        details.push(evItem);
      }

      const compItem = new BaseTreeItem(`Target: ${hypothesis.affectedComponent}`);
      compItem.iconPath = new vscode.ThemeIcon('file-code');
      details.push(compItem);

      return Promise.resolve(details);
    }

    return Promise.resolve([]);
  }
}

// ----------------------------------------------------
// 3. Blast Radius (Affected Components) Tree Provider
// ----------------------------------------------------
export class BlastRadiusTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private riskService: RiskAnalysisService) {
    this.riskService.onComponentsChanged(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<vscode.TreeItem[]> {
    const components = this.riskService.getAffectedComponents();
    const items = components.map((c) => {
      const item = new BaseTreeItem(`${c.filePath}:${c.line}`);
      item.contextValue = 'component';
      item.description = `${c.level} blast radius (${c.couplingScore}% coupling)`;
      item.iconPath = c.isModified
        ? new vscode.ThemeIcon('edit', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'))
        : new vscode.ThemeIcon('references');

      item.tooltip = `Service: ${c.serviceName || 'Unknown'}\nClick to open in editor`;
      item.command = {
        command: 'failurelens.jumpToCode',
        title: 'Jump to Code',
        arguments: [c.filePath, c.line]
      };
      return item;
    });

    return Promise.resolve(items);
  }
}

// ----------------------------------------------------
// 4. Preventive Suggestions Tree Provider
// ----------------------------------------------------
export class SuggestionsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private riskService: RiskAnalysisService) {
    this.riskService.onRiskChanged(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<vscode.TreeItem[]> {
    const suggestions = this.riskService.getSuggestions();
    if (!suggestions) {
      return Promise.resolve([]);
    }

    const items: vscode.TreeItem[] = [];

    // Rollout Strategy
    const rolloutItem = new BaseTreeItem(`Rollout: ${suggestions.rolloutStrategy.recommendation}`);
    rolloutItem.iconPath = new vscode.ThemeIcon('radio-tower');
    items.push(rolloutItem);

    // Recommended Tests
    suggestions.recommendedTests.forEach((t) => {
      const testItem = new BaseTreeItem(t);
      testItem.iconPath = new vscode.ThemeIcon('check-all');
      items.push(testItem);
    });

    return Promise.resolve(items);
  }
}

// ----------------------------------------------------
// 5. Active Incident Tree Provider (Model B Root Causes)
// ----------------------------------------------------
export class ActiveIncidentTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private incidentService: IncidentService) {
    this.incidentService.onIncidentChanged(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    const incident = this.incidentService.getActiveIncident();
    if (!incident) {
      const empty = new BaseTreeItem('✓ No active incidents. All deployments healthy.');
      empty.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
      return Promise.resolve([empty]);
    }

    if (!element) {
      const items: vscode.TreeItem[] = [];

      // Incident Header Banner
      const headerItem = new BaseTreeItem(`${incident.id} (${incident.severity}): ${incident.title}`);
      headerItem.iconPath = new vscode.ThemeIcon('flame', new vscode.ThemeColor('testing.iconFailed'));
      headerItem.description = 'Production Outage';
      items.push(headerItem);

      // Ranked Root Causes
      incident.rootCauses.forEach((rc) => {
        const rcItem = new BaseTreeItem(
          `#${rc.rank}: ${rc.confidence}% Confidence — ${rc.title}`,
          vscode.TreeItemCollapsibleState.Expanded
        );
        rcItem.contextValue = 'rootCause';
        (rcItem as unknown as { rootCause: IncidentRootCause }).rootCause = rc;
        rcItem.iconPath = new vscode.ThemeIcon('debug-stackframe-dot');
        rcItem.description = `[${rc.commitHash}] ${rc.filePath}:${rc.line}`;
        rcItem.tooltip = `${rc.explanation}\nClick to jump to code`;
        rcItem.command = {
          command: 'failurelens.jumpToCode',
          title: 'Jump to Code',
          arguments: [rc.filePath, rc.line]
        };
        items.push(rcItem);
      });

      return Promise.resolve(items);
    }

    const rc = (element as unknown as { rootCause: IncidentRootCause }).rootCause;
    if (rc) {
      const details: vscode.TreeItem[] = [];

      const expItem = new BaseTreeItem(rc.explanation);
      expItem.iconPath = new vscode.ThemeIcon('info');
      details.push(expItem);

      const commitItem = new BaseTreeItem(`Commit: ${rc.commitHash} - "${rc.commitMessage}"`);
      commitItem.iconPath = new vscode.ThemeIcon('git-commit');
      details.push(commitItem);

      const replayItem = new BaseTreeItem('▶ Replay this root cause in Local Docker');
      replayItem.iconPath = new vscode.ThemeIcon('debug-restart');
      replayItem.command = {
        command: 'failurelens.replayRootCauseInDocker',
        title: 'Replay in Local Docker',
        arguments: [rc]
      };
      details.push(replayItem);

      return Promise.resolve(details);
    }

    return Promise.resolve([]);
  }
}
