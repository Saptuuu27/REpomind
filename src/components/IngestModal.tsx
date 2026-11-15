import { memo, useEffect, useId, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  FileText,
  GitBranch,
  Loader2,
  Network,
  Sparkles,
  X,
} from 'lucide-react';
import type { IngestProgressEvent, RepositorySummary } from '../types';
import {
  deriveLiveStatsIndexingStatus,
  deriveSummaryIndexingStatus,
  getResolvedEmbeddingsCount,
} from '../utils/indexingStatus';
import { useDialogA11y } from '../utils/useDialogA11y';

interface IngestPanelProps {
  isModal: boolean;
  isIngesting: boolean;
  progress: IngestProgressEvent | null;
  error: string | null;
  recentRepos: RepositorySummary[];
  maxIndexableFiles?: number;
  activeRepoSummary?: {
    id: string;
    fullName: string;
    defaultBranch: string;
    activeTabLabel: string;
  } | null;
  onResumeActive?: () => void;
  onClose?: () => void;
  onIngest: (url: string, forceRefresh: boolean) => void;
  onSelectExisting: (id: string) => void;
}

const PIPELINE_STEPS: Array<{
  id: string;
  label: string;
  stages: IngestProgressEvent['stage'][];
}> = [
  {
    id: 'metadata',
    label: 'Validate & Metadata',
    stages: ['validating', 'fetching-metadata'],
  },
  {
    id: 'files',
    label: 'Tree & Source Files',
    stages: ['fetching-tree', 'fetching-files'],
  },
  {
    id: 'static',
    label: 'Facts & Dependencies',
    stages: ['analyzing-facts', 'extracting-architecture'],
  },
  {
    id: 'ai',
    label: 'Gemini AI & Vectors',
    stages: ['ai-analysis', 'embedding', 'saving', 'complete'],
  },
];

function getStepIndex(stage: IngestProgressEvent['stage']): number {
  const idx = PIPELINE_STEPS.findIndex((s) => s.stages.includes(stage));
  return idx === -1 ? 0 : idx;
}

function isLikelyGitHubInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+(\.git)?$/.test(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    if (!['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase())) {
      return false;
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts.length >= 2;
  } catch {
    return false;
  }
}

export const IngestPanel = memo(function IngestPanel({
  isModal,
  isIngesting,
  progress,
  error,
  recentRepos,
  maxIndexableFiles = 300,
  activeRepoSummary,
  onResumeActive,
  onClose,
  onIngest,
  onSelectExisting,
}: IngestPanelProps) {
  const [urlInput, setUrlInput] = useState('');
  const [forceRefresh, setForceRefresh] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const errorId = useId();
  const titleId = useId();

  useDialogA11y(isModal, dialogRef, {
    initialFocusRef: urlInputRef,
    onEscape: !isIngesting && onClose ? onClose : undefined,
  });

  useEffect(() => {
    if (!isIngesting && !progress && !error) {
      setValidationError(null);
    }
  }, [isIngesting, progress, error, activeRepoSummary?.id]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed || isIngesting) return;
    if (!isLikelyGitHubInput(trimmed)) {
      setValidationError(
        'Enter a valid public GitHub repository URL (e.g. https://github.com/owner/repo) or owner/repo slug.'
      );
      return;
    }
    setValidationError(null);
    onIngest(trimmed, forceRefresh);
  };

  const activeStepIdx = progress ? getStepIndex(progress.stage) : 0;
  const displayedError = validationError || error;
  const stats = progress?.stats;
  const liveIndexingStatus = deriveLiveStatsIndexingStatus(
    stats,
    isIngesting,
    progress?.stage
  );

  // Honest deterministic progress metrics without misleading completion percentages
  const fileRatioText =
    stats && (stats.eligibleFiles ?? 0) > 0
      ? `${stats.indexedFiles ?? 0} / ${stats.eligibleFiles} files`
      : null;
  const embedRatioText =
    stats && (stats.chunksCreated ?? 0) > 0
      ? `${stats.embeddingsGenerated ?? 0} / ${stats.chunksCreated} vectors`
      : null;

  const chunksCreatedCount = stats?.chunksCreated ?? 0;
  const activeBarPercent =
    progress?.stage === 'fetching-files' && stats && (stats.eligibleFiles ?? 0) > 0
      ? Math.min(
          100,
          Math.round(
            (((stats.indexedFiles ?? 0) + (stats.failedFiles ?? 0)) /
              Math.max(Math.min(stats.eligibleFiles ?? 1, maxIndexableFiles), 1)) *
              100
          )
        )
      : progress?.stage === 'embedding' && chunksCreatedCount > 0
      ? Math.min(
          100,
          Math.round(((stats?.embeddingsGenerated ?? 0) / chunksCreatedCount) * 100)
        )
      : null;

  const content = (
    <div
      ref={isModal ? dialogRef : undefined}
      role={isModal ? 'dialog' : undefined}
      aria-modal={isModal ? true : undefined}
      aria-labelledby={isModal ? titleId : undefined}
      tabIndex={isModal ? -1 : undefined}
      onClick={(e) => e.stopPropagation()}
      className={`w-full max-w-2xl my-auto border rounded-xl p-4 sm:p-6 space-y-5 ${
        isModal ? 'ok-glass-modal ok-modal-enter' : 'ok-glass-card'
      }`}
    >
      {!isModal && activeRepoSummary && onResumeActive && (
        <div className="p-3 rounded-xl bg-[#0F121C]/90 border border-[#8B5CF6]/40 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-mono uppercase tracking-wider text-[#C4B5FD]">
              Loaded Workspace Preserved
            </div>
            <div className="text-xs font-mono text-[#F8FAFC] truncate mt-0.5">
              {activeRepoSummary.fullName}{' '}
              <span className="text-[#8B9BB2]">· {activeRepoSummary.defaultBranch}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onResumeActive}
            className="px-3 py-1.5 rounded-lg bg-[#8B5CF6]/20 border border-[#8B5CF6]/50 hover:bg-[#8B5CF6]/30 text-xs font-medium text-[#F8FAFC] inline-flex items-center gap-1.5 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors"
          >
            <span>Return to {activeRepoSummary.activeTabLabel}</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id={titleId} className="text-base sm:text-lg font-semibold tracking-tight text-[#F8FAFC]">
            Ingest Public GitHub Repository
          </h2>
          <p className="text-xs text-[#94A3B8] mt-1 leading-relaxed">
            Fetches live repository metadata, complete file tree, and up to {maxIndexableFiles}{' '}
            eligible source files via the GitHub REST API, then builds static dependency graphs and Gemini vector embeddings.
          </p>
        </div>
        {isModal && onClose && (
          <button
            type="button"
            disabled={isIngesting}
            onClick={onClose}
            aria-label="Close repository ingestion dialog"
            className="p-1.5 rounded-md text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438]/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] disabled:opacity-40 shrink-0 transition-colors duration-150"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-3" noValidate>
        <div className="flex flex-col sm:flex-row gap-2.5">
          <div className="relative flex-1 min-w-0">
            <GitBranch className="w-4 h-4 text-[#8B9BB2] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={urlInputRef}
              type="text"
              value={urlInput}
              disabled={isIngesting}
              aria-invalid={Boolean(displayedError)}
              aria-describedby={displayedError ? errorId : undefined}
              onChange={(e) => {
                setUrlInput(e.target.value);
                if (validationError) setValidationError(null);
              }}
              placeholder="https://github.com/owner/repository or owner/repo"
              aria-label="GitHub repository URL or owner/repo slug"
              className="w-full bg-[#0F121C]/85 border border-[rgba(88,108,160,0.3)] focus:border-[#8B5CF6] focus:shadow-[0_0_0_3px_rgba(139,92,246,0.16)] focus:outline-none rounded-lg pl-9 pr-3 py-2.5 text-sm font-mono text-[#F8FAFC] placeholder-[#8B9BB2] transition-all duration-150"
            />
          </div>
          <button
            type="submit"
            disabled={isIngesting || !urlInput.trim()}
            className="ok-btn-primary px-4 py-2.5 rounded-lg text-xs font-medium text-[#F8FAFC] inline-flex items-center justify-center gap-2 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {isIngesting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Indexing...</span>
              </>
            ) : (
              <>
                <span>Ingest &amp; Index</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>

        <label className="inline-flex items-center gap-2 text-xs text-[#94A3B8] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={forceRefresh}
            disabled={isIngesting}
            onChange={(e) => setForceRefresh(e.target.checked)}
            className="rounded border-[#2A324B] bg-[#0F121C] text-[#8B5CF6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
          />
          <span>Bypass 15-minute cache and re-fetch latest default branch from GitHub</span>
        </label>
      </form>

      {/* Live SSE Ingestion Pipeline & Accurate Telemetry */}
      {(isIngesting || (progress && progress.stage === 'complete')) && progress && (
        <div
          role="status"
          aria-live="polite"
          className="p-4 rounded-xl bg-[#0F121C] border border-[#8B5CF6]/40 space-y-3"
        >
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-mono text-[#06B6D4] flex items-center gap-2 min-w-0">
              {isIngesting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
              ) : liveIndexingStatus === 'partial' ? (
                <AlertTriangle className="w-3.5 h-3.5 text-[#F59E0B] shrink-0" />
              ) : liveIndexingStatus === 'failed' ? (
                <AlertCircle className="w-3.5 h-3.5 text-[#EF4444] shrink-0" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5 text-[#10B981] shrink-0" />
              )}
              <span className="truncate">{progress.message}</span>
            </span>
            <span className="font-mono text-[#CBD5E1] shrink-0 text-[11px]">
              {progress.stage === 'embedding' && embedRatioText
                ? embedRatioText
                : progress.stage === 'fetching-files' && fileRatioText
                ? fileRatioText
                : stats
                ? `Status: ${liveIndexingStatus}`
                : progress.stage}
            </span>
          </div>

          <div className="h-1.5 w-full bg-[#151926] rounded-full overflow-hidden">
            {activeBarPercent !== null ? (
              <div
                className="h-full transition-all duration-300"
                style={{
                  width: `${Math.max(activeBarPercent, 4)}%`,
                  background:
                    'linear-gradient(90deg, #8B5CF6 0%, #3B82F6 50%, #06B6D4 100%)',
                }}
              />
            ) : (
              <div
                className={`h-full transition-all duration-300 ${
                  isIngesting ? 'w-1/3 animate-pulse' : 'w-full'
                }`}
                style={{
                  background:
                    liveIndexingStatus === 'failed'
                      ? '#EF4444'
                      : liveIndexingStatus === 'partial'
                      ? '#F59E0B'
                      : 'linear-gradient(90deg, #8B5CF6 0%, #3B82F6 50%, #06B6D4 100%)',
                }}
              />
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-0.5">
            {PIPELINE_STEPS.map((step, idx) => {
              const isDone = idx < activeStepIdx || (!isIngesting && progress.stage === 'complete');
              const isCurrent = idx === activeStepIdx && isIngesting;
              return (
                <div
                  key={step.id}
                  className={`px-2.5 py-2 rounded-lg border text-[11px] font-mono flex items-center gap-1.5 min-w-0 ${
                    isDone
                      ? 'bg-[#10B981]/10 border-[#10B981]/35 text-[#10B981]'
                      : isCurrent
                      ? 'bg-[#8B5CF6]/15 border-[#8B5CF6]/45 text-[#F8FAFC]'
                      : 'bg-[#151926] border-[rgba(59,72,111,0.25)] text-[#8B9BB2]'
                  }`}
                >
                  {isDone ? (
                    <Check className="w-3 h-3 shrink-0" />
                  ) : isCurrent ? (
                    <Loader2 className="w-3 h-3 animate-spin shrink-0 text-[#8B5CF6]" />
                  ) : (
                    <span className="w-3 h-3 text-center shrink-0">{idx + 1}</span>
                  )}
                  <span className="truncate">{step.label}</span>
                </div>
              );
            })}
          </div>

          {stats && (
            <div className="pt-2 border-t border-[rgba(59,72,111,0.25)] space-y-2.5">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px] font-mono">
                <div className="px-2.5 py-1.5 rounded bg-[#151926] border border-[rgba(59,72,111,0.2)]">
                  <div className="text-[#8B9BB2]">Eligible Files</div>
                  <div className="text-[#F8FAFC] font-semibold mt-0.5">
                    {stats.eligibleFiles ?? 0}{' '}
                    <span className="text-[#8B9BB2] font-normal">
                      / {stats.totalTreeFiles ?? 0} total
                    </span>
                  </div>
                </div>
                <div className="px-2.5 py-1.5 rounded bg-[#151926] border border-[rgba(59,72,111,0.2)]">
                  <div className="text-[#8B9BB2]">Indexed / Skipped</div>
                  <div className="text-[#F8FAFC] font-semibold mt-0.5">
                    <span className="text-[#10B981]">{stats.indexedFiles ?? 0}</span>{' '}
                    <span className="text-[#8B9BB2] font-normal">
                      · {stats.skippedFiles ?? 0} skip
                    </span>
                  </div>
                </div>
                <div className="px-2.5 py-1.5 rounded bg-[#151926] border border-[rgba(59,72,111,0.2)]">
                  <div className="text-[#8B9BB2]">Failed Files</div>
                  <div
                    className={`font-semibold mt-0.5 ${
                      (stats.failedFiles ?? 0) > 0 ? 'text-[#EF4444]' : 'text-[#F8FAFC]'
                    }`}
                  >
                    {stats.failedFiles ?? 0}
                  </div>
                </div>
                <div className="px-2.5 py-1.5 rounded bg-[#151926] border border-[rgba(59,72,111,0.2)]">
                  <div className="text-[#8B9BB2]">Chunks Created</div>
                  <div className="text-[#F8FAFC] font-semibold mt-0.5">
                    {stats.chunksCreated ?? 0}
                  </div>
                </div>
                <div className="px-2.5 py-1.5 rounded bg-[#151926] border border-[rgba(59,72,111,0.2)]">
                  <div className="text-[#8B9BB2]">Embeddings</div>
                  <div className="text-[#F8FAFC] font-semibold mt-0.5">
                    {stats.embeddingsGenerated ?? 0} / {stats.chunksCreated ?? 0}
                  </div>
                </div>
                <div className="px-2.5 py-1.5 rounded bg-[#151926] border border-[rgba(59,72,111,0.2)]">
                  <div className="text-[#8B9BB2]">Indexing Status</div>
                  <div
                    className={`font-semibold mt-0.5 capitalize ${
                      liveIndexingStatus === 'complete'
                        ? 'text-[#10B981]'
                        : liveIndexingStatus === 'partial'
                        ? 'text-[#F59E0B]'
                        : liveIndexingStatus === 'failed'
                        ? 'text-[#EF4444]'
                        : 'text-[#06B6D4]'
                    }`}
                  >
                    {liveIndexingStatus}
                  </div>
                </div>
              </div>

              {stats.skippedBreakdown && stats.skippedBreakdown.length > 0 && (
                <div className="text-[11px] font-mono text-[#94A3B8] space-y-1">
                  <div className="text-[#8B9BB2]">Skipped reasons:</div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {stats.skippedBreakdown.map((item) => (
                      <span key={item.reason}>
                        {item.reason}: <span className="text-[#CBD5E1]">{item.count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {stats.failedFileDetails && stats.failedFileDetails.length > 0 && (
                <div className="text-[11px] font-mono text-[#ffb4ab] space-y-1">
                  <div>Failed files:</div>
                  <div className="max-h-20 overflow-y-auto space-y-0.5">
                    {stats.failedFileDetails.map((ff) => (
                      <div key={ff.path} className="truncate">
                        {ff.path} — {ff.reason}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {displayedError && (
        <div
          id={errorId}
          role="alert"
          className="p-3.5 rounded-xl bg-[#93000a]/25 border border-[#EF4444]/40 space-y-1.5 text-xs text-[#ffb4ab]"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-words">{displayedError}</span>
          </div>
          <div className="pl-6 text-[11px] text-[#FCA5A5]/90 leading-relaxed">
            Verify the repository is public and spelled accurately (e.g.{' '}
            <span className="font-mono">owner/repo</span>)
            {recentRepos.length > 0 ? ', or select a previously indexed repository below.' : '.'}
          </div>
        </div>
      )}

      {/* Previously Indexed Repositories */}
      {recentRepos.length > 0 && (
        <div className="pt-2 border-t border-[rgba(59,72,111,0.25)] space-y-2">
          <div className="text-xs font-medium text-[#94A3B8]">
            Previously Indexed in Store ({recentRepos.length})
          </div>
          <div className="max-h-40 overflow-y-auto space-y-1.5">
            {recentRepos.map((repo) => {
              const isCurrentActive = repo.id === activeRepoSummary?.id;
              const embeddingsCount = getResolvedEmbeddingsCount(repo);
              const status = deriveSummaryIndexingStatus(repo);
              const statusColor =
                status === 'failed'
                  ? 'text-[#EF4444]'
                  : status === 'partial'
                    ? 'text-[#F59E0B]'
                    : status === 'indexing'
                      ? 'text-[#06B6D4]'
                      : 'text-[#10B981]';
              return (
                <button
                  key={repo.id}
                  type="button"
                  disabled={isIngesting}
                  onClick={() => onSelectExisting(repo.id)}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg border text-left transition-colors min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] ${
                    isCurrentActive
                      ? 'bg-[#181D2D] border-[#8B5CF6]/55'
                      : 'bg-[#151926] border-[rgba(59,72,111,0.25)] hover:border-[#3B82F6]/50'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="font-mono text-xs text-[#F8FAFC] truncate">
                      {repo.fullName}
                    </div>
                    <div className="text-[11px] font-mono text-[#8B9BB2] truncate">
                      {repo.ingestedFileCount}
                      {repo.eligibleFileCount ? `/${repo.eligibleFileCount}` : ''} files ·{' '}
                      {embeddingsCount}/{repo.chunkCount} vectors ·{' '}
                      {repo.defaultBranch}
                    </div>
                  </div>
                  <div className={`flex items-center gap-1.5 text-[11px] font-mono shrink-0 ${statusColor}`}>
                    {status === 'failed' ? (
                      <AlertCircle className="w-3.5 h-3.5" />
                    ) : status === 'partial' ? (
                      <AlertTriangle className="w-3.5 h-3.5" />
                    ) : status === 'indexing' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {isCurrentActive
                        ? 'Active · Resume'
                        : status === 'partial'
                          ? 'Open · Partial'
                          : status === 'failed'
                            ? 'Open · Failed'
                            : status === 'indexing'
                              ? 'Open · Indexing'
                              : 'Open'}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!isModal && (
        <div className="pt-3 border-t border-[rgba(59,72,111,0.25)] grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.2)] space-y-1">
            <div className="flex items-center gap-1.5 text-[#F8FAFC] font-medium">
              <Sparkles className="w-3.5 h-3.5 text-[#8B5CF6]" />
              <span>Grounded RAG Q&amp;A</span>
            </div>
            <p className="text-[11px] text-[#94A3B8] leading-relaxed">
              Semantic vector search with line-level file citations.
            </p>
          </div>
          <div className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.2)] space-y-1">
            <div className="flex items-center gap-1.5 text-[#F8FAFC] font-medium">
              <Network className="w-3.5 h-3.5 text-[#3B82F6]" />
              <span>Real Import Graph</span>
            </div>
            <p className="text-[11px] text-[#94A3B8] leading-relaxed">
              Static dependency parsing with exact source line evidence.
            </p>
          </div>
          <div className="p-3 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.2)] space-y-1">
            <div className="flex items-center gap-1.5 text-[#F8FAFC] font-medium">
              <FileText className="w-3.5 h-3.5 text-[#10B981]" />
              <span>Markdown Docs Export</span>
            </div>
            <p className="text-[11px] text-[#94A3B8] leading-relaxed">
              Synthesized setup and module guides ready to download.
            </p>
          </div>
        </div>
      )}
    </div>
  );

  if (isModal) {
    return (
      <div
        onClick={() => {
          if (!isIngesting && onClose) onClose();
        }}
        className="fixed inset-0 z-50 bg-[#07090F]/75 backdrop-blur-sm ok-backdrop-enter overflow-y-auto flex flex-col items-center p-3 sm:p-4"
      >
        {content}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto flex flex-col items-center p-4 sm:p-6 bg-transparent">
      {content}
    </div>
  );
});

export default IngestPanel;
