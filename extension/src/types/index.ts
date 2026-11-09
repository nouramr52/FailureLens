export type RiskDecision = 'DEPLOY' | 'CAUTION' | 'REVIEW' | 'BLOCK';

export type HypothesisStatus = 'UNTESTED' | 'CONFIRMED' | 'REJECTED';
export type ImpactLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export type BlastRadiusLevel = 'DIRECT' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface ReleaseRisk {
  decision: RiskDecision;
  score: number; // 0 - 100
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  analyzedAt: Date;
  summary: string;
  stagedFilesCount: number;
  linesAdded: number;
  linesDeleted: number;
}

export interface Hypothesis {
  id: string;
  title: string;
  description: string;
  status: HypothesisStatus;
  impact: ImpactLevel;
  affectedComponent: string;
  changedComponent?: string;
  evidence?: string;
  dockerTestCommand?: string;
  executionLogs?: string[];
  testScripts?: RecommendedTest[];
  passPercent?: number;
  passedCount?: number;
  failedCount?: number;
  skippedCount?: number;
  measuredWith?: number;
}

export interface AffectedComponent {
  id: string;
  filePath: string;
  line: number;
  level: BlastRadiusLevel;
  isModified: boolean;
  couplingScore: number;
  serviceName?: string;
  nodeId?: string;
  label?: string;
  depth?: number;
  viaRelation?: string;
  changePreview?: string;
  isCleared?: boolean;
}

export interface RecommendedTest {
  file: string;
  reason: string;
  runner: 'pytest' | 'npm';
  passPercent?: number;
  passedCount?: number;
  failedCount?: number;
  skippedCount?: number;
  measuredWith?: number;
}

export interface PreventiveSuggestion {
  recommendedTests: RecommendedTest[];
  rolloutStrategy: {
    type: 'CANARY' | 'FULL' | 'STAGED';
    percentage: number;
    recommendation: string;
  };
}

export interface IncidentRootCause {
  rank: number;
  confidence: number; // 0 - 100
  title: string;
  commitHash: string;
  commitMessage: string;
  filePath: string;
  line: number;
  explanation: string;
  reproductionCommand?: string;
}

export interface ActiveIncident {
  id: string;
  title: string;
  severity: 'P1' | 'P2' | 'P3';
  startedAt: Date;
  service: string;
  rootCauses: IncidentRootCause[];
}

export interface PastIncidentCitation {
  id: string;
  title: string;
  similarity: number; // percentage
  resolvedAt: string;
  rootCauseSummary: string;
  dashboardUrl: string;
}

export interface UserAccount {
  email: string;
  name: string;
  token: string;
  organization: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  repo: string;
  createdAt: string;
}

export interface GraphNode {
  id: string;
  label: string;
  source_file: string;
  source_location?: string;
  community?: number;
  community_name?: string;
  _callable?: boolean;
}

export interface GraphLink {
  source: string;
  target: string;
  relation: string;
  source_file?: string;
  source_location?: string;
  weight?: number;
}

export interface KnowledgeGraphSummary {
  status: string;
  nodes: number;
  edges: number;
  communities: number;
  criticalNodes: {
    nodeId: string;
    label: string;
    filePath: string;
    degree: number;
    inDegree: number;
    community: string;
  }[];
  criticalHubs?: {
    nodeId: string;
    label: string;
    filePath: string;
    degree: number;
    inDegree: number;
    community: string;
  }[];
  godNodes?: {
    nodeId: string;
    label: string;
    filePath: string;
    degree: number;
    inDegree: number;
    community: string;
  }[];
  graphJson?: string;
  graphHtml?: string;
  reportPath?: string;
  builtAtCommit?: string;
  isStale?: boolean;
}
