export type PersistenceMode = 'mongodb' | 'local-disk' | 'unavailable';

export type PersistenceStatus = 'durable' | 'temporary-local' | 'unavailable';

export type IndexingStatus = 'indexing' | 'complete' | 'partial' | 'failed';

export interface SkippedReasonSummary {
  reason: string;
  count: number;
}

export interface FailedFileEntry {
  path: string;
  reason: string;
}

export interface IngestionLiveStats {
  totalTreeFiles: number;
  eligibleFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  chunksCreated: number;
  embeddingsGenerated: number;
  indexingStatus: IndexingStatus;
  skippedBreakdown?: SkippedReasonSummary[];
  failedFileDetails?: FailedFileEntry[];
}

export interface HealthStatus {
  ok: boolean;
  persistence: PersistenceMode;
  persistenceStatus?: PersistenceStatus;
  isDurable?: boolean;
  databaseName?: string | null;
  mongodbConfigured?: boolean;
  mongodbConnected: boolean;
  mongodbError?: string;
  geminiConfigured: boolean;
  groqConfigured?: boolean;
  aiTextModel?: string;
  githubTokenConfigured: boolean;
  maxIndexableFiles?: number;
  rateLimit?: {
    remaining: number;
    limit: number;
    resetAt: string;
  };
}

export interface TreeItem {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
  sha: string;
  ingested?: boolean;
  failed?: boolean;
  skipReason?: string;
}

export interface SourceFile {
  path: string;
  name: string;
  extension: string;
  language: string;
  size: number;
  lines: number;
  content: string;
  sha: string;
}

export interface LanguageStat {
  language: string;
  files: number;
  lines: number;
  bytes: number;
  percentage: number;
}

export interface DetectedFramework {
  name: string;
  category: 'framework' | 'runtime' | 'database' | 'styling' | 'testing' | 'tooling' | 'ai';
  evidenceFile: string;
  evidenceDetail: string;
}

export interface EntryPoint {
  path: string;
  reason: string;
}

export interface DetectedFacts {
  languages: LanguageStat[];
  frameworks: DetectedFramework[];
  entryPoints: EntryPoint[];
  totalTreeFiles: number;
  eligibleFileCount: number;
  ingestedFileCount: number;
  skippedFileCount: number;
  failedFileCount: number;
  skippedBreakdown: SkippedReasonSummary[];
  failedFiles: FailedFileEntry[];
  totalLinesOfCode: number;
  totalBytesIngested: number;
  limitsApplied: {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    truncatedByFileCap: boolean;
    truncatedBySizeCap: boolean;
  };
  packageManifest?: {
    file: string;
    name?: string;
    version?: string;
    scripts?: Record<string, string>;
    dependenciesCount: number;
    devDependenciesCount: number;
  };
}

export interface ModuleInsight {
  name: string;
  directoryOrFile: string;
  responsibility: string;
  keyFiles: string[];
}

export interface AIAnalysis {
  status: 'complete' | 'unavailable' | 'error';
  model: string;
  generatedAt: string;
  summary: string;
  architecturalPattern: string;
  keyCapabilities: string[];
  modules: ModuleInsight[];
  caveats: string[];
  errorMessage?: string;
}

export interface ArchitectureNode {
  id: string;
  label: string;
  path: string;
  directory: string;
  kind: 'internal' | 'external';
  language?: string;
  lines?: number;
  inDegree: number;
  outDegree: number;
  position: { x: number; y: number };
}

export interface ArchitectureEdgeEvidence {
  line: number;
  rawStatement: string;
  specifiers: string[];
}

export interface ArchitectureEdge {
  id: string;
  source: string;
  target: string;
  sourcePath: string;
  targetPath: string;
  targetKind: 'internal' | 'external';
  evidences: ArchitectureEdgeEvidence[];
}

export interface ArchitectureGraph {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  internalEdgeCount: number;
  externalEdgeCount: number;
  parsedFilesCount: number;
  extractionNotes: string[];
}

export interface CodeChunk {
  id: string;
  repoId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  content: string;
  embedding: number[];
}

