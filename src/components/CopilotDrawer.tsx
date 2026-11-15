import { Suspense, lazy, memo, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Send,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { ChatMessage, Citation, RepositoryRecord } from '../types';
import { resolveRepoFilePath } from '../utils/repoPaths';
import { useDialogA11y } from '../utils/useDialogA11y';

const MarkdownContent = lazy(() => import('./MarkdownContent'));

interface CopilotDrawerProps {
  repo: RepositoryRecord | null;
  messages: ChatMessage[];
  isSending: boolean;
  error: string | null;
  isOpen: boolean;
  isOverlay: boolean;
  onClose: () => void;
  onSendQuestion: (question: string) => void;
  onClearChat: () => void;
  onOpenCitation: (citation: Citation) => void;
}

const STARTER_PROMPTS = [
  'What is the main entry point and execution flow of this repository?',
  'How are modules organized and what are their responsibilities?',
  'What dependencies or configuration files are used for setup?',
  'Does this repository implement any database persistence or caching?',
];

interface ChatMessageItemProps {
  msg: ChatMessage;
  repo: RepositoryRecord;
  expandedSnippet: string | null;
  onToggleSnippet: (key: string) => void;
  onOpenCitation: (citation: Citation) => void;
  isOverlay: boolean;
  onClose: () => void;
}

const ChatMessageItem = memo(function ChatMessageItem({
  msg,
  repo,
  expandedSnippet,
  onToggleSnippet,
  onOpenCitation,
  isOverlay,
  onClose,
}: ChatMessageItemProps) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end min-w-0">
        <div className="max-w-[90%] rounded-xl px-3.5 py-2.5 bg-[#1E2438] border border-[#2A324B] text-xs text-[#F8FAFC] leading-relaxed whitespace-pre-wrap break-words">
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] font-mono text-[#D0BCFF]">
        <Sparkles className="w-3 h-3 text-[#8B5CF6] shrink-0" />
        <span>RepoMind</span>
        {msg.model && <span className="text-[#8B9BB2] truncate">· {msg.model}</span>}
      </div>

      {msg.insufficientEvidence && (
        <div className="px-3 py-2 rounded-lg bg-[#F59E0B]/10 border border-[#F59E0B]/35 flex items-center gap-2 text-[11px] text-[#F59E0B]">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>Insufficient repository evidence for a full answer</span>
        </div>
      )}

      <div className="markdown-body text-[13px] min-w-0">
        <Suspense
          fallback={<p className="text-xs text-[#CBD5E1] whitespace-pre-wrap">{msg.content}</p>}
        >
          <MarkdownContent>{msg.content}</MarkdownContent>
        </Suspense>
      </div>

      {msg.citations && msg.citations.length > 0 && (
        <div className="pt-1 space-y-1.5 min-w-0">
          <div className="text-[10px] font-mono text-[#8B9BB2]">
            Retrieved Source Citations ({msg.citations.length})
          </div>
          {msg.citations.map((cit, idx) => {
            const key = `${msg.id}-${idx}`;
            const isExpanded = expandedSnippet === key;
            const resolved = resolveRepoFilePath(repo, cit.filePath);
            const isIndexedFile = resolved.file !== null;
            return (
              <div
                key={key}
                className="rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.35)] overflow-hidden min-w-0"
              >
                <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 min-w-0">
                  <button
                    type="button"
                    onClick={() => onToggleSnippet(key)}
                    aria-expanded={isExpanded}
                    title={
                      isExpanded
                        ? 'Hide retrieved code snippet'
                        : 'Preview retrieved code snippet'
                    }
                    className="flex items-center gap-1.5 min-w-0 flex-1 text-left text-[11px] font-mono text-[#ADC6FF] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-3 h-3 shrink-0 text-[#8B9BB2]" />
                    ) : (
                      <ChevronRight className="w-3 h-3 shrink-0 text-[#8B9BB2]" />
                    )}
                    <span className="truncate">
                      {cit.filePath}:{cit.startLine}-{cit.endLine}
                    </span>
                  </button>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="font-mono text-[10px] text-[#06B6D4]">
                      {(cit.similarity * 100).toFixed(0)}%
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        onOpenCitation({
                          ...cit,
                          filePath: resolved.resolvedPath ?? cit.filePath,
                        });
                        if (isOverlay) onClose();
                      }}
                      title={
                        isIndexedFile
                          ? 'Open file and highlight cited lines in Code Explorer'
                          : `Inspect status for ${cit.filePath}`
                      }
                      aria-label={`Open ${cit.filePath} lines ${cit.startLine} to ${cit.endLine}`}
                      className="px-1.5 py-0.5 rounded text-[10px] font-mono text-[#CBD5E1] hover:text-[#F8FAFC] hover:bg-[#1E2438] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] inline-flex items-center gap-1 transition-colors"
                    >
                      <span>Open</span>
                      <ExternalLink className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <pre className="px-2.5 pb-2.5 pt-1 text-[11px] font-mono text-[#CBD5E1] overflow-x-auto border-t border-[rgba(59,72,111,0.2)]">
                    {cit.snippet}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

export const CopilotDrawer = memo(function CopilotDrawer({
  repo,
  messages,
  isSending,
  error,
  isOpen,
  isOverlay,
  onClose,
  onSendQuestion,
  onClearChat,
  onOpenCitation,
}: CopilotDrawerProps) {
  const [input, setInput] = useState('');
  const [expandedSnippet, setExpandedSnippet] = useState<string | null>(null);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useDialogA11y(isOverlay && isOpen, drawerRef, {
    initialFocusRef: closeButtonRef,
    onEscape: onClose,
  });

  useEffect(() => {
    setInput('');
    setExpandedSnippet(null);
  }, [repo?.id]);

  useEffect(() => {
    if (!isOpen) return;
    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    scrollEndRef.current?.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  }, [messages.length, isSending, isOpen]);

  const handleToggleSnippet = (key: string) => {
    setExpandedSnippet((prev) => (prev === key ? null : key));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || !repo || isSending) return;
    setInput('');
    onSendQuestion(trimmed);
  };

  const drawerClasses = isOverlay
    ? `fixed inset-y-0 right-0 z-50 w-[340px] sm:w-[368px] max-w-[92vw] ok-glass-panel border-l shadow-[0_24px_48px_-12px_rgba(0,0,0,0.75)] flex flex-col overflow-hidden transform transition-[transform,visibility] duration-200 ease-out ${
        isOpen ? 'translate-x-0 visible' : 'translate-x-full invisible pointer-events-none'
      }`
    : `shrink-0 h-full ok-glass-panel flex flex-col overflow-hidden transition-[width,opacity,visibility] duration-200 ease-out z-20 ${
        isOpen
          ? 'w-[312px] min-[1440px]:w-[368px] border-l opacity-100 visible'
          : 'w-0 border-l-0 opacity-0 invisible pointer-events-none'
      }`;

  return (
    <>
      {isOverlay && isOpen && (
        <div
          aria-hidden="true"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-[#0B0D13]/72 backdrop-blur-xs ok-backdrop-enter"
        />
      )}

      <aside
        ref={drawerRef}
        role={isOverlay ? 'dialog' : undefined}
        aria-modal={isOverlay && isOpen ? true : undefined}
        aria-label="RAG Codebase Assistant"
        aria-hidden={!isOpen ? true : undefined}
        tabIndex={-1}
        className={drawerClasses}
      >
        <div
          className={`h-full flex flex-col min-w-0 ${
            isOverlay ? 'w-full' : 'w-[312px] min-[1440px]:w-[368px]'
          }`}
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-[rgba(59,72,111,0.25)] flex items-center justify-between gap-2 shrink-0">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#8B5CF6] shrink-0" />
                <h2 className="text-xs font-semibold text-[#F8FAFC] truncate">
                  RAG Codebase Assistant
                </h2>
              </div>
              {repo && (
                <p className="text-[11px] font-mono text-[#94A3B8] mt-0.5 truncate">
                  {repo.chunkCount} chunks ·{' '}
                  <span
                    className={
                      repo.embeddingsReady ? 'text-[#10B981]' : 'text-[#F59E0B]'
                    }
                  >
                    {repo.embeddingsReady ? 'vectors ready' : 'vectors pending'}
                  </span>
                </p>
              )}
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {repo && messages.length > 0 && (
                <button
                  type="button"
                  onClick={onClearChat}
                  title="Clear conversation"
                  aria-label="Clear conversation"
                  className="p-1.5 rounded-md text-[#94A3B8] hover:text-[#EF4444] hover:bg-[#1E2438] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                ref={closeButtonRef}
                type="button"
                onClick={onClose}
                title="Close assistant"
                aria-label="Close assistant"
                className="p-1.5 rounded-md text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-4">
            {!repo ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-4">
                <Sparkles className="w-8 h-8 text-[#3B486F] mb-3" />
                <p className="text-xs text-[#94A3B8] leading-relaxed">
                  Ingest a public GitHub repository to ask grounded questions backed by vector search and source citations.
                </p>
              </div>
            ) : messages.length === 0 ? (
              <div className="space-y-4">
                <div className="p-3.5 rounded-xl ok-glass-card border text-xs text-[#CBD5E1] leading-relaxed">
                  Ask questions about{' '}
                  <span className="font-mono text-[#F8FAFC] break-all">
                    {repo.metadata.fullName}
                  </span>
                  . RepoMind embeds your query, retrieves matching code chunks, and cites exact file paths and line numbers.
                </div>

                <div className="space-y-2">
                  <div className="text-[11px] font-medium text-[#94A3B8]">
                    Grounded Starter Questions
                  </div>
                  {STARTER_PROMPTS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      disabled={isSending}
                      onClick={() => onSendQuestion(q)}
                      className="w-full text-left px-3 py-2.5 rounded-lg bg-[#0F121C]/80 border border-[rgba(88,108,160,0.26)] hover:border-[#8B5CF6]/55 hover:bg-[#1E2438]/70 text-xs text-[#CBD5E1] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors duration-150 disabled:opacity-50"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg) => (
                <ChatMessageItem
                  key={msg.id}
                  msg={msg}
                  repo={repo}
                  expandedSnippet={expandedSnippet}
                  onToggleSnippet={handleToggleSnippet}
                  onOpenCitation={onOpenCitation}
                  isOverlay={isOverlay}
                  onClose={onClose}
                />
              ))
            )}

            {isSending && (
              <div role="status" aria-live="polite" className="space-y-2">
                <div className="flex items-center gap-1.5 text-[11px] font-mono text-[#06B6D4]">
                  <Sparkles className="w-3 h-3 animate-pulse shrink-0" />
                  <span>Retrieving vectors &amp; synthesizing grounded answer...</span>
                </div>
                <div className="h-12 rounded-lg bg-[#181D2D]/70 border border-[rgba(139,92,246,0.25)] animate-pulse" />
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-[#93000a]/25 border border-[#EF4444]/40 flex items-start gap-2 text-xs text-[#ffb4ab]"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div ref={scrollEndRef} />
          </div>

          {/* Prompt Input */}
          <form
            onSubmit={handleSubmit}
            className="p-3 border-t border-[rgba(59,72,111,0.25)] bg-[#0F121C]/45 shrink-0"
          >
            <div className="relative flex items-end gap-2 bg-[#0F121C]/85 border border-[rgba(88,108,160,0.3)] focus-within:border-[#8B5CF6] focus-within:shadow-[0_0_0_3px_rgba(139,92,246,0.16)] rounded-xl p-2 transition-all duration-150">
              <textarea
                rows={2}
                value={input}
                disabled={!repo || isSending}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit(e);
                  }
                }}
                placeholder={
                  repo
                    ? 'Ask about functions, routes, or architecture...'
                    : 'Ingest a repository first...'
                }
                aria-label="Ask codebase question"
                className="flex-1 min-w-0 bg-transparent text-xs text-[#F8FAFC] placeholder-[#8B9BB2] resize-none focus:outline-none leading-relaxed px-1"
              />
              <button
                type="submit"
                disabled={!repo || isSending || !input.trim()}
                aria-label="Send question"
                className="ok-btn-primary p-2 rounded-lg text-[#F8FAFC] disabled:opacity-40 shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          </form>
        </div>
      </aside>
    </>
  );
});
