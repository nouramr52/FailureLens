import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ReleaseRisk, RiskDecision, Hypothesis, AffectedComponent, PreventiveSuggestion, RecommendedTest } from '../types';
import { KnowledgeGraphService } from './knowledgeGraphService';

const execAsync = promisify(exec);

const SKIP_PREFIXES = ['graphify-out/', 'extension/out/', 'node_modules/', '.failurelens/'];

export interface GitChangeSet {
  files: string[];
  linesByFile: Record<string, number[]>;
  previews: Record<string, string>;
  linesAdded: number;
  linesDeleted: number;
}

function shouldSkip(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  return SKIP_PREFIXES.some((prefix) => norm === prefix.slice(0, -1) || norm.startsWith(prefix));
}

export function parsePorcelain(stdout: string): { file: string; untracked: boolean }[] {
  const found: { file: string; untracked: boolean }[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (rawLine.length < 4) {
      continue;
    }
    const status = rawLine.slice(0, 2);
    let file = rawLine.slice(3).trim();
    if (file.includes(' -> ')) {
      file = file.split(' -> ').pop()?.trim() || file;
    }
    if (file.startsWith('"') && file.endsWith('"')) {
      file = file.slice(1, -1);
    }
    file = file.replace(/\\/g, '/');
    if (!file || shouldSkip(file)) {
      continue;
    }
    found.push({ file, untracked: status === '??' });
  }
  return found;
}

export function parseUnifiedDiff(diff: string): { linesByFile: Record<string, number[]>; linesAdded: number; linesDeleted: number; previews: Record<string, string> } {
  const lineSets: Record<string, Set<number>> = {};
  const previewLines: Record<string, string[]> = {};
  let linesAdded = 0;
  let linesDeleted = 0;
  let current = '';
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/ b\/(.+)$/);
      current = match ? match[1].replace(/\\/g, '/') : '';
      if (current.startsWith('"') && current.endsWith('"')) {
        current = current.slice(1, -1);
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      if (raw === '/dev/null') {
        current = '';
      } else {
        current = raw.replace(/^b\//, '').replace(/\\/g, '/');
      }
      continue;
    }
    if (!current || shouldSkip(current)) {
      continue;
    }
    const hunk = line.match(hunkRe);
    if (hunk) {
      const newStart = parseInt(hunk[3], 10);
      const newCount = hunk[4] === undefined ? 1 : parseInt(hunk[4], 10);
      if (!lineSets[current]) {
        lineSets[current] = new Set();
      }
      if (newCount === 0) {
        if (newStart > 0) {
          lineSets[current].add(newStart);
        }
      } else {
        for (let i = 0; i < newCount; i++) {
          lineSets[current].add(newStart + i);
        }
      }
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      linesAdded += 1;
      const bucket = previewLines[current] || (previewLines[current] = []);
      if (bucket.length < 4) {
        bucket.push(line.slice(0, 120));
      }
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      linesDeleted += 1;
      const bucket = previewLines[current] || (previewLines[current] = []);
      if (bucket.length < 4) {
        bucket.push(line.slice(0, 120));
      }
    }
  }

  const linesByFile: Record<string, number[]> = {};
  for (const [file, set] of Object.entries(lineSets)) {
    linesByFile[file] = [...set].sort((a, b) => a - b);
  }
  const previews: Record<string, string> = {};
  for (const [file, parts] of Object.entries(previewLines)) {
    previews[file] = parts.join(' ');
  }
  return { linesByFile, linesAdded, linesDeleted, previews };
}

function previewFor(filePath: string, previews: Record<string, string>): string | undefined {
  const norm = filePath.replace(/\\/g, '/');
  if (previews[norm]) {
    return previews[norm];
  }
  for (const [key, value] of Object.entries(previews)) {
    if (norm.endsWith('/' + key) || key.endsWith('/' + norm)) {
      return value;
    }
  }
  return undefined;
}

interface ParsedFailure {
  name: string;
  reason: string;
}

interface ParsedTestRun {
  passedCount: number | null;
  failedCount: number | null;
  skippedCount: number | null;
  failures: ParsedFailure[];
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '').replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');
}

function shortenText(text: string, max = 140): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

function shortTestName(name: string): string {
  const parts = name.split('::');
  if (parts.length >= 2) {
    const file = parts[0].replace(/\\/g, '/').split('/').pop() || parts[0];
    return `${file}::${parts.slice(1).join('::')}`;
  }
  return name.replace(/\\/g, '/').split('/').pop() || name;
}

function fileList(files: string[]): string {
  const names = files.map((file) => file.replace(/\\/g, '/').split('/').pop() || file);
  if (names.length <= 3) {
    return names.join(', ');
  }
  return `${names.length} files (${names.slice(0, 3).join(', ')}, …)`;
}