export interface Citation {
  filePath: string;
  startLine: number;
  endLine: number;
  similarity: number;
  snippet: string;
}

export interface ChatMessage {
  id: string;
  repoId: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  insufficientEvidence?: boolean;
  model?: string;
  createdAt: string;
}

export interface GeneratedDocs {
  status: 'complete' | 'error';
  model: string;
  generatedAt: string;
  markdown: string;
  sectionsIncluded: string[];
  errorMessage?: string;
}

export interface RepositoryMetadata {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  htmlUrl: string;
  defaultBranch: string;
  commitSha: string;
  stars: number;
  forks: number;
  openIssues: number;
  sizeKb: number;
  primaryLanguage: string | null;
  license: string | null;
  topics: string[];
  updatedAt: string;
}

export interface RepositorySummary {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  commitSha: string;
  stars: number;
  primaryLanguage: string | null;
  ingestedFileCount: number;
  eligibleFileCount?: number;
  chunkCount: number;
  embeddingsCount?: number;
  embeddingsReady: boolean;
  indexingStatus?: IndexingStatus;
  ingestedAt: string;
}

export interface SourceCitation {
  filePath: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  snippet?: string;
}

export type EvidenceConfidence = 'high' | 'medium' | 'low';

export interface OverviewBatchFileSummary {
  filePath: string;
  purpose: string;
  keySymbols: string[];
  interactions: string[];
}

export interface OverviewBatchResult {
  batchId: string;
  label: string;
  filePaths: string[];
  totalLines: number;
  status: 'pending' | 'running' | 'complete' | 'failed';
  fileSummaries: OverviewBatchFileSummary[];
  observedCapabilities: string[];
  executionNotes: string[];
  storageSignals: string[];
  issuesObserved: Array<{
    title: string;
    severity: 'high' | 'medium' | 'low';
    description: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
  }>;
  analyzedAt?: string;
  errorMessage?: string;
}

export type TechStackGroup =
  | 'Frontend'
  | 'Backend'
  | 'Database & Storage'
  | 'APIs & Integrations'
  | 'Frameworks & Libraries'
  | 'Build & Dev Tools';

export interface TechStackItem {
  name: string;
  group: TechStackGroup;
  verification: 'verified-in-source' | 'manifest-only' | 'source-only';
  versionOrDetail?: string;
  manifestFile?: string;
  sourceEvidence: SourceCitation[];
}

export type IssueCategory =
  | 'architecture'
  | 'documentation'
  | 'error-handling'
  | 'performance'
  | 'maintainability';

export interface ComprehensiveOverview {
  version: number;
  status: 'idle' | 'analyzing' | 'complete' | 'partial' | 'failed';
  model: string;
  startedAt: string;
  completedAt?: string;
  commitSha: string;
  coverage: {
    analyzedFiles: number;
    totalEligibleFiles: number;
    completedBatches: number;
    totalBatches: number;
    failedBatches: number;
  };
  batches: OverviewBatchResult[];

  // A. Project Identity
  projectIdentity: {
    name: string;
    shortDescription: string;
    mainPurpose: string;
    problemSolved: string;
    intendedUsers: string[];
    primaryUseCases: string[];
    evidence: SourceCitation[];
    confidence: EvidenceConfidence;
  };

  // B. Technology Stack
  technologyStack: TechStackItem[];

  // C. Project Structure
  projectStructure: {
    summary: string;
    entryPoints: Array<{
      path: string;
      reason: string;
      role: string;
      line?: number;
    }>;
    folderGuide: Array<{
      folder: string;
      purpose: string;
      fileCount: number;
      importantFiles: Array<{
        path: string;
        role: string;
        keySymbols: string[];
      }>;
    }>;
  };

