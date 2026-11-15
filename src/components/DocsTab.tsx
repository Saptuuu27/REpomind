import { Suspense, lazy, memo, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Code2,
  Copy,
  Download,
  Eye,
  FileText,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import type { RepositoryRecord } from '../types';

const MarkdownContent = lazy(() => import('./MarkdownContent'));

interface DocsTabProps {
  repo: RepositoryRecord;
  isGenerating: boolean;
  error: string | null;
  onGenerate: () => void;
}

export const DocsTab = memo(function DocsTab({
  repo,
  isGenerating,
  error,
  onGenerate,
}: DocsTabProps) {
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview');
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  const docs = repo.docs;
  const hasFiles = repo.files.length > 0;
  const displayedError =
    error || (docs?.status === 'error' ? docs.errorMessage || 'Documentation generation failed.' : null);

  useEffect(() => {
    setViewMode('preview');
    setCopied(false);
  }, [repo.id]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    if (!docs?.markdown) return;
    try {
      await navigator.clipboard.writeText(docs.markdown);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable
    }
  };

  const handleDownload = () => {
    if (!docs?.markdown) return;
    const blob = new Blob([docs.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${repo.metadata.name}-documentation.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col bg-[#0F121C]/78 min-w-0">
      <div className="sr-only" role="status" aria-live="polite">
        {copied
          ? 'Documentation markdown copied to clipboard'
          : isGenerating
            ? 'Generating repository documentation'
            : ''}
      </div>

      {/* Toolbar */}
      <div className="px-3 sm:px-4 py-2.5 ok-glass-bar border-b flex flex-wrap items-center justify-between gap-3 shrink-0 min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-[#F8FAFC] shrink-0">
            <FileText className="w-4 h-4 text-[#8B5CF6]" />
            <span>Documentation Generator</span>
          </div>
          {docs && docs.status === 'complete' && (
            <span className="text-[11px] font-mono text-[#94A3B8] truncate">
              {docs.model} · {new Date(docs.generatedAt).toLocaleString()}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {docs && docs.status === 'complete' && (
            <>
              <div
                role="group"
                aria-label="Documentation view mode"
                className="flex items-center p-0.5 rounded-lg bg-[#0F121C] border border-[#2A324B]"
              >
                <button
                  type="button"
                  aria-pressed={viewMode === 'preview'}
                  onClick={() => setViewMode('preview')}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors whitespace-nowrap ${
                    viewMode === 'preview'
                      ? 'bg-[#1E2438] text-[#F8FAFC]'
                      : 'text-[#94A3B8] hover:text-[#F8FAFC]'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>Preview</span>
                </button>
                <button
                  type="button"
                  aria-pressed={viewMode === 'raw'}
                  onClick={() => setViewMode('raw')}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors whitespace-nowrap ${
                    viewMode === 'raw'
                      ? 'bg-[#1E2438] text-[#F8FAFC]'
                      : 'text-[#94A3B8] hover:text-[#F8FAFC]'
                  }`}
                >
                  <Code2 className="w-3.5 h-3.5" />
                  <span>Markdown</span>
                </button>
              </div>

              <button
                type="button"
                onClick={handleCopy}
                aria-label={copied ? 'Documentation copied' : 'Copy documentation markdown'}
                className="px-2.5 py-1.5 rounded-lg bg-[#181D2D] border border-[#2A324B] hover:border-[#8B5CF6]/40 text-xs text-[#CBD5E1] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#10B981]" />
                    <span className="text-[#10B981]">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleDownload}
                className="px-2.5 py-1.5 rounded-lg bg-[#181D2D] border border-[#2A324B] hover:border-[#3B82F6]/50 text-xs text-[#CBD5E1] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export .md</span>
              </button>
            </>
          )}

          <button
            type="button"
            onClick={onGenerate}
            disabled={isGenerating || !hasFiles}
            className="ok-btn-primary px-3 py-1.5 rounded-lg text-xs font-medium text-[#F8FAFC] inline-flex items-center gap-1.5 disabled:opacity-50 whitespace-nowrap"
          >
            {isGenerating ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Generating...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5" />
                <span>{docs?.status === 'complete' ? 'Regenerate Docs' : 'Generate Docs'}</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6">
        {displayedError && (
          <div
            role="alert"
            className="max-w-4xl mx-auto mb-4 p-4 rounded-xl bg-[#93000a]/25 border border-[#EF4444]/40 flex items-start gap-2.5 text-xs text-[#ffb4ab]"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{displayedError}</span>
          </div>
        )}

        {!docs || docs.status !== 'complete' ? (
          <div className="h-full flex flex-col items-center justify-center text-center max-w-lg mx-auto py-12">
            <div className="w-12 h-12 rounded-xl ok-glass-card border flex items-center justify-center mb-4">
              <FileText className="w-6 h-6 text-[#8B5CF6]" />
            </div>
            <h2 className="text-base font-semibold text-[#F8FAFC] mb-2">
              {docs?.status === 'error'
                ? 'Documentation Generation Failed'
                : 'Generate Grounded Repository Documentation'}
            </h2>
            <p className="text-sm text-[#94A3B8] leading-relaxed mb-6">
              {!hasFiles ? (
                <>
                  No eligible source files were indexed for{' '}
                  <span className="font-mono text-[#CBD5E1]">{repo.metadata.fullName}</span>.
                  Re-sync the repository from GitHub before generating documentation.
                </>
              ) : (
                <>
                  RepoMind synthesizes a structured technical guide for{' '}
                  <span className="font-mono text-[#CBD5E1]">{repo.metadata.fullName}</span>{' '}
                  directly from its manifests, entry points, detected modules, and setup files—exportable as Markdown.
                </>
              )}
            </p>
            <button
              type="button"
              onClick={onGenerate}
              disabled={isGenerating || !hasFiles}
              className="ok-btn-primary px-4 py-2 rounded-lg text-xs font-medium text-[#F8FAFC] inline-flex items-center gap-2 disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4" />
              <span>
                {isGenerating
                  ? 'Generating Documentation...'
                  : docs?.status === 'error'
                    ? 'Retry Documentation Generation'
                    : 'Generate Markdown Docs'}
              </span>
            </button>
          </div>
        ) : viewMode === 'preview' ? (
          <div className="max-w-4xl mx-auto ok-glass-card border rounded-xl p-4 sm:p-7 markdown-body overflow-x-hidden">
            <Suspense
              fallback={
                <div className="text-xs font-mono text-[#94A3B8]">
                  Rendering documentation preview...
                </div>
              }
            >
              <MarkdownContent>{docs.markdown}</MarkdownContent>
            </Suspense>
          </div>
        ) : (
          <div className="max-w-4xl mx-auto ok-glass-card border rounded-xl p-4 sm:p-5 overflow-x-auto">
            <pre className="font-mono text-xs leading-relaxed text-[#E2E2EB] whitespace-pre-wrap break-words">
              {docs.markdown}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
});

export default DocsTab;

