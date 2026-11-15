import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Database,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  LayoutDashboard,
  Network,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { WorkspaceTab } from './CommandMenu';
import type { RepositoryRecord, RepositorySummary, TreeItem } from '../types';
import { useDialogA11y } from '../utils/useDialogA11y';

interface FileTreeSidebarProps {
  repositories: RepositorySummary[];
  activeRepo: RepositoryRecord | null;
  activeTab: WorkspaceTab;
  activeNavTab?: WorkspaceTab | null;
  selectedFilePath: string | null;
  isCollapsed: boolean;
  isOverlay: boolean;
  isOpen: boolean;
  onToggleCollapse: () => void;
  onCloseOverlay: () => void;
  onSwitchTab: (tab: WorkspaceTab) => void;
  onSelectFile: (path: string) => void;
  onSelectRepo: (id: string) => void;
  onDeleteRepo: (id: string) => void;
  onOpenIngest: () => void;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  ingested?: boolean;
  failed?: boolean;
  skipReason?: string;
  children: TreeNode[];
}

interface FloatingTooltipState {
  label: string;
  top: number;
  left: number;
}

function buildHierarchy(items: TreeItem[], filterQuery: string): TreeNode[] {
  const q = filterQuery.trim().toLowerCase();
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] };
  const dirMap = new Map<string, TreeNode>([['', root]]);

  const blobs = items.filter((item) => item.type === 'blob');
  const filteredBlobs = q
    ? blobs.filter((b) => b.path.toLowerCase().includes(q))
    : blobs;

  const ensureDir = (dirPath: string): TreeNode => {
    const existing = dirMap.get(dirPath);
    if (existing) return existing;
    const parts = dirPath.split('/');
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');
    const parent = ensureDir(parentPath);
    const node: TreeNode = {
      name,
      path: dirPath,
      isDir: true,
      children: [],
    };
    parent.children.push(node);
    dirMap.set(dirPath, node);
    return node;
  };

  for (const item of filteredBlobs) {
    const parts = item.path.split('/');
    const fileName = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');
    const parent = ensureDir(parentPath);
    parent.children.push({
      name: fileName,
      path: item.path,
      isDir: false,
      ingested: item.ingested,
      failed: item.failed,
      skipReason: item.skipReason,
      children: [],
    });
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.isDir) sortNodes(n.children);
    }
  };
  sortNodes(root.children);
  return root.children;
}

function FileIcon({ name, ingested }: { name: string; ingested?: boolean }) {
  const lower = name.toLowerCase();
  const dimClass = ingested ? '' : 'opacity-45';
  if (
    lower.endsWith('.json') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.toml')
  ) {
    return <FileJson className={`w-3.5 h-3.5 shrink-0 text-[#F59E0B] ${dimClass}`} />;
  }
  if (lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.txt')) {
    return <FileText className={`w-3.5 h-3.5 shrink-0 text-[#94A3B8] ${dimClass}`} />;
  }
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) {
    return <FileCode2 className={`w-3.5 h-3.5 shrink-0 text-[#3B82F6] ${dimClass}`} />;
  }
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs')) {
    return <FileCode2 className={`w-3.5 h-3.5 shrink-0 text-[#F59E0B] ${dimClass}`} />;
  }
  if (lower.endsWith('.py') || lower.endsWith('.go') || lower.endsWith('.rs')) {
    return <FileCode2 className={`w-3.5 h-3.5 shrink-0 text-[#10B981] ${dimClass}`} />;
  }
  return <FileCode2 className={`w-3.5 h-3.5 shrink-0 text-[#8B5CF6] ${dimClass}`} />;
}

interface TreeBranchProps {
  nodes: TreeNode[];
  depth: number;
  expandedDirs: Set<string>;
  filterActive: boolean;
  selectedFilePath: string | null;
  onToggleDir: (dirPath: string) => void;
  onPickFile: (filePath: string) => void;
}

