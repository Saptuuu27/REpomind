import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Code2,
  FileCode2,
  FileText,
  Home,
  Network,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import type { RepositoryRecord } from '../types';
import { useDialogA11y } from '../utils/useDialogA11y';

export type WorkspaceTab = 'overview' | 'code' | 'architecture' | 'docs';

interface CommandMenuProps {
  isOpen: boolean;
  repo: RepositoryRecord | null;
  onClose: () => void;
  onOpenFile: (filePath: string) => void;
  onSwitchTab: (tab: WorkspaceTab) => void;
  onOpenIngest: () => void;
  onNavigateHome?: () => void;
}

interface CommandItem {
  id: string;
  group: 'action' | 'file';
  label: string;
  meta?: string;
  keywords: string;
  onSelect: () => void;
  icon: 'ingest' | 'home' | 'overview' | 'code' | 'architecture' | 'docs' | 'file';
}

export const CommandMenu = memo(function CommandMenu({
  isOpen,
  repo,
  onClose,
  onOpenFile,
  onSwitchTab,
  onOpenIngest,
  onNavigateHome,
}: CommandMenuProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();

  useDialogA11y(isOpen, dialogRef, {
    initialFocusRef: inputRef,
    onEscape: onClose,
  });

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setActiveIndex(0);
  }, [isOpen]);

  const { filteredActions, matchingFiles, allItems } = useMemo(() => {
    const q = query.trim().toLowerCase();

    const baseActions: CommandItem[] = [
      {
        id: 'action:ingest',
        group: 'action',
        label: 'Ingest New GitHub Repository',
        keywords: 'ingest add clone import github repository url new',
        icon: 'ingest',
        onSelect: () => {
          onOpenIngest();
          onClose();
        },
      },
    ];

    if (onNavigateHome) {
      baseActions.push({
        id: 'action:home',
        group: 'action',
        label: 'Go to RepoMind Home',
        keywords: 'home landing repositories start',
        icon: 'home',
        onSelect: () => {
          onNavigateHome();
          onClose();
        },
      });
    }

    if (repo) {
      baseActions.push(
        {
          id: 'action:overview',
          group: 'action',
          label: 'Go to Repository Intelligence Overview',
          keywords: 'overview intelligence summary tech stack features database',
          icon: 'overview',
          onSelect: () => {
            onSwitchTab('overview');
            onClose();
          },
        },
        {
          id: 'action:code',
          group: 'action',
          label: 'Go to Code Explorer',
          keywords: 'code explorer viewer source files editor',
          icon: 'code',
          onSelect: () => {
            onSwitchTab('code');
            onClose();
          },
        },
        {
          id: 'action:architecture',
          group: 'action',
          label: 'Go to Architecture Dependency Graph',
          keywords: 'architecture hierarchy graph module flows dependencies',
          icon: 'architecture',
          onSelect: () => {
            onSwitchTab('architecture');
            onClose();
          },
        },
        {
          id: 'action:docs',
          group: 'action',
          label: 'Go to Documentation Generator',
          keywords: 'docs documentation markdown readme export',
          icon: 'docs',
          onSelect: () => {
            onSwitchTab('docs');
            onClose();
          },
        }
      );
    }

    const actions = q
      ? baseActions.filter(
          (a) =>
            a.label.toLowerCase().includes(q) || a.keywords.toLowerCase().includes(q)
        )
      : baseActions;

    const filesList = repo
      ? (q
          ? repo.files.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 18)
          : repo.files.slice(0, 12))
      : [];

    const fileItems: CommandItem[] = filesList.map((file) => ({
      id: `file:${file.path}`,
      group: 'file',
      label: file.path,
      meta: `${file.lines} ln`,
      keywords: file.path,
      icon: 'file',
      onSelect: () => {
        onOpenFile(file.path);
        onClose();
      },
    }));

    return {
      filteredActions: actions,
      matchingFiles: fileItems,
      allItems: [...actions, ...fileItems],
    };
  }, [query, repo, onOpenIngest, onNavigateHome, onSwitchTab, onOpenFile, onClose]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, isOpen]);

  useEffect(() => {
    const activeEl = itemRefs.current[activeIndex];
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  if (!isOpen) return null;

  const activeItem = allItems[activeIndex];
  const activeOptionId = activeItem ? `${listboxId}-opt-${activeIndex}` : undefined;

  const renderIcon = (kind: CommandItem['icon']) => {
    switch (kind) {
      case 'ingest':
        return <Plus className="w-3.5 h-3.5 text-[#8B5CF6] shrink-0" />;
      case 'home':
        return <Home className="w-3.5 h-3.5 text-[#CBD5E1] shrink-0" />;
      case 'overview':
        return <Sparkles className="w-3.5 h-3.5 text-[#3B82F6] shrink-0" />;
      case 'code':
        return <Code2 className="w-3.5 h-3.5 text-[#D0BCFF] shrink-0" />;
      case 'architecture':
        return <Network className="w-3.5 h-3.5 text-[#06B6D4] shrink-0" />;
      case 'docs':
        return <FileText className="w-3.5 h-3.5 text-[#10B981] shrink-0" />;
      case 'file':
        return <FileCode2 className="w-3.5 h-3.5 text-[#3B82F6] shrink-0" />;
    }
  };

  let runningIndex = 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-[#07090F]/75 backdrop-blur-sm ok-backdrop-enter flex items-start justify-center pt-[10vh] sm:pt-[12vh] p-3 sm:p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Workspace command search"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[640px] ok-glass-modal border rounded-xl overflow-hidden ok-modal-enter"
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[rgba(59,72,111,0.3)]">
          <Search className="w-4 h-4 text-[#8B5CF6] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && allItems.length > 0) {
                e.preventDefault();
                setActiveIndex((i) => (i + 1) % allItems.length);
                return;
              }
              if (e.key === 'ArrowUp' && allItems.length > 0) {
                e.preventDefault();
                setActiveIndex((i) => (i - 1 + allItems.length) % allItems.length);
                return;
              }
              if (e.key === 'Enter' && allItems.length > 0) {
                e.preventDefault();
                const target = allItems[activeIndex] ?? allItems[0];
                target?.onSelect();
              }
            }}
            placeholder={
              repo
                ? `Search ${repo.files.length} indexed files or jump to view...`
                : 'Search quick actions...'
            }
            aria-label="Search files or workspace commands"
            className="flex-1 min-w-0 bg-transparent text-sm text-[#F8FAFC] placeholder-[#8B9BB2] focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close command search"
            className="px-1.5 py-0.5 rounded bg-[#0F121C]/85 border border-[rgba(88,108,160,0.3)] font-mono text-[10px] text-[#94A3B8] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
          >
            ESC
          </button>
        </div>

        <div className="sr-only" role="status" aria-live="polite">
          {allItems.length} result{allItems.length === 1 ? '' : 's'} available
        </div>

        <div
          id={listboxId}
          role="listbox"
          aria-label="Workspace actions and matching files"
          className="max-h-[380px] overflow-y-auto p-2 space-y-3"
        >
          {filteredActions.length > 0 && (
            <div className="space-y-1">
              <div className="px-2 py-1 text-[10px] font-mono text-[#8B9BB2]">
                Workspace Actions
              </div>
              {filteredActions.map((item) => {
                const idx = runningIndex++;
                const isActive = idx === activeIndex;
                return (
                  <button
                    key={item.id}
                    id={`${listboxId}-opt-${idx}`}
                    role="option"
                    aria-selected={isActive}
                    ref={(el) => {
                      itemRefs.current[idx] = el;
                    }}
                    type="button"
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={item.onSelect}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] ${
                      isActive
                        ? 'bg-[#8B5CF6]/20 text-[#F8FAFC] border border-[#8B5CF6]/40'
                        : 'text-[#E2E2EB] hover:bg-[#8B5CF6]/15 hover:text-[#F8FAFC] border border-transparent'
                    }`}
                  >
                    {renderIcon(item.icon)}
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          )}

          {matchingFiles.length > 0 && (
            <div className="space-y-1">
              <div className="px-2 py-1 text-[10px] font-mono text-[#8B9BB2]">
                Indexed Source Files
              </div>
              {matchingFiles.map((item) => {
                const idx = runningIndex++;
                const isActive = idx === activeIndex;
                return (
                  <button
                    key={item.id}
                    id={`${listboxId}-opt-${idx}`}
                    role="option"
                    aria-selected={isActive}
                    ref={(el) => {
                      itemRefs.current[idx] = el;
                    }}
                    type="button"
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={item.onSelect}
                    className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] ${
                      isActive
                        ? 'bg-[#8B5CF6]/20 text-[#F8FAFC] border border-[#8B5CF6]/40'
                        : 'hover:bg-[#8B5CF6]/15 border border-transparent'
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      {renderIcon(item.icon)}
                      <span className="font-mono text-xs text-[#E2E2EB] truncate">
                        {item.label}
                      </span>
                    </span>
                    {item.meta && (
                      <span className="font-mono text-[11px] text-[#8B9BB2] shrink-0">
                        {item.meta}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {allItems.length === 0 && (
            <div className="py-8 text-center text-xs text-[#8B9BB2]">
              No matching commands or indexed files for &ldquo;{query}&rdquo;.
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default CommandMenu;
