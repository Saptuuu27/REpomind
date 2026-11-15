import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Database,
  ExternalLink,
  FileCode2,
  FolderTree,
  GitBranch,
  GitFork,
  Layers,
  Lightbulb,
  Play,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Star,
  Terminal,
  Wrench,
} from 'lucide-react';
import type {
  ComprehensiveOverview,
  OverviewProgressEvent,
  RepositoryRecord,
  SourceCitation,
  TechStackGroup,
} from '../types';
import {
  areAllEmbeddingsGenerated,
  deriveRecordIndexingStatus,
  getResolvedEmbeddingsCount,
} from '../utils/indexingStatus';

interface OverviewTabProps {
  repo: RepositoryRecord;
  isReanalyzing: boolean;
  isAnalyzingOverview: boolean;
  overviewProgress: OverviewProgressEvent | null;
  overviewError: string | null;
  onAnalyzeOverview: (options: { mode: 'resume' | 'full'; retryBatchIds?: string[] }) => void;
  onReanalyze: () => void;
  onForceRefresh: () => void;
  onOpenFileAtLine: (path: string, line?: number) => void;
  onOpenArchitecture: () => void;
}

const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3B82F6',
  'TypeScript (TSX)': '#60A5FA',
  JavaScript: '#F59E0B',
  'JavaScript (JSX)': '#FBBF24',
  Python: '#10B981',
  Go: '#06B6D4',
  Rust: '#EF4444',
  JSON: '#94A3B8',
  Markdown: '#8B5CF6',
  CSS: '#EC4899',
  HTML: '#F97316',
};

const TECH_GROUP_ORDER: TechStackGroup[] = [
  'Frontend',
  'Backend',
  'Database & Storage',
  'APIs & Integrations',
  'Frameworks & Libraries',
  'Build & Dev Tools',
];

type SectionId =
  | 'identity'
  | 'tech'
  | 'structure'
  | 'architecture'
  | 'features'
  | 'flows'
  | 'database'
  | 'devguide'
  | 'improvements';

const ConfidenceBadge = memo(function ConfidenceBadge({
  level,
}: {
  level: 'high' | 'medium' | 'low';
}) {
  const styles =
    level === 'high'
      ? 'text-[#10B981] bg-[#10B981]/10 border-[#10B981]/30'
      : level === 'medium'
        ? 'text-[#3B82F6] bg-[#3B82F6]/10 border-[#3B82F6]/30'
        : 'text-[#F59E0B] bg-[#F59E0B]/10 border-[#F59E0B]/30';
  return (
    <span className={`px-2 py-0.5 rounded border text-[10px] font-mono uppercase ${styles}`}>
      {level} confidence
    </span>
  );
});

const CitationChip = memo(function CitationChip({
  citation,
  onOpen,
}: {
  citation: SourceCitation;
  onOpen: (path: string, line?: number) => void;
}) {
  const lineLabel =
    citation.startLine !== undefined
      ? citation.endLine && citation.endLine !== citation.startLine
        ? `:${citation.startLine}-${citation.endLine}`
        : `:${citation.startLine}`
      : '';
  return (
    <button
      type="button"
      onClick={() => onOpen(citation.filePath, citation.startLine)}
      title={citation.snippet || `${citation.filePath}${lineLabel}`}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#0F121C] border border-[#2A324B] hover:border-[#8B5CF6]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] font-mono text-[11px] text-[#ADC6FF] hover:text-[#F8FAFC] transition-colors max-w-full"
    >
      <FileCode2 className="w-3 h-3 text-[#3B82F6] shrink-0" />
      <span className="truncate">
        {citation.filePath}
        {lineLabel}
      </span>
    </button>
  );
});

