import * as vscode from 'vscode';
import { ActiveIncident } from '../types';

export class IncidentService {
  private activeIncident: ActiveIncident | null = null;
  private onIncidentChangedEmitter = new vscode.EventEmitter<ActiveIncident | null>();
  public readonly onIncidentChanged = this.onIncidentChangedEmitter.event;

  constructor() {
    // Default to clean state: no active incident until triggered or received from telemetry
    this.activeIncident = null;
  }

  private initializeDefaultIncident() {
    this.activeIncident = {
      id: 'INC-1042',
      title: 'P1: Gateway 504 Timeout on /checkout',
      severity: 'P1',
      startedAt: new Date(Date.now() - 14 * 60 * 1000), // 14 mins ago
      service: 'checkout-service',
      rootCauses: [
        {
          rank: 1,
          confidence: 92,
          title: 'DB Connection Pool Lock Contention',
          commitHash: 'c4f2a9',
          commitMessage: 'Refactor pool acquire timeout',
          filePath: 'src/db/pool.py',
          line: 45,
          explanation: 'Acquire lock called without explicit timeout threshold under saturated concurrency.',
          reproductionCommand: 'docker run --rm failurelens/reproducer:1042 --rank 1'
        },
        {
          rank: 2,
          confidence: 68,
          title: 'Redis Client Async Upgrade',
          commitHash: 'e8b102',
          commitMessage: 'Upgrade redis-client from v4.2 to v5.0',
          filePath: 'requirements.txt',
          line: 18,
          explanation: 'Async connection pool disposal semantics changed in v5.0, leaking idle sockets.',
          reproductionCommand: 'docker run --rm failurelens/reproducer:1042 --rank 2'
        },
        {
          rank: 3,
          confidence: 24,
          title: 'Cache TTL Drift',
          commitHash: 'a19d33',
          commitMessage: 'Reduce auth token cache TTL to 30s',
          filePath: 'src/api/checkout.py',
          line: 120,
          explanation: 'Increased cache miss rate compounded the database connection pool saturation.'
        }
      ]
    };
  }

  public getActiveIncident(): ActiveIncident | null {
    return this.activeIncident;
  }

  public toggleIncidentSimulation(): ActiveIncident | null {
    if (this.activeIncident) {
      this.activeIncident = null;
      vscode.window.showInformationMessage('Active Incident cleared. All systems operational.');
    } else {
      this.initializeDefaultIncident();
      this.fireIncidentAlert();
    }
    this.onIncidentChangedEmitter.fire(this.activeIncident);
    return this.activeIncident;
  }

  public fireIncidentAlert(): void {
    if (!this.activeIncident) {
      return;
    }
    const config = vscode.workspace.getConfiguration('failurelens');
    const enabled = config.get<boolean>('notifications.enabled', true);
    if (!enabled) {
      return;
    }

    vscode.window.showErrorMessage(
      `🔥 FailureLens Alert: Incident ${this.activeIncident.id} (${this.activeIncident.severity}) linked to recent deployment!`,
      'Inspect Root Causes',
      'Dismiss'
    ).then((selection) => {
      if (selection === 'Inspect Root Causes') {
        vscode.commands.executeCommand('failurelens.inspectActiveIncident');
      }
    });
  }
}
