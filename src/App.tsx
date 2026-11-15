import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Code2,
  Command,
  FileText,
  GitBranch,
  LayoutDashboard,
  Network,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  X,
} from 'lucide-react';
import {
  analyzeOverviewStream,
  clearChatHistory,
  deleteRepository,
  fetchHealth,
  generateDocs,
  getChatHistory,
  getRepository,
  ingestRepositoryStream,
  listRepositories,
  reanalyzeRepository,
  sendChatQuestion,
} from './api';
import type { WorkspaceTab } from './components/CommandMenu';
import { CopilotDrawer } from './components/CopilotDrawer';
import { FileTreeSidebar } from './components/FileTreeSidebar';
import {
  deriveRecordIndexingStatus,
  getResolvedEmbeddingsCount,
} from './utils/indexingStatus';
import { resolveRepoFilePath } from './utils/repoPaths';
import type {
  ChatMessage,
  Citation,
  HealthStatus,
  IngestProgressEvent,
  OverviewProgressEvent,
  RepositoryRecord,
  RepositorySummary,
} from './types';

const ArchitectureTab = lazy(() => import('./components/ArchitectureTab'));
const CodeViewerTab = lazy(() => import('./components/CodeViewerTab'));
const CommandMenu = lazy(() => import('./components/CommandMenu'));
const DocsTab = lazy(() => import('./components/DocsTab'));
const IngestPanel = lazy(() => import('./components/IngestModal'));
const OverviewTab = lazy(() => import('./components/OverviewTab'));

const NAV_TABS: Array<{ id: WorkspaceTab; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'code', label: 'Code', icon: Code2 },
  { id: 'architecture', label: 'Architecture', icon: Network },
  { id: 'docs', label: 'Docs', icon: FileText },
];

function WorkspaceFallback({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="h-full flex items-center justify-center p-6 text-xs font-mono text-[#94A3B8]"
    >
      {label}
    </div>
  );
}

function useViewportBreakpoints() {
  const [width, setWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1440
  );

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return {
    isDesktopLeft: width >= 1024,
    isDesktopRight: width >= 1280,
  };
}