const SectionCard = memo(function SectionCard({
  id,
  letter,
  title,
  subtitle,
  icon,
  badge,
  expanded,
  onToggle,
  children,
}: {
  id: SectionId;
  letter: string;
  title: string;
  subtitle?: string;
  icon: ReactNode;
  badge?: ReactNode;
  expanded: boolean;
  onToggle: (id: SectionId) => void;
  children: ReactNode;
}) {
  return (
    <section
      id={`overview-section-${id}`}
      className="ok-glass-card-interactive border rounded-xl overflow-hidden min-w-0"
    >
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={expanded}
        className="w-full px-4 sm:px-5 py-3.5 flex flex-wrap items-center justify-between gap-2 text-left hover:bg-[#1E2438]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#8B5CF6] transition-colors duration-150"
      >
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <span className="px-1.5 py-0.5 rounded bg-[#0F121C] border border-[#2A324B] font-mono text-[11px] text-[#8B5CF6] shrink-0">
            {letter}
          </span>
          <span className="shrink-0">{icon}</span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[#F8FAFC] truncate">{title}</h2>
            {subtitle && (
              <p className="text-[11px] text-[#94A3B8] truncate">{subtitle}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {badge}
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-[#94A3B8]" />
          ) : (
            <ChevronRight className="w-4 h-4 text-[#94A3B8]" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-4 sm:px-5 pb-5 pt-2 border-t border-[rgba(59,72,111,0.22)] space-y-4">
          {children}
        </div>
      )}
    </section>
  );
});

export const OverviewTab = memo(function OverviewTab({
  repo,
  isReanalyzing,
  isAnalyzingOverview,
  overviewProgress,
  overviewError,
  onAnalyzeOverview,
  onReanalyze,
  onForceRefresh,
  onOpenFileAtLine,
  onOpenArchitecture,
}: OverviewTabProps) {
  const { metadata, detectedFacts, aiAnalysis, architecture } = repo;
  const overview: ComprehensiveOverview | null | undefined =
    overviewProgress?.overview ?? repo.comprehensiveOverview;

  const [expandedSections, setExpandedSections] = useState<Record<SectionId, boolean>>({
    identity: true,
    tech: true,
    structure: true,
    architecture: true,
    features: true,
    flows: false,
    database: false,
    devguide: false,
    improvements: false,
  });
  const [showBatchDetails, setShowBatchDetails] = useState(false);

  useEffect(() => {
    setExpandedSections({
      identity: true,
      tech: true,
      structure: true,
      architecture: true,
      features: true,
      flows: false,
      database: false,
      devguide: false,
      improvements: false,
    });
    setShowBatchDetails(false);
  }, [repo.id]);

  const toggleSection = useCallback((id: SectionId) => {
    setExpandedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const setAllSections = useCallback((open: boolean) => {
    setExpandedSections({
      identity: open,
      tech: open,
      structure: open,
      architecture: open,
      features: open,
      flows: open,
      database: open,
      devguide: open,
      improvements: open,
    });
  }, []);

  const eligibleCount =
    detectedFacts.eligibleFileCount ?? detectedFacts.ingestedFileCount;
  const failedCount = detectedFacts.failedFileCount ?? 0;
  const skippedCount = detectedFacts.skippedFileCount ?? 0;
  const skippedBreakdown = detectedFacts.skippedBreakdown ?? [];
  const failedFiles = detectedFacts.failedFiles ?? [];
  const embeddingsCount = getResolvedEmbeddingsCount(repo);
  const allEmbeddingsReady = areAllEmbeddingsGenerated(repo);
  const indexingStatus = deriveRecordIndexingStatus(repo);

  const sizeCapLabel =
    detectedFacts.limitsApplied.maxTotalBytes >= 1024 * 1024
      ? `${(detectedFacts.limitsApplied.maxTotalBytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
      : `${Math.round(detectedFacts.limitsApplied.maxTotalBytes / 1024)} KB`;

  const statusColorClass =
    indexingStatus === 'complete'
      ? 'text-[#10B981] bg-[#10B981]/10 border-[#10B981]/30'
      : indexingStatus === 'failed'
        ? 'text-[#EF4444] bg-[#EF4444]/10 border-[#EF4444]/30'
        : indexingStatus === 'indexing'
          ? 'text-[#06B6D4] bg-[#06B6D4]/10 border-[#06B6D4]/30'
          : 'text-[#F59E0B] bg-[#F59E0B]/10 border-[#F59E0B]/30';

  const statusLabel =
    indexingStatus === 'complete'
      ? 'Indexing Complete'
      : indexingStatus === 'failed'
        ? 'Indexing Failed'
        : indexingStatus === 'indexing'
          ? 'Indexing in Progress'
          : 'Partial Indexing';

  const hasComprehensive = Boolean(overview);
  const hasFailedOrPartialBatches =
    Boolean(overview) &&
    (overview!.status === 'partial' ||
      overview!.status === 'failed' ||
      overview!.coverage.failedBatches > 0);

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden p-4 sm:p-6 space-y-5">
      {/* Repository Identity Header */}
      <div className="ok-glass-card border rounded-xl p-4 sm:p-5">
        <div className="flex flex-col @[760px]:flex-row @[760px]:items-start @[760px]:justify-between gap-4">
          <div className="space-y-1.5 min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5 min-w-0">
              <h1 className="text-lg sm:text-xl font-semibold tracking-tight text-[#F8FAFC] break-all sm:break-normal sm:truncate">
                {metadata.fullName}
              </h1>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-mono shrink-0 ${statusColorClass}`}
              >
                {statusLabel}
              </span>
              {overview && (
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-mono shrink-0 ${
                    overview.status === 'complete'
                      ? 'text-[#06B6D4] bg-[#06B6D4]/10 border-[#06B6D4]/30'
                      : overview.status === 'analyzing'
                        ? 'text-[#D0BCFF] bg-[#8B5CF6]/15 border-[#8B5CF6]/40'
                        : 'text-[#F59E0B] bg-[#F59E0B]/10 border-[#F59E0B]/30'
                  }`}
                >
                  {overview.coverage.analyzedFiles}/{overview.coverage.totalEligibleFiles} files analyzed
                </span>
              )}
              <a
                href={metadata.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-mono text-[#60A5FA] hover:text-[#93C5FD] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded transition-colors shrink-0"
              >
                <span>GitHub</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <p className="text-sm text-[#CBD5E1] leading-relaxed max-w-3xl">
              {overview?.projectIdentity.shortDescription ||
                metadata.description ||
                'No repository description provided on GitHub.'}
            </p>
            <div className="pt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs font-mono text-[#94A3B8]">
              <span className="inline-flex items-center gap-1">
                <Star className="w-3.5 h-3.5 text-[#F59E0B]" />
                {metadata.stars.toLocaleString()} stars
              </span>
              <span className="inline-flex items-center gap-1">
                <GitFork className="w-3.5 h-3.5 text-[#3B82F6]" />
                {metadata.forks.toLocaleString()} forks
              </span>
              {metadata.license && <span>License: {metadata.license}</span>}
              <span>Commit: {metadata.commitSha.slice(0, 7)}</span>
              <span>Size: {metadata.sizeKb.toLocaleString()} KB</span>
              <span>Cap: {detectedFacts.limitsApplied.maxFiles} files</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onForceRefresh}
              disabled={isReanalyzing || isAnalyzingOverview}
              className="px-3 py-1.5 rounded-lg bg-[#151926]/85 border border-[#2A324B] hover:border-[#8B5CF6]/45 hover:bg-[#1E2438] text-xs font-medium text-[#CBD5E1] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors duration-150 inline-flex items-center gap-1.5 disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isReanalyzing ? 'animate-spin' : ''}`} />
              <span>Re-sync GitHub</span>
            </button>
            <button
              type="button"
              onClick={() =>
                onAnalyzeOverview({
                  mode: hasFailedOrPartialBatches ? 'resume' : 'full',
                })
              }
              disabled={isReanalyzing || isAnalyzingOverview}
              className="ok-btn-primary px-3 py-1.5 rounded-lg text-xs font-medium text-[#F8FAFC] inline-flex items-center gap-1.5 disabled:opacity-50 whitespace-nowrap"
            >
              <Sparkles className={`w-3.5 h-3.5 ${isAnalyzingOverview ? 'animate-pulse' : ''}`} />
              <span>
                {isAnalyzingOverview
                  ? 'Analyzing Repo...'
                  : hasFailedOrPartialBatches
                    ? 'Resume / Retry Batches'
                    : hasComprehensive
                      ? 'Re-analyze Overview'
                      : 'Run Full Repo Intelligence'}
              </span>
            </button>
            <button
              type="button"
              onClick={onReanalyze}
              disabled={isReanalyzing || isAnalyzingOverview}
              title="Re-run both repository intelligence and vector embeddings"
              className="px-3 py-1.5 rounded-lg bg-[#151926]/85 border border-[#2A324B] hover:border-[#3B82F6]/50 hover:bg-[#1E2438] text-xs font-medium text-[#94A3B8] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3B82F6] transition-colors duration-150 inline-flex items-center gap-1.5 disabled:opacity-50 whitespace-nowrap"
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>Rebuild Vectors</span>
            </button>
          </div>
        </div>

        {/* Ingestion & Coverage Stats Strip */}
        <div className="mt-5 pt-4 border-t border-[rgba(59,72,111,0.25)] grid grid-cols-1 @[420px]:grid-cols-2 @[760px]:grid-cols-4 gap-4">
          <div>
            <div className="text-[11px] font-mono text-[#94A3B8]">Eligible Files Indexed</div>
            <div className="text-base font-semibold font-mono text-[#F8FAFC] mt-0.5">
              {detectedFacts.ingestedFileCount}{' '}
              <span className="text-xs font-normal text-[#94A3B8]">
                / {eligibleCount} eligible
              </span>
            </div>
            <div className="text-[11px] font-mono text-[#8B9BB2] mt-0.5">
              {detectedFacts.totalTreeFiles} tree · {skippedCount} skipped · {failedCount} failed
            </div>
          </div>
          <div>
            <div className="text-[11px] font-mono text-[#94A3B8]">Lines Indexed</div>
            <div className="text-base font-semibold font-mono text-[#F8FAFC] mt-0.5">
              {detectedFacts.totalLinesOfCode.toLocaleString()}
            </div>
            <div className="text-[11px] font-mono text-[#8B9BB2] mt-0.5">
              {(detectedFacts.totalBytesIngested / 1024).toFixed(0)} KB source text
            </div>
          </div>
          <div>
            <div className="text-[11px] font-mono text-[#94A3B8]">RAG Embeddings</div>
            <div className="text-base font-semibold font-mono text-[#F8FAFC] mt-0.5 flex flex-wrap items-baseline gap-2">
              <span>
                {embeddingsCount}{' '}
                <span className="text-xs font-normal text-[#94A3B8]">
                  / {repo.chunkCount} chunks
                </span>
              </span>
              <span
                className={`text-[11px] font-normal ${
                  allEmbeddingsReady ? 'text-[#10B981]' : 'text-[#F59E0B]'
                }`}
              >
                {allEmbeddingsReady ? '100% Embedded' : 'Incomplete'}
              </span>
            </div>
            {repo.embeddingModel && (
              <div className="text-[11px] font-mono text-[#8B9BB2] mt-0.5 truncate">
                {repo.embeddingModel}
              </div>
            )}
          </div>
          <div>
            <div className="text-[11px] font-mono text-[#94A3B8]">Dependency Edges</div>
            <button
              type="button"
              onClick={onOpenArchitecture}
              className="text-base font-semibold font-mono text-[#60A5FA] hover:text-[#93C5FD] mt-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded transition-colors text-left"
            >
              {architecture.internalEdgeCount} internal · {architecture.externalEdgeCount} ext
            </button>
            <div className="text-[11px] font-mono text-[#8B9BB2] mt-0.5">
              {architecture.parsedFilesCount} files parsed
            </div>
          </div>
        </div>
      </div>

      {/* Live Staged Analysis Progress & Batch Recovery Panel */}
      {(isAnalyzingOverview || !overview || hasFailedOrPartialBatches || overviewError || showBatchDetails) && (
        <div
          role={isAnalyzingOverview ? 'status' : undefined}
          aria-live={isAnalyzingOverview ? 'polite' : undefined}
          className={`ok-glass-card border rounded-xl p-4 space-y-3 ${
            overviewError || hasFailedOrPartialBatches
              ? '!border-[#F59E0B]/40'
              : ''
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-0.5 min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#F8FAFC]">
                <Layers className="w-4 h-4 text-[#8B5CF6] shrink-0" />
                <span>
                  {isAnalyzingOverview
                    ? 'Staged Repository-Wide Analysis Running'
                    : !overview
                      ? 'Comprehensive Repository Intelligence Not Yet Generated'
                      : hasFailedOrPartialBatches
                        ? 'Partial Staged Analysis — Recoverable'
                        : 'Staged Repository Coverage'}
                </span>
              </div>
              <p className="text-xs text-[#94A3B8]">
                {isAnalyzingOverview && overviewProgress
                  ? overviewProgress.message
                  : !overview
                    ? `Analyze all ${detectedFacts.ingestedFileCount} eligible files in batches to generate sections A–I with file/line citations and persisted checkpoints.`
                    : `${overview.coverage.completedBatches}/${overview.coverage.totalBatches} batches complete · ${overview.coverage.analyzedFiles}/${overview.coverage.totalEligibleFiles} files covered${
                        overview.coverage.failedBatches > 0
                          ? ` · ${overview.coverage.failedBatches} batch(es) failed`
                          : ''
                      }`}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {overview && overview.batches.length > 0 && (
                <button
                  type="button"
                  aria-expanded={showBatchDetails}
                  onClick={() => setShowBatchDetails((v) => !v)}
                  className="px-2.5 py-1 rounded-md bg-[#0F121C] border border-[#2A324B] text-[11px] font-mono text-[#CBD5E1] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                >
                  {showBatchDetails ? 'Hide Batches' : `Inspect ${overview.batches.length} Batches`}
                </button>
              )}
              {!isAnalyzingOverview && (!overview || hasFailedOrPartialBatches) && (
                <button
                  type="button"
                  onClick={() =>
                    onAnalyzeOverview({
                      mode: overview ? 'resume' : 'full',
                    })
                  }
                  className="px-3 py-1.5 rounded-md bg-[#8B5CF6]/20 border border-[#8B5CF6]/50 hover:bg-[#8B5CF6]/30 text-xs font-medium text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] inline-flex items-center gap-1.5"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>{overview ? 'Resume Pending / Failed Batches' : 'Analyze All Eligible Files'}</span>
                </button>
              )}
            </div>
          </div>

          {isAnalyzingOverview && overviewProgress && (
            <div className="space-y-1.5">
              <div className="h-1.5 w-full bg-[#0F121C] rounded-full overflow-hidden">
                <div
                  className="h-full transition-all duration-300"
                  style={{
                    width: `${Math.max(overviewProgress.progress, 5)}%`,
                    background: 'linear-gradient(90deg, #8B5CF6 0%, #3B82F6 50%, #06B6D4 100%)',
                  }}
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-[#94A3B8]">
                <span>
                  Batches: {overviewProgress.completedBatches}/{overviewProgress.totalBatches} complete
                  {overviewProgress.failedBatches > 0 ? ` (${overviewProgress.failedBatches} failed)` : ''}
                </span>
                <span>
                  Files: {overviewProgress.analyzedFiles}/{overviewProgress.totalEligibleFiles}
                </span>
              </div>
            </div>
          )}

          {overviewError && (
            <div
              role="alert"
              className="p-2.5 rounded-lg bg-[#93000a]/25 border border-[#EF4444]/40 flex items-start gap-2 text-xs text-[#ffb4ab]"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{overviewError}</span>
            </div>
          )}

          {showBatchDetails && overview && overview.batches.length > 0 && (
            <div className="grid grid-cols-1 @[600px]:grid-cols-2 gap-2 max-h-60 overflow-y-auto pt-1">
              {overview.batches.map((b) => (
                <div
                  key={b.batchId}
                  className="px-3 py-2 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.3)] flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-[11px] text-[#F8FAFC] truncate">{b.label}</div>
                    <div className="text-[10px] font-mono text-[#8B9BB2]">
                      {b.filePaths.length} files · {b.totalLines.toLocaleString()} lines
                      {b.errorMessage ? ` · ${b.errorMessage}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span
                      className={`px-1.5 py-0.5 rounded font-mono text-[10px] uppercase ${
                        b.status === 'complete'
                          ? 'bg-[#10B981]/15 text-[#10B981]'
                          : b.status === 'failed'
                            ? 'bg-[#EF4444]/15 text-[#FCA5A5]'
                            : b.status === 'running'
                              ? 'bg-[#8B5CF6]/20 text-[#D0BCFF]'
                              : 'bg-[#1E2438] text-[#94A3B8]'
                      }`}
                    >
                      {b.status}
                    </span>
                    {b.status === 'failed' && !isAnalyzingOverview && (
                      <button
                        type="button"
                        onClick={() =>
                          onAnalyzeOverview({ mode: 'resume', retryBatchIds: [b.batchId] })
                        }
                        className="px-1.5 py-0.5 rounded bg-[#1E2438] border border-[#2A324B] hover:border-[#8B5CF6]/50 text-[10px] font-mono text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                      >
                        Retry
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Explicit Ingestion Details, Skipped/Failed Reasons & Warnings */}
      {(detectedFacts.limitsApplied.truncatedByFileCap ||
        detectedFacts.limitsApplied.truncatedBySizeCap ||
        failedCount > 0 ||
        skippedBreakdown.length > 0 ||
        !allEmbeddingsReady) && (
        <div
          className={`ok-glass-card border rounded-xl p-4 space-y-3 ${
            failedCount > 0 || !allEmbeddingsReady
              ? '!border-[#F59E0B]/35'
              : ''
          }`}
        >
          {(detectedFacts.limitsApplied.truncatedByFileCap ||
            detectedFacts.limitsApplied.truncatedBySizeCap ||
            failedCount > 0 ||
            !allEmbeddingsReady) && (
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-[#F59E0B] shrink-0 mt-0.5" />
              <div className="text-xs text-[#CBD5E1] space-y-1">
                {detectedFacts.limitsApplied.truncatedByFileCap && (
                  <p>
                    Eligible repository files exceeded the {detectedFacts.limitsApplied.maxFiles}-file cap.
                  </p>
                )}
                {detectedFacts.limitsApplied.truncatedBySizeCap && (
                  <p>
                    Ingestion stopped at the {sizeCapLabel} source text cap to keep analysis responsive.
                  </p>
                )}
                {failedCount > 0 && (
                  <p className="text-[#F59E0B]">
                    {failedCount} eligible file(s) failed to download or decode after retries.
                  </p>
                )}
                {!allEmbeddingsReady && (
                  <p className="text-[#F59E0B]">
                    Vector embeddings incomplete ({embeddingsCount}/{repo.chunkCount}):{' '}
                    {repo.embeddingError || 'Embeddings were not generated for all chunks.'}
                  </p>
                )}
              </div>
            </div>
          )}

          {skippedBreakdown.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-mono uppercase tracking-wider text-[#94A3B8]">
                Skipped Files Breakdown ({skippedCount} total)
              </div>
              <div className="flex flex-wrap gap-2">
                {skippedBreakdown.map((item) => (
                  <span
                    key={item.reason}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#0F121C] border border-[rgba(59,72,111,0.25)] text-[11px] font-mono text-[#CBD5E1]"
                  >
                    <span>{item.reason}</span>
                    <span className="text-[#94A3B8]">{item.count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {failedFiles.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-mono uppercase tracking-wider text-[#EF4444]">
                Failed Files ({failedFiles.length})
              </div>
              <div className="max-h-32 overflow-y-auto space-y-1 bg-[#0F121C] border border-[#EF4444]/25 rounded-lg p-2.5">
                {failedFiles.map((f) => (
                  <div
                    key={f.path}
                    className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-[11px] font-mono"
                  >
                    <span className="text-[#F8FAFC] truncate">{f.path}</span>
                    <span className="text-[#fca5a5] shrink-0">{f.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Comprehensive Sections A–I (when available) */}
      {overview ? (
        <div className="space-y-4">
          {/* Quick Scannable Section Controls */}
          <div className="flex flex-wrap items-center justify-between gap-2 ok-glass-card border rounded-xl px-3.5 py-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  ['identity', 'A. Identity'],
                  ['tech', 'B. Tech Stack'],
                  ['structure', 'C. Structure'],
                  ['architecture', 'D. Architecture'],
                  ['features', 'E. Features'],
                  ['flows', 'F. Data & Execution'],
                  ['database', 'G. Database'],
                  ['devguide', 'H. Dev Guide'],
                  ['improvements', 'I. Improvements'],
                ] as Array<[SectionId, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setExpandedSections((prev) => ({ ...prev, [id]: true }));
                    const prefersReducedMotion =
                      typeof window !== 'undefined' &&
                      typeof window.matchMedia === 'function' &&
                      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                    window.requestAnimationFrame(() => {
                      document
                        .getElementById(`overview-section-${id}`)
                        ?.scrollIntoView({
                          behavior: prefersReducedMotion ? 'auto' : 'smooth',
                          block: 'start',
                        });
                    });
                  }}
                  className={`px-2 py-1 rounded text-[11px] font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors ${
                    expandedSections[id]
                      ? 'bg-[#1E2438] text-[#F8FAFC] border border-[#8B5CF6]/40'
                      : 'bg-[#0F121C] text-[#94A3B8] hover:text-[#F8FAFC] border border-[#2A324B]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setAllSections(true)}
                className="text-[11px] font-mono text-[#60A5FA] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded"
              >
                Expand all
              </button>
              <span className="text-[#3B486F]" aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => setAllSections(false)}
                className="text-[11px] font-mono text-[#94A3B8] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded"
              >
                Collapse all
              </button>
              {overview.batches.length > 0 && (
                <>
                  <span className="text-[#3B486F]" aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={() => setShowBatchDetails((v) => !v)}
                    className="text-[11px] font-mono text-[#10B981] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded"
                  >
                    {overview.coverage.completedBatches}/{overview.coverage.totalBatches} batches
                  </button>
                </>
              )}
            </div>
          </div>

          {/* A. Project Identity */}
          <SectionCard
            id="identity"
            letter="A"
            title="Project Identity"
            subtitle="Purpose, problem solved, intended audience, and primary use cases"
            icon={<BookOpen className="w-4 h-4 text-[#8B5CF6]" />}
            badge={<ConfidenceBadge level={overview.projectIdentity.confidence} />}
            expanded={expandedSections.identity}
            onToggle={toggleSection}
          >
            <div className="grid grid-cols-1 @[760px]:grid-cols-2 gap-4">
              <div className="p-3.5 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-2">
                <div className="text-[11px] font-mono uppercase tracking-wider text-[#94A3B8]">
                  Main Purpose
                </div>
                <p className="text-xs text-[#E2E2EB] leading-relaxed whitespace-pre-line">
                  {overview.projectIdentity.mainPurpose}
                </p>
              </div>
              <div className="p-3.5 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-2">
                <div className="text-[11px] font-mono uppercase tracking-wider text-[#94A3B8]">
                  Problem Solved
                </div>
                <p className="text-xs text-[#E2E2EB] leading-relaxed whitespace-pre-line">
                  {overview.projectIdentity.problemSolved}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 @[760px]:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-[#94A3B8]">Intended Users</div>
                {overview.projectIdentity.intendedUsers.length === 0 ? (
                  <p className="text-xs text-[#8B9BB2]">Not explicitly stated in repository files.</p>
                ) : (
                  <ul className="space-y-1 text-xs text-[#CBD5E1]">
                    {overview.projectIdentity.intendedUsers.map((u, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-[#8B5CF6] font-mono">-</span>
                        <span>{u}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-[#94A3B8]">Primary Use Cases</div>
                {overview.projectIdentity.primaryUseCases.length === 0 ? (
                  <p className="text-xs text-[#8B9BB2]">Not explicitly specified.</p>
                ) : (
                  <ul className="space-y-1 text-xs text-[#CBD5E1]">
                    {overview.projectIdentity.primaryUseCases.map((uc, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-[#06B6D4] font-mono">-</span>
                        <span>{uc}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {overview.projectIdentity.evidence.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-[11px] font-mono text-[#8B9BB2] mr-1">Evidence:</span>
                {overview.projectIdentity.evidence.map((cit, i) => (
                  <CitationChip key={i} citation={cit} onOpen={onOpenFileAtLine} />
                ))}
              </div>
            )}
          </SectionCard>

          {/* B. Technology Stack */}
          <SectionCard
            id="tech"
            letter="B"
            title="Technology Stack"
            subtitle="Grouped by role, distinguishing manifest declarations from source-verified usage"
            icon={<Wrench className="w-4 h-4 text-[#3B82F6]" />}
            badge={
              <span className="text-[11px] font-mono text-[#94A3B8]">
                {overview.technologyStack.length} detected
              </span>
            }
            expanded={expandedSections.tech}
            onToggle={toggleSection}
          >
            {/* Language breakdown bar preserved */}
            {detectedFacts.languages.length > 0 && (
              <div className="space-y-2 p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)]">
                <div className="flex items-center justify-between text-[11px] font-mono text-[#94A3B8]">
                  <span>Source Language Breakdown</span>
                  <span>{detectedFacts.totalLinesOfCode.toLocaleString()} total lines</span>
                </div>
                <div className="h-2 w-full rounded-full overflow-hidden bg-[#151926] flex">
                  {detectedFacts.languages.map((lang) => (
                    <div
                      key={lang.language}
                      style={{
                        width: `${Math.max(lang.percentage, 1)}%`,
                        backgroundColor: LANG_COLORS[lang.language] || '#64748B',
                      }}
                      title={`${lang.language}: ${lang.percentage}% (${lang.files} files)`}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-[#CBD5E1]">
                  {detectedFacts.languages.slice(0, 8).map((lang) => (
                    <span key={lang.language} className="inline-flex items-center gap-1.5">
                      <span
                        className="w-2 h-2 rounded-sm shrink-0"
                        style={{ backgroundColor: LANG_COLORS[lang.language] || '#64748B' }}
                      />
                      <span>{lang.language}</span>
                      <span className="text-[#94A3B8]">{lang.percentage}%</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 @[760px]:grid-cols-2 gap-3">
              {TECH_GROUP_ORDER.map((groupName) => {
                const items = overview.technologyStack.filter((t) => t.group === groupName);
                if (items.length === 0) return null;
                return (
                  <div
                    key={groupName}
                    className="p-3.5 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-2.5"
                  >
                    <div className="text-xs font-semibold text-[#F8FAFC] flex items-center justify-between">
                      <span>{groupName}</span>
                      <span className="text-[11px] font-mono text-[#8B9BB2]">
                        {items.length}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {items.map((item) => (
                        <div
                          key={`${item.group}-${item.name}`}
                          className="p-2 rounded bg-[#151926] border border-[rgba(59,72,111,0.2)] space-y-1.5"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-xs font-medium text-[#F8FAFC] truncate">
                                {item.name}
                              </span>
                              {item.versionOrDetail && (
                                <span className="font-mono text-[10px] text-[#94A3B8]">
                                  {item.versionOrDetail}
                                </span>
                              )}
                            </div>
                            <span
                              className={`px-1.5 py-0.5 rounded font-mono text-[10px] shrink-0 ${
                                item.verification === 'verified-in-source'
                                  ? 'bg-[#10B981]/15 text-[#10B981]'
                                  : item.verification === 'manifest-only'
                                    ? 'bg-[#F59E0B]/15 text-[#F59E0B]'
                                    : 'bg-[#06B6D4]/15 text-[#06B6D4]'
                              }`}
                            >
                              {item.verification === 'verified-in-source'
                                ? 'Verified in Source'
                                : item.verification === 'manifest-only'
                                  ? 'Manifest Only'
                                  : 'Source Only'}
                            </span>
                          </div>
                          {(item.manifestFile || item.sourceEvidence.length > 0) && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              {item.manifestFile && (
                                <CitationChip
                                  citation={{ filePath: item.manifestFile }}
                                  onOpen={onOpenFileAtLine}
                                />
                              )}
                              {item.sourceEvidence.slice(0, 2).map((cit, idx) => (
                                <CitationChip
                                  key={idx}
                                  citation={cit}
                                  onOpen={onOpenFileAtLine}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </SectionCard>

          {/* C. Project Structure */}
          <SectionCard
            id="structure"
            letter="C"
            title="Project Structure"
            subtitle="Folder guide, important modules, and verified application entry points"
            icon={<FolderTree className="w-4 h-4 text-[#10B981]" />}
            badge={
              <span className="text-[11px] font-mono text-[#94A3B8]">
                {overview.projectStructure.folderGuide.length} folder groups
              </span>
            }
            expanded={expandedSections.structure}
            onToggle={toggleSection}
          >
            <p className="text-xs text-[#CBD5E1] leading-relaxed">
              {overview.projectStructure.summary}
            </p>

            {/* Entry points */}
            {overview.projectStructure.entryPoints.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-[#94A3B8]">
                  Application Entry Points
                </div>
                <div className="grid grid-cols-1 @[760px]:grid-cols-2 gap-2">
                  {overview.projectStructure.entryPoints.map((ep) => (
                    <div
                      key={ep.path}
                      className="p-2.5 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => onOpenFileAtLine(ep.path, ep.line)}
                          className="font-mono text-xs text-[#ADC6FF] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded truncate text-left"
                        >
                          {ep.path}
                        </button>
                        <span className="font-mono text-[10px] text-[#8B9BB2] shrink-0">
                          {ep.reason}
                        </span>
                      </div>
                      <p className="text-[11px] text-[#94A3B8]">{ep.role}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Folder Guide */}
            <div className="space-y-2">
              <div className="text-xs font-medium text-[#94A3B8]">Folder Guide</div>
              <div className="grid grid-cols-1 @[820px]:grid-cols-2 gap-3">
                {overview.projectStructure.folderGuide.map((fg) => (
                  <div
                    key={fg.folder}
                    className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold text-[#F8FAFC] truncate">
                        {fg.folder === 'root' ? '/ (root)' : `${fg.folder}/`}
                      </span>
                      <span className="font-mono text-[11px] text-[#8B9BB2] shrink-0">
                        {fg.fileCount} files
                      </span>
                    </div>
                    <p className="text-xs text-[#CBD5E1] leading-relaxed">{fg.purpose}</p>
                    {fg.importantFiles.length > 0 && (
                      <div className="space-y-1 pt-1 border-t border-[rgba(59,72,111,0.2)]">
                        {fg.importantFiles.map((imp) => (
                          <div key={imp.path} className="text-[11px] space-y-0.5">
                            <button
                              type="button"
                              onClick={() => onOpenFileAtLine(imp.path, 1)}
                              className="font-mono text-[#60A5FA] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded text-left break-all"
                            >
                              {imp.path}
                            </button>
                            <div className="text-[#94A3B8]">{imp.role}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </SectionCard>

          {/* D. Application Architecture */}
          <SectionCard
            id="architecture"
            letter="D"
            title="Application Architecture"
            subtitle={overview.applicationArchitecture.architecturalPattern}
            icon={<Server className="w-4 h-4 text-[#06B6D4]" />}
            badge={<ConfidenceBadge level={overview.applicationArchitecture.confidence} />}
            expanded={expandedSections.architecture}
            onToggle={toggleSection}
          >
            <p className="text-xs text-[#CBD5E1] leading-relaxed whitespace-pre-line">
              {overview.applicationArchitecture.summary}
            </p>

            {/* Observed Layers */}
            {overview.applicationArchitecture.layersObserved.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-[#94A3B8]">Observed Architectural Layers</div>
                <div className="grid grid-cols-1 @[760px]:grid-cols-2 gap-3">
                  {overview.applicationArchitecture.layersObserved.map((layer) => (
                    <div
                      key={layer.name}
                      className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-2"
                    >
                      <div className="text-xs font-semibold text-[#F8FAFC]">{layer.name}</div>
                      <p className="text-xs text-[#CBD5E1] leading-relaxed">{layer.description}</p>
                      {layer.files.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {layer.files.slice(0, 6).map((fp) => (
                            <CitationChip
                              key={fp}
                              citation={{ filePath: fp }}
                              onOpen={onOpenFileAtLine}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Module Responsibilities */}
            {overview.applicationArchitecture.moduleResponsibilities.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-[#94A3B8]">
                  Major Modules &amp; Responsibilities
                </div>
                <div className="grid grid-cols-1 @[860px]:grid-cols-2 gap-3">
                  {overview.applicationArchitecture.moduleResponsibilities.map((mod, idx) => (
                    <div
                      key={`${mod.name}-${idx}`}
                      className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-2"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-xs font-semibold text-[#F8FAFC]">{mod.name}</span>
                        <span className="font-mono text-[11px] text-[#3B82F6] break-all">
                          {mod.directoryOrFile}
                        </span>
                      </div>
                      <p className="text-xs text-[#CBD5E1] leading-relaxed">{mod.responsibility}</p>
                      {mod.dependsOn.length > 0 && (
                        <div className="text-[11px] font-mono text-[#94A3B8]">
                          Depends on: {mod.dependsOn.join(', ')}
                        </div>
                      )}
                      {mod.keyFiles.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {mod.keyFiles.map((kf) => (
                            <CitationChip
                              key={kf}
                              citation={{ filePath: kf }}
                              onOpen={onOpenFileAtLine}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Internal Dependencies & Storage & External Integrations */}
            <div className="grid grid-cols-1 @[760px]:grid-cols-2 gap-3">
              <div className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-[#F8FAFC]">Internal Dependencies</span>
                  <button
                    type="button"
                    onClick={onOpenArchitecture}
                    className="text-[11px] font-mono text-[#60A5FA] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded"
                  >
                    Open Graph →
                  </button>
                </div>
                <p className="text-xs text-[#CBD5E1] leading-relaxed">
                  {overview.applicationArchitecture.internalDependenciesSummary}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-1.5">
                <div className="text-xs font-medium text-[#F8FAFC]">Data Storage Approach</div>
                <p className="text-xs text-[#CBD5E1] leading-relaxed">
                  {overview.applicationArchitecture.storageApproach}
                </p>
              </div>
            </div>

            {overview.applicationArchitecture.externalIntegrations.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-[#94A3B8]">External Integrations</div>
                <div className="space-y-2">
                  {overview.applicationArchitecture.externalIntegrations.map((ext, idx) => (
                    <div
                      key={`${ext.name}-${idx}`}
                      className="p-2.5 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-1.5"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-xs font-semibold text-[#F8FAFC]">{ext.name}</span>
                        <div className="flex flex-wrap gap-1.5">
                          {ext.evidence.map((cit, i) => (
                            <CitationChip key={i} citation={cit} onOpen={onOpenFileAtLine} />
                          ))}
                        </div>
                      </div>
                      <p className="text-xs text-[#CBD5E1]">{ext.purpose}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </SectionCard>

          {/* E. Core Features */}
          <SectionCard
            id="features"
            letter="E"
            title="Core Features"
            subtitle="Source-backed capabilities, endpoints/functions, and verification citations"
            icon={<Sparkles className="w-4 h-4 text-[#8B5CF6]" />}
            badge={
              <span className="text-[11px] font-mono text-[#94A3B8]">
                {overview.coreFeatures.length} features
              </span>
            }
            expanded={expandedSections.features}
            onToggle={toggleSection}
          >
            {overview.coreFeatures.length === 0 ? (
              <p className="text-xs text-[#8B9BB2]">
                Insufficient evidence to summarize distinct features.
              </p>
            ) : (
              <div className="grid grid-cols-1 @[820px]:grid-cols-2 gap-3">
                {overview.coreFeatures.map((feat, idx) => (
                  <div
                    key={`${feat.name}-${idx}`}
                    className="p-3.5 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold text-[#F8FAFC]">{feat.name}</h3>
                      <ConfidenceBadge level={feat.confidence} />
                    </div>
                    <p className="text-xs text-[#CBD5E1] leading-relaxed">{feat.description}</p>
                    {feat.keyFunctionsOrEndpoints.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {feat.keyFunctionsOrEndpoints.map((fn) => (
                          <span
                            key={fn}
                            className="px-1.5 py-0.5 rounded bg-[#151926] border border-[#2A324B] font-mono text-[10px] text-[#06B6D4]"
                          >
                            {fn}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5 pt-1 border-t border-[rgba(59,72,111,0.2)]">
                      {feat.evidence.length > 0
                        ? feat.evidence.map((cit, i) => (
                            <CitationChip key={i} citation={cit} onOpen={onOpenFileAtLine} />
                          ))
                        : feat.relevantFiles.map((rf) => (
                            <CitationChip
                              key={rf}
                              citation={{ filePath: rf }}
                              onOpen={onOpenFileAtLine}
                            />
                          ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          {/* F. Data Flow and Execution Flow */}
          <SectionCard
            id="flows"
            letter="F"
            title="Data Flow & Execution Flow"
            subtitle="Sequenced workflows traced across components, handlers, APIs, and storage"
            icon={<GitBranch className="w-4 h-4 text-[#06B6D4]" />}
            badge={
              <span className="text-[11px] font-mono text-[#94A3B8]">
                {overview.executionFlows.length} workflows
              </span>
            }
            expanded={expandedSections.flows}
            onToggle={toggleSection}
          >
            {overview.executionFlows.length === 0 ? (
              <p className="text-xs text-[#8B9BB2]">
                No multi-step runtime workflows were conclusively verified in the indexed files.
              </p>
            ) : (
              <div className="space-y-4">
                {overview.executionFlows.map((flow, idx) => (
                  <div
                    key={`${flow.title}-${idx}`}
                    className="p-3.5 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-3"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-xs font-semibold text-[#F8FAFC]">{flow.title}</h3>
                        <span className="font-mono text-[10px] text-[#06B6D4]">
                          Trigger: {flow.trigger}
                        </span>
                      </div>
                      <p className="text-xs text-[#CBD5E1]">{flow.summary}</p>
                    </div>

                    <div className="space-y-2">
                      {flow.steps.map((step) => (
                        <div
                          key={`${step.stepNumber}-${step.filePath}`}
                          className="p-2.5 rounded bg-[#151926] border border-[rgba(59,72,111,0.2)] flex flex-col @[640px]:flex-row @[640px]:items-center @[640px]:justify-between gap-2"
                        >
                          <div className="flex items-start gap-2.5 min-w-0">
                            <span className="w-5 h-5 rounded bg-[#1E2438] border border-[#2A324B] font-mono text-[11px] text-[#8B5CF6] flex items-center justify-center shrink-0 mt-0.5">
                              {step.stepNumber}
                            </span>
                            <div className="min-w-0">
                              <div className="text-[10px] font-mono uppercase text-[#94A3B8]">
                                {step.layer}
                              </div>
                              <div className="text-xs text-[#E2E2EB]">{step.action}</div>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                            <span
                              className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${
                                step.evidenceBasis === 'verified-call' ||
                                step.evidenceBasis === 'route-handler'
                                  ? 'bg-[#10B981]/15 text-[#10B981]'
                                  : step.evidenceBasis === 'import-only'
                                    ? 'bg-[#3B82F6]/15 text-[#ADC6FF]'
                                    : 'bg-[#F59E0B]/15 text-[#F59E0B]'
                              }`}
                            >
                              {step.evidenceBasis}
                            </span>
                            <CitationChip
                              citation={{
                                filePath: step.filePath,
                                startLine: step.startLine,
                                endLine: step.endLine,
                              }}
                              onOpen={onOpenFileAtLine}
                            />
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="text-[11px] text-[#94A3B8] italic">
                      Verification note: {flow.verificationNote}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          {/* G. Database and Data Models */}
          <SectionCard
            id="database"
            letter="G"
            title="Database & Data Models"
            subtitle={
              overview.databaseAndModels.hasDatabase
                ? overview.databaseAndModels.technologies.join(', ') || 'Database detected'
                : 'No dedicated backend database detected'
            }
            icon={<Database className="w-4 h-4 text-[#F59E0B]" />}
            badge={
              <span
                className={`px-2 py-0.5 rounded border text-[10px] font-mono ${
                  overview.databaseAndModels.hasDatabase
                    ? 'text-[#10B981] bg-[#10B981]/10 border-[#10B981]/30'
                    : 'text-[#94A3B8] bg-[#0F121C] border-[#2A324B]'
                }`}
              >
                {overview.databaseAndModels.hasDatabase ? 'Database Detected' : 'No DB Detected'}
              </span>
            }
            expanded={expandedSections.database}
            onToggle={toggleSection}
          >
            <p className="text-xs text-[#CBD5E1] leading-relaxed">
              {overview.databaseAndModels.summary}
            </p>

            {overview.databaseAndModels.collectionsOrTables.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-[#94A3B8]">Collections / Stores / Tables</div>
                <div className="grid grid-cols-1 @[760px]:grid-cols-2 gap-2.5">
                  {overview.databaseAndModels.collectionsOrTables.map((col) => (
                    <div
                      key={col.name}
                      className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-1.5"
                    >
                      <div className="font-mono text-xs font-semibold text-[#F8FAFC]">{col.name}</div>
                      <p className="text-xs text-[#CBD5E1]">{col.purpose}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {col.evidence.map((cit, i) => (
                          <CitationChip key={i} citation={cit} onOpen={onOpenFileAtLine} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {overview.databaseAndModels.schemasAndModels.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-[#94A3B8]">Schemas &amp; Data Models</div>
                <div className="space-y-2">
                  {overview.databaseAndModels.schemasAndModels.map((sc) => (
                    <div
                      key={sc.name}
                      className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-1.5"
                    >
                      <div className="font-mono text-xs font-semibold text-[#ADC6FF]">{sc.name}</div>
                      <p className="text-xs text-[#CBD5E1]">{sc.fieldsSummary}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {sc.evidence.map((cit, i) => (
                          <CitationChip key={i} citation={cit} onOpen={onOpenFileAtLine} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-1">
              <div className="text-[11px] font-mono text-[#94A3B8]">Persistence &amp; Caching</div>
              <p className="text-xs text-[#CBD5E1] leading-relaxed">
                {overview.databaseAndModels.persistenceAndCaching}
              </p>
            </div>
          </SectionCard>

          {/* H. Developer Guide */}
          <SectionCard
            id="devguide"
            letter="H"
            title="Developer Guide"
            subtitle="Setup, scripts, environment variable names, and contributor entry points"
            icon={<Terminal className="w-4 h-4 text-[#10B981]" />}
            expanded={expandedSections.devguide}
            onToggle={toggleSection}
          >
            <div className="grid grid-cols-1 @[760px]:grid-cols-3 gap-3">
              <div className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-1.5">
                <div className="text-[11px] font-mono text-[#94A3B8]">Install</div>
                {overview.developerGuide.installCommands.map((cmd, i) => (
                  <pre key={i} className="font-mono text-xs text-[#E2E2EB] whitespace-pre-wrap break-all">
                    {cmd}
                  </pre>
                ))}
              </div>
              <div className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-1.5">
                <div className="text-[11px] font-mono text-[#94A3B8]">Run</div>
                {overview.developerGuide.runCommands.length === 0 ? (
                  <span className="text-xs text-[#8B9BB2]">None declared</span>
                ) : (
                  overview.developerGuide.runCommands.map((cmd, i) => (
                    <pre key={i} className="font-mono text-xs text-[#10B981] whitespace-pre-wrap break-all">
                      {cmd}
                    </pre>
                  ))
                )}
              </div>
              <div className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-1.5">
                <div className="text-[11px] font-mono text-[#94A3B8]">Build &amp; Checks</div>
                {overview.developerGuide.buildCommands.length === 0 ? (
                  <span className="text-xs text-[#8B9BB2]">None declared</span>
                ) : (
                  overview.developerGuide.buildCommands.map((cmd, i) => (
                    <pre key={i} className="font-mono text-xs text-[#60A5FA] whitespace-pre-wrap break-all">
                      {cmd}
                    </pre>
                  ))
                )}
              </div>
            </div>

            {overview.developerGuide.importantScripts.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-[#94A3B8]">Manifest Scripts</div>
                <div className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-1.5 font-mono text-xs">
                  {overview.developerGuide.importantScripts.map((s) => (
                    <div key={`${s.sourceFile}-${s.name}`} className="flex flex-wrap items-baseline gap-2">
                      <span className="text-[#8B5CF6] shrink-0">{s.name}:</span>
                      <span className="text-[#CBD5E1] break-all flex-1 min-w-0">{s.command}</span>
                      <span className="text-[10px] text-[#8B9BB2] shrink-0">({s.sourceFile})</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-[#94A3B8]">
                Environment Variables Referenced (Names Only — No Values Exposed)
              </div>
              {overview.developerGuide.environmentVariables.length === 0 ? (
                <p className="text-xs text-[#8B9BB2]">
                  No environment variable references detected in indexed source files.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {overview.developerGuide.environmentVariables.map((env) => (
                    <div
                      key={env.name}
                      className="p-2.5 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-1.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-xs font-semibold text-[#F8FAFC]">
                          {env.name}
                        </span>
                        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#151926] border border-[#2A324B] text-[#94A3B8]">
                          {env.required}
                        </span>
                      </div>
                      <p className="text-xs text-[#CBD5E1]">{env.purpose}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {env.references.map((cit, idx) => (
                          <CitationChip key={idx} citation={cit} onOpen={onOpenFileAtLine} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {overview.developerGuide.contributorEntryPoints.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-[#94A3B8]">
                  Key Files for New Contributors
                </div>
                <div className="grid grid-cols-1 @[760px]:grid-cols-2 gap-2">
                  {overview.developerGuide.contributorEntryPoints.map((cep) => (
                    <div
                      key={cep.path}
                      className="p-2.5 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] flex items-start justify-between gap-2"
                    >
                      <button
                        type="button"
                        onClick={() => onOpenFileAtLine(cep.path, 1)}
                        className="font-mono text-xs text-[#ADC6FF] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded text-left truncate"
                      >
                        {cep.path}
                      </button>
                      <span className="text-[11px] text-[#94A3B8] text-right">{cep.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </SectionCard>

          {/* I. Improvement Opportunities */}
          <SectionCard
            id="improvements"
            letter="I"
            title="Improvement Opportunities"
            subtitle="Strictly separated into file-verified observations vs architectural suggestions"
            icon={<ShieldAlert className="w-4 h-4 text-[#F59E0B]" />}
            badge={
              <span className="text-[11px] font-mono text-[#94A3B8]">
                {overview.improvementOpportunities.verifiedIssues.length} verified ·{' '}
                {overview.improvementOpportunities.suggestions.length} suggestions
              </span>
            }
            expanded={expandedSections.improvements}
            onToggle={toggleSection}
          >
            <div className="grid grid-cols-1 @[880px]:grid-cols-2 gap-4">
              {/* Verified Issues */}
              <div className="space-y-2.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#F8FAFC]">
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#F59E0B]" />
                  <span>Verified Issues (Source-Cited)</span>
                </div>
                {overview.improvementOpportunities.verifiedIssues.length === 0 ? (
                  <p className="text-xs text-[#8B9BB2]">
                    No verified code-level issues flagged in automated scans.
                  </p>
                ) : (
                  overview.improvementOpportunities.verifiedIssues.map((iss, i) => (
                    <div
                      key={`${iss.title}-${i}`}
                      className="p-3 rounded-lg bg-[#0F121C] border border-[#F59E0B]/25 space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-[#F8FAFC]">{iss.title}</span>
                        <div className="flex items-center gap-1.5 font-mono text-[10px]">
                          <span className="px-1.5 py-0.5 rounded bg-[#151926] text-[#94A3B8]">
                            {iss.category}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded uppercase ${
                              iss.severity === 'high'
                                ? 'bg-[#EF4444]/15 text-[#FCA5A5]'
                                : iss.severity === 'medium'
                                  ? 'bg-[#F59E0B]/15 text-[#F59E0B]'
                                  : 'bg-[#3B82F6]/15 text-[#ADC6FF]'
                            }`}
                          >
                            {iss.severity}
                          </span>
                        </div>
                      </div>
                      <p className="text-xs text-[#CBD5E1] leading-relaxed">{iss.description}</p>
                      {iss.evidence.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {iss.evidence.map((cit, j) => (
                            <CitationChip key={j} citation={cit} onOpen={onOpenFileAtLine} />
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* Suggestions / Hypotheses */}
              <div className="space-y-2.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#F8FAFC]">
                  <Lightbulb className="w-3.5 h-3.5 text-[#8B5CF6]" />
                  <span>Suggestions &amp; Hypotheses (Advisory)</span>
                </div>
                {overview.improvementOpportunities.suggestions.length === 0 ? (
                  <p className="text-xs text-[#8B9BB2]">No additional suggestions generated.</p>
                ) : (
                  overview.improvementOpportunities.suggestions.map((sug, i) => (
                    <div
                      key={`${sug.title}-${i}`}
                      className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-[#F8FAFC]">{sug.title}</span>
                        <span className="px-1.5 py-0.5 rounded bg-[#151926] font-mono text-[10px] text-[#D0BCFF]">
                          {sug.category} · suggestion
                        </span>
                      </div>
                      <p className="text-xs text-[#CBD5E1] leading-relaxed">{sug.rationale}</p>
                      {sug.relatedFiles.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {sug.relatedFiles.map((rf) => (
                            <CitationChip
                              key={rf}
                              citation={{ filePath: rf }}
                              onOpen={onOpenFileAtLine}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {overview.caveats.length > 0 && (
              <div className="pt-2 border-t border-[rgba(59,72,111,0.2)] space-y-1">
                <div className="text-[11px] font-mono text-[#94A3B8]">Coverage &amp; Analysis Caveats</div>
                {overview.caveats.map((cav, idx) => (
                  <p key={idx} className="text-xs text-[#94A3B8]">
                    · {cav}
                  </p>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      ) : (
        /* Fallback deterministic + legacy view when staged comprehensive analysis has not been run yet */
        <div className="grid grid-cols-1 @[920px]:grid-cols-2 gap-6 items-start">
          <section className="ok-glass-card border rounded-xl p-4 sm:p-5 space-y-5 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[rgba(59,72,111,0.25)]">
              <div className="flex items-center gap-2 min-w-0">
                <ShieldCheck className="w-4 h-4 text-[#10B981] shrink-0" />
                <h2 className="text-sm font-semibold text-[#F8FAFC]">
                  Detected Repository Facts
                </h2>
              </div>
              <span className="text-[11px] font-mono text-[#10B981]">
                Deterministic · File-Verified
              </span>
            </div>

            <div className="space-y-2.5">
              <h3 className="text-xs font-medium text-[#94A3B8]">
                Language Breakdown (Ingested Source)
              </h3>
              {detectedFacts.languages.length > 0 && (
                <div className="h-2 w-full rounded-full overflow-hidden bg-[#0F121C] flex">
                  {detectedFacts.languages.map((lang) => (
                    <div
                      key={lang.language}
                      style={{
                        width: `${Math.max(lang.percentage, 1)}%`,
                        backgroundColor: LANG_COLORS[lang.language] || '#64748B',
                      }}
                      title={`${lang.language}: ${lang.percentage}%`}
                    />
                  ))}
                </div>
              )}
              <div className="divide-y divide-[rgba(59,72,111,0.2)]">
                {detectedFacts.languages.slice(0, 7).map((lang) => (
                  <div
                    key={lang.language}
                    className="py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-sm shrink-0"
                        style={{
                          backgroundColor: LANG_COLORS[lang.language] || '#64748B',
                        }}
                      />
                      <span className="text-[#E2E2EB] truncate">{lang.language}</span>
                    </div>
                    <div className="font-mono text-[#94A3B8] flex items-center gap-3 shrink-0">
                      <span>{lang.files} files</span>
                      <span>{lang.lines.toLocaleString()} ln</span>
                      <span className="text-[#F8FAFC] w-12 text-right">{lang.percentage}%</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {detectedFacts.entryPoints.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-[#94A3B8]">Detected Entry Points</h3>
                <div className="space-y-1.5">
                  {detectedFacts.entryPoints.map((ep) => (
                    <div
                      key={ep.path}
                      className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 px-3 py-2 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.25)] text-xs min-w-0"
                    >
                      <button
                        type="button"
                        onClick={() => onOpenFileAtLine(ep.path, 1)}
                        className="font-mono text-[#ADC6FF] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded truncate text-left"
                      >
                        {ep.path}
                      </button>
                      <span className="text-[11px] text-[#8B9BB2] truncate">{ep.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="ok-glass-card border rounded-xl p-4 sm:p-5 space-y-4 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[rgba(59,72,111,0.25)]">
              <div className="flex items-center gap-2 min-w-0">
                <Cpu className="w-4 h-4 text-[#8B5CF6] shrink-0" />
                <h2 className="text-sm font-semibold text-[#F8FAFC]">
                  Initial Summary (Legacy Snapshot)
                </h2>
              </div>
              <span className="text-[11px] font-mono text-[#D0BCFF] truncate">
                {aiAnalysis.model}
              </span>
            </div>
            <p className="text-xs text-[#CBD5E1] leading-relaxed whitespace-pre-line">
              {aiAnalysis.summary}
            </p>
          </section>
        </div>
      )}
    </div>
  );
});

export default OverviewTab;
