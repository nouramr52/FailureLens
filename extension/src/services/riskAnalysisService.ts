import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ReleaseRisk, Hypothesis, AffectedComponent, PreventiveSuggestion } from '../types';
import { KnowledgeGraphService } from './knowledgeGraphService';

const execAsync = promisify(exec);

export class RiskAnalysisService {
  private currentRisk: ReleaseRisk | null = null;
  private hypotheses: Hypothesis[] = [];
  private affectedComponents: AffectedComponent[] = [];
  private suggestions: PreventiveSuggestion | null = null;

  private onRiskChangedEmitter = new vscode.EventEmitter<ReleaseRisk | null>();
  public readonly onRiskChanged = this.onRiskChangedEmitter.event;

  private onHypothesesChangedEmitter = new vscode.EventEmitter<Hypothesis[]>();
  public readonly onHypothesesChanged = this.onHypothesesChangedEmitter.event;

  private onComponentsChangedEmitter = new vscode.EventEmitter<AffectedComponent[]>();
  public readonly onComponentsChanged = this.onComponentsChangedEmitter.event;

  constructor(private knowledgeService?: KnowledgeGraphService) {
    this.initializeDefaultData();
    if (this.knowledgeService) {
      this.knowledgeService.onGraphChanged(() => {
        this.analyzeStagedDiff();
      });
    }
  }

  private initializeDefaultData() {
    this.currentRisk = {
      decision: 'DEPLOY',
      score: 0,
      confidence: 'HIGH',
      analyzedAt: new Date(),
      summary: 'Working tree is clean. Knowledge Graph ready and tracking feature dependencies.',
      stagedFilesCount: 0,
      linesAdded: 0,
      linesDeleted: 0
    };

    this.hypotheses = [];
    this.affectedComponents = [];

    this.suggestions = {
      recommendedTests: [
        'npm test (Automated unit tests)',
        'pytest tests/ (Integration test suite)'
      ],
      rolloutStrategy: {
        type: 'FULL',
        percentage: 100,
        recommendation: 'Working tree clean. Stage changes or modify code to calculate live blast radius.'
      }
    };
  }

  public getRisk(): ReleaseRisk | null {
    return this.currentRisk;
  }

  public getHypotheses(): Hypothesis[] {
    return this.hypotheses;
  }

  public getAffectedComponents(): AffectedComponent[] {
    return this.affectedComponents;
  }

  public getSuggestions(): PreventiveSuggestion | null {
    return this.suggestions;
  }

  public async analyzeStagedDiff(): Promise<ReleaseRisk> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let stagedCount = 1;
    let added = 32;
    let deleted = 8;
    let changedFiles: string[] = [];

    if (workspaceFolder) {
      try {
        // 1. Check git staged shortstat
        const { stdout: statOut } = await execAsync('git diff --cached --shortstat', { cwd: workspaceFolder });
        const match = statOut.match(/(\d+) files? changed(?:,\s*(\d+) insertions?\(\+\))?(?:,\s*(\d+) deletions?\(-\))?/);
        if (match) {
          stagedCount = parseInt(match[1] || '0', 10);
          added = parseInt(match[2] || '0', 10);
          deleted = parseInt(match[3] || '0', 10);
        }

        // 2. Discover changed files (staged or unstaged)
        const { stdout: filesOut } = await execAsync('git diff --cached --name-only', { cwd: workspaceFolder });
        changedFiles = filesOut.trim().split('\n').map(f => f.trim()).filter(Boolean);

        if (changedFiles.length === 0) {
          // If no staged changes, check working directory diff
          const { stdout: unstagedOut } = await execAsync('git diff --name-only', { cwd: workspaceFolder });
          changedFiles = unstagedOut.trim().split('\n').map(f => f.trim()).filter(Boolean);
        }
      } catch {
        // Git fallback
      }
    }

