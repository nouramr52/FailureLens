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
    files: string[]
  ): Promise<{ affectedComponents: AffectedComponent[]; hypotheses: Hypothesis[]; recommendedTests: string[] }> {
    const root = this.getWorkspaceRoot();
    if (!root || !this.isInitialized()) {
      return { affectedComponents: [], hypotheses: [], recommendedTests: [] };
    }

    const pythonCmd = this.resolvePythonCommand();
    const cliPath = this.resolveEngineCliPath();
    const quotedFiles = files.map(f => `"${f}"`).join(' ');

    try {
      const command = `"${pythonCmd}" "${cliPath}" affected "${root}" ${quotedFiles}`;
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
          return {
            affectedComponents: parsed.affectedComponents || [],
            hypotheses: parsed.hypotheses || [],
            recommendedTests: parsed.recommendedTests || []
          };
        }
      }
    } catch (err) {
      console.warn('[FailureLens] Python affected query failed, falling back to in-memory traversal:', err);
    }

    // In-memory fallback traversal
    return this.calculateInMemoryBlastRadius(files);
  }

  private calculateInMemoryBlastRadius(
    files: string[]
  ): { affectedComponents: AffectedComponent[]; hypotheses: Hypothesis[]; recommendedTests: string[] } {
    const normalizedFiles = new Set(files.map(f => f.replace(/\\/g, '/').replace(/^\.\//, '')));
    const affected: AffectedComponent[] = [];
    const visited = new Set<string>();

    for (const [filePath, nodes] of this.fileToNodes.entries()) {
      const matches = normalizedFiles.has(filePath) || [...normalizedFiles].some(mf => filePath.endsWith(mf));
      if (matches) {
        for (const n of nodes) {
          if (!visited.has(n.id)) {
            visited.add(n.id);
            const line = parseInt((n.source_location || 'L1').replace('L', ''), 10) || 1;
            const inCount = (this.incomingEdges.get(n.id) || []).length;
            const outCount = (this.outgoingEdges.get(n.id) || []).length;

            affected.push({
              id: `comp_${affected.length + 1}`,
              filePath: n.source_file,
              line,
              level: 'DIRECT',
              isModified: true,
              couplingScore: Math.min(99, Math.max(20, inCount * 15 + outCount * 10)),
              serviceName: n.community_name || 'Core Module'
            });

            // Find immediate incoming callers
            const callers = this.incomingEdges.get(n.id) || [];
            for (const c of callers) {
              const callerNode = this.nodeMap.get(c.source);
              if (callerNode && !visited.has(callerNode.id) && callerNode.source_file) {
                visited.add(callerNode.id);
                const cLine = parseInt((callerNode.source_location || 'L1').replace('L', ''), 10) || 1;
                affected.push({
                  id: `comp_${affected.length + 1}`,
                  filePath: callerNode.source_file,
                  line: cLine,
                  level: 'HIGH',
                  isModified: false,
                  couplingScore: 65,
                  serviceName: callerNode.community_name || 'Dependent Service'
                });
              }
            }
          }
        }
      }
    }

    const hypotheses: Hypothesis[] = affected.length > 0
      ? [
          {
            id: 'h1',
            title: `Potential Regression in ${path.basename(affected[0].filePath)}`,
            description: `Modified symbols affect ${affected.length - 1} dependent components in blast radius. Verify contract compatibility.`,
            status: 'UNTESTED',
            impact: 'HIGH',
            affectedComponent: affected[0].filePath,
            dockerTestCommand: `docker run --rm failurelens-val test_suite`
          }
        ]
      : [];

    return {
      affectedComponents: affected,
      hypotheses,
      recommendedTests: ['npm test', 'pytest']
    };
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
      return 'FailureLens Knowledge Graph is not yet initialized. Click "⚡ Initialize / Re-sync" in Cockpit.';
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