function parseTestRun(output: string): ParsedTestRun {
  const lines = stripAnsi(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let passedCount: number | null = null;
  let failedCount: number | null = null;
  let skippedCount: number | null = null;
  const failures: ParsedFailure[] = [];
  const seen = new Set<string>();
  let current: ParsedFailure | undefined;

  const remember = (name: string, reason = '', overwrite = false): ParsedFailure => {
    const key = name.trim();
    let item = failures.find((failure) => failure.name === key);
    if (!item) {
      item = { name: key, reason: '' };
      if (!seen.has(key)) {
        seen.add(key);
        failures.push(item);
      }
    }
    if (reason && (overwrite || !item.reason)) {
      item.reason = shortenText(reason);
    }
    return item;
  };

  for (const line of lines) {
    if (/(\d+)\s+(passed|failed|errors?)/i.test(line) && (/^=+/.test(line) || /^tests?\b/i.test(line) || /\d+\s+failed\s*[|,]/i.test(line) || /\d+\s+passed\s*[|,]/i.test(line))) {
      const passed = line.match(/(\d+)\s+passed/i);
      const failed = line.match(/(\d+)\s+failed/i);
      const errors = line.match(/(\d+)\s+errors?/i);
      const skipped = line.match(/(\d+)\s+skipped/i);
      if (passed) {
        passedCount = Number(passed[1]);
      }
      if (failed || errors) {
        failedCount = (failed ? Number(failed[1]) : 0) + (errors ? Number(errors[1]) : 0);
      }
      if (skipped) {
        skippedCount = Number(skipped[1]);
      }
    }

    const header = line.match(/^_+\s+(.+?)\s+_+$/);
    if (header) {
      current = failures.find((failure) => failure.name.endsWith(`::${header[1]}`) || failure.name.endsWith(header[1]));
      continue;
    }

    const pytestShort = line.match(/^(FAILED|ERROR)\s+(\S+?)(?:\s+-\s+(.+))?$/);
    if (pytestShort) {
      current = remember(pytestShort[2], pytestShort[3] || '', true);
      continue;
    }

    const pytestVerbose = line.match(/^(\S+::\S+)\s+(FAILED|ERROR)\b/);
    if (pytestVerbose) {
      current = remember(pytestVerbose[1]);
      continue;
    }

    const namedFail = line.match(/^(?:FAIL|[✕×✖])\s+(.+)$/);
    if (namedFail) {
      current = remember(namedFail[1].replace(/\s+\(\d+.*$/, '').trim());
      continue;
    }

    const explanation = line.match(/^(?:E\s+|(?:→|>)+\s+)(.+)$/);
    const expect = /^(Expected|Received|AssertionError|Error|Exception)\b/.test(line) ? line : '';
    const reason = explanation?.[1] || expect;
    const target = current || (failures.length === 1 ? failures[0] : undefined);
    if (reason && target && !target.reason) {
      target.reason = shortenText(reason);
    }
  }

  return { passedCount, failedCount, skippedCount, failures };
}

interface TestMeasurement {
  passed: number;
  failed: number;
  skipped: number;
  selected: number;
  uncovered: number;
  failures: ParsedFailure[];
}

interface PartRecord extends ScorePart {
  key: string;
  failures: ParsedFailure[];
  conclusion: string;
}

function measureTestRun(passed: boolean, files: string[], output: string): TestMeasurement {
  const parsed = parseTestRun(output);
  const uncoveredMatch = stripAnsi(output).match(/No package test script covers:\s*(.+)/);
  const uncovered = uncoveredMatch
    ? uncoveredMatch[1].split(',').map((file) => file.trim()).filter(Boolean).length
    : 0;
  let failed = parsed.failedCount ?? 0;
  const passedCount = parsed.passedCount ?? 0;
  const skipped = parsed.skippedCount ?? 0;
  if (failed === 0 && parsed.failures.length > 0) {
    failed = parsed.failures.length;
  }
  if (!passed && failed === 0 && uncovered === 0 && passedCount === 0) {
    failed = 1;
  }
  return {
    passed: passedCount,
    failed,
    skipped,
    selected: files.length,
    uncovered,
    failures: parsed.failures
  };
}

function normalizeFile(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function fileBase(file: string): string {
  const norm = normalizeFile(file);
  return norm.split('/').pop() || norm;
}

function sameFile(left: string, right: string): boolean {
  const a = normalizeFile(left);
  const b = normalizeFile(right);
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a) || fileBase(a) === fileBase(b);
}

function percentOf(part: number, total: number): number {
  if (part <= 0) {
    return 0;
  }
  if (total <= 0) {
    return 100;
  }
  return Math.max(1, Math.round((part / total) * 100));
}

export function passPercentOf(passed: number, failed: number, skipped: number): number {
  const total = passed + failed + skipped;
  if (total <= 0) {
    return 0;
  }
  return Math.round((passed / total) * 100);
}

export interface ScorePart {
  files: string[];
  passed: number;
  failed: number;
  skipped: number;
  uncovered: number;
}

export interface AggregateScore {
  decision: RiskDecision;
  score: number;
  passed: number;
  failed: number;
  skipped: number;
  uncovered: number;
  passPercent: number;
}

export function partKey(files: string[]): string {
  return files.map(normalizeFile).filter(Boolean).sort().join('|');
}

export function selectContributions<T extends { files: string[] }>(records: T[]): T[] {
  const sorted = [...records].sort((a, b) => a.files.length - b.files.length);
  const claimed = new Set<string>();
  const used: T[] = [];
  for (const record of sorted) {
    const files = record.files.map(normalizeFile);
    if (files.length === 0 || files.every((file) => claimed.has(file)) || files.some((file) => claimed.has(file))) {
      continue;
    }
    used.push(record);
    files.forEach((file) => claimed.add(file));
  }
  return used;
}

function failuresForFiles(failures: ParsedFailure[], files: string[]): ParsedFailure[] {
  const matched = failures.filter((failure) => files.some((file) => failure.name.includes(fileBase(file))));
  return matched;
}

export function stageReadiness(parts: { passPercent?: number; failedCount?: number }[]): { decision: RiskDecision; score: number } {
  if (parts.length === 0) {
    return { decision: 'DEPLOY', score: 100 };
  }
  const readiness = Math.round(
    parts.reduce((sum, part) => sum + (typeof part.passPercent === 'number' ? part.passPercent : 0), 0) / parts.length
  );
  const anyFailed = parts.some((part) => (part.failedCount || 0) > 0);
  const ready = parts.every((part) => part.passPercent === 100);
  if (anyFailed) {
    return { decision: 'BLOCK', score: readiness };
  }
  if (!ready) {
    return { decision: 'CAUTION', score: readiness };
  }
  return { decision: 'DEPLOY', score: 100 };
}

export function aggregatePartScores(records: ScorePart[], unrunParts: number, runParts = 0): AggregateScore {
  const used = selectContributions(records);
  const passed = used.reduce((sum, record) => sum + record.passed, 0);
  const failed = used.reduce((sum, record) => sum + record.failed, 0);
  const skipped = used.reduce((sum, record) => sum + record.skipped, 0);
  const uncovered = used.reduce((sum, record) => sum + record.uncovered, 0);
  const runTests = passed + failed + skipped;
  const slots = runParts > 0 ? runParts : Math.max(used.length, 1);
  const avg = runTests > 0 ? runTests / slots : 1;
  const unrunWeight = Math.max(0, unrunParts) * avg;
  const uncoveredWeight = uncovered > 0 ? uncovered * avg : 0;
  const counted = runTests + unrunWeight + uncoveredWeight;
  const notPassed = failed + skipped + unrunWeight + uncoveredWeight;
  let decision: RiskDecision = 'DEPLOY';
  let score = 0;
  if (failed > 0) {
    decision = 'BLOCK';
    score = percentOf(notPassed, counted);
  } else if (notPassed > 0 || unrunParts > 0 || uncovered > 0) {
    decision = 'CAUTION';
    score = percentOf(notPassed, counted > 0 ? counted : notPassed);
  }
  const passPercent = counted > 0 ? Math.round((passed / counted) * 100) : 0;
  return { decision, score, passed, failed, skipped, uncovered, passPercent };
}

interface FileSlice {
  file: string;
  passed: number;
  failed: number;
  skipped: number;
}

function matchSelectedFile(raw: string, files: string[]): string | undefined {
  return files.find((file) => sameFile(file, raw));
}

export function parseFileSlices(output: string, files: string[]): FileSlice[] | null {
  if (files.length <= 1) {
    return null;
  }
  const slices = new Map<string, FileSlice>();
  const vitestFile = /^(?:[^\w\s]+\s+)?(.+?\.(?:test|spec)\.[cm]?[jt]sx?)\s+\((\d+)\s+tests?(?:\s*\|\s*(\d+)\s+failed)?(?:\s*\|\s*(\d+)\s+skipped)?\)/i;
  const pytestCase = /^(.+?\.py)::\S+\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\b/;
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    const vitest = line.match(vitestFile);
    if (vitest) {
      const file = matchSelectedFile(vitest[1], files);
      if (!file) {
        continue;
      }
      const total = Number(vitest[2]);
      const failed = vitest[3] ? Number(vitest[3]) : 0;
      const skipped = vitest[4] ? Number(vitest[4]) : 0;
      slices.set(partKey([file]), {
        file,
        passed: Math.max(0, total - failed - skipped),
        failed,
        skipped
      });
      continue;
    }
    const pytest = line.match(pytestCase);
    if (pytest) {
      const file = matchSelectedFile(pytest[1], files);
      if (!file) {
        continue;
      }
      const key = partKey([file]);
      const bucket = slices.get(key) || { file, passed: 0, failed: 0, skipped: 0 };
      const status = pytest[2].toUpperCase();
      if (status === 'FAILED' || status === 'ERROR') {
        bucket.failed += 1;
      } else if (status === 'SKIPPED' || status === 'XFAIL') {
        bucket.skipped += 1;
      } else {
        bucket.passed += 1;
      }
      slices.set(key, bucket);
    }
  }
  const found = [...slices.values()].filter((slice) => slice.passed + slice.failed + slice.skipped > 0);
  if (found.length < 2) {
    return null;
  }
  return found;
}

function decisionFromTests(measurement: TestMeasurement): { decision: RiskDecision; score: number } {
  const total = measurement.passed + measurement.failed + measurement.skipped;
  if (measurement.failed > 0) {
    return { decision: 'BLOCK', score: percentOf(measurement.failed, total) };
  }
  if (measurement.uncovered > 0) {
    return { decision: 'CAUTION', score: percentOf(measurement.uncovered, measurement.selected) };
  }
  if (measurement.skipped > 0) {
    return { decision: 'CAUTION', score: percentOf(measurement.skipped, total) };
  }
  return { decision: 'DEPLOY', score: 0 };
}

function countSentence(passed: boolean, parsed: ParsedTestRun): string {
  const failed = parsed.failedCount ?? 0;
  if (passed && failed === 0 && parsed.passedCount !== null && !parsed.skippedCount) {
    return `All ${parsed.passedCount} test${parsed.passedCount === 1 ? '' : 's'} passed.`;
  }
  const parts: string[] = [];
  if (parsed.failedCount) {
    parts.push(`${parsed.failedCount} failed`);
  }
  if (parsed.passedCount !== null) {
    parts.push(`${parsed.passedCount} passed`);
  }
  if (parsed.skippedCount) {
    parts.push(`${parsed.skippedCount} skipped`);
  }
  if (parts.length > 0) {
    return `${parts.join(', ')}.`;
  }
  return passed ? 'Selected tests passed.' : 'Selected tests failed.';
}

export function describeTestConclusion(
  passed: boolean,
  files: string[],
  output: string,
  hypotheses: { title: string }[]
): string {
  const measured = measureTestRun(passed, files, output);
  const outcome = decisionFromTests(measured);
  const parsed: ParsedTestRun = {
    passedCount: measured.passed > 0 ? measured.passed : null,
    failedCount: measured.failed > 0 ? measured.failed : null,
    skippedCount: measured.skipped > 0 ? measured.skipped : null,
    failures: measured.failures
  };
  const titles = hypotheses
    .map((hypothesis) => shortenText(hypothesis.title, 90))
    .filter(Boolean)
    .slice(0, 2);
  const ran = `Ran ${fileList(files)}.`;
  const uncovered = stripAnsi(output).match(/No package test script covers:\s*(.+)/);

  if (outcome.decision === 'CAUTION' && uncovered) {
    const ranFine = measured.passed ? `${measured.passed} test${measured.passed === 1 ? '' : 's'} passed in the files that did run.` : '';
    const passRate = passPercentOf(measured.passed, measured.failed, measured.skipped);
    return [
      `This part passed ${passRate}%. ${outcome.score}% of its selected files were not tested.`,
      `No test script covers: ${shortenText(uncovered[1], 160)}`,
      ranFine,
      ran
    ].filter(Boolean).join('\n');
  }

  const counts = countSentence(outcome.decision === 'DEPLOY', parsed);
  const passRate = passPercentOf(measured.passed, measured.failed, measured.skipped);
  const verdict = `This part passed ${passRate}%.`;
  const hypothesisLine = titles.length === 0 || outcome.decision === 'CAUTION'
    ? ''
    : `${outcome.decision === 'DEPLOY' ? 'Rejected' : 'Confirmed'}: ${titles.join('; ')}.`;
  const details = parsed.failures.slice(0, 3).map((failure) => {
    const name = shortTestName(failure.name);
    return failure.reason ? `${name} — ${failure.reason}` : name;
  });
  if (outcome.decision === 'BLOCK' && parsed.failures.length > 3) {
    details.push(`and ${parsed.failures.length - 3} more failed.`);
  }
  if (outcome.decision === 'BLOCK' && details.length === 0) {
    const lines = stripAnsi(output).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^[=\-_]+$/.test(line));
    const useful = [...lines].reverse().find((line) => /error|fail|assert|exception/i.test(line) && !/^tests?\b/i.test(line));
    if (useful) {
      details.push(shortenText(useful, 160));
    }
  }

  return [ `${counts} ${verdict}`, hypothesisLine, details.join('\n'), ran ].filter(Boolean).join('\n');
}

