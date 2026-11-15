import { Suspense, lazy, memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AlertTriangle, Check, Copy, Eye, FileCode2 } from 'lucide-react';
import type { RepositoryRecord } from '../types';
import { resolveRepoFilePath } from '../utils/repoPaths';

const MarkdownContent = lazy(() => import('./MarkdownContent'));

interface CodeViewerTabProps {
  repo: RepositoryRecord;
  selectedFilePath: string | null;
  highlightRange: { startLine: number; endLine: number } | null;
  onSelectFile?: (path: string) => void;
}

interface CodeLinesViewProps {
  lines: string[];
  clampedRange: { startLine: number; endLine: number } | null;
  highlightedLineRef: RefObject<HTMLDivElement | null>;
}

const CodeLinesView = memo(function CodeLinesView({
  lines,
  clampedRange,
  highlightedLineRef,
}: CodeLinesViewProps) {
  return (
    <div
      role="region"
      aria-label="Source code lines"
      tabIndex={0}
      className="flex-1 min-w-0 overflow-auto py-3 font-mono text-[13px] leading-[1.45] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#8B5CF6]/70"
    >
      <div className="min-w-max">
        {lines.map((lineText, idx) => {
          const lineNum = idx + 1;
          const isHighlighted =
            clampedRange !== null &&
            lineNum >= clampedRange.startLine &&
            lineNum <= clampedRange.endLine;
          const isFirstHighlighted =
            clampedRange !== null && lineNum === clampedRange.startLine;

          return (
            <div
              key={lineNum}
              ref={isFirstHighlighted ? highlightedLineRef : undefined}
              className={`flex px-3 sm:px-4 ${
                isHighlighted
                  ? 'bg-[#8B5CF6]/15 text-[#F8FAFC]'
                  : 'hover:bg-[#181D2D]/60 text-[#CBD5E1]'
              }`}
            >
              <span
                aria-hidden="true"
                className={`w-10 sm:w-12 shrink-0 select-none text-right pr-3 sm:pr-4 font-mono text-xs leading-[1.45] ${
                  isHighlighted ? 'text-[#D0BCFF] font-semibold' : 'text-[#8B9BB2]'
                }`}
              >
                {lineNum}
              </span>
              <pre className="whitespace-pre font-mono text-[13px] leading-[1.45] m-0">
                {lineText.length > 0 ? lineText : ' '}
              </pre>
            </div>
          );
        })}
      </div>
    </div>
  );
});