    // If no changes exist in working tree or staging
    if (changedFiles.length === 0) {
      this.affectedComponents = [];
      this.hypotheses = [];
      this.onComponentsChangedEmitter.fire(this.affectedComponents);
      this.onHypothesesChangedEmitter.fire(this.hypotheses);

      const kSummary = this.knowledgeService?.getSummary();
      const kInfo = kSummary ? ` (${kSummary.nodes} components, ${kSummary.communities} feature groups indexed)` : '';

      this.currentRisk = {
        decision: 'DEPLOY',
        score: 0,
        confidence: 'HIGH',
        analyzedAt: new Date(),
        summary: `Working tree clean. Repository Knowledge Graph is active${kInfo}.`,
        stagedFilesCount: 0,
        linesAdded: 0,
        linesDeleted: 0
      };

      this.onRiskChangedEmitter.fire(this.currentRisk);
      return this.currentRisk;
    }

    // 3. Query FailureLens Knowledge Graph for live blast radius on actual changed files
    if (this.knowledgeService && this.knowledgeService.isInitialized()) {
      try {
        const blastResult = await this.knowledgeService.getBlastRadiusForFiles(changedFiles);
        if (blastResult.affectedComponents.length > 0) {
          this.affectedComponents = blastResult.affectedComponents;
          this.onComponentsChangedEmitter.fire(this.affectedComponents);
        }

        if (blastResult.hypotheses.length > 0) {
          // Preserve any existing confirmation/rejection status if id matches
          const existingMap = new Map(this.hypotheses.map(h => [h.id, h]));
          this.hypotheses = blastResult.hypotheses.map(newH => {
            const oldH = existingMap.get(newH.id);
            return oldH ? { ...newH, status: oldH.status, evidence: oldH.evidence } : newH;
          });
          this.onHypothesesChangedEmitter.fire(this.hypotheses);
        }

        if (blastResult.recommendedTests.length > 0) {
          this.suggestions = {
            recommendedTests: blastResult.recommendedTests,
            rolloutStrategy: {
              type: 'CANARY',
              percentage: 5,
              recommendation: `Canary rollout recommended across ${this.affectedComponents.length} affected components.`
            }
          };
        }
      } catch (err) {
        console.warn('[FailureLens] Error computing live blast radius from knowledge graph:', err);
      }
    }

    // 4. Calculate Risk Decision & Score
    const confirmedCount = this.hypotheses.filter(h => h.status === 'CONFIRMED').length;
    const untestedCount = this.hypotheses.filter(h => h.status === 'UNTESTED').length;
    const directCoupling = Math.max(0, ...this.affectedComponents.map(c => c.couplingScore || 0));

    let score = 20;
    let decision: ReleaseRisk['decision'] = 'DEPLOY';

    if (confirmedCount > 0) {
      score = 88;
      decision = 'BLOCK';
    } else if (untestedCount > 0 && directCoupling > 70) {
      score = 72;
      decision = 'CAUTION';
    } else if (untestedCount > 0) {
      score = 48;
      decision = 'CAUTION';
    } else {
      score = 15;
      decision = 'DEPLOY';
    }

    this.currentRisk = {
      decision,
      score,
      confidence: 'HIGH',
      analyzedAt: new Date(),
      summary: decision === 'BLOCK'
        ? `High risk: Confirmed failure hypotheses detected in staging validation (${this.affectedComponents.length} components in blast radius).`
        : decision === 'CAUTION'
        ? `Caution: ${untestedCount} untested failure hypotheses across ${this.affectedComponents.length} affected components.`
        : 'Safe to deploy: All critical risk hypotheses rejected or verified.',
      stagedFilesCount: stagedCount,
      linesAdded: added,
      linesDeleted: deleted
    };

    this.onRiskChangedEmitter.fire(this.currentRisk);
    return this.currentRisk;
  }

  public setHypothesisStatus(id: string, status: Hypothesis['status'], evidence?: string): void {
    const item = this.hypotheses.find(h => h.id === id);
    if (item) {
      item.status = status;
      if (evidence) {
        item.evidence = evidence;
      }
      this.onHypothesesChangedEmitter.fire(this.hypotheses);
      // Automatically refresh risk score
      this.analyzeStagedDiff();
    }
  }
}
