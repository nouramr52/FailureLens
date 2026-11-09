import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  GraphNode,
  GraphLink,
  KnowledgeGraphSummary,
  AffectedComponent,
  Hypothesis,
  RecommendedTest,
  BlastRadiusLevel
} from '../types';

const execAsync = promisify(exec);

export class KnowledgeGraphService {
  private summary: KnowledgeGraphSummary | null = null;
  private nodeMap = new Map<string, GraphNode>();
  private fileToNodes = new Map<string, GraphNode[]>();
  private incomingEdges = new Map<string, GraphLink[]>();
  private outgoingEdges = new Map<string, GraphLink[]>();
  private communityLabels = new Map<number, string>();
  private clearedNodeIds = new Set<string>();
  private clearedFiles = new Set<string>();
  private failedNodeIds = new Set<string>();
  private failedFiles = new Set<string>();

  private onGraphChangedEmitter = new vscode.EventEmitter<KnowledgeGraphSummary | null>();
  public readonly onGraphChanged = this.onGraphChangedEmitter.event;

  constructor(private context: vscode.ExtensionContext) {
    this.tryLoadExistingGraph();
  }

  public getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  public isInitialized(): boolean {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return false;
    }
    const graphJsonPath = path.join(root, '.failurelens', 'graph.json');
    return fs.existsSync(graphJsonPath);
  }

  public getSummary(): KnowledgeGraphSummary | null {
    return this.summary;
  }

  public getGraphHtmlPath(): string | null {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return null;
    }
    const htmlPath = path.join(root, '.failurelens', 'graph.html');
    return fs.existsSync(htmlPath) ? htmlPath : null;
  }

  public getClearedNodeIds(): Set<string> {
    return new Set(this.clearedNodeIds);
  }

  public getClearedFiles(): Set<string> {
    return new Set(this.clearedFiles);
  }

  public getFailedNodeIds(): Set<string> {
    return new Set(this.failedNodeIds);
  }

  public getFailedFiles(): Set<string> {
    return new Set(this.failedFiles);
  }

  public async recordTestRunResults(
    passed: boolean,
    testFiles: string[],
    hypothesisId?: string,
    affectedComponents?: AffectedComponent[],
    hypothesisTargetFile?: string
  ): Promise<{ cleared: string[]; failed: string[] }> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return { cleared: [], failed: [] };
    }

    const targetNodes = new Set<string>();
    const targetFiles = new Set<string>();
    const norm = (f: string) => f.replace(/\\/g, '/').toLowerCase().replace(/^\.\//, '').trim();

    const sameFilePath = (a: string, b: string): boolean => {
      const na = norm(a);
      const nb = norm(b);
      if (!na || !nb) {
        return false;
      }
      return na === nb || na.endsWith('/' + nb) || nb.endsWith('/' + na);
    };

    const normalizedTests = testFiles.map(norm);

    // 1. Gather candidate target files (strictly bounded to the hypothesis or matching test)
    if (hypothesisTargetFile) {
      targetFiles.add(norm(hypothesisTargetFile));
    }
    for (const tf of normalizedTests) {
      targetFiles.add(tf);
    }
    if (affectedComponents && affectedComponents.length > 0) {
      for (const comp of affectedComponents) {
        if (comp.filePath) {
          const compNorm = norm(comp.filePath);
          const isTarget = hypothesisTargetFile
            ? sameFilePath(compNorm, hypothesisTargetFile)
            : normalizedTests.some((tf) => {
                const base = path.basename(compNorm, path.extname(compNorm));
                return base.length > 2 && tf.includes(base);
              });
          if (isTarget) {
            targetFiles.add(compNorm);
            if (comp.nodeId) {
              targetNodes.add(comp.nodeId);
            }
          }
        }
      }
    }

    // 2. Resolve nodes directly from target files
    for (const targetFile of Array.from(targetFiles)) {
      const directNodes = this.getNodesForFile(targetFile);
      for (const n of directNodes) {
        targetNodes.add(n.id);
      }
      for (const [nodeId, node] of this.nodeMap.entries()) {
        const sf = norm(node.source_file || '');
        if (sf && sameFilePath(sf, targetFile)) {
          targetNodes.add(nodeId);
        }
      }
    }

    // 3. Match test file direct outgoing call dependencies
    for (const testFile of normalizedTests) {
      for (const [nodeId, node] of this.nodeMap.entries()) {
        const sf = norm(node.source_file || '');
        if (sf && sameFilePath(sf, testFile)) {
          const outEdges = this.outgoingEdges.get(nodeId) || [];
          for (const edge of outEdges) {
            if (this.nodeMap.has(edge.target)) {
              targetNodes.add(edge.target);
            }
          }
        }
      }
    }

    // 4. Trace incoming callers strictly bounded to the affected components
    const affectedNodeSet = new Set((affectedComponents || []).map((c) => c.nodeId).filter(Boolean) as string[]);
    const callerQueue = Array.from(targetNodes);
    for (let depth = 0; depth < 2; depth++) {
      const nextQueue: string[] = [];
      for (const nid of callerQueue) {
        const callers = this.getIncomingCallers(nid);
        for (const caller of callers) {
          if (!targetNodes.has(caller.id) && affectedNodeSet.has(caller.id)) {
            targetNodes.add(caller.id);
            nextQueue.push(caller.id);
          }
        }
      }
      callerQueue.length = 0;
      callerQueue.push(...nextQueue);
    }

    // 4. Update cleared vs failed state
    if (passed) {
      for (const nid of targetNodes) {
        this.clearedNodeIds.add(nid);
        this.failedNodeIds.delete(nid);
      }
      for (const file of targetFiles) {
        this.clearedFiles.add(file);
        this.failedFiles.delete(file);
      }
    } else {
      for (const nid of targetNodes) {
        this.failedNodeIds.add(nid);
        this.clearedNodeIds.delete(nid);
      }
      for (const file of targetFiles) {
        this.failedFiles.add(file);
        this.clearedFiles.delete(file);
      }
    }

    // 5. Persist to .failurelens/cleared-nodes.json and failed-nodes.json
    const dir = path.join(root, '.failurelens');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, 'cleared-nodes.json'),
      JSON.stringify({ nodes: Array.from(this.clearedNodeIds), files: Array.from(this.clearedFiles) }, null, 2),
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(dir, 'failed-nodes.json'),
      JSON.stringify({ nodes: Array.from(this.failedNodeIds), files: Array.from(this.failedFiles) }, null, 2),
      'utf8'
    );

    // 6. Update the graph.html overlay
    await this.updateImpactOverlay();

    // 7. Fire change event
    this.onGraphChangedEmitter.fire(this.summary);

    return {
      cleared: Array.from(this.clearedNodeIds),
      failed: Array.from(this.failedNodeIds)
    };
  }

  public async clearNodesForPassedTests(
    testFiles: string[],
    hypothesisId?: string,
    affectedComponents?: AffectedComponent[],
    hypothesisTargetFile?: string
  ): Promise<string[]> {
    const res = await this.recordTestRunResults(true, testFiles, hypothesisId, affectedComponents, hypothesisTargetFile);
    return res.cleared;
  }

  public async updateImpactOverlay(): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root || !this.isInitialized()) {
      return;
    }

    const pythonCmd = this.resolvePythonCommand();
    const cliPath = this.resolveEngineCliPath();
    const clearedPath = path.join(root, '.failurelens', 'cleared-nodes.json');
    const failedPath = path.join(root, '.failurelens', 'failed-nodes.json');

    try {
      const command = `"${pythonCmd}" "${cliPath}" update-impact "${root}" --cleared "${clearedPath}" --failed "${failedPath}"`;
      await execAsync(command, { cwd: root });
    } catch (err) {
      console.warn('[FailureLens] update-impact command failed:', err);
    }
  }

  public async resetClearedNodes(): Promise<void> {
    this.clearedNodeIds.clear();
    this.clearedFiles.clear();
    this.failedNodeIds.clear();
    this.failedFiles.clear();
    const root = this.getWorkspaceRoot();
    if (root) {
      const clearedPath = path.join(root, '.failurelens', 'cleared-nodes.json');
      const failedPath = path.join(root, '.failurelens', 'failed-nodes.json');
      try {
        if (fs.existsSync(clearedPath)) {
          await fs.promises.unlink(clearedPath);
        }
      } catch {}
      try {
        if (fs.existsSync(failedPath)) {
          await fs.promises.unlink(failedPath);
        }
      } catch {}
      await this.updateImpactOverlay();
      this.onGraphChangedEmitter.fire(this.summary);
    }
  }

  public async tryLoadExistingGraph(): Promise<boolean> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return false;
    }

    const graphJsonPath = path.join(root, '.failurelens', 'graph.json');
    if (!fs.existsSync(graphJsonPath)) {
      return false;
    }

    try {
      const raw = await fs.promises.readFile(graphJsonPath, 'utf-8');
      const data = JSON.parse(raw);
      this.buildIndex(data);

      const nodes = data.nodes || [];
      const links = data.links || [];
      const communities = new Set(nodes.map((n: GraphNode) => n.community)).size;

      const critNodes = this.computeCriticalNodes(nodes, links);

      const clearedPath = path.join(root, '.failurelens', 'cleared-nodes.json');
      if (fs.existsSync(clearedPath)) {
        try {
          const rawCleared = JSON.parse(await fs.promises.readFile(clearedPath, 'utf-8'));
          this.clearedNodeIds = new Set(rawCleared.nodes || []);
          this.clearedFiles = new Set(rawCleared.files || []);
        } catch {
          // ignore
        }
      }

      const failedPath = path.join(root, '.failurelens', 'failed-nodes.json');
      if (fs.existsSync(failedPath)) {
        try {
          const rawFailed = JSON.parse(await fs.promises.readFile(failedPath, 'utf-8'));
          this.failedNodeIds = new Set(rawFailed.nodes || []);
          this.failedFiles = new Set(rawFailed.files || []);
        } catch {
          // ignore
        }
      }

      let isStale = false;
      const builtAtCommit = data.built_at_commit || undefined;
      try {
        const { stdout } = await execAsync('git rev-parse HEAD', { cwd: root });
        const currentCommit = stdout.trim();
        if (builtAtCommit && currentCommit && builtAtCommit !== currentCommit) {
          isStale = true;
        }
      } catch {
        // Not in git or git command unavailable
      }

      this.summary = {
        status: 'success',
        nodes: nodes.length,
        edges: links.length,
        communities,
        criticalNodes: critNodes,
        criticalHubs: critNodes,
        godNodes: critNodes,
        graphJson: graphJsonPath,
        graphHtml: path.join(root, '.failurelens', 'graph.html'),
        reportPath: path.join(root, '.failurelens', 'KNOWLEDGE_REPORT.md'),
        builtAtCommit,
        isStale
      };

      this.onGraphChangedEmitter.fire(this.summary);
      return true;
    } catch (err) {
      console.error('[FailureLens] Error reading existing knowledge graph:', err);
      return false;
    }
  }

  private buildIndex(data: { nodes: GraphNode[]; links: GraphLink[] }) {
    this.nodeMap.clear();
    this.fileToNodes.clear();
    this.incomingEdges.clear();
    this.outgoingEdges.clear();
    this.communityLabels.clear();

    const nodes = data.nodes || [];
    const links = data.links || [];

    for (const node of nodes) {
      this.nodeMap.set(node.id, node);
      const sf = (node.source_file || '').replace(/\\/g, '/').replace(/^\.\//, '');
      if (sf) {
        const list = this.fileToNodes.get(sf) || [];
        list.push(node);
        this.fileToNodes.set(sf, list);
      }
      if (node.community !== undefined && node.community_name) {
        this.communityLabels.set(node.community, node.community_name);
      }
    }

    for (const link of links) {
      // Outgoing: source -> target
      const outList = this.outgoingEdges.get(link.source) || [];
      outList.push(link);
      this.outgoingEdges.set(link.source, outList);

      // Incoming: target has predecessor source
      const inList = this.incomingEdges.get(link.target) || [];
      inList.push(link);
      this.incomingEdges.set(link.target, inList);
    }
  }

  private computeCriticalNodes(nodes: GraphNode[], links: GraphLink[]) {
    const inDegrees = new Map<string, number>();
    const totalDegrees = new Map<string, number>();

    for (const l of links) {
      inDegrees.set(l.target, (inDegrees.get(l.target) || 0) + 1);
      totalDegrees.set(l.source, (totalDegrees.get(l.source) || 0) + 1);
      totalDegrees.set(l.target, (totalDegrees.get(l.target) || 0) + 1);
    }

    const sorted = [...nodes].sort((a, b) => {
      const aIn = inDegrees.get(a.id) || 0;
      const bIn = inDegrees.get(b.id) || 0;
      return bIn - aIn;
    });

    return sorted.slice(0, 6).map(n => ({
      nodeId: n.id,
      label: n.label,
      filePath: n.source_file,
      degree: totalDegrees.get(n.id) || 0,
      inDegree: inDegrees.get(n.id) || 0,
      community: n.community_name || `Feature Group ${n.community || 0}`
    }));
  }

  private resolvePythonCommand(): string {
    const config = vscode.workspace.getConfiguration('failurelens');
    const custom = config.get<string>('pythonPath');
    if (custom && custom.trim()) {
      return custom.trim();
    }
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  private resolveEngineCliPath(): string {
    // 1. Try workspace engine first during development (canonical source of truth)
    const root = this.getWorkspaceRoot();
    if (root) {
      const wsEngine = path.join(root, 'src', 'engine', 'cli.py');
      if (fs.existsSync(wsEngine)) {
        return wsEngine;
      }
    }

    // 2. Fall back to bundled extension engine
    const bundled = path.join(this.context.extensionPath, 'engine', 'cli.py');
    if (fs.existsSync(bundled)) {
      return bundled;
    }

    return bundled;
  }

  public async initializeGraph(): Promise<KnowledgeGraphSummary> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      throw new Error('No open workspace found.');
    }

    const pythonCmd = this.resolvePythonCommand();
    const cliPath = this.resolveEngineCliPath();

    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'FailureLens: Initializing Repository Knowledge Graph...',
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: 'Extracting AST symbols & tracing dependencies...' });

        const command = `"${pythonCmd}" "${cliPath}" init "${root}"`;
        const { stdout, stderr } = await execAsync(command, { cwd: root });

        // Find JSON output line
        const lines = stdout.trim().split('\n');
        let jsonStr = '';
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].trim().startsWith('{') && lines[i].trim().endsWith('}')) {
            jsonStr = lines[i].trim();
            break;
          }
        }

        if (!jsonStr) {
          throw new Error(`Failed to initialize knowledge graph: ${stderr || stdout}`);
        }

        const result: KnowledgeGraphSummary = JSON.parse(jsonStr);
        if (result.status === 'error') {
          throw new Error(`Engine error: ${(result as unknown as { message: string }).message}`);
        }

        await this.tryLoadExistingGraph();
        vscode.window.showInformationMessage(
          `FailureLens: Knowledge Graph initialized! (${result.nodes} components, ${result.edges} dependencies across ${result.communities} feature groups)`
        );

        return result;
      }
    );
  }

  public async getBlastRadiusForFiles(
    files: string[],
    linesFile?: string
  ): Promise<{ affectedComponents: AffectedComponent[]; hypotheses: Hypothesis[]; recommendedTests: RecommendedTest[] }> {
    const root = this.getWorkspaceRoot();
    if (!root || !this.isInitialized()) {
      return { affectedComponents: [], hypotheses: [], recommendedTests: [] };
    }

    const pythonCmd = this.resolvePythonCommand();
    const cliPath = this.resolveEngineCliPath();
    const quotedFiles = files.map(f => `"${f}"`).join(' ');
    const linesArg = linesFile ? ` --lines "${linesFile}"` : '';

    try {
      const command = `"${pythonCmd}" "${cliPath}" affected "${root}"${linesArg} ${quotedFiles}`;
      const { stdout } = await execAsync(command, { cwd: root });

      const lines = stdout.trim().split('\n');
      let jsonStr = '';
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().startsWith('{') && lines[i].trim().endsWith('}')) {
          jsonStr = lines[i].trim();
          break;
        }
      }

      if (jsonStr) {
        const parsed = JSON.parse(jsonStr);
        if (parsed.status === 'success') {
          const affectedComponents = parsed.affectedComponents || [];
          const recommendedTests = this.normalizeTests(parsed.recommendedTests);
          return {
            affectedComponents,
            hypotheses: this.attachTestScripts(parsed.hypotheses || [], recommendedTests, affectedComponents),
            recommendedTests
          };
        }
      }
    } catch (err) {
      console.warn('[FailureLens] Python affected query failed, falling back to in-memory traversal:', err);
    }

    // In-memory fallback traversal
    return this.calculateInMemoryBlastRadius(files, linesFile);
  }

  private normalizeTests(raw: unknown): RecommendedTest[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const tests: RecommendedTest[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object' || !('file' in item)) {
        continue;
      }
      const record = item as { file?: string; reason?: string; runner?: string };
      if (!record.file) {
        continue;
      }
      tests.push({
        file: record.file,
        reason: record.reason || 'covers a changed symbol',
        runner: record.runner === 'npm' ? 'npm' : 'pytest'
      });
    }
    return tests;
  }

  private loadLinesFile(linesFile?: string): Record<string, number[]> {
    if (!linesFile || !fs.existsSync(linesFile)) {
      return {};
    }
    try {
      const raw = JSON.parse(fs.readFileSync(linesFile, 'utf8')) as Record<string, number[]>;
      const lines: Record<string, number[]> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (Array.isArray(value)) {
          lines[key.replace(/\\/g, '/').replace(/^\.\//, '')] = value.map((n) => Number(n));
        }
      }
      return lines;
    } catch {
      return {};
    }
  }

  private linesForFile(filePath: string, linesByFile: Record<string, number[]>): number[] | undefined {
    const norm = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (linesByFile[norm]) {
      return linesByFile[norm];
    }
    for (const [key, lines] of Object.entries(linesByFile)) {
      if (norm.endsWith('/' + key) || key.endsWith('/' + norm)) {
        return lines;
      }
    }
    return undefined;
  }

  private calculateInMemoryBlastRadius(
    files: string[],
    linesFile?: string
  ): { affectedComponents: AffectedComponent[]; hypotheses: Hypothesis[]; recommendedTests: RecommendedTest[] } {
    const normalizedFiles = new Set(files.map(f => f.replace(/\\/g, '/').replace(/^\.\//, '')));
    const linesByFile = this.loadLinesFile(linesFile);
    const affected: AffectedComponent[] = [];
    const visited = new Set<string>();

    const spans = new Map<string, { start: number; end: number | null }>();
    for (const [, nodes] of this.fileToNodes.entries()) {
      const ordered = [...nodes].sort((a, b) => this.nodeLine(a) - this.nodeLine(b));
      ordered.forEach((node, index) => {
        const start = this.nodeLine(node);
        const end = index + 1 < ordered.length ? this.nodeLine(ordered[index + 1]) : null;
        spans.set(node.id, { start, end });
      });
    }

    for (const [filePath, nodes] of this.fileToNodes.entries()) {
      const matches = normalizedFiles.has(filePath) || [...normalizedFiles].some(mf => filePath.endsWith('/' + mf) || mf.endsWith('/' + filePath));
      if (!matches) {
        continue;
      }
      const hunkLines = this.linesForFile(filePath, linesByFile);
      for (const n of nodes) {
        if (visited.has(n.id)) {
          continue;
        }
        if (hunkLines && !this.spanOverlaps(spans.get(n.id), hunkLines)) {
          continue;
        }
        visited.add(n.id);
        const line = this.nodeLine(n);
        const inCount = (this.incomingEdges.get(n.id) || []).length;
        const outCount = (this.outgoingEdges.get(n.id) || []).length;

        affected.push({
          id: `comp_${affected.length + 1}`,
          nodeId: n.id,
          label: n.label,
          filePath: n.source_file,
          line,
          level: 'DIRECT',
          isModified: true,
          couplingScore: Math.min(99, Math.max(20, inCount * 15 + outCount * 10)),
          serviceName: n.community_name || 'Core Module',
          depth: 0,
          viaRelation: 'modified'
        });

        const callers = this.incomingEdges.get(n.id) || [];
        for (const c of callers) {
          const callerNode = this.nodeMap.get(c.source);
          if (callerNode && !visited.has(callerNode.id) && callerNode.source_file) {
            visited.add(callerNode.id);
            affected.push({
              id: `comp_${affected.length + 1}`,
              nodeId: callerNode.id,
              label: callerNode.label,
              filePath: callerNode.source_file,
              line: this.nodeLine(callerNode),
              level: 'HIGH',
              isModified: false,
              couplingScore: 65,
              serviceName: callerNode.community_name || 'Dependent Service',
              depth: 1,
              viaRelation: c.relation
            });
          }
        }
      }
    }

    const hypotheses: Hypothesis[] = affected.length > 0
      ? [
          {
            id: 'h1',
            title: `Potential Regression in ${path.basename(affected[0].filePath)}`,
            description: `Modified symbols affect ${Math.max(0, affected.length - 1)} dependent components in blast radius. Run the covering tests before deploy.`,
            status: 'UNTESTED',
            impact: 'HIGH',
            affectedComponent: affected[0].filePath
          }
        ]
      : [];

    const recommendedTests = this.testsForAffected(affected, normalizedFiles);
    return {
      affectedComponents: affected,
      hypotheses: this.attachTestScripts(hypotheses, recommendedTests, affected),
      recommendedTests
    };
  }

  private nodeLine(node: GraphNode): number {
    const match = /^L(\d+)/.exec(node.source_location || 'L1');
    return match ? parseInt(match[1], 10) : 1;
  }

  private spanOverlaps(span: { start: number; end: number | null } | undefined, lines: number[]): boolean {
    if (!span) {
      return false;
    }
    return lines.some((line) => {
      if (span.end === null) {
        return line >= span.start;
      }
      if (span.end <= span.start) {
        return line === span.start;
      }
      return line >= span.start && line < span.end;
    });
  }

  private testsForAffected(affected: AffectedComponent[], changedFiles: Set<string>): RecommendedTest[] {
    const tests: RecommendedTest[] = [];
    const seen = new Set<string>();
    const production = affected.filter((item) => !this.isTestPath(item.filePath || ''));
    const coverIds = new Set(
      production
        .filter((item) => item.isModified || item.depth === 1)
        .map((item) => item.nodeId)
        .filter((id): id is string => !!id)
    );
    const editedTests = affected
      .filter((item) => item.isModified && this.isTestPath(item.filePath || ''))
      .map((item) => item.filePath);
    const add = (file: string, reason: string) => {
      const norm = file.replace(/\\/g, '/');
      if (!norm || seen.has(norm) || tests.length >= 8 || !this.isTestPath(norm)) {
        return;
      }
      seen.add(norm);
      tests.push({
        file: norm,
        reason,
        runner: norm.endsWith('.py') ? 'pytest' : 'npm'
      });
    };

    for (const [nodeId, node] of this.nodeMap.entries()) {
      if (!this.isTestPath(node.source_file || '')) {
        continue;
      }
      for (const edge of this.outgoingEdges.get(nodeId) || []) {
        if (coverIds.has(edge.target)) {
          const target = this.nodeMap.get(edge.target);
          add(node.source_file, `covers ${target?.label || edge.target}`);
          break;
        }
      }
    }

    for (const file of changedFiles) {
      if (this.isTestPath(file)) {
        continue;
      }
      const stem = path.basename(file, path.extname(file));
      const names = new Set([
        `test_${stem}.py`, `${stem}_test.py`,
        `${stem}.test.ts`, `${stem}.spec.ts`, `${stem}.test.js`, `${stem}.spec.js`
      ]);
      for (const [candidate] of this.fileToNodes.entries()) {
        if (names.has(path.basename(candidate))) {
          add(candidate, `name matches ${path.basename(file)}`);
        }
      }
    }
    for (const file of editedTests) {
      add(file, 'edited test; run this file');
    }
    return tests;
  }

  private attachTestScripts(
    hypotheses: Hypothesis[],
    tests: RecommendedTest[],
    affected: AffectedComponent[]
  ): Hypothesis[] {
    const norm = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '');
    const labelsByFile = new Map<string, Set<string>>();
    for (const component of affected) {
      const file = norm(component.filePath || '');
      if (!file) {
        continue;
      }
      const labels = labelsByFile.get(file) ?? new Set<string>();
      if (component.label) {
        labels.add(component.label);
      }
      labelsByFile.set(file, labels);
    }

    const labelsFor = (target: string): Set<string> => {
      const direct = labelsByFile.get(target);
      if (direct) {
        return direct;
      }
      for (const [file, labels] of labelsByFile) {
        if (file.endsWith('/' + target) || target.endsWith('/' + file)) {
          return labels;
        }
      }
      return new Set();
    };

    const sameFile = (left: string, right: string) =>
      left === right || left.endsWith('/' + right) || right.endsWith('/' + left);

    const coversFile = (reason: string, target: string): boolean => {
      if (!reason.startsWith('covers ')) {
        return false;
      }
      const label = reason.slice('covers '.length);
      if (labelsFor(target).has(label)) {
        return true;
      }
      for (const node of this.nodeMap.values()) {
        if (node.label !== label || !node.source_file) {
          continue;
        }
        if (sameFile(norm(node.source_file), target)) {
          return true;
        }
      }
      return false;
    };

    return hypotheses.map((hypothesis) => {
      const targets = [hypothesis.affectedComponent, hypothesis.changedComponent]
        .map((value) => norm(value || ''))
        .filter((value, index, all) => value && all.indexOf(value) === index);
      const testScripts = tests.filter((test) => {
        const file = norm(test.file);
        const reason = test.reason || '';
        return targets.some((target) => {
          const base = target.split('/').pop() || '';
          if (sameFile(file, target)) {
            return true;
          }
          if (reason === `imports ${target}` || (base && (reason === `name matches ${base}` || reason === `imports ${base}`))) {
            return true;
          }
          return coversFile(reason, target);
        });
      });
      return { ...hypothesis, testScripts };
    });
  }

  private isTestPath(filePath: string): boolean {
    const name = path.basename(filePath).toLowerCase();
    if ((name.startsWith('test_') && name.endsWith('.py')) || name.endsWith('_test.py')) {
      return true;
    }
    if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(name)) {
      return true;
    }
    return filePath.replace(/\\/g, '/').split('/').some((part) => part === 'test' || part === 'tests' || part === '__tests__');
  }

  public getNodesForFile(filePath: string): GraphNode[] {
    const norm = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
    for (const [key, nodes] of this.fileToNodes.entries()) {
      if (key === norm || norm.endsWith(key) || key.endsWith(norm)) {
        return nodes;
      }
    }
    return [];
  }

  public getIncomingCallers(nodeId: string): GraphNode[] {
    const edges = this.incomingEdges.get(nodeId) || [];
    const callers: GraphNode[] = [];
    for (const e of edges) {
      const node = this.nodeMap.get(e.source);
      if (node) {
        callers.push(node);
      }
    }
    return callers;
  }

  public getOutgoingDependencies(nodeId: string): GraphNode[] {
    const edges = this.outgoingEdges.get(nodeId) || [];
    const deps: GraphNode[] = [];
    for (const e of edges) {
      const node = this.nodeMap.get(e.target);
      if (node) {
        deps.push(node);
      }
    }
    return deps;
  }

  public queryGraph(query: string): string {
    if (!this.summary) {
      return 'FailureLens Knowledge Graph is not yet initialized. Run FailureLens: Initialize Project Knowledge Graph.';
    }

    const q = query.toLowerCase().trim();

    // 1. Critical Nodes inquiry
    if (q.includes('critical') || q.includes('hub') || q.includes('central') || q.includes('backbone') || q.includes('god')) {
      const crit = this.summary.criticalNodes || this.summary.criticalHubs || this.summary.godNodes || [];
      if (crit.length > 0) {
        const top = crit.slice(0, 5).map(c => `• <strong>${c.label}</strong> (<code>${c.filePath}</code>) — In-Degree: ${c.inDegree}, Total Degree: ${c.degree}`).join('<br/>');
        return `Top <strong>Critical Nodes</strong> with highest blast radius in this project:<br/>${top}`;
      }
      return 'No critical nodes identified yet. Run repository initialization to calculate node centrality.';
    }

    // 2. Feature communities inquiry
    if (q.includes('feature') || q.includes('communities') || q.includes('domain') || q.includes('architecture')) {
      const commMap = new Map<string, number>();
      for (const node of this.nodeMap.values()) {
        const name = node.community_name || 'Core System';
        commMap.set(name, (commMap.get(name) || 0) + 1);
      }
      const topComm = Array.from(commMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `• <strong>${name}</strong>: ${count} components`)
        .join('<br/>');
      return `FailureLens identified <strong>${this.summary.communities} feature communities</strong> (${this.summary.nodes} components, ${this.summary.edges} dependency links):<br/>${topComm}`;
    }

    // 3. Extract keywords (strip common stopwords)
    const stopwords = new Set(['who', 'what', 'where', 'when', 'why', 'how', 'is', 'are', 'the', 'a', 'an', 'in', 'of', 'for', 'to', 'does', 'calls', 'call', 'caller', 'called', 'depend', 'depends', 'dependencies', 'show', 'tell', 'me', 'about']);
    const rawTokens = q.replace(/[^a-z0-9_\.]/g, ' ').split(/\s+/).filter(t => t.length > 1);
    const candidateTokens = rawTokens.filter(t => !stopwords.has(t));
    const searchTerms = candidateTokens.length > 0 ? candidateTokens : rawTokens;

    const matchedNodes: GraphNode[] = [];
    for (const node of this.nodeMap.values()) {
      const lbl = (node.label || '').toLowerCase();
      const sf = (node.source_file || '').toLowerCase();

      const matched = searchTerms.some(term => lbl.includes(term) || sf.includes(term));
      if (matched) {
        matchedNodes.push(node);
      }
    }

    if (matchedNodes.length === 0) {
      return `Knowledge Graph indexed ${this.summary.nodes} components across ${this.summary.communities} features. No direct matches found for "${query}".`;
    }

    const top = matchedNodes.slice(0, 3);
    const answers: string[] = [];
    for (const m of top) {
      const callers = this.getIncomingCallers(m.id);
      const deps = this.getOutgoingDependencies(m.id);
      const callersText = callers.length > 0 ? `${callers.length} callers (${callers.slice(0, 2).map(c => c.label).join(', ')})` : '0 external callers';
      answers.push(
        `• <strong>${m.label}</strong> (<code>${m.source_file}</code>) in <em>${m.community_name || 'Core'}</em>: has ${callersText} and ${deps.length} outgoing dependencies.`
      );
    }

    return `Knowledge Graph found ${matchedNodes.length} related component(s):<br/>${answers.join('<br/>')}`;
  }
}
