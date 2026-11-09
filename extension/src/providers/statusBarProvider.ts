import * as vscode from 'vscode';
import { RiskAnalysisService } from '../services/riskAnalysisService';
import { DockerRunnerService } from '../services/dockerRunnerService';
import { IncidentService } from '../services/incidentService';

export class StatusBarProvider implements vscode.Disposable {
  private riskStatusBarItem: vscode.StatusBarItem;
  private dockerStatusBarItem: vscode.StatusBarItem;
  private incidentStatusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private riskService: RiskAnalysisService,
    private dockerService: DockerRunnerService,
    private incidentService: IncidentService
  ) {
    // Left-aligned risk badge
    this.riskStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.riskStatusBarItem.command = 'workbench.view.extension.failurelens-sidebar';
    this.disposables.push(this.riskStatusBarItem);

    // Docker Runner badge
    this.dockerStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.dockerStatusBarItem.command = 'failurelens.showDockerLogs';
    this.disposables.push(this.dockerStatusBarItem);

    // Incident alert badge
    this.incidentStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    this.incidentStatusBarItem.command = 'failurelens.inspectActiveIncident';
    this.disposables.push(this.incidentStatusBarItem);

    this.updateRiskStatus();
    this.updateDockerStatus();
    this.updateIncidentStatus();

    this.disposables.push(this.riskService.onRiskChanged(() => this.updateRiskStatus()));
    this.disposables.push(this.dockerService.onStatusChanged(() => this.updateDockerStatus()));
    this.disposables.push(this.incidentService.onIncidentChanged(() => this.updateIncidentStatus()));
  }

  private updateRiskStatus(): void {
    const risk = this.riskService.getRisk();
    if (!risk) {
      this.riskStatusBarItem.text = '$(shield) FailureLens: Ready';
      this.riskStatusBarItem.tooltip = 'Click to analyze release risk';
      this.riskStatusBarItem.backgroundColor = undefined;
      this.riskStatusBarItem.show();
      return;
    }

    switch (risk.decision) {
      case 'BLOCK':
        this.riskStatusBarItem.text = `$(error) ■ BLOCK (${risk.score}%)`;
        this.riskStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
      case 'REVIEW':
        this.riskStatusBarItem.text = `$(eye) ◆ REVIEW (${risk.score}%)`;
        this.riskStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'CAUTION':
        this.riskStatusBarItem.text = `$(info) ▼ CAUTION (${risk.score}%)`;
        this.riskStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'DEPLOY':
        this.riskStatusBarItem.text = `$(check) ● DEPLOY (${risk.score}%)`;
        this.riskStatusBarItem.backgroundColor = undefined;
        break;
    }
    this.riskStatusBarItem.tooltip = `FailureLens: ${risk.decision} (${risk.score}/100)\n${risk.summary}`;
    this.riskStatusBarItem.show();
  }

  private updateDockerStatus(): void {
    const isReady = this.dockerService.isAvailable();
    if (isReady) {
      this.dockerStatusBarItem.text = '$(vm) Docker: Ready';
      this.dockerStatusBarItem.tooltip = 'Local Docker daemon connected. Hypothesis tests run in isolated containers.';
    } else {
      this.dockerStatusBarItem.text = '$(vm) Docker: Standby';
      this.dockerStatusBarItem.tooltip = 'Docker daemon not running. Local sandboxed runner active. Click to view logs.';
    }
    this.dockerStatusBarItem.show();
  }

  private updateIncidentStatus(): void {
    const incident = this.incidentService.getActiveIncident();
    if (incident) {
      this.incidentStatusBarItem.text = `$(flame) ${incident.id} (${incident.severity})`;
      this.incidentStatusBarItem.tooltip = `Active Incident: ${incident.title}\nLinked to recent deployment.\nClick to inspect root causes.`;
      this.incidentStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.incidentStatusBarItem.show();
    } else {
      this.incidentStatusBarItem.hide();
    }
  }

  public dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}