export interface PersistedAnalysisState {
  version: number;
  lastDiffKey: string;
  savedAt: string;
  currentRisk: ReleaseRisk | null;
  hypotheses: Hypothesis[];
  affectedComponents: AffectedComponent[];
  suggestions: PreventiveSuggestion | null;
  partRecords: [string, PartRecord][];
  manualStatus: [string, { status: Hypothesis['status']; evidence?: string }][];
}

export class RiskAnalysisService {
  private currentRisk: ReleaseRisk | null = null;
  private hypotheses: Hypothesis[] = [];
  private affectedComponents: AffectedComponent[] = [];
  private suggestions: PreventiveSuggestion | null = null;
  private lastDiffKey = '';
  private partRecords = new Map<string, PartRecord>();
  private manualStatus = new Map<string, { status: Hypothesis['status']; evidence?: string }>();
  private analyzeQueue: Promise<void> = Promise.resolve();
  private context?: vscode.ExtensionContext;
  private knowledgeService?: KnowledgeGraphService;

  private onRiskChangedEmitter = new vscode.EventEmitter<ReleaseRisk | null>();
  public readonly onRiskChanged = this.onRiskChangedEmitter.event;

  private onHypothesesChangedEmitter = new vscode.EventEmitter<Hypothesis[]>();
  public readonly onHypothesesChanged = this.onHypothesesChangedEmitter.event;