const TreeBranch = memo(function TreeBranch({
  nodes,
  depth,
  expandedDirs,
  filterActive,
  selectedFilePath,
  onToggleDir,
  onPickFile,
}: TreeBranchProps) {
  const indentPx = 6 + Math.min(depth, 5) * 10;

  return (
    <>
      {nodes.map((node) => {
        if (node.isDir) {
          const isOpenDir = filterActive || expandedDirs.has(node.path);
          return (
            <div key={node.path} className="min-w-0">
              <button
                type="button"
                title={node.path}
                onClick={() => onToggleDir(node.path)}
                aria-expanded={isOpenDir}
                style={{ paddingLeft: `${indentPx}px` }}
                className="w-full min-w-0 flex items-center gap-1.5 py-1.5 pr-2 text-left text-[12px] text-[#CBD5E1] hover:bg-[#1E2438]/70 hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded transition-colors"
              >
                {isOpenDir ? (
                  <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[#8B9BB2]" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[#8B9BB2]" />
                )}
                {isOpenDir ? (
                  <FolderOpen className="w-3.5 h-3.5 shrink-0 text-[#3B82F6]" />
                ) : (
                  <Folder className="w-3.5 h-3.5 shrink-0 text-[#3B82F6]" />
                )}
                <span className="truncate font-mono text-[12px] min-w-0 flex-1">
                  {node.name}
                </span>
              </button>
              {isOpenDir && (
                <div className="min-w-0">
                  <TreeBranch
                    nodes={node.children}
                    depth={depth + 1}
                    expandedDirs={expandedDirs}
                    filterActive={filterActive}
                    selectedFilePath={selectedFilePath}
                    onToggleDir={onToggleDir}
                    onPickFile={onPickFile}
                  />
                </div>
              )}
            </div>
          );
        }

        const isSelected = selectedFilePath === node.path;
        const canOpen = Boolean(node.ingested);
        const isFailed = Boolean(node.failed);

        return (
          <button
            key={node.path}
            type="button"
            disabled={!canOpen}
            title={
              canOpen
                ? node.path
                : `${node.path} — ${isFailed ? 'Failed' : 'Skipped'}: ${
                    node.skipReason || 'Not indexed'
                  }`
            }
            onClick={() => {
              if (!canOpen) return;
              onPickFile(node.path);
            }}
            style={{ paddingLeft: `${indentPx + 14}px` }}
            className={`w-full min-w-0 flex items-center justify-between gap-1.5 py-1.5 pr-2 text-left rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] ${
              isSelected
                ? 'bg-[#8B5CF6]/15 text-[#F8FAFC] border border-[#8B5CF6]/40'
                : canOpen
                ? 'text-[#CBD5E1] hover:bg-[#1E2438]/60 hover:text-[#F8FAFC] border border-transparent'
                : isFailed
                ? 'text-[#FCA5A5] cursor-not-allowed opacity-80 border border-transparent'
                : 'text-[#8B9BB2] cursor-not-allowed opacity-70 border border-transparent'
            }`}
          >
            <span className="flex items-center gap-1.5 min-w-0 flex-1">
              <FileIcon name={node.name} ingested={node.ingested} />
              <span className="truncate font-mono text-[12px] min-w-0">{node.name}</span>
            </span>
            {!canOpen && (
              <span
                className={`text-[10px] font-mono shrink-0 ${
                  isFailed ? 'text-[#FCA5A5]' : 'text-[#8B9BB2]'
                }`}
              >
                {isFailed ? 'fail' : 'skip'}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
});

const NAV_ITEMS: Array<{
  id: WorkspaceTab;
  label: string;
  icon: typeof LayoutDashboard;
}> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'code', label: 'Code Explorer', icon: Code2 },
  { id: 'architecture', label: 'Architecture', icon: Network },
  { id: 'docs', label: 'Documentation', icon: FileText },
];

export const FileTreeSidebar = memo(function FileTreeSidebar({
  repositories,
  activeRepo,
  activeTab,
  activeNavTab,
  selectedFilePath,
  isCollapsed,
  isOverlay,
  isOpen,
  onToggleCollapse,
  onCloseOverlay,
  onSwitchTab,
  onSelectFile,
  onSelectRepo,
  onDeleteRepo,
  onOpenIngest,
}: FileTreeSidebarProps) {
  const [filterQuery, setFilterQuery] = useState('');
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    () => new Set(['src', 'app', 'lib', 'server', 'packages'])
  );
  const [showRepos, setShowRepos] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<FloatingTooltipState | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const overlayCloseRef = useRef<HTMLButtonElement | null>(null);

  const showCollapsedRail = !isOverlay && isCollapsed;
  const effectiveActiveTab = activeNavTab === undefined ? activeTab : activeNavTab;

  useDialogA11y(isOverlay && isOpen, sidebarRef, {
    initialFocusRef: overlayCloseRef,
    onEscape: onCloseOverlay,
  });

  useEffect(() => {
    setFilterQuery('');
    setConfirmDeleteId(null);
  }, [activeRepo?.id]);

  // Automatically reveal ancestor directories when a citation or jump opens a nested file
  useEffect(() => {
    if (!selectedFilePath || !selectedFilePath.includes('/')) return;
    const parts = selectedFilePath.split('/').slice(0, -1);
    if (parts.length === 0) return;
    setExpandedDirs((prev) => {
      let changed = false;
      const next = new Set(prev);
      let prefix = '';
      for (const part of parts) {
        prefix = prefix ? `${prefix}/${part}` : part;
        if (!next.has(prefix)) {
          next.add(prefix);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedFilePath, activeRepo?.id]);

  useEffect(() => {
    if (!showCollapsedRail) {
      setTooltip(null);
    }
  }, [showCollapsedRail]);

  useEffect(() => {
    return () => {
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
      }
    };
  }, []);

  const showRailTooltip = useCallback((el: HTMLElement, label: string) => {
    const rect = el.getBoundingClientRect();
    setTooltip({
      label,
      top: rect.top + rect.height / 2,
      left: rect.right + 10,
    });
  }, []);

  const hideRailTooltip = useCallback(() => {
    setTooltip(null);
  }, []);

  const treeNodes = useMemo(() => {
    if (!activeRepo) return [];
    return buildHierarchy(activeRepo.tree, filterQuery);
  }, [activeRepo, filterQuery]);

  const toggleDir = useCallback((dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  const handlePickFile = useCallback(
    (path: string) => {
      onSelectFile(path);
      if (isOverlay) onCloseOverlay();
    },
    [onSelectFile, isOverlay, onCloseOverlay]
  );

  const sidebarClasses = isOverlay
    ? `fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] ok-glass-panel border-r shadow-[0_24px_48px_-12px_rgba(0,0,0,0.75)] flex flex-col overflow-hidden transform transition-[transform,visibility] duration-200 ease-out ${
        isOpen ? 'translate-x-0 visible' : '-translate-x-full invisible pointer-events-none'
      }`
    : `relative shrink-0 h-full ok-glass-panel border-r flex flex-col overflow-hidden transition-[width] duration-200 ease-out z-20 ${
        showCollapsedRail ? 'w-[56px]' : 'w-[236px] min-[1440px]:w-[260px]'
      }`;

  return (
    <>
      {isOverlay && isOpen && (
        <div
          aria-hidden="true"
          onClick={onCloseOverlay}
          className="fixed inset-0 z-40 bg-[#0B0D13]/72 backdrop-blur-xs ok-backdrop-enter"
        />
      )}

      <aside
        ref={sidebarRef}
        role={isOverlay ? 'dialog' : undefined}
        aria-modal={isOverlay && isOpen ? true : undefined}
        aria-label="Repository Explorer and Navigation"
        aria-hidden={isOverlay && !isOpen ? true : undefined}
        tabIndex={isOverlay ? -1 : undefined}
        className={sidebarClasses}
      >
        {/* Unified Top Header Bar */}
        <div
          className={`h-[42px] border-b border-[rgba(59,72,111,0.25)] flex items-center shrink-0 ${
            showCollapsedRail ? 'justify-center px-1.5' : 'justify-between px-3 gap-2'
          }`}
        >
          {!showCollapsedRail && (
            <span className="text-[11px] font-mono uppercase tracking-wider text-[#94A3B8] truncate">
              Explorer
            </span>
          )}

          {isOverlay ? (
            <button
              ref={overlayCloseRef}
              type="button"
              onClick={onCloseOverlay}
              aria-label="Close sidebar"
              className="p-1.5 rounded-md text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onToggleCollapse}
              onMouseEnter={(e) => {
                if (showCollapsedRail) showRailTooltip(e.currentTarget, 'Expand sidebar');
              }}
              onMouseLeave={hideRailTooltip}
              onFocus={(e) => {
                if (showCollapsedRail) showRailTooltip(e.currentTarget, 'Expand sidebar');
              }}
              onBlur={hideRailTooltip}
              aria-label={showCollapsedRail ? 'Expand sidebar' : 'Collapse sidebar'}
              className="p-1.5 rounded-md text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors shrink-0"
            >
              {showCollapsedRail ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <ChevronLeft className="w-4 h-4" />
              )}
            </button>
          )}
        </div>

        {/* Single Persistent Body Container: Rail Controls + Persistent Explorer Panel */}
        <div className="flex-1 min-h-0 relative overflow-hidden">
          {/* Compact Icon Rail Controls (active when desktop collapsed) */}
          <div
            aria-hidden={!showCollapsedRail}
            className={`absolute inset-0 flex flex-col items-center py-2.5 gap-2 transition-opacity duration-150 ${
              showCollapsedRail
                ? 'opacity-100 visible pointer-events-auto'
                : 'opacity-0 invisible pointer-events-none'
            }`}
          >
            {activeRepo && (
              <nav aria-label="Collapsed workspace views" className="flex flex-col items-center gap-1.5">
                {NAV_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const active = effectiveActiveTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onSwitchTab(item.id)}
                      onMouseEnter={(e) => showRailTooltip(e.currentTarget, item.label)}
                      onMouseLeave={hideRailTooltip}
                      onFocus={(e) => showRailTooltip(e.currentTarget, item.label)}
                      onBlur={hideRailTooltip}
                      aria-label={item.label}
                      aria-current={active ? 'page' : undefined}
                      className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] ${
                        active
                          ? 'bg-[#8B5CF6]/20 text-[#F8FAFC] border border-[#8B5CF6]/45'
                          : 'text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438] border border-transparent'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                    </button>
                  );
                })}
                <div className="w-7 h-px bg-[#2A324B]/80 my-1" />
              </nav>
            )}

            <button
              type="button"
              onClick={() => {
                onToggleCollapse();
                setShowRepos(true);
              }}
              onMouseEnter={(e) =>
                showRailTooltip(e.currentTarget, `Indexed Repos (${repositories.length})`)
              }
              onMouseLeave={hideRailTooltip}
              onFocus={(e) =>
                showRailTooltip(e.currentTarget, `Indexed Repos (${repositories.length})`)
              }
              onBlur={hideRailTooltip}
              aria-label={`Indexed repositories (${repositories.length})`}
              className="relative w-9 h-9 rounded-lg flex items-center justify-center text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors"
            >
              <Database className="w-4 h-4 text-[#8B5CF6]" />
              {repositories.length > 0 && (
                <span className="absolute top-1 right-1 min-w-[14px] h-[14px] px-0.5 rounded-full bg-[#1E2438] border border-[#2A324B] text-[9px] font-mono text-[#CBD5E1] flex items-center justify-center">
                  {repositories.length}
                </span>
              )}
            </button>

            {activeRepo && (
              <button
                type="button"
                onClick={() => {
                  onToggleCollapse();
                  if (focusTimerRef.current !== null) {
                    window.clearTimeout(focusTimerRef.current);
                  }
                  focusTimerRef.current = window.setTimeout(
                    () => filterInputRef.current?.focus(),
                    80
                  );
                }}
                onMouseEnter={(e) =>
                  showRailTooltip(
                    e.currentTarget,
                    `Browse ${activeRepo.detectedFacts.ingestedFileCount} indexed files`
                  )
                }
                onMouseLeave={hideRailTooltip}
                onFocus={(e) =>
                  showRailTooltip(
                    e.currentTarget,
                    `Browse ${activeRepo.detectedFacts.ingestedFileCount} indexed files`
                  )
                }
                onBlur={hideRailTooltip}
                aria-label="Filter repository files"
                className="w-9 h-9 rounded-lg flex items-center justify-center text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors"
              >
                <Search className="w-4 h-4" />
              </button>
            )}

            <div className="mt-auto pt-2">
              <button
                type="button"
                onClick={onOpenIngest}
                onMouseEnter={(e) => showRailTooltip(e.currentTarget, 'Ingest GitHub Repo')}
                onMouseLeave={hideRailTooltip}
                onFocus={(e) => showRailTooltip(e.currentTarget, 'Ingest GitHub Repo')}
                onBlur={hideRailTooltip}
                aria-label="Ingest GitHub repository"
                className="w-9 h-9 rounded-lg flex items-center justify-center bg-[#181D2D] border border-[#2A324B] text-[#CBD5E1] hover:text-[#F8FAFC] hover:border-[#8B5CF6]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Persistent Expanded Content (keeps fixed inner width & scroll state during width transitions) */}
          <div
            aria-hidden={showCollapsedRail}
            className={`absolute inset-y-0 left-0 flex flex-col min-h-0 transition-opacity duration-150 ${
              isOverlay ? 'w-full' : 'w-[236px] min-[1440px]:w-[260px]'
            } ${
              showCollapsedRail
                ? 'opacity-0 invisible pointer-events-none'
                : 'opacity-100 visible pointer-events-auto'
            }`}
          >
            {/* Repository Switcher Header */}
            <div className="p-3 border-b border-[rgba(59,72,111,0.25)] space-y-2 shrink-0">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setShowRepos((v) => !v)}
                  aria-expanded={showRepos}
                  className="flex items-center gap-1.5 text-xs font-medium text-[#CBD5E1] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded transition-colors min-w-0"
                >
                  <Database className="w-3.5 h-3.5 text-[#8B5CF6] shrink-0" />
                  <span className="truncate">
                    Indexed Repos ({repositories.length})
                  </span>
                  {showRepos ? (
                    <ChevronDown className="w-3.5 h-3.5 text-[#8B9BB2] shrink-0" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-[#8B9BB2] shrink-0" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (isOverlay) onCloseOverlay();
                    onOpenIngest();
                  }}
                  title="Ingest GitHub Repository"
                  aria-label="Ingest GitHub Repository"
                  className="p-1.5 rounded-md bg-[#181D2D] border border-[#2A324B] text-[#CBD5E1] hover:text-[#F8FAFC] hover:border-[#8B5CF6]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>

              {showRepos && (
                <div className="max-h-48 overflow-y-auto space-y-1 pt-1">
                  {repositories.length === 0 ? (
                    <p className="text-xs text-[#8B9BB2] py-1">
                      No repositories indexed yet.
                    </p>
                  ) : (
                    repositories.map((r) => {
                      const active = activeRepo?.id === r.id;
                      const isConfirming = confirmDeleteId === r.id;
                      return (
                        <div
                          key={r.id}
                          className={`group flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-md text-xs transition-colors ${
                            active
                              ? 'bg-[#8B5CF6]/15 text-[#F8FAFC] border border-[#8B5CF6]/40'
                              : 'bg-[#0F121C] text-[#94A3B8] hover:text-[#F8FAFC] border border-transparent'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              onSelectRepo(r.id);
                              setShowRepos(false);
                              if (isOverlay) onCloseOverlay();
                            }}
                            className="truncate text-left flex-1 font-mono text-[11px] min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded"
                            title={r.fullName}
                          >
                            {r.fullName}
                          </button>
                          {isConfirming ? (
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setConfirmDeleteId(null);
                                  onDeleteRepo(r.id);
                                }}
                                aria-label={`Confirm delete ${r.fullName}`}
                                title="Confirm delete"
                                className="p-1 rounded bg-[#EF4444]/20 text-[#FCA5A5] hover:bg-[#EF4444]/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#EF4444]"
                              >
                                <Check className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setConfirmDeleteId(null);
                                }}
                                aria-label="Cancel delete"
                                title="Cancel"
                                className="p-1 rounded bg-[#1E2438] text-[#94A3B8] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteId(r.id);
                              }}
                              title={`Remove ${r.fullName}`}
                              aria-label={`Remove ${r.fullName}`}
                              className="opacity-80 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 focus-visible:opacity-100 p-1 text-[#8B9BB2] hover:text-[#EF4444] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded transition-opacity shrink-0"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            {/* File Filter & Tree */}
            {activeRepo ? (
              <>
                <div className="p-2.5 border-b border-[rgba(59,72,111,0.25)] shrink-0">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-[#8B9BB2] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      ref={filterInputRef}
                      type="text"
                      value={filterQuery}
                      onChange={(e) => setFilterQuery(e.target.value)}
                      placeholder="Filter files..."
                      aria-label="Filter repository files"
                      className="w-full bg-[#0F121C] border border-[#2A324B] focus:border-[#8B5CF6] focus:outline-none rounded-md pl-8 pr-7 py-1.5 text-xs text-[#F8FAFC] placeholder-[#8B9BB2] font-mono"
                    />
                    {filterQuery && (
                      <button
                        type="button"
                        onClick={() => setFilterQuery('')}
                        aria-label="Clear file filter"
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8B9BB2] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px] font-mono text-[#94A3B8] px-0.5">
                    <span className="truncate">
                      {activeRepo.detectedFacts.ingestedFileCount}/
                      {activeRepo.detectedFacts.eligibleFileCount ??
                        activeRepo.detectedFacts.ingestedFileCount}{' '}
                      eligible
                    </span>
                    <span className="text-[#8B9BB2] shrink-0">
                      {activeRepo.detectedFacts.totalTreeFiles} total
                    </span>
                  </div>
                </div>

                {/* File Tree */}
                <div className="flex-1 overflow-y-auto overflow-x-hidden p-2 space-y-0.5 min-w-0">
                  {treeNodes.length === 0 ? (
                    <div className="px-2 py-6 text-center space-y-2">
                      <p className="text-xs text-[#8B9BB2]">
                        No matching files found.
                      </p>
                      {filterQuery && (
                        <button
                          type="button"
                          onClick={() => setFilterQuery('')}
                          className="text-[11px] font-mono text-[#60A5FA] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded"
                        >
                          Clear filter
                        </button>
                      )}
                    </div>
                  ) : (
                    <TreeBranch
                      nodes={treeNodes}
                      depth={0}
                      expandedDirs={expandedDirs}
                      filterActive={filterQuery.trim().length > 0}
                      selectedFilePath={selectedFilePath}
                      onToggleDir={toggleDir}
                      onPickFile={handlePickFile}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-5 text-center">
                <Folder className="w-8 h-8 text-[#3B486F] mb-2" />
                <p className="text-xs text-[#94A3B8] leading-relaxed">
                  Ingest a public GitHub repository to explore its file tree.
                </p>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Fixed-viewport tooltip escapes overflow-hidden & stacking contexts cleanly */}
      {showCollapsedRail && tooltip && (
        <div
          role="tooltip"
          style={{
            top: `${tooltip.top}px`,
            left: `${tooltip.left}px`,
          }}
          className="fixed -translate-y-1/2 z-[70] pointer-events-none px-2.5 py-1 rounded-md ok-glass-floating border text-[11px] font-medium text-[#F8FAFC] whitespace-nowrap"
        >
          {tooltip.label}
        </div>
      )}
    </>
  );
});