export default function App() {
  const { isDesktopLeft, isDesktopRight } = useViewportBreakpoints();

  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [activeRepo, setActiveRepo] = useState<RepositoryRecord | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('overview');
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [highlightRange, setHighlightRange] = useState<{
    startLine: number;
    endLine: number;
  } | null>(null);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const [isIngesting, setIsIngesting] = useState(false);
  const [ingestProgress, setIngestProgress] = useState<IngestProgressEvent | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [showIngestModal, setShowIngestModal] = useState(false);

  const [isReanalyzing, setIsReanalyzing] = useState(false);
  const [isAnalyzingOverview, setIsAnalyzingOverview] = useState(false);
  const [overviewProgress, setOverviewProgress] = useState<OverviewProgressEvent | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [isGeneratingDocs, setIsGeneratingDocs] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [workspaceFeedback, setWorkspaceFeedback] = useState<{
    type: 'error' | 'warning' | 'success';
    message: string;
  } | null>(null);

  // Desktop inline pane states vs mobile/tablet overlay drawer states
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [leftOverlayOpen, setLeftOverlayOpen] = useState(false);
  const [rightDesktopOpen, setRightDesktopOpen] = useState(true);
  const [rightOverlayOpen, setRightOverlayOpen] = useState(false);

  const shellRef = useRef<HTMLDivElement | null>(null);
  const activeRepoRef = useRef<RepositoryRecord | null>(null);
  const activeRepoRequestRef = useRef(0);
  const ingestAbortRef = useRef<AbortController | null>(null);
  const overviewAbortRef = useRef<AbortController | null>(null);

  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [showHomeView, setShowHomeView] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isLoadingRepo, setIsLoadingRepo] = useState(false);

  useEffect(() => {
    activeRepoRef.current = activeRepo;
  }, [activeRepo]);

  useEffect(() => {
    return () => {
      ingestAbortRef.current?.abort();
      overviewAbortRef.current?.abort();
    };
  }, []);

  // Zero-re-render cursor spotlight using CSS custom properties + requestAnimationFrame
  useEffect(() => {
    const rootEl = shellRef.current;
    if (!rootEl || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const coarseQuery = window.matchMedia('(hover: none), (pointer: coarse)');
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    let rafId = 0;
    let pointerX = 0;
    let pointerY = 0;
    let isListening = false;

    const flushPosition = () => {
      rafId = 0;
      rootEl.style.setProperty('--spotlight-x', `${pointerX}px`);
      rootEl.style.setProperty('--spotlight-y', `${pointerY}px`);
      rootEl.style.setProperty('--spotlight-opacity', '1');
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (!rafId) {
        rafId = window.requestAnimationFrame(flushPosition);
      }
    };

    const handlePointerLeave = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      rootEl.style.setProperty('--spotlight-opacity', '0');
    };

    const syncListeners = () => {
      const disabled = coarseQuery.matches || motionQuery.matches;
      if (disabled && isListening) {
        window.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('mouseleave', handlePointerLeave);
        window.removeEventListener('blur', handlePointerLeave);
        isListening = false;
        handlePointerLeave();
      } else if (!disabled && !isListening) {
        window.addEventListener('pointermove', handlePointerMove, { passive: true });
        document.addEventListener('mouseleave', handlePointerLeave);
        window.addEventListener('blur', handlePointerLeave);
        isListening = true;
      }
    };

    syncListeners();
    coarseQuery.addEventListener('change', syncListeners);
    motionQuery.addEventListener('change', syncListeners);

    return () => {
      coarseQuery.removeEventListener('change', syncListeners);
      motionQuery.removeEventListener('change', syncListeners);
      if (isListening) {
        window.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('mouseleave', handlePointerLeave);
        window.removeEventListener('blur', handlePointerLeave);
      }
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, []);

  const loadRepositoryById = useCallback(async (id: string) => {
    const reqSeq = ++activeRepoRequestRef.current;
    overviewAbortRef.current?.abort();
    overviewAbortRef.current = null;
    setIsLoadingRepo(true);
    setIsAnalyzingOverview(false);
    setIsSendingChat(false);
    setIsReanalyzing(false);
    setIsGeneratingDocs(false);
    setLeftOverlayOpen(false);
    setRightOverlayOpen(false);
    setShowIngestModal(false);
    setWorkspaceFeedback(null);
    setChatError(null);
    setDocsError(null);
    setOverviewProgress(null);
    setOverviewError(null);
    if (!ingestAbortRef.current) {
      setIngestProgress(null);
      setIngestError(null);
    }

    try {
      const [repo, messages] = await Promise.all([
        getRepository(id),
        getChatHistory(id),
      ]);
      if (reqSeq !== activeRepoRequestRef.current) return;
      activeRepoRef.current = repo;
      setActiveRepo(repo);
      setChatMessages(messages);
      setChatError(null);
      setDocsError(null);
      setOverviewProgress(null);
      setOverviewError(null);
      setHighlightRange(null);
      setSelectedFilePath(repo.readmePath ?? repo.files[0]?.path ?? null);
      setActiveTab('overview');
      setShowHomeView(false);
    } catch (err) {
      if (reqSeq !== activeRepoRequestRef.current) return;
      setWorkspaceFeedback({
        type: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to load repository details.',
      });
    } finally {
      if (reqSeq === activeRepoRequestRef.current) {
        setIsLoadingRepo(false);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const [healthRes, reposRes] = await Promise.allSettled([
          fetchHealth(),
          listRepositories(),
        ]);
        if (cancelled) return;

        if (healthRes.status === 'fulfilled') {
          setHealth(healthRes.value);
          if (healthRes.value.persistenceStatus === 'unavailable') {
            setWorkspaceFeedback({
              type: 'error',
              message: healthRes.value.mongodbError
                ? `Durable MongoDB persistence unavailable: ${healthRes.value.mongodbError}`
                : 'Durable MongoDB persistence is unavailable. Repository saves are disabled until connectivity recovers.',
            });
          }
        } else {
          setWorkspaceFeedback({
            type: 'error',
            message:
              healthRes.reason instanceof Error
                ? healthRes.reason.message
                : 'Unable to reach RepoMind backend service.',
          });
        }

        if (reposRes.status === 'fulfilled') {
          setRepositories(reposRes.value);
          if (reposRes.value.length > 0) {
            await loadRepositoryById(reposRes.value[0].id);
          }
        } else if (
          healthRes.status !== 'fulfilled' ||
          healthRes.value.persistenceStatus !== 'unavailable'
        ) {
          setWorkspaceFeedback({
            type: 'error',
            message:
              reposRes.reason instanceof Error
                ? reposRes.reason.message
                : 'Failed to load persisted repositories.',
          });
        }
      } finally {
        if (!cancelled) setIsBootstrapping(false);
      }
    }
    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [loadRepositoryById]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowCommandMenu((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        if (showCommandMenu) {
          setShowCommandMenu(false);
        } else if (showIngestModal) {
          if (!isIngesting) setShowIngestModal(false);
        } else if (leftOverlayOpen) {
          setLeftOverlayOpen(false);
        } else if (rightOverlayOpen) {
          setRightOverlayOpen(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showCommandMenu, showIngestModal, isIngesting, leftOverlayOpen, rightOverlayOpen]);

  // Close overlay drawers automatically when crossing into desktop breakpoints
  useEffect(() => {
    if (isDesktopLeft && leftOverlayOpen) {
      setLeftOverlayOpen(false);
    }
  }, [isDesktopLeft, leftOverlayOpen]);

  useEffect(() => {
    if (isDesktopRight && rightOverlayOpen) {
      setRightOverlayOpen(false);
    }
  }, [isDesktopRight, rightOverlayOpen]);

  const handleToggleLeftSidebar = useCallback(() => {
    if (isDesktopLeft) {
      setLeftCollapsed((v) => !v);
    } else {
      setRightOverlayOpen(false);
      setLeftOverlayOpen((v) => !v);
    }
  }, [isDesktopLeft]);

  const handleToggleRightAssistant = useCallback(() => {
    if (isDesktopRight) {
      setRightDesktopOpen((v) => !v);
    } else {
      setLeftOverlayOpen(false);
      setRightOverlayOpen((v) => !v);
    }
  }, [isDesktopRight]);

  const handleToggleLeftCollapse = useCallback(() => {
    setLeftCollapsed((v) => !v);
  }, []);

  const handleCloseLeftOverlay = useCallback(() => {
    setLeftOverlayOpen(false);
  }, []);

  const handleCloseRight = useCallback(() => {
    if (isDesktopRight) setRightDesktopOpen(false);
    else setRightOverlayOpen(false);
  }, [isDesktopRight]);

  const handleCloseCommandMenu = useCallback(() => {
    setShowCommandMenu(false);
  }, []);

  const handleCloseIngestModal = useCallback(() => {
    setShowIngestModal(false);
  }, []);

  const handleResumeActive = useCallback(() => {
    setShowHomeView(false);
  }, []);

  const openIngestModal = useCallback(() => {
    setIngestError(null);
    if (!isIngesting) {
      setIngestProgress(null);
    }
    setShowIngestModal(true);
  }, [isIngesting]);

  const handleIngest = useCallback(async (url: string, forceRefresh: boolean) => {
    ingestAbortRef.current?.abort();
    const controller = new AbortController();
    ingestAbortRef.current = controller;

    setIsIngesting(true);
    setIngestError(null);
    setWorkspaceFeedback(null);
    setIngestProgress({
      stage: 'validating',
      message: 'Starting ingestion pipeline...',
      progress: 4,
    });

    try {
      const repo = await ingestRepositoryStream(
        url,
        forceRefresh,
        (ev) => {
          setIngestProgress(ev);
        },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;

      const [list, messages, updatedHealth] = await Promise.all([
        listRepositories(),
        getChatHistory(repo.id),
        fetchHealth(),
      ]);
      if (controller.signal.aborted) return;

      activeRepoRequestRef.current++;
      activeRepoRef.current = repo;
      setRepositories(list);
      setHealth(updatedHealth);
      setActiveRepo(repo);
      setChatMessages(messages);
      setChatError(null);
      setDocsError(null);
      setOverviewProgress(null);
      setOverviewError(null);
      setHighlightRange(null);
      setSelectedFilePath(repo.readmePath ?? repo.files[0]?.path ?? null);
      setActiveTab('overview');
      setShowHomeView(false);
      setShowIngestModal(false);
      const eligible =
        repo.detectedFacts.eligibleFileCount ?? repo.detectedFacts.ingestedFileCount;
      const embeddingsCount = getResolvedEmbeddingsCount(repo);
      const failedCount = repo.detectedFacts.failedFileCount ?? 0;
      const status = deriveRecordIndexingStatus(repo);

      if (status === 'complete') {
        setWorkspaceFeedback({
          type: 'success',
          message: `Complete: indexed ${repo.metadata.fullName} (${repo.detectedFacts.ingestedFileCount}/${eligible} eligible files, ${embeddingsCount}/${repo.chunkCount} embeddings).`,
        });
      } else if (status === 'failed') {
        setWorkspaceFeedback({
          type: 'error',
          message: `Indexing incomplete for ${repo.metadata.fullName}: ${repo.detectedFacts.ingestedFileCount}/${eligible} files, ${embeddingsCount}/${repo.chunkCount} embeddings, ${failedCount} failed.`,
        });
      } else {
        setWorkspaceFeedback({
          type: 'warning',
          message: `Partial index for ${repo.metadata.fullName}: ${repo.detectedFacts.ingestedFileCount}/${eligible} eligible files, ${embeddingsCount}/${repo.chunkCount} embeddings${failedCount > 0 ? `, ${failedCount} failed` : ''}.`,
        });
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setIngestProgress(null);
      setIngestError(err instanceof Error ? err.message : 'Ingestion failed.');
    } finally {
      if (ingestAbortRef.current === controller) {
        ingestAbortRef.current = null;
        setIsIngesting(false);
      }
    }
  }, []);

  const handleDeleteRepo = useCallback(
    async (id: string) => {
      try {
        await deleteRepository(id);
        const list = await listRepositories();
        setRepositories(list);
        if (activeRepoRef.current?.id === id) {
          overviewAbortRef.current?.abort();
          if (list.length > 0) {
            await loadRepositoryById(list[0].id);
          } else {
            activeRepoRef.current = null;
            setActiveRepo(null);
            setChatMessages([]);
            setSelectedFilePath(null);
            setHighlightRange(null);
            setOverviewProgress(null);
            setOverviewError(null);
            setWorkspaceFeedback(null);
            setShowHomeView(false);
          }
        }
      } catch (err) {
        setWorkspaceFeedback({
          type: 'error',
          message:
            err instanceof Error ? err.message : 'Failed to remove repository.',
        });
      }
    },
    [loadRepositoryById]
  );

  const handleReanalyze = useCallback(async () => {
    const currentRepo = activeRepoRef.current;
    if (!currentRepo || isReanalyzing) return;
    const targetRepoId = currentRepo.id;
    setIsReanalyzing(true);
    setWorkspaceFeedback(null);
    try {
      const updated = await reanalyzeRepository(targetRepoId);
      if (activeRepoRef.current?.id !== targetRepoId) return;
      setActiveRepo(updated);
      const list = await listRepositories();
      setRepositories(list);
      const embeddingsCount = getResolvedEmbeddingsCount(updated);
      const status = deriveRecordIndexingStatus(updated);
      setWorkspaceFeedback({
        type: status === 'complete' ? 'success' : status === 'failed' ? 'error' : 'warning',
        message:
          status === 'complete'
            ? `Re-ran analysis and embedded ${embeddingsCount}/${updated.chunkCount} chunks.`
            : `Re-analysis finished with ${status} index (${embeddingsCount}/${updated.chunkCount} embeddings). ${updated.embeddingError || ''}`,
      });
    } catch (err) {
      if (activeRepoRef.current?.id !== targetRepoId) return;
      setWorkspaceFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Re-analysis failed.',
      });
    } finally {
      if (activeRepoRef.current?.id === targetRepoId) {
        setIsReanalyzing(false);
      }
    }
  }, [isReanalyzing]);

  const handleAnalyzeOverview = useCallback(
    async (options: { mode: 'resume' | 'full'; retryBatchIds?: string[] }) => {
      const currentRepo = activeRepoRef.current;
      if (!currentRepo || isAnalyzingOverview || isReanalyzing || isIngesting) return;
      const targetRepoId = currentRepo.id;
      overviewAbortRef.current?.abort();
      const controller = new AbortController();
      overviewAbortRef.current = controller;

      setIsAnalyzingOverview(true);
      setOverviewError(null);
      setWorkspaceFeedback(null);
      setOverviewProgress({
        stage: 'preparing',
        message:
          options.mode === 'resume'
            ? 'Resuming staged repository intelligence analysis...'
            : 'Starting repository-wide staged intelligence analysis...',
        progress: 2,
        analyzedFiles: 0,
        totalEligibleFiles: currentRepo.files.length,
        completedBatches: 0,
        totalBatches: currentRepo.comprehensiveOverview?.coverage.totalBatches ?? 0,
        failedBatches: 0,
        overview: currentRepo.comprehensiveOverview ?? undefined,
      });

      try {
        const updated = await analyzeOverviewStream(
          targetRepoId,
          options,
          (ev) => {
            if (activeRepoRef.current?.id === targetRepoId) {
              setOverviewProgress(ev);
            }
          },
          { signal: controller.signal }
        );
        if (controller.signal.aborted || activeRepoRef.current?.id !== targetRepoId) return;
        setActiveRepo(updated);
        setOverviewProgress(null);

        const ov = updated.comprehensiveOverview;
        if (ov) {
          if (ov.status === 'complete') {
            setWorkspaceFeedback({
              type: 'success',
              message: `Repository intelligence complete: analyzed ${ov.coverage.analyzedFiles}/${ov.coverage.totalEligibleFiles} files across ${ov.coverage.totalBatches} batches.`,
            });
          } else if (ov.status === 'partial') {
            setWorkspaceFeedback({
              type: 'warning',
              message: `Partial intelligence analysis: ${ov.coverage.analyzedFiles}/${ov.coverage.totalEligibleFiles} files analyzed (${ov.coverage.failedBatches} failed batches can be retried).`,
            });
          } else if (ov.status === 'failed') {
            setWorkspaceFeedback({
              type: 'error',
              message:
                ov.errorMessage ||
                `Overview analysis could not complete (${ov.coverage.failedBatches} failed batches).`,
            });
          }
        }
      } catch (err) {
        if (controller.signal.aborted || activeRepoRef.current?.id !== targetRepoId) return;
        const msg = err instanceof Error ? err.message : 'Overview analysis failed.';
        setOverviewError(msg);
        setWorkspaceFeedback({
          type: 'error',
          message: msg,
        });
      } finally {
        if (overviewAbortRef.current === controller) {
          overviewAbortRef.current = null;
          if (activeRepoRef.current?.id === targetRepoId) {
            setIsAnalyzingOverview(false);
          }
        }
      }
    },
    [isAnalyzingOverview, isReanalyzing, isIngesting]
  );

  const handleForceRefreshRepo = useCallback(() => {
    const currentRepo = activeRepoRef.current;
    if (!currentRepo || isIngesting) return;
    setIngestError(null);
    setShowIngestModal(true);
    void handleIngest(currentRepo.metadata.htmlUrl, true);
  }, [isIngesting, handleIngest]);

  const handleSendChat = useCallback(
    async (question: string) => {
      const currentRepo = activeRepoRef.current;
      if (!currentRepo || isSendingChat) return;
      const targetRepoId = currentRepo.id;
      setIsSendingChat(true);
      setChatError(null);

      const optimisticUser: ChatMessage = {
        id: `temp_${Date.now()}`,
        repoId: targetRepoId,
        role: 'user',
        content: question,
        createdAt: new Date().toISOString(),
      };
      setChatMessages((prev) => [...prev, optimisticUser]);

      try {
        const { userMessage, assistantMessage, embeddingsReady } = await sendChatQuestion(
          targetRepoId,
          question
        );
        if (activeRepoRef.current?.id !== targetRepoId) return;
        setChatMessages((prev) => [
          ...prev.filter((m) => m.id !== optimisticUser.id),
          userMessage,
          assistantMessage,
        ]);
        if (embeddingsReady === true) {
          setActiveRepo((prev) => {
            if (!prev || prev.id !== targetRepoId) return prev;
            if (prev.embeddingsReady && (prev.embeddingsCount ?? 0) >= prev.chunkCount) {
              return prev;
            }
            const hasFileGaps =
              (prev.detectedFacts.failedFileCount ?? 0) > 0 ||
              prev.detectedFacts.limitsApplied.truncatedByFileCap ||
              prev.detectedFacts.limitsApplied.truncatedBySizeCap;
            const nextStatus =
              prev.indexingStatus === 'failed' || prev.indexingStatus === 'partial'
                ? hasFileGaps
                  ? 'partial'
                  : 'complete'
                : prev.indexingStatus;
            return {
              ...prev,
              embeddingsReady: true,
              embeddingsCount: prev.chunkCount,
              embeddingError: '',
              indexingStatus: nextStatus,
            };
          });
        }
      } catch (err) {
        if (activeRepoRef.current?.id !== targetRepoId) return;
        setChatMessages((prev) => prev.filter((m) => m.id !== optimisticUser.id));
        setChatError(err instanceof Error ? err.message : 'Failed to answer question.');
      } finally {
        if (activeRepoRef.current?.id === targetRepoId) {
          setIsSendingChat(false);
        }
      }
    },
    [isSendingChat]
  );

  const handleClearChat = useCallback(async () => {
    const currentRepo = activeRepoRef.current;
    if (!currentRepo) return;
    const targetRepoId = currentRepo.id;
    try {
      await clearChatHistory(targetRepoId);
      if (activeRepoRef.current?.id !== targetRepoId) return;
      setChatMessages([]);
      setChatError(null);
    } catch (err) {
      if (activeRepoRef.current?.id !== targetRepoId) return;
      setChatError(err instanceof Error ? err.message : 'Failed to clear chat.');
    }
  }, []);

  const handleNavigateHome = useCallback(() => {
    activeRepoRequestRef.current += 1;
    overviewAbortRef.current?.abort();
    overviewAbortRef.current = null;
    activeRepoRef.current = null;

    setActiveRepo(null);
    setActiveTab('overview');
    setSelectedFilePath(null);
    setHighlightRange(null);
    setChatMessages([]);
    setChatError(null);
    setIsLoadingRepo(false);
    setIsAnalyzingOverview(false);
    setIsReanalyzing(false);
    setIsGeneratingDocs(false);
    setIsSendingChat(false);
    setOverviewProgress(null);
    setOverviewError(null);
    setDocsError(null);
    setWorkspaceFeedback(null);
    if (!ingestAbortRef.current) {
      setIngestProgress(null);
      setIngestError(null);
    }
    setShowIngestModal(false);
    setLeftOverlayOpen(false);
    setRightOverlayOpen(false);
    setShowCommandMenu(false);
    setShowHomeView(true);
  }, []);

  const handleSwitchTab = useCallback((tab: WorkspaceTab) => {
    setActiveTab(tab);
    setShowHomeView(false);
  }, []);

  const handleOpenArchitecture = useCallback(() => {
    handleSwitchTab('architecture');
  }, [handleSwitchTab]);

  const handleSelectRepo = useCallback(
    (id: string) => {
      if (activeRepoRef.current?.id === id) {
        if (!ingestAbortRef.current) {
          setIngestProgress(null);
          setIngestError(null);
        }
        setShowHomeView(false);
        setLeftOverlayOpen(false);
        return;
      }
      void loadRepositoryById(id);
    },
    [loadRepositoryById]
  );

  const handleSelectExistingFromModal = useCallback(
    (id: string) => {
      setShowIngestModal(false);
      handleSelectRepo(id);
    },
    [handleSelectRepo]
  );

  const handleOpenFile = useCallback((filePath: string) => {
    const currentRepo = activeRepoRef.current;
    const resolved = currentRepo
      ? resolveRepoFilePath(currentRepo, filePath).resolvedPath ?? filePath
      : filePath;
    setSelectedFilePath(resolved);
    setHighlightRange(null);
    setActiveTab('code');
    setShowHomeView(false);
  }, []);

  const handleOpenFileAtLine = useCallback((filePath: string, line?: number) => {
    const currentRepo = activeRepoRef.current;
    const resolved = currentRepo
      ? resolveRepoFilePath(currentRepo, filePath).resolvedPath ?? filePath
      : filePath;
    setSelectedFilePath(resolved);
    setHighlightRange(line ? { startLine: line, endLine: line } : null);
    setActiveTab('code');
    setShowHomeView(false);
  }, []);

  const handleOpenCitation = useCallback((citation: Citation) => {
    const currentRepo = activeRepoRef.current;
    const resolved = currentRepo
      ? resolveRepoFilePath(currentRepo, citation.filePath).resolvedPath ?? citation.filePath
      : citation.filePath;
    setSelectedFilePath(resolved);
    setHighlightRange({
      startLine: citation.startLine,
      endLine: citation.endLine,
    });
    setActiveTab('code');
    setShowHomeView(false);
  }, []);

  const handleGenerateDocs = useCallback(async () => {
    const currentRepo = activeRepoRef.current;
    if (!currentRepo || isGeneratingDocs) return;
    const targetRepoId = currentRepo.id;
    setIsGeneratingDocs(true);
    setDocsError(null);
    try {
      const docs = await generateDocs(targetRepoId);
      if (activeRepoRef.current?.id !== targetRepoId) return;
      setActiveRepo((prev) => (prev && prev.id === targetRepoId ? { ...prev, docs } : prev));
    } catch (err) {
      if (activeRepoRef.current?.id !== targetRepoId) return;
      setDocsError(
        err instanceof Error ? err.message : 'Documentation generation failed.'
      );
    } finally {
      if (activeRepoRef.current?.id === targetRepoId) {
        setIsGeneratingDocs(false);
      }
    }
  }, [isGeneratingDocs]);

  const activeRepoSummary = useMemo(
    () =>
      activeRepo
        ? {
            id: activeRepo.id,
            fullName: activeRepo.metadata.fullName,
            defaultBranch: activeRepo.metadata.defaultBranch,
            activeTabLabel:
              NAV_TABS.find((t) => t.id === activeTab)?.label ?? 'Overview',
          }
        : null,
    [activeRepo, activeTab]
  );

  const isLeftActive = isDesktopLeft ? !leftCollapsed : leftOverlayOpen;
  const isRightActive = isDesktopRight ? rightDesktopOpen : rightOverlayOpen;
  const isHomeActive = showHomeView || !activeRepo;

  return (
    <div
      ref={shellRef}
      className="relative h-screen w-full overflow-hidden flex flex-col bg-[#0B0D13] text-[#F8FAFC]"
    >
      <div aria-hidden="true" className="ok-ambient-bg" />
      <div aria-hidden="true" className="ok-spotlight-layer" />
      <a
        href="#workspace-main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-1.5 focus:rounded-md focus:bg-[#1E2438] focus:border focus:border-[#8B5CF6] focus:text-xs focus:font-medium focus:text-[#F8FAFC] focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]"
      >
        Skip to workspace content
      </a>

      {/* Top Bar */}
      <header className="relative h-[52px] shrink-0 ok-glass-bar border-b px-3 sm:px-4 flex items-center justify-between gap-3 z-20">
        {/* Left: Sidebar Toggle, Brand & Repo Context */}
        <div className="flex items-center gap-2 sm:gap-2.5 min-w-0 flex-1 lg:flex-initial">
          <button
            type="button"
            onClick={handleToggleLeftSidebar}
            title={
              isDesktopLeft
                ? leftCollapsed
                  ? 'Expand sidebar'
                  : 'Collapse sidebar'
                : 'Open navigation & file explorer'
            }
            aria-label={
              isDesktopLeft
                ? leftCollapsed
                  ? 'Expand sidebar'
                  : 'Collapse sidebar'
                : 'Open navigation & file explorer'
            }
            aria-expanded={isLeftActive}
            className={`p-1.5 rounded-md transition-colors duration-150 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] ${
              isLeftActive
                ? 'text-[#F8FAFC] bg-[#1E2438]/90'
                : 'text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438]/75'
            }`}
          >
            <PanelLeft className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={handleNavigateHome}
            title="Return to RepoMind Home"
            aria-label="RepoMind Home"
            aria-current={isHomeActive ? 'page' : undefined}
            className={`group flex items-center gap-2 px-1.5 py-1 -mx-0.5 rounded-md shrink-0 cursor-pointer transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] focus-visible:ring-offset-1 focus-visible:ring-offset-[#151926] ${
              isHomeActive
                ? 'bg-[#1E2438]/80'
                : 'hover:bg-[#1E2438]/75'
            }`}
          >
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-[#8B5CF6] to-[#3B82F6] shadow-[0_2px_10px_-2px_rgba(139,92,246,0.5)] flex items-center justify-center transition-transform duration-150 group-hover:scale-[1.03]">
              <BookOpen className="w-3.5 h-3.5 text-[#F8FAFC]" />
            </div>
            <span className="text-sm font-semibold tracking-tight text-[#F8FAFC] whitespace-nowrap">
              RepoMind
            </span>
          </button>

          {activeRepo && (
            <div className="hidden lg:flex items-center gap-2 pl-2.5 border-l border-[rgba(59,72,111,0.35)] min-w-0">
              <span
                title={activeRepo.metadata.fullName}
                className="font-mono text-xs text-[#E2E2EB] truncate max-w-[140px] xl:max-w-[220px]"
              >
                {activeRepo.metadata.fullName}
              </span>
              <span
                title={`Default branch: ${activeRepo.metadata.defaultBranch}`}
                className="hidden xl:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#3B82F6]/10 border border-[#3B82F6]/30 font-mono text-[11px] text-[#3B82F6] max-w-[110px] shrink-0"
              >
                <GitBranch className="w-3 h-3 shrink-0" />
                <span className="truncate">{activeRepo.metadata.defaultBranch}</span>
              </span>
            </div>
          )}
        </div>

        {/* Center: Workspace Tabs (Desktop / Tablet) */}
        {activeRepo && (
          <nav
            aria-label="Primary workspace views"
            className="hidden md:flex items-center gap-1 p-1 rounded-lg bg-[#0F121C]/80 border border-[rgba(88,108,160,0.28)] shrink-0"
          >
            {NAV_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = !showHomeView && activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleSwitchTab(tab.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`px-2.5 lg:px-3 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors duration-150 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] ${
                    isActive
                      ? 'bg-[#1E2438]/95 text-[#F8FAFC] border border-[#8B5CF6]/45 shadow-[inset_0_1px_0_rgba(248,250,252,0.06)]'
                      : 'text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438]/45 border border-transparent'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        )}

        {/* Right: Actions */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {health && (
            <span
              className={`hidden 2xl:inline-flex items-center font-mono text-[11px] mr-1 whitespace-nowrap ${
                health.persistence === 'unavailable'
                  ? 'text-[#F87171]'
                  : health.mongodbConnected
                    ? 'text-[#94A3B8]'
                    : 'text-[#FBBF24]'
              }`}
              title={`Persistence: ${health.persistenceStatus ?? health.persistence}${
                health.databaseName ? ` (${health.databaseName})` : ''
              }${health.mongodbError ? ` — ${health.mongodbError}` : ''}`}
            >
              {health.persistence === 'unavailable'
                ? 'DB Unavailable'
                : health.mongodbConnected
                  ? 'MongoDB (Durable)'
                  : 'Temp Local (Non-Durable)'}
            </span>
          )}

          <button
            type="button"
            onClick={() => setShowCommandMenu(true)}
            aria-label="Open command search"
            className="sm:hidden p-1.5 rounded-md bg-[#0F121C]/80 border border-[rgba(88,108,160,0.28)] text-[#94A3B8] hover:text-[#F8FAFC] hover:border-[#8B5CF6]/45 transition-colors duration-150 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
          >
            <Search className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => setShowCommandMenu(true)}
            className="hidden sm:inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[#0F121C]/80 border border-[rgba(88,108,160,0.28)] hover:border-[#8B5CF6]/45 hover:bg-[#181D2D]/80 text-xs text-[#94A3B8] hover:text-[#F8FAFC] transition-colors duration-150 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
          >
            <Command className="w-3 h-3" />
            <span>Search</span>
            <kbd className="font-mono text-[10px] text-[#8B9BB2]">⌘K</kbd>
          </button>

          <button
            type="button"
            onClick={openIngestModal}
            className="ok-btn-primary px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium text-[#F8FAFC] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="sm:hidden">Ingest</span>
            <span className="hidden sm:inline">Ingest Repo</span>
          </button>

          <button
            type="button"
            onClick={handleToggleRightAssistant}
            title="Toggle RAG Codebase Assistant"
            aria-label="Toggle RAG Codebase Assistant"
            aria-expanded={isRightActive}
            className={`p-1.5 rounded-md transition-colors duration-150 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] ${
              isRightActive
                ? 'text-[#F8FAFC] bg-[#1E2438]/90'
                : 'text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438]/75'
            }`}
          >
            <PanelRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Mobile Compact Tab Strip (< md) */}
      {activeRepo && (
        <nav
          aria-label="Mobile workspace tabs"
          className="relative z-20 md:hidden shrink-0 ok-glass-bar border-b px-2 py-1.5 flex items-center gap-1 overflow-x-auto"
        >
          {NAV_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = !showHomeView && activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => handleSwitchTab(tab.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`flex-1 min-w-0 px-2 py-1.5 rounded-md text-[11px] sm:text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors duration-150 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] ${
                  isActive
                    ? 'bg-[#1E2438]/95 text-[#F8FAFC] border border-[#8B5CF6]/45'
                    : 'text-[#94A3B8] hover:text-[#F8FAFC] border border-transparent'
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{tab.label}</span>
              </button>
            );
          })}
        </nav>
      )}

      {/* 3-Tier Operational Split Workspace */}
      <div className="relative z-10 flex-1 flex min-h-0 overflow-hidden">
        <FileTreeSidebar
          repositories={repositories}
          activeRepo={activeRepo}
          activeTab={activeTab}
          activeNavTab={isHomeActive ? null : activeTab}
          selectedFilePath={selectedFilePath}
          isCollapsed={leftCollapsed}
          isOverlay={!isDesktopLeft}
          isOpen={leftOverlayOpen}
          onToggleCollapse={handleToggleLeftCollapse}
          onCloseOverlay={handleCloseLeftOverlay}
          onSwitchTab={handleSwitchTab}
          onSelectFile={handleOpenFile}
          onSelectRepo={handleSelectRepo}
          onDeleteRepo={handleDeleteRepo}
          onOpenIngest={openIngestModal}
        />

        <main
          id="workspace-main"
          tabIndex={-1}
          className="@container flex-1 min-w-0 h-full flex flex-col overflow-hidden bg-[#111319]/82 focus:outline-none"
        >
          {workspaceFeedback && (
            <div
              role={workspaceFeedback.type === 'error' ? 'alert' : 'status'}
              className={`shrink-0 px-4 py-2.5 border-b backdrop-blur-sm flex items-center justify-between gap-3 text-xs ${
                workspaceFeedback.type === 'error'
                  ? 'bg-[#93000a]/30 border-[#EF4444]/40 text-[#ffb4ab]'
                  : workspaceFeedback.type === 'warning'
                    ? 'bg-[#F59E0B]/12 border-[#F59E0B]/35 text-[#FDE68A]'
                    : 'bg-[#10B981]/12 border-[#10B981]/30 text-[#6EE7B7]'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                {workspaceFeedback.type === 'error' ? (
                  <AlertCircle className="w-4 h-4 shrink-0" />
                ) : workspaceFeedback.type === 'warning' ? (
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                )}
                <span className="truncate">{workspaceFeedback.message}</span>
              </div>
              <button
                type="button"
                onClick={() => setWorkspaceFeedback(null)}
                aria-label="Dismiss notification"
                className="p-1 rounded hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-hidden">
            {isBootstrapping || isLoadingRepo ? (
              <div
                role="status"
                aria-live="polite"
                className="h-full flex items-center justify-center text-xs font-mono text-[#94A3B8]"
              >
                {isBootstrapping
                  ? 'Initializing RepoMind workspace...'
                  : 'Loading repository workspace...'}
              </div>
            ) : !activeRepo || showHomeView ? (
              <Suspense fallback={<WorkspaceFallback label="Loading RepoMind home..." />}>
                <IngestPanel
                  isModal={false}
                  isIngesting={isIngesting}
                  progress={ingestProgress}
                  error={ingestError}
                  recentRepos={repositories}
                  maxIndexableFiles={health?.maxIndexableFiles}
                  activeRepoSummary={activeRepoSummary}
                  onResumeActive={handleResumeActive}
                  onIngest={handleIngest}
                  onSelectExisting={handleSelectRepo}
                />
              </Suspense>
            ) : activeTab === 'overview' ? (
              <Suspense fallback={<WorkspaceFallback label="Loading overview intelligence..." />}>
                <OverviewTab
                  repo={activeRepo}
                  isReanalyzing={isReanalyzing || isIngesting}
                  isAnalyzingOverview={isAnalyzingOverview}
                  overviewProgress={overviewProgress}
                  overviewError={overviewError}
                  onAnalyzeOverview={handleAnalyzeOverview}
                  onReanalyze={handleReanalyze}
                  onForceRefresh={handleForceRefreshRepo}
                  onOpenFileAtLine={handleOpenFileAtLine}
                  onOpenArchitecture={handleOpenArchitecture}
                />
              </Suspense>
            ) : activeTab === 'code' ? (
              <Suspense fallback={<WorkspaceFallback label="Loading code viewer..." />}>
                <CodeViewerTab
                  repo={activeRepo}
                  selectedFilePath={selectedFilePath}
                  highlightRange={highlightRange}
                  onSelectFile={handleOpenFile}
                />
              </Suspense>
            ) : activeTab === 'architecture' ? (
              <Suspense fallback={<WorkspaceFallback label="Loading interactive architecture graph..." />}>
                <ArchitectureTab
                  repo={activeRepo}
                  onOpenFileAtLine={handleOpenFileAtLine}
                />
              </Suspense>
            ) : (
              <Suspense fallback={<WorkspaceFallback label="Loading documentation generator..." />}>
                <DocsTab
                  repo={activeRepo}
                  isGenerating={isGeneratingDocs}
                  error={docsError}
                  onGenerate={handleGenerateDocs}
                />
              </Suspense>
            )}
          </div>
        </main>

        <CopilotDrawer
          repo={activeRepo}
          messages={chatMessages}
          isSending={isSendingChat}
          error={chatError}
          isOpen={isRightActive}
          isOverlay={!isDesktopRight}
          onClose={handleCloseRight}
          onSendQuestion={handleSendChat}
          onClearChat={handleClearChat}
          onOpenCitation={handleOpenCitation}
        />
      </div>

      {/* Modals */}
      {showIngestModal && (
        <Suspense fallback={null}>
          <IngestPanel
            isModal={true}
            isIngesting={isIngesting}
            progress={ingestProgress}
            error={ingestError}
            recentRepos={repositories}
            maxIndexableFiles={health?.maxIndexableFiles}
            onClose={handleCloseIngestModal}
            onIngest={handleIngest}
            onSelectExisting={handleSelectExistingFromModal}
          />
        </Suspense>
      )}

      {showCommandMenu && (
        <Suspense fallback={null}>
          <CommandMenu
            isOpen={showCommandMenu}
            repo={activeRepo}
            onClose={handleCloseCommandMenu}
            onOpenFile={handleOpenFile}
            onSwitchTab={handleSwitchTab}
            onNavigateHome={handleNavigateHome}
            onOpenIngest={openIngestModal}
          />
        </Suspense>
      )}
    </div>
  );
}
