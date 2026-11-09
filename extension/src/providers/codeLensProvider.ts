import * as vscode from 'vscode';
import { RiskAnalysisService } from '../services/riskAnalysisService';
import { KnowledgeGraphService } from '../services/knowledgeGraphService';

export class CodeRiskProvider implements vscode.CodeLensProvider, vscode.HoverProvider {
  private onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  constructor(
    private riskService: RiskAnalysisService,
    private knowledgeService?: KnowledgeGraphService
  ) {
    this.riskService.onHypothesesChanged(() => this.onDidChangeCodeLensesEmitter.fire());
    this.riskService.onRiskChanged(() => this.onDidChangeCodeLensesEmitter.fire());
    this.riskService.onComponentsChanged(() => this.onDidChangeCodeLensesEmitter.fire());
    if (this.knowledgeService) {
      this.knowledgeService.onGraphChanged(() => this.onDidChangeCodeLensesEmitter.fire());
    }
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    const codeLenses: vscode.CodeLens[] = [];
    const filePath = document.uri.fsPath.replace(/\\/g, '/');

    // Match modified/risky components from risk analysis
    const components = this.riskService.getAffectedComponents();
    const matchingComps = components.filter(c => filePath.endsWith(c.filePath) || c.filePath.endsWith(filePath));

    const risk = this.riskService.getRisk();
    const score = risk ? risk.score : 65;

    for (const comp of matchingComps) {
      const line = Math.max(0, comp.line - 1);
      const range = new vscode.Range(line, 0, line, 0);

      const icon = comp.level === 'DIRECT' ? '$(error)' : comp.level === 'HIGH' ? '$(warning)' : '$(shield)';
      const title = `${icon} FailureLens: ${comp.level} Blast Radius (${comp.couplingScore}% Coupling) | Risk: ${score}%`;

      const lens = new vscode.CodeLens(range, {
        title,
        tooltip: `Component is in FailureLens blast radius for feature "${comp.serviceName}". Click to inspect in Cockpit.`,
        command: 'workbench.view.extension.failurelens-sidebar'
      });

      codeLenses.push(lens);
    }

    return codeLenses;
  }

  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.Hover | null {
    const filePath = document.uri.fsPath.replace(/\\/g, '/');
    const components = this.riskService.getAffectedComponents();
    const matchingComp = components.find(
      c => (filePath.endsWith(c.filePath) || c.filePath.endsWith(filePath)) && Math.abs(position.line - (c.line - 1)) <= 3
    );

    if (matchingComp) {
      const markdown = new vscode.MarkdownString();
      markdown.isTrusted = true;

      markdown.appendMarkdown(`### 🛡️ FailureLens Blast-Radius Analysis\n\n`);
      markdown.appendMarkdown(`**Feature Domain**: \`${matchingComp.serviceName || 'Core Feature'}\`\n\n`);
      markdown.appendMarkdown(`**Blast Radius Tier**: **${matchingComp.level}** (${matchingComp.couplingScore}% coupling score)\n\n`);

      if (this.knowledgeService && (matchingComp as unknown as { nodeId?: string }).nodeId) {
        const nodeId = (matchingComp as unknown as { nodeId: string }).nodeId;
        const callers = this.knowledgeService.getIncomingCallers(nodeId);
        const deps = this.knowledgeService.getOutgoingDependencies(nodeId);

        if (callers.length > 0) {
          markdown.appendMarkdown(`**Dependent Callers (${callers.length})**:\n`);
          for (const c of callers.slice(0, 3)) {
            markdown.appendMarkdown(`- \`${c.label}\` in *${c.source_file}*\n`);
          }
          markdown.appendMarkdown('\n');
        }

        if (deps.length > 0) {
          markdown.appendMarkdown(`**Outgoing Dependencies**: ${deps.length} linked symbols\n\n`);
        }
      }

      markdown.appendMarkdown(`[🌐 View in Knowledge Graph](command:failurelens.openKnowledgeGraph) | [Open Cockpit Sidebar](command:workbench.view.extension.failurelens-sidebar)`);
      return new vscode.Hover(markdown);
    }

    return null;
  }
}