  // D. Application Architecture
  applicationArchitecture: {
    architecturalPattern: string;
    summary: string;
    layersObserved: Array<{
      name: string;
      description: string;
      files: string[];
    }>;
    moduleResponsibilities: Array<{
      name: string;
      directoryOrFile: string;
      responsibility: string;
      keyFiles: string[];
      dependsOn: string[];
    }>;
    internalDependenciesSummary: string;
    externalIntegrations: Array<{
      name: string;
      purpose: string;
      evidence: SourceCitation[];
    }>;
    storageApproach: string;
    evidence: SourceCitation[];
    confidence: EvidenceConfidence;
  };

  // E. Core Features
  coreFeatures: Array<{
    name: string;
    description: string;
    relevantFiles: string[];
    keyFunctionsOrEndpoints: string[];
    evidence: SourceCitation[];
    confidence: EvidenceConfidence;
  }>;

  // F. Data Flow and Execution Flow
  executionFlows: Array<{
    title: string;
    trigger: string;
    summary: string;
    steps: Array<{
      stepNumber: number;
      layer: string;
      action: string;
      filePath: string;
      startLine?: number;
      endLine?: number;
      evidenceBasis: 'verified-call' | 'route-handler' | 'import-only' | 'inferred';
    }>;
    verificationNote: string;
  }>;

  // G. Database and Data Models
  databaseAndModels: {
    hasDatabase: boolean;
    summary: string;
    technologies: string[];
    collectionsOrTables: Array<{
      name: string;
      purpose: string;
      evidence: SourceCitation[];
    }>;
    schemasAndModels: Array<{
      name: string;
      fieldsSummary: string;
      evidence: SourceCitation[];
    }>;
    relationships: string[];
    persistenceAndCaching: string;
    evidence: SourceCitation[];
  };

  // H. Developer Guide
  developerGuide: {
    prerequisites: string[];
    installCommands: string[];
    runCommands: string[];
    buildCommands: string[];
    importantScripts: Array<{
      name: string;
      command: string;
      sourceFile: string;
    }>;
    environmentVariables: Array<{
      name: string;
      required: 'required' | 'optional' | 'unknown';
      purpose: string;
      references: SourceCitation[];
    }>;
    contributorEntryPoints: Array<{
      path: string;
      reason: string;
    }>;
  };

  // I. Improvement Opportunities
  improvementOpportunities: {
    verifiedIssues: Array<{
      title: string;
      category: IssueCategory;
      severity: 'high' | 'medium' | 'low';
      description: string;
      evidence: SourceCitation[];
    }>;
    suggestions: Array<{
      title: string;
      category: IssueCategory;
      rationale: string;
      relatedFiles: string[];
    }>;
  };

  caveats: string[];
  errorMessage?: string;
}

export interface OverviewProgressEvent {
  stage: 'preparing' | 'batch' | 'consolidating' | 'saving' | 'complete' | 'error';
  message: string;
  progress: number;
  analyzedFiles: number;
  totalEligibleFiles: number;
  completedBatches: number;
  totalBatches: number;
  failedBatches: number;
  currentBatchLabel?: string;
  overview?: ComprehensiveOverview;
}

export interface RepositoryRecord {
  id: string;
  metadata: RepositoryMetadata;
  tree: TreeItem[];
  files: SourceFile[];
  readmePath: string | null;
  readmeContent: string | null;
  detectedFacts: DetectedFacts;
  aiAnalysis: AIAnalysis;
  comprehensiveOverview?: ComprehensiveOverview | null;
  architecture: ArchitectureGraph;
  docs: GeneratedDocs | null;
  chunkCount: number;
  embeddingsCount?: number;
  embeddingsReady: boolean;
  indexingStatus?: IndexingStatus;
  embeddingModel: string | null;
  embeddingError?: string;
  ingestedAt: string;
}

export interface IngestProgressEvent {
  stage:
    | 'validating'
    | 'fetching-metadata'
    | 'fetching-tree'
    | 'fetching-files'
    | 'analyzing-facts'
    | 'extracting-architecture'
    | 'ai-analysis'
    | 'embedding'
    | 'saving'
    | 'complete'
    | 'error';
  message: string;
  progress: number;
  detail?: string;
  repositoryId?: string;
  stats?: Partial<IngestionLiveStats>;
}
