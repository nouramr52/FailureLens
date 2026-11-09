import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { AuthService } from './services/authService';
import { ProjectService } from './services/projectService';
import { DockerRunnerService } from './services/dockerRunnerService';
import { RiskAnalysisService } from './services/riskAnalysisService';
import { IncidentService } from './services/incidentService';
import { KnowledgeGraphService } from './services/knowledgeGraphService';
import { StatusBarProvider } from './providers/statusBarProvider';
import { DashboardWebviewProvider } from './providers/dashboardWebviewProvider';
import { ChatWebviewProvider } from './providers/chatWebviewProvider';
import { CodeRiskProvider } from './providers/codeLensProvider';
import { GraphWebviewPanel } from './providers/graphWebviewPanel';
import { Hypothesis, IncidentRootCause, RecommendedTest } from './types';

const execAsync = promisify(exec);

async function runHypotheses(
  riskService: RiskAnalysisService,
  dockerService: DockerRunnerService,
  hypotheses: Hypothesis[],
  extensionUri?: vscode.Uri,
  knowledgeService?: KnowledgeGraphService
): Promise<void> {
  const runnable = hypotheses.filter((hypothesis) => (hypothesis.testScripts || []).length > 0);
  if (runnable.length === 0) {
    vscode.window.showWarningMessage('No hypothesis has a test script. Deploy stays on caution.');
    return;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'FailureLens',
      cancellable: true
    },
    async (progress, token) => {
      let sawFailure = false;
      for (let index = 0; index < runnable.length; index += 1) {
        if (token.isCancellationRequested) {
          return;
        }
        const hypothesis = runnable[index];
        const tests = hypothesis.testScripts || [];
        const names = tests.map((test) => test.file.replace(/\\/g, '/').split('/').pop() || test.file);
        progress.report({ message: `Running ${names.join(', ')} (${index + 1}/${runnable.length})…` });
        const res = await dockerService.runSelectedTests(
          tests,
          (update) => {
            if (typeof update.increment === 'number') {
              progress.report({ message: update.message, increment: update.increment });
            } else {
              progress.report({ message: update.message });
            }
          },
          token
        );
        if (res.cancelled) {
          return;
        }
        if (res.runnerMissing) {
          vscode.window.showErrorMessage(`Could not start the test runner. ${res.output.split('\n').slice(-3).join(' ')}`);
          return;
        }
        const files = tests.map((test) => test.file);
        await riskService.applyTestRunResult(res.success, files, res.output, hypothesis.id);
        if (!res.success) {
          sawFailure = true;
        }
      }
      if (extensionUri && knowledgeService && knowledgeService.isInitialized()) {
        GraphWebviewPanel.createOrShow(extensionUri, knowledgeService);
      }
      const summary = riskService.getRisk()?.summary || 'Finished the hypothesis tests.';
      const choice = sawFailure
        ? await vscode.window.showErrorMessage(summary, 'Show test log')
        : await vscode.window.showInformationMessage(summary, 'Show test log');
      if (choice === 'Show test log') {
        dockerService.showLogs();
      }
    }
  );
}

async function runCoveringTests(
  riskService: RiskAnalysisService,
  dockerService: DockerRunnerService,
  tests: RecommendedTest[],
  startMessage: string,
  emptyMessage: string,
  hypothesisId?: string,
  extensionUri?: vscode.Uri,
  knowledgeService?: KnowledgeGraphService
): Promise<void> {
  if (tests.length === 0) {
    vscode.window.showWarningMessage(emptyMessage);
    return;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'FailureLens',
      cancellable: true
    },
    async (progress, token) => {
      progress.report({ message: startMessage });
      const res = await dockerService.runSelectedTests(
        tests,
        (update) => {
          if (typeof update.increment === 'number') {
            progress.report({ message: update.message, increment: update.increment });
          } else {
            progress.report({ message: update.message });
          }
        },
        token
      );
      if (res.cancelled) {
        return;
      }
      if (res.runnerMissing) {
        vscode.window.showErrorMessage(`Could not start the test runner. ${res.output.split('\n').slice(-3).join(' ')}`);
        return;
      }
      const files = tests.map((test) => test.file);
      const { conclusion } = await riskService.applyTestRunResult(res.success, files, res.output, hypothesisId);
      if (extensionUri && knowledgeService && knowledgeService.isInitialized()) {
        GraphWebviewPanel.createOrShow(extensionUri, knowledgeService);
      }
      const choice = res.success
        ? await vscode.window.showInformationMessage(conclusion, 'Show test log')
        : await vscode.window.showErrorMessage(conclusion, 'Show test log');
      if (choice === 'Show test log') {
        dockerService.showLogs();
      }
    }
  );
}