  private onComponentsChangedEmitter = new vscode.EventEmitter<AffectedComponent[]>();
  public readonly onComponentsChanged = this.onComponentsChangedEmitter.event;

  constructor(
    contextOrKnowledge?: vscode.ExtensionContext | KnowledgeGraphService,
    knowledgeService?: KnowledgeGraphService
  ) {
    if (contextOrKnowledge && 'subscriptions' in contextOrKnowledge) {
      this.context = contextOrKnowledge;
      this.knowledgeService = knowledgeService;
    } else if (contextOrKnowledge) {
      this.knowledgeService = contextOrKnowledge as KnowledgeGraphService;
    }

    this.initializeDefaultData();
    this.loadPersistedState();

    if (this.knowledgeService) {
      this.knowledgeService.onGraphChanged(() => {
        this.analyzeStagedDiff();
      });
    }
  }

  private getStateFilePath(): string | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return null;
    }
    return path.join(root, '.failurelens', 'analysis-state.json');
  }

  public loadPersistedState(): boolean {
    let stateData: PersistedAnalysisState | null = null;

    const filePath = this.getStateFilePath();
    if (filePath && fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        stateData = JSON.parse(raw);
      } catch (err) {
        console.warn('[FailureLens] Error reading analysis state from disk:', err);
      }
    }

    if (!stateData && this.context) {
      try {
        stateData = this.context.workspaceState.get<PersistedAnalysisState>('failurelens.analysisState') || null;
      } catch (err) {
        console.warn('[FailureLens] Error reading analysis state from workspaceState:', err);
      }
    }

    if (!stateData) {
      return false;
    }

    try {
      if (typeof stateData.lastDiffKey === 'string') {
        this.lastDiffKey = stateData.lastDiffKey;
      }
      if (Array.isArray(stateData.partRecords)) {
        this.partRecords = new Map(stateData.partRecords);
      }
      if (Array.isArray(stateData.manualStatus)) {
        this.manualStatus = new Map(stateData.manualStatus);
      }
      if (stateData.currentRisk) {
        this.currentRisk = {
          ...stateData.currentRisk,
          analyzedAt: stateData.currentRisk.analyzedAt ? new Date(stateData.currentRisk.analyzedAt) : new Date()
        };
      }
      if (Array.isArray(stateData.hypotheses) && stateData.hypotheses.length > 0) {
        this.hypotheses = stateData.hypotheses;
      }
      if (Array.isArray(stateData.affectedComponents) && stateData.affectedComponents.length > 0) {
        this.affectedComponents = stateData.affectedComponents;
      }
      if (stateData.suggestions) {
        this.suggestions = stateData.suggestions;
      }
      return true;
    } catch (err) {
      console.warn('[FailureLens] Error applying persisted state:', err);
      return false;
    }
  }

  public async savePersistedState(): Promise<void> {
    const stateData: PersistedAnalysisState = {
      version: 1,
      lastDiffKey: this.lastDiffKey,
      savedAt: new Date().toISOString(),
      currentRisk: this.currentRisk,
      hypotheses: this.hypotheses,
      affectedComponents: this.affectedComponents,
      suggestions: this.suggestions,
      partRecords: Array.from(this.partRecords.entries()),
      manualStatus: Array.from(this.manualStatus.entries())
    };

    if (this.context) {
      try {
        await this.context.workspaceState.update('failurelens.analysisState', stateData);
      } catch {
        // ignore
      }
    }

    const filePath = this.getStateFilePath();
    if (filePath) {
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, JSON.stringify(stateData, null, 2), 'utf8');
      } catch (err) {
        console.warn('[FailureLens] Error saving analysis state to disk:', err);
      }
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
      recommendedTests: [],
      rolloutStrategy: {
        type: 'FULL',
        percentage: 100,
        recommendation: 'Working tree clean. Save a change to calculate blast radius and the tests that cover it.'
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

  public analyzeStagedDiff(): Promise<ReleaseRisk> {
    const run = this.analyzeQueue.then(() => this.analyzeNow());
    this.analyzeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async readGitChanges(workspaceFolder: string): Promise<GitChangeSet> {
    const empty: GitChangeSet = { files: [], linesByFile: {}, previews: {}, linesAdded: 0, linesDeleted: 0 };
    let porcelain = '';
    let diff = '';
    try {
      const [statusResult, diffResult] = await Promise.all([
        execAsync('git status --porcelain -uall', { cwd: workspaceFolder, maxBuffer: 8 * 1024 * 1024 }),
        execAsync('git diff HEAD -U0', { cwd: workspaceFolder, maxBuffer: 8 * 1024 * 1024 })
      ]);
      porcelain = statusResult.stdout;
      diff = diffResult.stdout;
    } catch {
      return empty;
    }

    const entries = parsePorcelain(porcelain);
    const parsed = parseUnifiedDiff(diff);
    const untracked = new Set(entries.filter((entry) => entry.untracked).map((entry) => entry.file));
    const files = [...new Set(entries.map((entry) => entry.file))];

    for (const file of untracked) {
      try {
        const text = fs.readFileSync(path.join(workspaceFolder, file), 'utf8');
        const body = text.split(/\r?\n/);
        parsed.linesAdded += body.length;
        if (!parsed.previews[file]) {
          parsed.previews[file] = body.slice(0, 4).map((line) => `+${line}`).join(' ').slice(0, 240);
        }
      } catch {
        // Untracked path can be a directory listing race. Leave it as a file-level seed.
      }
      delete parsed.linesByFile[file];
    }

    const linesByFile: Record<string, number[]> = {};
    for (const file of files) {
      if (untracked.has(file)) {
        continue;
      }
      if (parsed.linesByFile[file]) {
        linesByFile[file] = parsed.linesByFile[file];
      }
    }

    return {
      files,
      linesByFile,
      previews: parsed.previews,
      linesAdded: parsed.linesAdded,
      linesDeleted: parsed.linesDeleted
    };
  }

  private async analyzeNow(): Promise<ReleaseRisk> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const changes = workspaceFolder
      ? await this.readGitChanges(workspaceFolder)
      : { files: [], linesByFile: {}, previews: {}, linesAdded: 0, linesDeleted: 0 };
    const changedFiles = changes.files;
    const diffKey = JSON.stringify({ files: changedFiles, lines: changes.linesByFile });
    const sameDiff = diffKey === this.lastDiffKey && this.lastDiffKey !== '';
    if (!sameDiff) {
      this.lastDiffKey = diffKey;
    }

    if (changedFiles.length === 0) {
      this.affectedComponents = [];
      this.hypotheses = [];
      this.suggestions = {
        recommendedTests: [],
        rolloutStrategy: {
          type: 'FULL',
          percentage: 100,
          recommendation: 'Working tree clean. Save a change to calculate blast radius and the tests that cover it.'
        }
      };
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

      await this.savePersistedState();
      this.onRiskChangedEmitter.fire(this.currentRisk);
      return this.currentRisk;
    }

    let recommendedTests: RecommendedTest[] = [];
    let nextHypotheses: Hypothesis[] = [];
    this.affectedComponents = [];
    if (this.knowledgeService && this.knowledgeService.isInitialized() && workspaceFolder) {
      try {
        const linesPath = path.join(workspaceFolder, '.failurelens', 'diff-lines.json');
        await fs.promises.mkdir(path.dirname(linesPath), { recursive: true });
        await fs.promises.writeFile(linesPath, JSON.stringify(changes.linesByFile), 'utf8');
        const blastResult = await this.knowledgeService.getBlastRadiusForFiles(changedFiles, linesPath);
        this.affectedComponents = blastResult.affectedComponents;
        recommendedTests = blastResult.recommendedTests;
        nextHypotheses = blastResult.hypotheses;
      } catch (err) {
        console.warn('[FailureLens] Error computing live blast radius from knowledge graph:', err);
      }
    }

    if (this.affectedComponents.length === 0) {
      this.affectedComponents = changedFiles.map((file, index) => ({
        id: `comp_${index + 1}`,
        filePath: file,
        line: changes.linesByFile[file]?.[0] || 1,
        level: 'DIRECT' as const,
        isModified: true,
        couplingScore: 50,
        label: path.basename(file),
        depth: 0,
        viaRelation: 'modified'
      }));
    }

    const clearedIds = this.knowledgeService ? this.knowledgeService.getClearedNodeIds() : new Set<string>();
    const clearedFiles = this.knowledgeService ? this.knowledgeService.getClearedFiles() : new Set<string>();
    for (const component of this.affectedComponents) {
      if (component.isModified) {
        component.changePreview = previewFor(component.filePath, changes.previews);
      }
      const sfNorm = (component.filePath || '').replace(/\\/g, '/').toLowerCase();
      if (
        (component.nodeId && clearedIds.has(component.nodeId)) ||
        clearedFiles.has(sfNorm) ||
        Array.from(clearedFiles).some((cf) => sfNorm.endsWith(cf) || cf.endsWith(sfNorm))
      ) {
        component.isCleared = true;
      }
    }
    this.onComponentsChangedEmitter.fire(this.affectedComponents);

    if (nextHypotheses.length === 0) {
      const first = this.affectedComponents[0];
      nextHypotheses = [{
        id: 'h1',
        title: 'Behavioral regression in the changed files',
        description: `Changes in ${changedFiles.join(', ')} have no graph hypotheses yet. Run the covering tests before deploy.`,
        status: 'UNTESTED',
        impact: 'MEDIUM',
        affectedComponent: first?.filePath || changedFiles[0]
      }];
    }

    this.hypotheses = nextHypotheses.map((hypothesis) => this.decorateHypothesis(hypothesis));
    this.onHypothesesChangedEmitter.fire(this.hypotheses);

    const confirmedCount = this.hypotheses.filter((item) => item.status === 'CONFIRMED').length;
    const untestedCount = this.hypotheses.filter((item) => item.status === 'UNTESTED').length;
    const parts = this.hypotheses.filter((item) => (item.testScripts || []).length > 0);

    let score = 0;
    let decision: ReleaseRisk['decision'] = 'DEPLOY';
    let summary = 'Safe to deploy: selected tests passed, or no open hypotheses remain.';

    if (parts.length > 0) {
      const stage = stageReadiness(parts);
      score = stage.score;
      decision = stage.decision;
      summary = this.describeStage(parts, stage);
    } else if (confirmedCount > 0) {
      score = 100;
      decision = 'BLOCK';
      summary = 'A failure hypothesis was confirmed without a measured test pass rate. Deploy is blocked.';
    } else if (recommendedTests.length === 0) {
      score = 100;
      decision = 'CAUTION';
      summary = 'No covering test found. The change is unverified, so deploy stays on caution.';
    } else if (untestedCount > 0) {
      score = 100;
      decision = 'CAUTION';
      summary = `None of the ${recommendedTests.length} selected tests have run. Deploy stays on caution.`;
    }

    this.suggestions = {
      recommendedTests: recommendedTests.map((test) => this.decorateTest(test)),
      rolloutStrategy: {
        type: recommendedTests.length > 0 ? 'CANARY' : 'STAGED',
        percentage: recommendedTests.length > 0 ? 5 : 0,
        recommendation: recommendedTests.length > 0
          ? `Run ${recommendedTests.length} covering test file(s) before deploy.`
          : 'No covering test found.'
      }
    };

    this.currentRisk = {
      decision,
      score,
      confidence: 'HIGH',
      analyzedAt: new Date(),
      summary,
      stagedFilesCount: changedFiles.length,
      linesAdded: changes.linesAdded,
      linesDeleted: changes.linesDeleted
    };

    await this.savePersistedState();
    this.onRiskChangedEmitter.fire(this.currentRisk);
    return this.currentRisk;
  }

  public setHypothesisStatus(id: string, status: Hypothesis['status'], evidence?: string): void {
    const item = this.hypotheses.find((hypothesis) => hypothesis.id === id);
    if (item) {
      this.manualStatus.set(id, { status, evidence });
      item.status = status;
      if (evidence) {
        item.evidence = evidence;
      }
      this.onHypothesesChangedEmitter.fire(this.hypotheses);
      this.analyzeStagedDiff();
    }
  }

  public async applyTestRunResult(
    passed: boolean,
    files: string[],
    evidence: string,
    hypothesisId?: string
  ): Promise<{ risk: ReleaseRisk; conclusion: string }> {
    const measured = measureTestRun(passed, files, evidence);
    const owners = this.hypothesesForRun(files, hypothesisId);
    const owner = this.singleOwner(files, owners, hypothesisId);
    if (owner) {
      this.storeHypothesisResult(files, measured, passed, evidence, [owner]);
      this.manualStatus.delete(owner.id);
    } else {
      this.storeFileSlices(files, measured, passed, evidence);
    }
    if (this.knowledgeService) {
      try {
        const hypTarget = owner?.affectedComponent;
        await this.knowledgeService.recordTestRunResults(
          passed,
          files,
          hypothesisId,
          this.affectedComponents,
          hypTarget
        );
      } catch (err) {
        console.warn('[FailureLens] Error recording test run results on knowledge graph:', err);
      }
    }
    const risk = await this.analyzeStagedDiff();
    const partText = describeTestConclusion(passed, files, evidence, owners);
    const conclusion = `${partText}\n${risk.summary}`;
    return { risk, conclusion };
  }

  private hypothesesForRun(files: string[], hypothesisId?: string): Hypothesis[] {
    if (hypothesisId) {
      const match = this.hypotheses.filter((hypothesis) => hypothesis.id === hypothesisId);
      if (match.length > 0) {
        return match;
      }
    }
    const selected = new Set(files.map(normalizeFile));
    return this.hypotheses.filter((hypothesis) => {
      const scripts = (hypothesis.testScripts || []).map((test) => normalizeFile(test.file));
      return scripts.length > 0 && scripts.every((file) => selected.has(file));
    });
  }

  private recordFromMeasurement(
    files: string[],
    measured: TestMeasurement,
    passed: boolean,
    evidence: string,
    owners: Hypothesis[]
  ): PartRecord {
    const key = partKey(files);
    return {
      key,
      files,
      passed: measured.passed,
      failed: measured.failed,
      skipped: measured.skipped,
      uncovered: measured.uncovered,
      failures: measured.failures,
      conclusion: describeTestConclusion(passed, files, evidence, owners)
    };
  }

  private singleOwner(files: string[], owners: Hypothesis[], hypothesisId?: string): Hypothesis | undefined {
    if (hypothesisId) {
      return owners.find((hypothesis) => hypothesis.id === hypothesisId) || owners[0];
    }
    if (owners.length !== 1) {
      return undefined;
    }
    const ownerFiles = (owners[0].testScripts || []).map((test) => normalizeFile(test.file)).sort();
    const selected = files.map(normalizeFile).sort();
    if (ownerFiles.length !== selected.length || ownerFiles.some((file, index) => !sameFile(file, selected[index]))) {
      return undefined;
    }
    return owners[0];
  }

  private storeHypothesisResult(
    files: string[],
    measured: TestMeasurement,
    passed: boolean,
    evidence: string,
    owners: Hypothesis[]
  ): void {
    const slices = parseFileSlices(evidence, files);
    const covered = slices?.filter((slice) => files.some((file) => sameFile(file, slice.file))) || [];
    if (covered.length === files.length && files.length > 1) {
      this.partRecords.delete(partKey(files));
      for (const slice of covered) {
        const sliceMeasured: TestMeasurement = {
          ...measured,
          passed: slice.passed,
          failed: slice.failed,
          skipped: slice.skipped,
          selected: 1,
          uncovered: 0,
          failures: failuresForFiles(measured.failures, [slice.file])
        };
        const record = this.recordFromMeasurement([slice.file], sliceMeasured, passed, evidence, owners);
        this.partRecords.set(record.key, record);
      }
      return;
    }
    for (const file of files) {
      this.partRecords.delete(partKey([file]));
    }
    const record = this.recordFromMeasurement(files, measured, passed, evidence, owners);
    this.partRecords.set(record.key, record);
  }

  private storeFileSlices(files: string[], measured: TestMeasurement, passed: boolean, evidence: string): void {
    const slices = parseFileSlices(evidence, files);
    if (!slices) {
      return;
    }
    for (const slice of slices) {
      if (!files.some((file) => sameFile(file, slice.file))) {
        continue;
      }
      const sliceMeasured: TestMeasurement = {
        ...measured,
        passed: slice.passed,
        failed: slice.failed,
        skipped: slice.skipped,
        selected: 1,
        uncovered: 0,
        failures: failuresForFiles(measured.failures, [slice.file])
      };
      const owners = this.hypothesesForRun([slice.file]);
      const record = this.recordFromMeasurement([slice.file], sliceMeasured, passed, evidence, owners);
      this.partRecords.delete(partKey(files));
      this.partRecords.set(record.key, record);
    }
  }

  private measurementFor(files: string[]): PartRecord | null {
    if (files.length === 0) {
      return null;
    }
    const exact = this.partRecords.get(partKey(files));
    if (exact && exact.files.length === files.length) {
      return exact;
    }
    const singles = files
      .map((file) => this.partRecords.get(partKey([file])))
      .filter((record): record is PartRecord => Boolean(record && record.files.length === 1));
    if (singles.length !== files.length) {
      return null;
    }
    return {
      key: partKey(singles.flatMap((record) => record.files)),
      files: singles.flatMap((record) => record.files),
      passed: singles.reduce((sum, record) => sum + record.passed, 0),
      failed: singles.reduce((sum, record) => sum + record.failed, 0),
      skipped: singles.reduce((sum, record) => sum + record.skipped, 0),
      uncovered: singles.reduce((sum, record) => sum + record.uncovered, 0),
      failures: singles.flatMap((record) => record.failures).slice(0, 6),
      conclusion: singles.map((record) => record.conclusion).filter(Boolean).join('\n')
    };
  }

  private decorateHypothesis(hypothesis: Hypothesis): Hypothesis {
    const files = (hypothesis.testScripts || []).map((test) => test.file);
    const record = this.measurementFor(files);
    if (!record) {
      const manual = this.manualStatus.get(hypothesis.id);
      if (manual) {
        return { ...hypothesis, status: manual.status, evidence: manual.evidence };
      }
      return {
        ...hypothesis,
        status: 'UNTESTED',
        evidence: undefined,
        passPercent: undefined,
        passedCount: undefined,
        failedCount: undefined,
        skippedCount: undefined,
        measuredWith: undefined
      };
    }
    const outcome = decisionFromTests({
      passed: record.passed,
      failed: record.failed,
      skipped: record.skipped,
      selected: record.files.length,
      uncovered: record.uncovered,
      failures: record.failures
    });
    const status: Hypothesis['status'] = outcome.decision === 'BLOCK' ? 'CONFIRMED' : outcome.decision === 'DEPLOY' ? 'REJECTED' : 'UNTESTED';
    const manual = this.manualStatus.get(hypothesis.id);
    return {
      ...hypothesis,
      status: manual?.status || status,
      evidence: manual?.evidence || record.conclusion,
      passPercent: passPercentOf(record.passed, record.failed, record.skipped),
      passedCount: record.passed,
      failedCount: record.failed,
      skippedCount: record.skipped,
      measuredWith: record.files.length
    };
  }

  private decorateTest(test: RecommendedTest): RecommendedTest {
    const own = this.partRecords.get(partKey([test.file]));
    if (own && own.files.length === 1) {
      return this.testWithRecord(test, own);
    }
    const groups = [...this.partRecords.values()]
      .filter((record) => record.files.length > 1 && record.files.some((file) => sameFile(file, test.file)))
      .sort((a, b) => a.files.length - b.files.length);
    const group = groups.find((record) => !this.recordMixesHypotheses(record));
    if (!group) {
      return { ...test, passPercent: undefined, passedCount: undefined, failedCount: undefined, skippedCount: undefined, measuredWith: undefined };
    }
    return this.testWithRecord(test, group);
  }

  private recordMixesHypotheses(record: PartRecord): boolean {
    const groupFiles = record.files.map(normalizeFile);
    return [...this.partRecords.values()].some((other) => {
      if (other.key === record.key) {
        return false;
      }
      const otherFiles = other.files.map(normalizeFile);
      const inside = otherFiles.filter((file) => groupFiles.some((candidate) => sameFile(candidate, file))).length;
      return inside > 0 && inside < otherFiles.length;
    });
  }

  private testWithRecord(test: RecommendedTest, record: PartRecord): RecommendedTest {
    return {
      ...test,
      passPercent: passPercentOf(record.passed, record.failed, record.skipped),
      passedCount: record.passed,
      failedCount: record.failed,
      skippedCount: record.skipped,
      measuredWith: record.files.length
    };
  }

  private describeStage(parts: Hypothesis[], stage: { decision: RiskDecision; score: number }): string {
    const listed = parts.map((part) => (typeof part.passPercent === 'number' ? `${part.passPercent}%` : '0%')).join(', ');
    const reason = stage.decision === 'BLOCK'
      ? 'Deploy is blocked because a hypothesis still has failing tests.'
      : stage.decision === 'CAUTION'
        ? 'Deploy stays on caution because a hypothesis has not passed yet.'
        : 'Deploy is accepted because every hypothesis passed.';
    return `Stage readiness is ${stage.score}%. Parts: ${listed}. ${reason}`;
  }
}
