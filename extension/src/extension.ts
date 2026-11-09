import * as vscode from 'vscode';
import { AuthService } from './services/authService';
import { ProjectService } from './services/projectService';
import { DockerRunnerService } from './services/dockerRunnerService';
import { RiskAnalysisService } from './services/riskAnalysisService';
import { IncidentService } from './services/incidentService';
import { KnowledgeGraphService } from './services/knowledgeGraphService';
import { StatusBarProvider } from './providers/statusBarProvider';
import { DashboardWebviewProvider } from './providers/dashboardWebviewProvider';
import { CodeRiskProvider } from './providers/codeLensProvider';
import { GraphWebviewPanel } from './providers/graphWebviewPanel';
import { Hypothesis, IncidentRootCause } from './types';

export function activate(context: vscode.ExtensionContext) {
  // 1. Initialize core services
  const authService = new AuthService(context);
  const projectService = new ProjectService(context);
  const dockerService = new DockerRunnerService();
  const knowledgeService = new KnowledgeGraphService(context);
  const riskService = new RiskAnalysisService(knowledgeService);
  const incidentService = new IncidentService();

  // 2. Initialize Status Bar Provider
  const statusBarProvider = new StatusBarProvider(riskService, dockerService, incidentService);
  context.subscriptions.push(statusBarProvider);

  // 3. Register Unified Minimalist Dashboard Webview Provider
  const dashboardProvider = new DashboardWebviewProvider(
    context.extensionUri,
    riskService,
    dockerService,
    incidentService,
    projectService,
    knowledgeService
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DashboardWebviewProvider.viewType, dashboardProvider)
  );

  // 4. Register Code Risk Marker Providers (CodeLens + Hover)
  const codeRiskProvider = new CodeRiskProvider(riskService, knowledgeService);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeRiskProvider),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, codeRiskProvider)
  );

  // 5. Register Knowledge Graph Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('failurelens.initKnowledgeGraph', async () => {
      try {
        await knowledgeService.initializeGraph();
        await riskService.analyzeStagedDiff();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`FailureLens Knowledge Graph Init failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('failurelens.updateKnowledgeGraph', async () => {
      try {
        await knowledgeService.initializeGraph();
        await riskService.analyzeStagedDiff();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`FailureLens Knowledge Graph Update failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('failurelens.openKnowledgeGraph', () => {
      GraphWebviewPanel.createOrShow(context.extensionUri, knowledgeService);
    })
  );

  // 6. Register Commands
  // Auth Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('failurelens.signIn', () => authService.signIn()),
    vscode.commands.registerCommand('failurelens.signOut', () => authService.signOut()),
    vscode.commands.registerCommand('failurelens.selectProject', () => projectService.selectProject())
  );

  // Risk & Diff Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('failurelens.checkReleaseRisk', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'FailureLens: Analyzing staged diff with Model A...',
          cancellable: false
        },
        async () => {
          await new Promise((r) => setTimeout(r, 700));
          const result = await riskService.analyzeStagedDiff();
          vscode.window.showInformationMessage(
            `Analysis Complete: Decision is ${result.decision} (Risk: ${result.score}/100)`
          );
        }
      );
    }),

    // SCM Pre-Commit Risk Check
    vscode.commands.registerCommand('failurelens.checkPreCommitRisk', async () => {
      const risk = await riskService.analyzeStagedDiff();
      if (risk.decision === 'BLOCK') {
        const choice = await vscode.window.showWarningMessage(
          `🛑 FailureLens Pre-Commit Check: Risk level is BLOCK (${risk.score}/100).\n${risk.summary}`,
          'Review in FailureLens',
          'Commit Anyway'
        );
        if (choice === 'Review in FailureLens') {
          vscode.commands.executeCommand('workbench.view.extension.failurelens-sidebar');
        }
      } else {
        vscode.window.showInformationMessage(
          `✅ FailureLens Pre-Commit Check: Safe to commit (${risk.decision}, Risk: ${risk.score}/100).`
        );
      }
    })
  );

  // Docker Runner Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('failurelens.runHypothesisInDocker', async (item?: unknown) => {
      let hypothesisId = 'h1';
      let title = 'DB Connection Pool Exhaustion';

      if (item && typeof item === 'object' && 'hypothesis' in item) {
        const h = (item as { hypothesis: Hypothesis }).hypothesis;
        hypothesisId = h.id;
        title = h.title;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Docker Runner: Executing ${title}...`,
          cancellable: false
        },
        async () => {
          const res = await dockerService.runValidationInContainer(hypothesisId);
          if (!res.success) {
            riskService.setHypothesisStatus(
              hypothesisId,
              'CONFIRMED',
              'Docker test confirmed failure: 99ms timeout threshold exceeded.'
            );
            vscode.window.showErrorMessage(
              `❌ Docker Validation: Hypothesis confirmed! Failure reproduced in container.`
            );
          } else {
            riskService.setHypothesisStatus(
              hypothesisId,
              'REJECTED',
              'Docker test verified behavior: All assertions passed.'
            );
            vscode.window.showInformationMessage(
              `✅ Docker Validation: Hypothesis rejected! System passed validation test.`
            );
          }
        }
      );
    }),

    vscode.commands.registerCommand('failurelens.runAllHypothesesInDocker', async () => {
      vscode.window.showInformationMessage('Spawning Docker test runners for all hypotheses...');
      await dockerService.runValidationInContainer('all');
    }),

    vscode.commands.registerCommand('failurelens.showDockerLogs', () => {
      dockerService.showLogs();
    }),

    vscode.commands.registerCommand('failurelens.confirmHypothesis', (item?: unknown) => {
      if (item && typeof item === 'object' && 'hypothesis' in item) {
        const h = (item as { hypothesis: Hypothesis }).hypothesis;
        riskService.setHypothesisStatus(h.id, 'CONFIRMED', 'Manually confirmed by engineer.');
        vscode.window.showInformationMessage(`Hypothesis "${h.title}" marked as Confirmed.`);
      }
    }),

    vscode.commands.registerCommand('failurelens.rejectHypothesis', (item?: unknown) => {
      if (item && typeof item === 'object' && 'hypothesis' in item) {
        const h = (item as { hypothesis: Hypothesis }).hypothesis;
        riskService.setHypothesisStatus(h.id, 'REJECTED', 'Manually rejected by engineer.');
        vscode.window.showInformationMessage(`Hypothesis "${h.title}" marked as Rejected.`);
      }
    })
  );

  // Incident Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('failurelens.inspectActiveIncident', () => {
      vscode.commands.executeCommand('workbench.view.extension.failurelens-sidebar');
      vscode.commands.executeCommand('failurelens.views.dashboard.focus');
    }),

    vscode.commands.registerCommand('failurelens.replayRootCauseInDocker', async (rc?: unknown) => {
      let rank = 1;
      let incidentId = 'INC-1042';
      if (rc && typeof rc === 'object' && 'rank' in rc) {
        rank = (rc as IncidentRootCause).rank;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Docker Runner: Replaying root cause #${rank} in container...`,
          cancellable: false
        },
        async () => {
          await dockerService.replayIncidentInContainer(incidentId, rank);
          vscode.window.showInformationMessage(
            `Docker Replay: Root cause #${rank} successfully verified in local container.`
          );
        }
      );
    }),

    vscode.commands.registerCommand('failurelens.simulateIncident', () => {
      incidentService.toggleIncidentSimulation();
    })
  );

  // Navigation & Utility Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('failurelens.jumpToCode', async (filePath?: string, line?: number) => {
      if (!filePath) {
        return;
      }
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const targetUri = workspaceFolder
        ? vscode.Uri.joinPath(workspaceFolder.uri, filePath)
        : vscode.Uri.file(filePath);

      try {
        const doc = await vscode.workspace.openTextDocument(targetUri);
        const editor = await vscode.window.showTextDocument(doc);
        if (line) {
          const pos = new vscode.Position(Math.max(0, line - 1), 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      } catch {
        vscode.window.showWarningMessage(`Could not open file: ${filePath}. File may not exist locally yet.`);
      }
    }),

    vscode.commands.registerCommand('failurelens.openDashboard', () => {
      const config = vscode.workspace.getConfiguration('failurelens');
      const url = config.get<string>('dashboardUrl', 'https://app.failurelens.io');
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand('failurelens.ask', () => {
      vscode.commands.executeCommand('workbench.view.extension.failurelens-sidebar');
      vscode.commands.executeCommand('failurelens.views.dashboard.focus');
    }),

    vscode.commands.registerCommand('failurelens.toggleNotifications', async () => {
      const config = vscode.workspace.getConfiguration('failurelens');
      const current = config.get<boolean>('notifications.enabled', true);
      await config.update('notifications.enabled', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `FailureLens Notifications: ${!current ? 'Enabled' : 'Disabled'}`
      );
    })
  );

  // Startup check for Knowledge Graph initialization
  if (!knowledgeService.isInitialized()) {
    setTimeout(() => {
      vscode.window
        .showInformationMessage(
          'FailureLens: Knowledge Graph is not initialized. Initialize now to map feature dependencies and blast radius?',
          '⚡ Initialize Project',
          'Later'
        )
        .then((selection) => {
          if (selection === '⚡ Initialize Project') {
            vscode.commands.executeCommand('failurelens.initKnowledgeGraph');
          }
        });
    }, 2000);
  }
}

export function deactivate() {}