export const CodeViewerTab = memo(function CodeViewerTab({
  repo,
  selectedFilePath,
  highlightRange,
  onSelectFile,
}: CodeViewerTabProps) {
  const [copied, setCopied] = useState(false);
  const [renderMarkdown, setRenderMarkdown] = useState(false);
  const highlightedLineRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const fallbackFile = useMemo(
    () => repo.files.find((f) => f.path === repo.readmePath) ?? repo.files[0] ?? null,
    [repo.files, repo.readmePath]
  );

  const resolution = useMemo(() => {
    if (!selectedFilePath) {
      return {
        file: fallbackFile,
        resolvedPath: fallbackFile?.path ?? null,
        status: fallbackFile ? ('found' as const) : ('missing' as const),
      };
    }
    return resolveRepoFilePath(repo, selectedFilePath);
  }, [repo, selectedFilePath, fallbackFile]);

  const file = resolution.file;

  const isMarkdown = Boolean(
    file && (file.extension === '.md' || file.extension === '.mdx')
  );

  const lines = useMemo(() => (file ? file.content.split('\n') : []), [file]);

  const clampedRange = useMemo(
    () =>
      highlightRange && lines.length > 0
        ? {
            startLine: Math.max(1, Math.min(highlightRange.startLine, lines.length)),
            endLine: Math.max(
              Math.max(1, Math.min(highlightRange.startLine, lines.length)),
              Math.min(highlightRange.endLine, lines.length)
            ),
          }
        : null,
    [highlightRange, lines.length]
  );

  useEffect(() => {
    setCopied(false);
    if (!isMarkdown) {
      setRenderMarkdown(false);
    }
  }, [file?.path, isMarkdown]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (highlightRange && highlightedLineRef.current) {
      const reducedMotion =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      highlightedLineRef.current.scrollIntoView({
        behavior: reducedMotion ? 'auto' : 'smooth',
        block: 'center',
      });
    }
  }, [highlightRange, file?.path]);

  if (selectedFilePath && !file) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 sm:p-8 text-center">
        <div className="max-w-md w-full ok-glass-card border rounded-xl p-5 space-y-3">
          <div className="w-10 h-10 rounded-lg bg-[#F59E0B]/15 border border-[#F59E0B]/35 flex items-center justify-center mx-auto">
            <AlertTriangle className="w-5 h-5 text-[#F59E0B]" />
          </div>
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-[#F8FAFC]">
              {resolution.status === 'failed'
                ? 'Source File Failed to Download'
                : resolution.status === 'skipped'
                  ? 'Source File Excluded from Index'
                  : 'File Not Found in Indexed Snapshot'}
            </h2>
            <p className="font-mono text-xs text-[#ADC6FF] break-all">
              {resolution.resolvedPath || selectedFilePath}
            </p>
            <p className="text-xs text-[#94A3B8] leading-relaxed pt-1">
              {resolution.skipReason ||
                'This path was not found among the indexed repository source files.'}
            </p>
          </div>
          {fallbackFile && onSelectFile && (
            <button
              type="button"
              onClick={() => onSelectFile(fallbackFile.path)}
              className="px-3 py-1.5 rounded-lg bg-[#151926] border border-[#2A324B] hover:border-[#8B5CF6]/50 text-xs font-mono text-[#E2E2EB] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors"
            >
              Open {fallbackFile.path}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 sm:p-8 text-center">
        <FileCode2 className="w-10 h-10 text-[#3B486F] mb-3" />
        <p className="text-sm text-[#94A3B8]">
          Select an indexed file from the left explorer to view its source code.
        </p>
      </div>
    );
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#0F121C]/88 min-w-0">
      <div className="sr-only" role="status" aria-live="polite">
        {copied ? `Copied ${file.path} to clipboard` : ''}
      </div>

      {/* File Header Toolbar */}
      <div className="px-3 sm:px-4 py-2.5 ok-glass-bar border-b flex flex-wrap items-center justify-between gap-2.5 shrink-0 min-w-0">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 min-w-0 flex-1">
          <span className="font-mono text-xs text-[#F8FAFC] truncate max-w-full">
            {file.path}
          </span>
          <span className="font-mono text-[11px] text-[#94A3B8] shrink-0">
            {file.language} · {file.lines} lines · {(file.size / 1024).toFixed(1)} KB
          </span>
          {clampedRange && (
            <span className="font-mono text-[11px] text-[#D0BCFF] bg-[#8B5CF6]/15 border border-[#8B5CF6]/35 px-2 py-0.5 rounded shrink-0">
              Lines {clampedRange.startLine}–{clampedRange.endLine}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isMarkdown && (
            <button
              type="button"
              aria-pressed={renderMarkdown}
              onClick={() => setRenderMarkdown((v) => !v)}
              className="px-2.5 py-1.5 rounded-md bg-[#181D2D] border border-[#2A324B] hover:border-[#8B5CF6]/40 text-xs text-[#CBD5E1] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>{renderMarkdown ? 'View Raw' : 'Preview Markdown'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? 'File contents copied' : `Copy ${file.path}`}
            className="px-2.5 py-1.5 rounded-md bg-[#181D2D] border border-[#2A324B] hover:border-[#8B5CF6]/40 text-xs text-[#CBD5E1] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
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
        </div>
      </div>

      {/* Content Viewport */}
      {renderMarkdown ? (
        <div className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6 bg-[#111319]">
          <div className="max-w-4xl mx-auto markdown-body">
            <Suspense
              fallback={
                <div className="text-xs font-mono text-[#94A3B8]">Rendering Markdown...</div>
              }
            >
              <MarkdownContent>{file.content}</MarkdownContent>
            </Suspense>
          </div>
        </div>
      ) : (
        <CodeLinesView
          lines={lines}
          clampedRange={clampedRange}
          highlightedLineRef={highlightedLineRef}
        />
      )}
    </div>
  );
});

export default CodeViewerTab;