export function activate(context: vscode.ExtensionContext) {
  // 1. Initialize core services
  const authService = new AuthService(context);
  const projectService = new ProjectService(context);
  const dockerService = new DockerRunnerService();
  const knowledgeService = new KnowledgeGraphService(context);
  const riskService = new RiskAnalysisService(context, knowledgeService);
  const incidentService = new IncidentService();

  // 2. Initialize Status Bar Provider
  const statusBarProvider = new StatusBarProvider(riskService, dockerService, incidentService);
  context.subscriptions.push(statusBarProvider);

  // 3. Register Unified Minimalist Dashboard Webview Provider
  const dashboardProvider = new DashboardWebviewProvider(
    context.extensionUri,
    riskService,
    incidentService,
    projectService,
    knowledgeService
  );
  const chatProvider = new ChatWebviewProvider(
    context.extensionUri,
    riskService,
    incidentService,
    dockerService,
    knowledgeService
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DashboardWebviewProvider.viewType, dashboardProvider),
    vscode.window.registerWebviewViewProvider(ChatWebviewProvider.viewType, chatProvider)
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
    vscode.commands.registerCommand('failurelens.runHypothesisInDocker', async (arg?: { hypothesis?: Hypothesis }) => {
      const id = arg?.hypothesis?.id;
      const current = id ? riskService.getHypotheses().find((item) => item.id === id) : undefined;
      const hypothesis = current || arg?.hypothesis;
      const tests = hypothesis?.testScripts ?? [];
      const names = tests.map((test) => test.file.replace(/\\/g, '/').split('/').pop() || test.file);
      const title = hypothesis?.title || 'this issue';
      await runCoveringTests(
        riskService,
        dockerService,
        tests,
        names.length ? `Running ${names.join(', ')}…` : 'Running test…',
        `No test script covers "${title}".`,
        hypothesis?.id,
        context.extensionUri,
        knowledgeService
      );
    }),

    vscode.commands.registerCommand('failurelens.stageSafeFiles', async (files?: string[], hypothesisId?: string) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showErrorMessage('FailureLens: No active workspace folder found.');
        return;
      }

      let targets: string[] = [];
      if (files && files.length > 0) {
        targets = files.filter(Boolean);
      } else {
        targets = Array.from(knowledgeService.getClearedFiles());
      }

      if (targets.length === 0) {
        vscode.window.showInformationMessage('FailureLens: No safe files to stage.');
        return;
      }

      try {
        const quoted = targets.map((f) => `"${f.replace(/\\/g, '/')}"`).join(' ');
        await execAsync(`git add ${quoted}`, { cwd: root });
        vscode.window.showInformationMessage(
          `FailureLens: Staged ${targets.length} safe file(s) in Git: ${targets.join(', ')}`
        );
        await riskService.analyzeStagedDiff();
        await knowledgeService.updateImpactOverlay();
        if (knowledgeService.isInitialized() && GraphWebviewPanel.currentPanel) {
          GraphWebviewPanel.currentPanel.update(knowledgeService);
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`FailureLens: Failed to stage files: ${err?.message || err}`);
      }
    }),

    vscode.commands.registerCommand('failurelens.runAllHypothesesInDocker', async () => {
      await vscode.commands.executeCommand('failurelens.runSelectedTests');
    }),

    vscode.commands.registerCommand('failurelens.runAllTests', async () => {
      await runHypotheses(riskService, dockerService, riskService.getHypotheses(), context.extensionUri, knowledgeService);
    }),

    vscode.commands.registerCommand('failurelens.showDockerLogs', () => {
      dockerService.showLogs();
    }),

    vscode.commands.registerCommand('failurelens.runSelectedTests', async () => {
      await runHypotheses(riskService, dockerService, riskService.getHypotheses(), context.extensionUri, knowledgeService);
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
      vscode.commands.executeCommand('failurelens.views.chat.focus');
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

  // Re-read the git tree after a save. Unsaved buffers are invisible to git.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      saveTimer = setTimeout(() => {
        riskService.analyzeStagedDiff();
      }, 400);
    })
  );
  riskService.analyzeStagedDiff();

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
