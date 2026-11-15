import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Activity,
  ArrowDown,
  ArrowRight,
  Box,
  ChevronRight,
  Code2,
  Database,
  ExternalLink,
  FileCode2,
  FunctionSquare,
  GitBranch,
  Globe,
  Layers,
  Maximize2,
  Network,
  Package,
  RotateCcw,
  Search,
  Server,
  Sparkles,
  Wrench,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { ArchitectureEdge, RepositoryRecord } from '../types';
import {
  ARCH_ZONE_META,
  buildArchitectureHierarchy,
  buildLevel2Subgraph,
  buildLevel3FileSubgraph,
  type ArchModule,
  type ArchModuleEdge,
  type ArchZoneId,
  type CodeSymbol,
  type FlowEvidenceBasis,
  type SubgraphEdgeItem,
  type SubgraphNodeItem,
} from '../utils/architectureHierarchy';
import { resolveRepoFilePath } from '../utils/repoPaths';

interface ArchitectureTabProps {
  repo: RepositoryRecord;
  onOpenFileAtLine: (filePath: string, line?: number) => void;
}

type ViewMode = 'hierarchy' | 'flows';
type HierarchyLevel = 1 | 2 | 3;

interface ZoneHeaderNodeData extends Record<string, unknown> {
  zone: ArchZoneId;
  moduleCount: number;
  isFiltered: boolean;
}

interface ArchModuleNodeData extends Record<string, unknown> {
  mod: ArchModule;
  selected: boolean;
  connectedHighlight: boolean;
  dimmed: boolean;
  searchMatch: boolean;
}

interface SubgraphFlowNodeData extends Record<string, unknown> {
  item: SubgraphNodeItem;
  selected: boolean;
  dimmed: boolean;
  searchMatch: boolean;
}

const ZONE_ICONS: Record<ArchZoneId, typeof Layers> = {
  frontend: Layers,
  api: Globe,
  backend: Server,
  services: Code2,
  storage: Database,
  external: Package,
  infra: Wrench,
};

const EVIDENCE_BADGE_STYLES: Record<
  FlowEvidenceBasis,
  { label: string; className: string; hint: string }
> = {
  'verified-call': {
    label: 'Verified Call',
    className: 'bg-[#10B981]/15 border-[#10B981]/40 text-[#6EE7B7]',
    hint: 'Direct call expression observed in indexed source code',
  },
  'route-handler': {
    label: 'Route Handler',
    className: 'bg-[#06B6D4]/15 border-[#06B6D4]/40 text-[#67E8F9]',
    hint: 'Client request URL matched to a server HTTP route handler',
  },
  'import-only': {
    label: 'Import-Only',
    className: 'bg-[#F59E0B]/15 border-[#F59E0B]/40 text-[#FCD34D]',
    hint: 'Static module import — proves load dependency, NOT runtime execution order',
  },
  inferred: {
    label: 'Inferred Flow',
    className: 'bg-[#8B5CF6]/15 border-[#8B5CF6]/40 text-[#C4B5FD]',
    hint: 'Synthesized from analyzed files without full runtime trace',
  },
};

const ZoneHeaderFlowNode = memo(function ZoneHeaderFlowNode({
  data,
}: NodeProps<Node<ZoneHeaderNodeData>>) {
  const meta = ARCH_ZONE_META[data.zone];
  const Icon = ZONE_ICONS[data.zone];

  return (
    <div
      className={`w-[260px] rounded-lg px-3 py-2 border transition-colors cursor-pointer select-none ${
        data.isFiltered
          ? 'bg-[#1E2438] border-[#8B5CF6]'
          : 'bg-[#151926] border-[#2A324B] hover:border-[#3B486F]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: meta.accentHex }}
          />
          <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: meta.accentHex }} />
          <span className="text-xs font-semibold text-[#F8FAFC] truncate">{meta.label}</span>
        </div>
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#0F121C] border border-[#2A324B] text-[#94A3B8] shrink-0">
          {data.moduleCount}
        </span>
      </div>
    </div>
  );
});

const ArchModuleFlowNode = memo(function ArchModuleFlowNode({
  data,
}: NodeProps<Node<ArchModuleNodeData>>) {
  const { mod, selected, connectedHighlight, dimmed, searchMatch } = data;
  const meta = ARCH_ZONE_META[mod.zone];
  const isExternal = mod.kind === 'external';

  return (
    <div
      className={`w-[260px] rounded-lg px-3 py-2.5 transition-all select-none ${
        isExternal ? 'bg-[#131824] border border-dashed' : 'bg-[#181D2D] border'
      } ${
        selected
          ? 'border-[#8B5CF6] ring-1 ring-[#8B5CF6]/50'
          : connectedHighlight
          ? 'border-[#06B6D4]'
          : searchMatch
          ? 'border-[#10B981]'
          : 'border-[#2A324B] hover:border-[#8B5CF6]/60'
      } ${dimmed ? 'opacity-35' : 'opacity-100'}`}
      style={{
        borderLeftWidth: 3,
        borderLeftColor: selected ? '#8B5CF6' : meta.accentHex,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2 !h-2 !bg-[#3B82F6] !border-[#0B0D13]"
      />
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="font-mono text-[10px] text-[#94A3B8] truncate">{meta.shortLabel}</span>
        <span className="font-mono text-[10px] text-[#8B9BB2] shrink-0">
          {isExternal ? 'package' : `${mod.files.length} file${mod.files.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="text-xs font-semibold text-[#F8FAFC] truncate" title={mod.name}>
        {mod.name}
      </div>
      <p className="mt-1 text-[11px] text-[#94A3B8] line-clamp-2 leading-snug">
        {mod.responsibility}
      </p>
      <div className="mt-2 pt-1.5 border-t border-[rgba(59,72,111,0.22)] flex items-center justify-between font-mono text-[10px] text-[#8B9BB2]">
        <span>
          {mod.endpoints.length > 0
            ? `${mod.endpoints.length} route${mod.endpoints.length === 1 ? '' : 's'}`
            : mod.symbols.length > 0
            ? `${mod.symbols.length} symbols`
            : isExternal
            ? 'external'
            : `${mod.totalLines} ln`}
        </span>
        <span>
          in:{mod.inDegree} · out:{mod.outDegree}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!w-2 !h-2 !bg-[#8B5CF6] !border-[#0B0D13]"
      />
    </div>
  );
});

const SubgraphFlowNode = memo(function SubgraphFlowNode({
  data,
}: NodeProps<Node<SubgraphFlowNodeData>>) {
  const { item, selected, dimmed, searchMatch } = data;
  const isCenter = item.kind === 'focus-file';
  const isSymbol = item.kind === 'symbol';
  const isExternal = item.kind === 'external';
  const isUpstream = item.kind === 'upstream';

  return (
    <div
      className={`min-w-[220px] max-w-[260px] rounded-lg px-3 py-2 transition-all select-none ${
        isExternal
          ? 'bg-[#131824] border border-dashed'
          : isCenter
          ? 'bg-[#1B2236] border'
          : isSymbol
          ? 'bg-[#141A29] border'
          : 'bg-[#181D2D] border'
      } ${
        selected
          ? isSymbol
            ? 'border-[#10B981] ring-1 ring-[#10B981]/60'
            : 'border-[#8B5CF6] ring-1 ring-[#8B5CF6]/50'
          : searchMatch
          ? 'border-[#10B981]'
          : isCenter
          ? 'border-[#8B5CF6]/70'
          : isUpstream
          ? 'border-[#06B6D4]/45 hover:border-[#06B6D4]'
          : isExternal
          ? 'border-[#3B82F6]/45 hover:border-[#3B82F6]'
          : 'border-[#2A324B] hover:border-[#8B5CF6]/60'
      } ${dimmed ? 'opacity-35' : 'opacity-100'}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2 !h-2 !bg-[#06B6D4] !border-[#0B0D13]"
      />
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-[#8B9BB2]">
          {isCenter
            ? 'focused'
            : isSymbol
            ? 'symbol'
            : isUpstream
            ? 'caller'
            : isExternal
            ? 'external'
            : 'dependency'}
        </span>
        {isSymbol ? (
          <FunctionSquare className="w-3 h-3 text-[#10B981] shrink-0" />
        ) : isExternal ? (
          <Package className="w-3 h-3 text-[#3B82F6] shrink-0" />
        ) : (
          <FileCode2 className="w-3 h-3 text-[#8B5CF6] shrink-0" />
        )}
      </div>
      <div className="font-mono text-xs font-semibold text-[#F8FAFC] truncate" title={item.label}>
        {item.label}
      </div>
      <div className="font-mono text-[10px] text-[#94A3B8] truncate mt-0.5" title={item.sublabel}>
        {item.sublabel}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!w-2 !h-2 !bg-[#8B5CF6] !border-[#0B0D13]"
      />
    </div>
  );
});

const nodeTypes = {
  zoneHeader: ZoneHeaderFlowNode,
  archModule: ArchModuleFlowNode,
  subgraphNode: SubgraphFlowNode,
};

function prefersReducedMotionNow(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function getMiniMapNodeColor(n: Node): string {
  if (n.type === 'zoneHeader') return '#2A324B';
  if (n.type === 'archModule') {
    const d = n.data as ArchModuleNodeData;
    return ARCH_ZONE_META[d.mod.zone]?.accentHex ?? '#8B5CF6';
  }
  const s = (n.data as SubgraphFlowNodeData)?.item;
  if (s?.kind === 'focus-file') return '#8B5CF6';
  if (s?.kind === 'upstream') return '#06B6D4';
  if (s?.kind === 'symbol') return '#10B981';
  return '#3B82F6';
}

function FitViewTrigger({ triggerKey }: { triggerKey: string }) {
  const { fitView } = useReactFlow();

  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      void fitView({
        padding: 0.16,
        duration: prefersReducedMotionNow() ? 0 : 220,
      });
    });
    return () => window.cancelAnimationFrame(id);
  }, [triggerKey, fitView]);

  return null;
}

const ZoomActionBar = memo(function ZoomActionBar() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1 p-1 rounded-lg ok-glass-floating border">
      <button
        type="button"
        onClick={() => void zoomIn({ duration: prefersReducedMotionNow() ? 0 : 150 })}
        title="Zoom in"
        aria-label="Zoom in"
        className="p-1.5 rounded text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors"
      >
        <ZoomIn className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() => void zoomOut({ duration: prefersReducedMotionNow() ? 0 : 150 })}
        title="Zoom out"
        aria-label="Zoom out"
        className="p-1.5 rounded text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors"
      >
        <ZoomOut className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() =>
          void fitView({ padding: 0.16, duration: prefersReducedMotionNow() ? 0 : 220 })
        }
        title="Fit graph to screen"
        aria-label="Fit graph to screen"
        className="px-2 py-1 rounded text-[11px] font-mono text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] inline-flex items-center gap-1 transition-colors"
      >
        <Maximize2 className="w-3 h-3" />
        <span className="hidden sm:inline">Fit</span>
      </button>
    </div>
  );
});

function ArchitectureExplorerInner({ repo, onOpenFileAtLine }: ArchitectureTabProps) {
  const hierarchy = useMemo(
    () => buildArchitectureHierarchy(repo),
    // Rebuild hierarchy only when structural repository fields change (not docs or chat/embedding flags)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo.id, repo.metadata.commitSha, repo.files, repo.architecture, repo.comprehensiveOverview]
  );

  const [viewMode, setViewMode] = useState<ViewMode>('hierarchy');
  const [hierarchyLevel, setHierarchyLevel] = useState<HierarchyLevel>(1);
  const [focusedModuleId, setFocusedModuleId] = useState<string | null>(null);
  const [focusedFilePath, setFocusedFilePath] = useState<string | null>(null);

  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [selectedModuleEdgeId, setSelectedModuleEdgeId] = useState<string | null>(null);
  const [selectedSubNodeId, setSelectedSubNodeId] = useState<string | null>(null);
  const [selectedSubEdgeId, setSelectedSubEdgeId] = useState<string | null>(null);

  const [zoneFilter, setZoneFilter] = useState<ArchZoneId | 'all'>('all');
  const [includeExternal, setIncludeExternal] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [inspectorDismissedOnMobile, setInspectorDismissedOnMobile] = useState(false);

  // Reset navigation state ONLY when repository identity changes (preserve exploration across docs/overview updates)
  useEffect(() => {
    setViewMode('hierarchy');
    setHierarchyLevel(1);
    setFocusedModuleId(null);
    setFocusedFilePath(null);
    setSelectedModuleId(null);
    setSelectedModuleEdgeId(null);
    setSelectedSubNodeId(null);
    setSelectedSubEdgeId(null);
    setZoneFilter('all');
    setSearchQuery('');
    setSelectedFlowId(null);
    setInspectorDismissedOnMobile(false);
  }, [repo.id]);

  // Clear external zone filter if user hides external packages
  useEffect(() => {
    if (!includeExternal && zoneFilter === 'external') {
      setZoneFilter('all');
    }
  }, [includeExternal, zoneFilter]);

  const clearSelection = useCallback(() => {
    setSelectedModuleId(null);
    setSelectedModuleEdgeId(null);
    setSelectedSubNodeId(null);
    setSelectedSubEdgeId(null);
  }, []);

  const handleResetAll = useCallback(() => {
    clearSelection();
    setZoneFilter('all');
    setSearchQuery('');
    setHierarchyLevel(1);
    setFocusedModuleId(null);
    setFocusedFilePath(null);
  }, [clearSelection]);

  // Escape key clears current selection unless a higher-priority modal dialog is open
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.defaultPrevented || document.querySelector('[role="dialog"]')) {
          return;
        }
        clearSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearSelection]);

  const drillToLevel1 = useCallback(() => {
    setHierarchyLevel(1);
    setFocusedModuleId(null);
    setFocusedFilePath(null);
    clearSelection();
  }, [clearSelection]);

  const drillToLevel2 = useCallback(
    (moduleId: string) => {
      setViewMode('hierarchy');
      setHierarchyLevel(2);
      setFocusedModuleId(moduleId);
      setFocusedFilePath(null);
      setSelectedModuleId(moduleId);
      setSelectedModuleEdgeId(null);
      setSelectedSubNodeId(null);
      setSelectedSubEdgeId(null);
    },
    []
  );

  const drillToLevel3 = useCallback(
    (filePath: string) => {
      const resolution = resolveRepoFilePath(repo, filePath);
      const targetPath = resolution.resolvedPath ?? filePath;
      const parentModuleId = hierarchy.fileToModuleId.get(targetPath) ?? focusedModuleId;
      setViewMode('hierarchy');
      setHierarchyLevel(3);
      if (parentModuleId) {
        setFocusedModuleId(parentModuleId);
      }
      setFocusedFilePath(targetPath);
      setSelectedModuleId(parentModuleId ?? null);
      setSelectedModuleEdgeId(null);
      setSelectedSubNodeId(`l3:center:${targetPath}`);
      setSelectedSubEdgeId(null);
    },
    [focusedModuleId, hierarchy.fileToModuleId, repo]
  );

  const q = searchQuery.trim().toLowerCase();

  // Quick search matches across modules, files, and extracted symbols
  const searchResults = useMemo(() => {
    if (!q) return { modules: [] as ArchModule[], files: [] as string[], symbols: [] as CodeSymbol[] };

    const matchedModules = hierarchy.modules.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.directoryKey.toLowerCase().includes(q) ||
        m.responsibility.toLowerCase().includes(q)
    );

    const matchedFiles = repo.files
      .filter((f) => f.path.toLowerCase().includes(q))
      .map((f) => f.path)
      .slice(0, 8);

    const matchedSymbols: CodeSymbol[] = [];
    for (const syms of hierarchy.fileInternals.values()) {
      for (const s of syms) {
        if (s.name.toLowerCase().includes(q)) {
          matchedSymbols.push(s);
          if (matchedSymbols.length >= 8) break;
        }
      }
      if (matchedSymbols.length >= 8) break;
    }

    return {
      modules: matchedModules.slice(0, 6),
      files: matchedFiles,
      symbols: matchedSymbols,
    };
  }, [q, hierarchy.modules, hierarchy.fileInternals, repo.files]);

  const moduleMatchesSearch = useCallback(
    (m: ArchModule): boolean => {
      if (!q) return false;
      if (
        m.name.toLowerCase().includes(q) ||
        m.directoryKey.toLowerCase().includes(q) ||
        m.responsibility.toLowerCase().includes(q)
      ) {
        return true;
      }
      if (m.files.some((f) => f.path.toLowerCase().includes(q))) return true;
      if (m.symbols.some((s) => s.name.toLowerCase().includes(q))) return true;
      return false;
    },
    [q]
  );

  // Level 1 Graph Data
  const level1Graph = useMemo(() => {
    const visibleModules = hierarchy.modules.filter((m) => {
      if (!includeExternal && m.kind === 'external') return false;
      if (zoneFilter !== 'all' && m.zone !== zoneFilter) return false;
      return true;
    });

    const visibleIds = new Set(visibleModules.map((m) => m.id));
    const visibleEdges = hierarchy.moduleEdges.filter(
      (e) => visibleIds.has(e.source) && visibleIds.has(e.target)
    );

    // Recompute compact column positions for active visible zones when filtered
    const visibleZones = hierarchy.activeZones.filter((z) =>
      visibleModules.some((m) => m.zone === z)
    );
    const colIndexByZone = new Map(visibleZones.map((z, idx) => [z, idx]));

    const flowNodes: Node[] = [];
    visibleZones.forEach((zone, colIdx) => {
      const count = visibleModules.filter((m) => m.zone === zone).length;
      flowNodes.push({
        id: `zone-header:${zone}`,
        type: 'zoneHeader',
        position: { x: colIdx * 310 + 20, y: 12 },
        draggable: false,
        selectable: true,
        data: {
          zone,
          moduleCount: count,
          isFiltered: zoneFilter === zone,
        } satisfies ZoneHeaderNodeData,
      });
    });

    const selectedEdgeObj = visibleEdges.find((e) => e.id === selectedModuleEdgeId) ?? null;
    const connectedIds = new Set<string>();
    if (selectedModuleId) {
      connectedIds.add(selectedModuleId);
      visibleEdges.forEach((e) => {
        if (e.source === selectedModuleId) connectedIds.add(e.target);
        if (e.target === selectedModuleId) connectedIds.add(e.source);
      });
    } else if (selectedEdgeObj) {
      connectedIds.add(selectedEdgeObj.source);
      connectedIds.add(selectedEdgeObj.target);
    }

    const rowCounter = new Map<ArchZoneId, number>();
    const sortedVisible = [...visibleModules].sort(
      (a, b) =>
        (colIndexByZone.get(a.zone) ?? 0) - (colIndexByZone.get(b.zone) ?? 0) ||
        a.position.y - b.position.y
    );

    for (const m of sortedVisible) {
      const colIdx = colIndexByZone.get(m.zone) ?? 0;
      const rowIdx = rowCounter.get(m.zone) ?? 0;
      rowCounter.set(m.zone, rowIdx + 1);

      const isSearchMatch = moduleMatchesSearch(m);
      const hasFocusFilter = selectedModuleId !== null || selectedEdgeObj !== null;
      const isConnected = connectedIds.has(m.id);
      const dimmed =
        (hasFocusFilter && !isConnected) || (q.length > 0 && !isSearchMatch && !isConnected);

      flowNodes.push({
        id: m.id,
        type: 'archModule',
        position: { x: colIdx * 310 + 20, y: 74 + rowIdx * 130 },
        data: {
          mod: m,
          selected: selectedModuleId === m.id,
          connectedHighlight: selectedModuleId !== m.id && isConnected,
          dimmed,
          searchMatch: isSearchMatch,
        } satisfies ArchModuleNodeData,
      });
    }

    const flowEdges: Edge[] = visibleEdges.map((e) => {
      const isSelected = selectedModuleEdgeId === e.id;
      const isIncident =
        selectedModuleId !== null && (e.source === selectedModuleId || e.target === selectedModuleId);
      const isExternal = e.kind === 'external';
      const isRoute = e.evidenceBasis === 'route-handler';
      const hasFocus = selectedModuleId !== null || selectedModuleEdgeId !== null;

      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'smoothstep',
        animated: isSelected || isIncident || isRoute,
        label: isRoute ? 'route' : e.importCount > 1 ? `${e.importCount}x` : undefined,
        labelStyle: {
          fill: isSelected || isRoute ? '#F8FAFC' : '#94A3B8',
          fontSize: 10,
          fontFamily: 'JetBrains Mono, monospace',
        },
        labelBgStyle: {
          fill: '#0F121C',
          fillOpacity: 0.92,
        },
        style: {
          stroke: isSelected
            ? '#06B6D4'
            : isRoute
            ? '#06B6D4'
            : isIncident
            ? '#8B5CF6'
            : isExternal
            ? 'rgba(59, 130, 246, 0.45)'
            : 'rgba(139, 92, 246, 0.45)',
          strokeWidth: isSelected || isIncident || isRoute ? 2.2 : 1.25,
          strokeDasharray: isExternal ? '4 4' : undefined,
          opacity: hasFocus && !isSelected && !isIncident ? 0.16 : 1,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isSelected || isRoute ? '#06B6D4' : isExternal ? '#3B82F6' : '#8B5CF6',
          width: 15,
          height: 15,
        },
      };
    });

    return {
      flowNodes,
      flowEdges,
      visibleModules,
      visibleEdges,
    };
  }, [
    hierarchy,
    includeExternal,
    zoneFilter,
    selectedModuleId,
    selectedModuleEdgeId,
    moduleMatchesSearch,
    q,
  ]);

  // Level 2 Subgraph Data
  const level2Subgraph = useMemo(() => {
    if (hierarchyLevel !== 2 || !focusedModuleId) return null;
    return buildLevel2Subgraph(hierarchy, repo, focusedModuleId, includeExternal);
  }, [hierarchyLevel, focusedModuleId, hierarchy, repo, includeExternal]);

  // Level 3 Subgraph Data
  const level3Subgraph = useMemo(() => {
    if (hierarchyLevel !== 3 || !focusedFilePath) return null;
    const raw = buildLevel3FileSubgraph(hierarchy, repo, focusedFilePath);
    if (!includeExternal) {
      const filteredNodes = raw.nodes.filter((n) => n.kind !== 'external');
      const validIds = new Set(filteredNodes.map((n) => n.id));
      const filteredEdges = raw.edges.filter((e) => validIds.has(e.source) && validIds.has(e.target));
      return {
        ...raw,
        nodes: filteredNodes,
        edges: filteredEdges,
      };
    }
    return raw;
  }, [hierarchyLevel, focusedFilePath, hierarchy, repo, includeExternal]);

  // ReactFlow Nodes & Edges for Level 2 / Level 3
  const subFlowData = useMemo(() => {
    const items: SubgraphNodeItem[] =
      hierarchyLevel === 2
        ? level2Subgraph?.nodes ?? []
        : hierarchyLevel === 3
        ? level3Subgraph?.nodes ?? []
        : [];
    const subEdges: SubgraphEdgeItem[] =
      hierarchyLevel === 2
        ? level2Subgraph?.edges ?? []
        : hierarchyLevel === 3
        ? level3Subgraph?.edges ?? []
        : [];

    const connectedIds = new Set<string>();
    if (selectedSubNodeId) {
      connectedIds.add(selectedSubNodeId);
      subEdges.forEach((e) => {
        if (e.source === selectedSubNodeId) connectedIds.add(e.target);
        if (e.target === selectedSubNodeId) connectedIds.add(e.source);
      });
    } else if (selectedSubEdgeId) {
      const edge = subEdges.find((e) => e.id === selectedSubEdgeId);
      if (edge) {
        connectedIds.add(edge.source);
        connectedIds.add(edge.target);
      }
    }

    const hasFocus = selectedSubNodeId !== null || selectedSubEdgeId !== null;

    const flowNodes: Node<SubgraphFlowNodeData>[] = items.map((item) => {
      const isMatch =
        q.length > 0 &&
        (item.label.toLowerCase().includes(q) || item.sublabel.toLowerCase().includes(q));
      const isConnected = connectedIds.has(item.id);
      return {
        id: item.id,
        type: 'subgraphNode',
        position: item.position,
        data: {
          item,
          selected: selectedSubNodeId === item.id,
          dimmed: (hasFocus && !isConnected) || (q.length > 0 && !isMatch && !isConnected),
          searchMatch: isMatch,
        },
      };
    });

    const flowEdges: Edge[] = subEdges.map((e) => {
      const isSelected = selectedSubEdgeId === e.id;
      const isIncident =
        selectedSubNodeId !== null && (e.source === selectedSubNodeId || e.target === selectedSubNodeId);
      const isExternal = e.direction === 'external';
      const isIncoming = e.direction === 'incoming';

      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'smoothstep',
        animated: isSelected || isIncident,
        label: e.label,
        labelStyle: {
          fill: isSelected ? '#F8FAFC' : '#94A3B8',
          fontSize: 10,
          fontFamily: 'JetBrains Mono, monospace',
        },
        labelBgStyle: {
          fill: '#0F121C',
          fillOpacity: 0.92,
        },
        style: {
          stroke: isSelected
            ? '#06B6D4'
            : isIncoming
            ? '#06B6D4'
            : isExternal
            ? 'rgba(59, 130, 246, 0.55)'
            : '#8B5CF6',
          strokeWidth: isSelected || isIncident ? 2.2 : 1.35,
          strokeDasharray: isExternal ? '4 4' : undefined,
          opacity: hasFocus && !isSelected && !isIncident ? 0.2 : 1,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isSelected || isIncoming ? '#06B6D4' : isExternal ? '#3B82F6' : '#8B5CF6',
          width: 15,
          height: 15,
        },
      };
    });

    return { flowNodes, flowEdges, items, subEdges };
  }, [
    hierarchyLevel,
    level2Subgraph,
    level3Subgraph,
    selectedSubNodeId,
    selectedSubEdgeId,
    q,
  ]);

  const activeCanvasNodes = hierarchyLevel === 1 ? level1Graph.flowNodes : subFlowData.flowNodes;
  const activeCanvasEdges = hierarchyLevel === 1 ? level1Graph.flowEdges : subFlowData.flowEdges;

  // Selected Inspectors
  const selectedModule: ArchModule | null = useMemo(() => {
    const id = selectedModuleId ?? (hierarchyLevel === 2 ? focusedModuleId : null);
    return id ? hierarchy.modules.find((m) => m.id === id) ?? null : null;
  }, [selectedModuleId, hierarchyLevel, focusedModuleId, hierarchy.modules]);

  const selectedModuleEdge: ArchModuleEdge | null = useMemo(
    () =>
      selectedModuleEdgeId
        ? hierarchy.moduleEdges.find((e) => e.id === selectedModuleEdgeId) ?? null
        : null,
    [selectedModuleEdgeId, hierarchy.moduleEdges]
  );

  const selectedModuleNeighbors = useMemo(() => {
    if (!selectedModule) return { incoming: [] as ArchModuleEdge[], outgoing: [] as ArchModuleEdge[] };
    return {
      incoming: hierarchy.moduleEdges.filter((e) => e.target === selectedModule.id),
      outgoing: hierarchy.moduleEdges.filter(
        (e) => e.source === selectedModule.id && (includeExternal || e.kind === 'internal')
      ),
    };
  }, [selectedModule, hierarchy.moduleEdges, includeExternal]);

  const selectedSubNode: SubgraphNodeItem | null = useMemo(
    () => subFlowData.items.find((n) => n.id === selectedSubNodeId) ?? null,
    [subFlowData.items, selectedSubNodeId]
  );

  const selectedSubEdge: SubgraphEdgeItem | null = useMemo(
    () => subFlowData.subEdges.find((e) => e.id === selectedSubEdgeId) ?? null,
    [subFlowData.subEdges, selectedSubEdgeId]
  );

  const selectedSymbol: CodeSymbol | null = useMemo(() => {
    if (hierarchyLevel !== 3 || !selectedSubNode || selectedSubNode.kind !== 'symbol') {
      return null;
    }
    const matched = level3Subgraph?.symbols.find(
      (s) => s.name === selectedSubNode.label && s.line === selectedSubNode.line
    );
    if (matched) return matched;
    if (selectedSubNode.filePath && selectedSubNode.line !== undefined) {
      return {
        name: selectedSubNode.label,
        kind: selectedSubNode.symbolKind ?? 'function',
        filePath: selectedSubNode.filePath,
        line: selectedSubNode.line,
        detail: selectedSubNode.symbolDetail,
      };
    }
    return null;
  }, [hierarchyLevel, selectedSubNode, level3Subgraph]);

  // Determine whether right inspector panel should show
  const showInspector =
    viewMode === 'hierarchy' &&
    Boolean(
      (hierarchyLevel === 1 && (selectedModule || selectedModuleEdge)) ||
        hierarchyLevel === 2 ||
        hierarchyLevel === 3
    );

  // Filtered Process Flows
  const filteredFlows = useMemo(() => {
    if (!q) return hierarchy.processFlows;
    return hierarchy.processFlows.filter(
      (flow) =>
        flow.title.toLowerCase().includes(q) ||
        flow.summary.toLowerCase().includes(q) ||
        flow.trigger.toLowerCase().includes(q) ||
        flow.steps.some(
          (st) =>
            st.action.toLowerCase().includes(q) ||
            st.filePath.toLowerCase().includes(q) ||
            st.layer.toLowerCase().includes(q)
        )
    );
  }, [hierarchy.processFlows, q]);

  const activeFlow =
    filteredFlows.find((f) => f.id === selectedFlowId) ?? filteredFlows[0] ?? null;

  const focusedModuleMeta = useMemo(
    () => (focusedModuleId ? hierarchy.modules.find((m) => m.id === focusedModuleId) ?? null : null),
    [focusedModuleId, hierarchy.modules]
  );

  const fitTriggerKey = `${repo.id}|${viewMode}|${hierarchyLevel}|${focusedModuleId ?? ''}|${
    focusedFilePath ?? ''
  }|${zoneFilter}|${includeExternal}`;

  const renderRawEdgeBlock = (edge: ArchitectureEdge) => (
    <div className="space-y-2">
      <div className="p-3 rounded-lg bg-[#0F121C] border border-[#2A324B] space-y-2">
        <div>
          <div className="text-[10px] font-mono text-[#8B9BB2]">Source</div>
          <button
            type="button"
            onClick={() => onOpenFileAtLine(edge.sourcePath, edge.evidences[0]?.line)}
            className="font-mono text-xs text-[#ADC6FF] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded text-left break-all"
          >
            {edge.sourcePath}
          </button>
        </div>
        <div className="flex items-center gap-1.5 text-[#8B5CF6]">
          <ArrowRight className="w-3.5 h-3.5" />
          <span className="font-mono text-[10px]">import-only ({edge.targetKind})</span>
        </div>
        <div>
          <div className="text-[10px] font-mono text-[#8B9BB2]">Target</div>
          {edge.targetKind === 'internal' ? (
            <button
              type="button"
              onClick={() => onOpenFileAtLine(edge.targetPath)}
              className="font-mono text-xs text-[#60A5FA] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded text-left break-all"
            >
              {edge.targetPath}
            </button>
          ) : (
            <span className="font-mono text-xs text-[#E2E2EB] break-all">{edge.targetPath}</span>
          )}
        </div>
      </div>

      <div className="text-[11px] font-medium text-[#94A3B8]">
        Supporting Statements ({edge.evidences.length})
      </div>
      {edge.evidences.map((ev, idx) => (
        <div
          key={idx}
          className="p-2.5 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.3)] space-y-1.5"
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-[#06B6D4]">Line {ev.line}</span>
            <button
              type="button"
              onClick={() => onOpenFileAtLine(edge.sourcePath, ev.line)}
              className="inline-flex items-center gap-1 font-mono text-[11px] text-[#60A5FA] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded"
            >
              <span>Open</span>
              <ExternalLink className="w-3 h-3" />
            </button>
          </div>
          <pre className="font-mono text-[11px] text-[#E2E2EB] whitespace-pre-wrap break-all bg-[#151926] p-2 rounded border border-[rgba(59,72,111,0.2)]">
            {ev.rawStatement}
          </pre>
        </div>
      ))}
    </div>
  );

  return (
    <div className="h-full flex flex-col bg-[#0F121C]/75 min-w-0">
      {/* Top Architecture Control Bar */}
      <div className="px-3 sm:px-4 py-2.5 ok-glass-bar border-b space-y-2 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          {/* Left: Mode Toggle + Hierarchy Breadcrumbs */}
          <div className="flex flex-wrap items-center gap-2.5 min-w-0">
            <div
              role="tablist"
              aria-label="Architecture view modes"
              className="inline-flex items-center p-0.5 rounded-lg bg-[#0F121C] border border-[#2A324B] shrink-0"
            >
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'hierarchy'}
                onClick={() => setViewMode('hierarchy')}
                className={`px-2.5 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors ${
                  viewMode === 'hierarchy'
                    ? 'bg-[#1E2438] text-[#F8FAFC] border border-[#8B5CF6]/40'
                    : 'text-[#94A3B8] hover:text-[#F8FAFC] border border-transparent'
                }`}
              >
                <Network className="w-3.5 h-3.5 text-[#8B5CF6]" />
                <span>Hierarchy Map</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'flows'}
                onClick={() => setViewMode('flows')}
                className={`px-2.5 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors ${
                  viewMode === 'flows'
                    ? 'bg-[#1E2438] text-[#F8FAFC] border border-[#06B6D4]/40'
                    : 'text-[#94A3B8] hover:text-[#F8FAFC] border border-transparent'
                }`}
              >
                <Activity className="w-3.5 h-3.5 text-[#06B6D4]" />
                <span>Process Flows ({hierarchy.processFlows.length})</span>
              </button>
            </div>

            {viewMode === 'hierarchy' && (
              <nav
                aria-label="Architecture hierarchy breadcrumb"
                className="flex items-center gap-1 text-xs min-w-0 flex-wrap"
              >
                <button
                  type="button"
                  onClick={drillToLevel1}
                  className={`px-2 py-0.5 rounded font-mono text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors ${
                    hierarchyLevel === 1
                      ? 'bg-[#8B5CF6]/20 text-[#F8FAFC] border border-[#8B5CF6]/40'
                      : 'text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438]'
                  }`}
                >
                  L1 System Overview
                </button>
                {hierarchyLevel >= 2 && focusedModuleMeta && (
                  <>
                    <ChevronRight className="w-3.5 h-3.5 text-[#8B9BB2] shrink-0" />
                    <button
                      type="button"
                      onClick={() => drillToLevel2(focusedModuleMeta.id)}
                      className={`px-2 py-0.5 rounded font-mono text-[11px] truncate max-w-[160px] sm:max-w-[180px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors ${
                        hierarchyLevel === 2
                          ? 'bg-[#8B5CF6]/20 text-[#F8FAFC] border border-[#8B5CF6]/40'
                          : 'text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438]'
                      }`}
                      title={focusedModuleMeta.name}
                    >
                      L2 {focusedModuleMeta.name}
                    </button>
                  </>
                )}
                {hierarchyLevel === 3 && focusedFilePath && (
                  <>
                    <ChevronRight className="w-3.5 h-3.5 text-[#8B9BB2] shrink-0" />
                    <span
                      className="px-2 py-0.5 rounded font-mono text-[11px] bg-[#06B6D4]/15 text-[#67E8F9] border border-[#06B6D4]/40 truncate max-w-[160px] sm:max-w-[200px]"
                      title={focusedFilePath}
                    >
                      L3 {focusedFilePath.split('/').pop()}
                    </span>
                  </>
                )}
              </nav>
            )}
          </div>

          {/* Right: Search, External Deps, Reset */}
          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            <div className="relative flex-1 sm:flex-initial min-w-[160px]">
              <Search className="w-3.5 h-3.5 text-[#8B9BB2] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search modules, files, functions..."
                aria-label="Search architecture modules, files, and symbols"
                className="w-full sm:w-56 bg-[#0F121C] border border-[#2A324B] focus:border-[#8B5CF6] focus:outline-none rounded-md pl-8 pr-7 py-1.5 text-xs font-mono text-[#F8FAFC] placeholder-[#8B9BB2]"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear architecture search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8B9BB2] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {viewMode === 'hierarchy' && (
              <button
                type="button"
                aria-pressed={includeExternal}
                onClick={() => setIncludeExternal((v) => !v)}
                className={`px-2.5 py-1.5 rounded-md text-xs font-medium border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors whitespace-nowrap shrink-0 ${
                  includeExternal
                    ? 'bg-[#3B82F6]/15 border-[#3B82F6]/50 text-[#ADC6FF]'
                    : 'bg-[#181D2D] border-[#2A324B] text-[#94A3B8] hover:text-[#F8FAFC]'
                }`}
              >
                {includeExternal ? 'External Deps: On' : 'External Deps: Off'}
              </button>
            )}

            <button
              type="button"
              onClick={handleResetAll}
              title="Reset view, selection, and filters"
              className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-[#181D2D] border border-[#2A324B] text-[#94A3B8] hover:text-[#F8FAFC] hover:border-[#8B5CF6]/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] inline-flex items-center gap-1.5 transition-colors shrink-0"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset</span>
            </button>
          </div>
        </div>

        {/* Zone Filter Strip (Level 1) + Compact Stats */}
        {viewMode === 'hierarchy' && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
            {hierarchyLevel === 1 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={zoneFilter === 'all'}
                  onClick={() => setZoneFilter('all')}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors ${
                    zoneFilter === 'all'
                      ? 'bg-[#1E2438] border-[#8B5CF6]/50 text-[#F8FAFC]'
                      : 'bg-[#0F121C] border-[#2A324B] text-[#94A3B8] hover:text-[#F8FAFC]'
                  }`}
                >
                  All Zones ({hierarchy.stats.totalModules})
                </button>
                {hierarchy.activeZones
                  .filter((z) => includeExternal || z !== 'external')
                  .map((zone) => {
                    const meta = ARCH_ZONE_META[zone];
                    const count = hierarchy.modules.filter((m) => m.zone === zone).length;
                    const active = zoneFilter === zone;
                    return (
                      <button
                        key={zone}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setZoneFilter((prev) => (prev === zone ? 'all' : zone))}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium border inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors ${
                          active
                            ? 'bg-[#1E2438] text-[#F8FAFC]'
                            : 'bg-[#0F121C] border-[#2A324B] text-[#94A3B8] hover:text-[#F8FAFC]'
                        }`}
                        style={active ? { borderColor: meta.accentHex } : undefined}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: meta.accentHex }}
                        />
                        <span>{meta.shortLabel}</span>
                        <span className="font-mono text-[10px] text-[#8B9BB2]">{count}</span>
                      </button>
                    );
                  })}
              </div>
            ) : (
              <div className="text-[11px] font-mono text-[#94A3B8]">
                {hierarchyLevel === 2
                  ? 'Double-click any internal file to inspect its symbols & direct imports (Level 3)'
                  : 'Inspecting file imports and extracted code symbols — click lines to jump to Code Viewer'}
              </div>
            )}

            <span className="text-[11px] font-mono text-[#8B9BB2]">
              {hierarchyLevel === 1
                ? `${level1Graph.visibleModules.length} modules · ${level1Graph.visibleEdges.length} connections · ${hierarchy.stats.totalFiles} repo files`
                : `${activeCanvasNodes.length} nodes · ${activeCanvasEdges.length} edges`}
            </span>
          </div>
        )}

        {/* Quick Search Jump Strip when searchQuery matches files/symbols */}
        {viewMode === 'hierarchy' &&
          q.length > 0 &&
          (searchResults.modules.length > 0 ||
            searchResults.files.length > 0 ||
            searchResults.symbols.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-[rgba(59,72,111,0.2)]">
              <span className="font-mono text-[10px] text-[#8B9BB2] mr-1">Jump to:</span>
              {searchResults.modules.slice(0, 3).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => drillToLevel2(m.id)}
                  className="px-2 py-0.5 rounded bg-[#181D2D] border border-[#8B5CF6]/40 text-[11px] font-mono text-[#E2E2EB] hover:border-[#8B5CF6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] inline-flex items-center gap-1"
                >
                  <Box className="w-3 h-3 text-[#8B5CF6]" />
                  <span>{m.name}</span>
                </button>
              ))}
              {searchResults.files.slice(0, 3).map((fp) => (
                <button
                  key={fp}
                  type="button"
                  onClick={() => drillToLevel3(fp)}
                  className="px-2 py-0.5 rounded bg-[#181D2D] border border-[#06B6D4]/40 text-[11px] font-mono text-[#67E8F9] hover:border-[#06B6D4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#06B6D4] inline-flex items-center gap-1"
                >
                  <FileCode2 className="w-3 h-3" />
                  <span>{fp}</span>
                </button>
              ))}
              {searchResults.symbols.slice(0, 3).map((sym, idx) => (
                <button
                  key={`${sym.filePath}:${sym.line}:${idx}`}
                  type="button"
                  onClick={() => drillToLevel3(sym.filePath)}
                  className="px-2 py-0.5 rounded bg-[#181D2D] border border-[#10B981]/40 text-[11px] font-mono text-[#6EE7B7] hover:border-[#10B981] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#10B981] inline-flex items-center gap-1"
                >
                  <FunctionSquare className="w-3 h-3" />
                  <span>
                    {sym.name} ({sym.filePath.split('/').pop()}:L{sym.line})
                  </span>
                </button>
              ))}
            </div>
          )}
      </div>

      {/* Main Content Area */}
      {viewMode === 'flows' ? (
        <div
          role="tabpanel"
          aria-label="Process Flows"
          className="flex-1 min-h-0 flex flex-col @[840px]:flex-row overflow-hidden"
        >
          {/* Left: Workflow Selector + Evidence Legend */}
          <aside className="w-full @[840px]:w-80 shrink-0 ok-glass-panel border-b @[840px]:border-b-0 @[840px]:border-r flex flex-col max-h-[240px] @[840px]:max-h-none overflow-hidden">
            <div className="px-4 py-3 border-b border-[rgba(59,72,111,0.25)]">
              <div className="text-xs font-semibold text-[#F8FAFC]">Detected Process Flows</div>
              <p className="text-[11px] text-[#94A3B8] mt-0.5">
                Grounded execution & request paths derived from indexed files
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
              {filteredFlows.length === 0 ? (
                <div className="p-4 text-xs text-[#8B9BB2] text-center">
                  No process flows match the current filter.
                </div>
              ) : (
                filteredFlows.map((flow) => {
                  const isActive = activeFlow?.id === flow.id;
                  return (
                    <button
                      key={flow.id}
                      type="button"
                      onClick={() => setSelectedFlowId(flow.id)}
                      className={`w-full text-left p-2.5 rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#06B6D4] transition-colors ${
                        isActive
                          ? 'bg-[#1E2438] border-[#06B6D4]/60'
                          : 'bg-[#151926] border-[#2A324B] hover:border-[#3B486F]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="font-mono text-[10px] text-[#06B6D4] uppercase tracking-wider">
                          {flow.sourceKind === 'ai-consolidated' ? 'AI Verified' : 'Static Graph'}
                        </span>
                        <span className="font-mono text-[10px] text-[#8B9BB2]">
                          {flow.steps.length} step{flow.steps.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      <div className="text-xs font-semibold text-[#F8FAFC] leading-snug">
                        {flow.title}
                      </div>
                      <div className="text-[11px] text-[#94A3B8] truncate mt-1">
                        Trigger: {flow.trigger}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
            <div className="p-3 border-t border-[rgba(59,72,111,0.25)] bg-[#0F121C] space-y-1.5">
              <div className="text-[10px] font-mono uppercase tracking-wider text-[#8B9BB2]">
                Evidence Basis Legend
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(['verified-call', 'route-handler', 'import-only', 'inferred'] as FlowEvidenceBasis[]).map(
                  (basis) => (
                    <span
                      key={basis}
                      title={EVIDENCE_BADGE_STYLES[basis].hint}
                      className={`px-1.5 py-0.5 rounded border font-mono text-[10px] ${EVIDENCE_BADGE_STYLES[basis].className}`}
                    >
                      {EVIDENCE_BADGE_STYLES[basis].label}
                    </span>
                  )
                )}
              </div>
            </div>
          </aside>

          {/* Right: Selected Process Flow Sequence */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6">
            {!activeFlow ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-8">
                <Activity className="w-10 h-10 text-[#3B486F] mb-3" />
                <h3 className="text-sm font-semibold text-[#F8FAFC]">No process flows available</h3>
                <p className="text-xs text-[#94A3B8] max-w-md mt-1">
                  Run repository intelligence analysis or inspect modules with HTTP routes, storage calls, or entry imports.
                </p>
              </div>
            ) : (
              <div className="max-w-3xl mx-auto space-y-5">
                <div className="p-4 rounded-xl ok-glass-card border space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-base font-semibold text-[#F8FAFC]">{activeFlow.title}</h2>
                    <span className="px-2 py-0.5 rounded border border-[#2A324B] bg-[#0F121C] font-mono text-[10px] text-[#94A3B8]">
                      {activeFlow.sourceKind === 'ai-consolidated'
                        ? 'Consolidated Source Analysis'
                        : 'Static Code Extraction'}
                    </span>
                  </div>
                  <div className="text-xs font-mono text-[#06B6D4]">
                    Trigger: {activeFlow.trigger}
                  </div>
                  <p className="text-xs text-[#CBD5E1] leading-relaxed">{activeFlow.summary}</p>
                </div>

                {/* Flow Steps Timeline */}
                <div className="space-y-3">
                  {activeFlow.steps.map((step, index) => {
                    const badge =
                      EVIDENCE_BADGE_STYLES[step.evidenceBasis] ?? EVIDENCE_BADGE_STYLES.inferred;
                    return (
                      <div key={`${step.stepNumber}-${step.filePath}-${index}`}>
                        <div className="p-3.5 rounded-xl ok-glass-card-interactive border space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="w-5 h-5 rounded-full bg-[#8B5CF6]/20 border border-[#8B5CF6]/50 font-mono text-[11px] font-semibold text-[#C4B5FD] flex items-center justify-center">
                                {step.stepNumber}
                              </span>
                              <span className="text-xs font-semibold text-[#F8FAFC]">
                                {step.layer}
                              </span>
                            </div>
                            <span
                              title={badge.hint}
                              className={`px-2 py-0.5 rounded border font-mono text-[10px] ${badge.className}`}
                            >
                              {badge.label}
                            </span>
                          </div>
                          <p className="text-xs text-[#E2E2EB] leading-relaxed">{step.action}</p>
                          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => onOpenFileAtLine(step.filePath, step.startLine)}
                              className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[#ADC6FF] hover:text-[#F8FAFC] hover:underline"
                            >
                              <FileCode2 className="w-3.5 h-3.5 text-[#8B5CF6]" />
                              <span>
                                {step.filePath}
                                {step.startLine ? `:L${step.startLine}` : ''}
                              </span>
                              <ExternalLink className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => drillToLevel3(step.filePath)}
                              className="font-mono text-[11px] text-[#94A3B8] hover:text-[#06B6D4] transition-colors"
                            >
                              Inspect in Hierarchy →
                            </button>
                          </div>
                        </div>
                        {index < activeFlow.steps.length - 1 && (
                          <div className="flex justify-center py-1">
                            <ArrowDown className="w-4 h-4 text-[#3B486F]" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Verification Note */}
                <div className="p-3 rounded-lg bg-[#131722] border border-[#2A324B] text-[11px] text-[#94A3B8] leading-relaxed">
                  <span className="font-mono text-[#F59E0B] mr-1.5">Verification Note:</span>
                  {activeFlow.verificationNote}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div
          role="tabpanel"
          aria-label="Architecture Hierarchy Map"
          className="flex-1 relative min-h-0 flex overflow-hidden"
        >
          {activeCanvasNodes.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-6 sm:p-8 text-center">
              <GitBranch className="w-10 h-10 text-[#3B486F] mb-3" />
              <h3 className="text-sm font-semibold text-[#F8FAFC] mb-1">
                {hierarchyLevel === 3 && focusedFilePath && !level3Subgraph?.file
                  ? 'File not indexed for Level 3 exploration'
                  : 'No matching architecture nodes'}
              </h3>
              <p className="text-xs text-[#94A3B8] max-w-md mb-4">
                {hierarchyLevel === 3 && focusedFilePath && !level3Subgraph?.file
                  ? `"${focusedFilePath}" is not among the indexed source files of this repository (it may have been skipped, excluded, or only referenced in an import).`
                  : 'Adjust your search query, zone filter, or enable External Dependencies to explore more modules.'}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {hierarchyLevel === 3 && focusedFilePath && !level3Subgraph?.file && (
                  <>
                    <button
                      type="button"
                      onClick={() => onOpenFileAtLine(focusedFilePath)}
                      className="px-3 py-1.5 rounded-lg bg-[#8B5CF6]/20 border border-[#8B5CF6]/45 hover:bg-[#8B5CF6]/30 text-xs text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors"
                    >
                      Check Status in Code Viewer
                    </button>
                    {focusedModuleMeta && (
                      <button
                        type="button"
                        onClick={() => drillToLevel2(focusedModuleMeta.id)}
                        className="px-3 py-1.5 rounded-lg bg-[#181D2D] border border-[#2A324B] hover:border-[#06B6D4]/50 text-xs text-[#E2E2EB] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors"
                      >
                        Back to {focusedModuleMeta.name} (L2)
                      </button>
                    )}
                  </>
                )}
                <button
                  type="button"
                  onClick={handleResetAll}
                  className="px-3 py-1.5 rounded-lg bg-[#181D2D] border border-[#2A324B] hover:border-[#8B5CF6]/50 text-xs text-[#E2E2EB] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors"
                >
                  {hierarchyLevel === 3 && focusedFilePath && !level3Subgraph?.file
                    ? 'Level 1 System Overview'
                    : 'Reset architecture filters'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 min-w-0 h-full relative">
              <ReactFlow
                nodes={activeCanvasNodes}
                edges={activeCanvasEdges}
                nodeTypes={nodeTypes}
                onNodeClick={(_e, node) => {
                  setInspectorDismissedOnMobile(false);
                  if (hierarchyLevel === 1) {
                    if (node.id.startsWith('zone-header:')) {
                      const z = node.id.replace('zone-header:', '') as ArchZoneId;
                      setZoneFilter((prev) => (prev === z ? 'all' : z));
                      return;
                    }
                    setSelectedModuleId(node.id);
                    setSelectedModuleEdgeId(null);
                  } else {
                    setSelectedSubNodeId(node.id);
                    setSelectedSubEdgeId(null);
                  }
                }}
                onNodeDoubleClick={(_e, node) => {
                  setInspectorDismissedOnMobile(false);
                  if (hierarchyLevel === 1) {
                    if (node.id.startsWith('zone-header:')) return;
                    drillToLevel2(node.id);
                  } else if (hierarchyLevel === 2) {
                    const item = (node.data as SubgraphFlowNodeData)?.item;
                    if (item?.filePath) {
                      drillToLevel3(item.filePath);
                    } else if (item?.moduleId) {
                      drillToLevel2(item.moduleId);
                    }
                  } else if (hierarchyLevel === 3) {
                    const item = (node.data as SubgraphFlowNodeData)?.item;
                    if (item?.kind === 'symbol' && item.filePath) {
                      onOpenFileAtLine(item.filePath, item.line);
                    } else if (item?.filePath && item.filePath !== focusedFilePath) {
                      drillToLevel3(item.filePath);
                    }
                  }
                }}
                onEdgeClick={(_e, edge) => {
                  setInspectorDismissedOnMobile(false);
                  if (hierarchyLevel === 1) {
                    setSelectedModuleEdgeId(edge.id);
                    setSelectedModuleId(null);
                  } else {
                    setSelectedSubEdgeId(edge.id);
                    setSelectedSubNodeId(null);
                  }
                }}
                onPaneClick={clearSelection}
                fitView
                fitViewOptions={{ padding: 0.16 }}
                minZoom={0.18}
                maxZoom={1.9}
              >
                <FitViewTrigger triggerKey={fitTriggerKey} />
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={20}
                  size={1}
                  color="rgba(100, 116, 139, 0.22)"
                />
                <MiniMap
                  className="!hidden sm:!block"
                  nodeColor={getMiniMapNodeColor}
                  maskColor="rgba(11, 13, 19, 0.78)"
                />
              </ReactFlow>

              <ZoomActionBar />

              {showInspector && inspectorDismissedOnMobile && (
                <button
                  type="button"
                  onClick={() => setInspectorDismissedOnMobile(false)}
                  aria-label="Open architecture details panel"
                  className="absolute bottom-3 right-3 z-10 @[960px]:hidden px-3 py-1.5 rounded-lg ok-glass-floating border text-xs font-medium text-[#F8FAFC] hover:border-[#8B5CF6]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors"
                >
                  Details
                </button>
              )}

              <div className="absolute bottom-3 left-36 sm:left-44 z-10 pointer-events-none hidden @[720px]:block">
                <div className="ok-glass-floating border rounded-lg px-3 py-1.5 text-[11px] font-mono text-[#94A3B8]">
                  {hierarchyLevel === 1
                    ? 'Click module to inspect · Double-click to explore files (Level 2)'
                    : hierarchyLevel === 2
                    ? 'Double-click any file to inspect functions & imports (Level 3)'
                    : 'Click any line or symbol to open in Code Viewer'}
                </div>
              </div>
            </div>
          )}

          {/* Right Compact Architecture Details Panel */}
          {showInspector && (
            <aside
              aria-label="Architecture details inspector"
              className={`absolute inset-y-0 right-0 z-20 w-full max-w-[340px] @[960px]:static @[960px]:w-84 shrink-0 ok-glass-panel border-l shadow-2xl @[960px]:shadow-none flex-col overflow-hidden ${
                inspectorDismissedOnMobile ? 'hidden @[960px]:flex' : 'flex'
              }`}
            >
              <div className="px-4 py-3 border-b border-[rgba(59,72,111,0.25)] flex items-center justify-between shrink-0">
                <span className="text-xs font-semibold text-[#F8FAFC]">
                  {hierarchyLevel === 1 && selectedModuleEdge
                    ? 'Dependency Connection'
                    : hierarchyLevel === 3
                    ? 'File & Symbol Inspector'
                    : 'Module Details'}
                </span>
                <div className="flex items-center gap-1">
                  {hierarchyLevel > 1 && (
                    <button
                      type="button"
                      onClick={drillToLevel1}
                      className="@[960px]:hidden px-2 py-1 rounded text-[11px] font-mono text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                    >
                      L1
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="Close details panel"
                    onClick={() => {
                      if (typeof window !== 'undefined' && window.innerWidth < 960) {
                        setInspectorDismissedOnMobile(true);
                        return;
                      }
                      if (hierarchyLevel === 1) {
                        clearSelection();
                      } else {
                        drillToLevel1();
                      }
                    }}
                    className="p-1.5 rounded text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#1E2438] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
                {/* LEVEL 1 EDGE DETAILS */}
                {hierarchyLevel === 1 && selectedModuleEdge && (
                  <>
                    <div className="p-3 rounded-lg bg-[#0F121C] border border-[#2A324B] space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[10px] text-[#8B9BB2]">Evidence Basis</span>
                        <span
                          className={`px-1.5 py-0.5 rounded border font-mono text-[10px] ${
                            EVIDENCE_BADGE_STYLES[selectedModuleEdge.evidenceBasis].className
                          }`}
                        >
                          {EVIDENCE_BADGE_STYLES[selectedModuleEdge.evidenceBasis].label}
                        </span>
                      </div>
                      <div className="text-xs font-semibold text-[#F8FAFC]">
                        {hierarchy.modules.find((m) => m.id === selectedModuleEdge.source)?.name ??
                          selectedModuleEdge.source}{' '}
                        →{' '}
                        {hierarchy.modules.find((m) => m.id === selectedModuleEdge.target)?.name ??
                          selectedModuleEdge.target}
                      </div>
                      <div className="font-mono text-[11px] text-[#94A3B8]">
                        {selectedModuleEdge.importCount} observed reference(s)
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="text-[11px] font-medium text-[#94A3B8]">
                        Supporting Source Evidence ({selectedModuleEdge.evidences.length})
                      </div>
                      {selectedModuleEdge.evidences.map((ev, i) => (
                        <div
                          key={i}
                          className="p-2.5 rounded-lg bg-[#0F121C] border border-[rgba(59,72,111,0.3)] space-y-1"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => onOpenFileAtLine(ev.sourcePath, ev.line)}
                              className="font-mono text-[11px] text-[#ADC6FF] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded truncate text-left"
                            >
                              {ev.sourcePath}:L{ev.line}
                            </button>
                            <ExternalLink className="w-3 h-3 text-[#8B9BB2] shrink-0" />
                          </div>
                          <pre className="font-mono text-[10px] text-[#E2E2EB] whitespace-pre-wrap break-all bg-[#151926] p-1.5 rounded">
                            {ev.rawStatement}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* LEVEL 1 or LEVEL 2 MODULE DETAILS */}
                {((hierarchyLevel === 1 && !selectedModuleEdge && selectedModule) ||
                  (hierarchyLevel === 2 && selectedModule && !selectedSubEdge && (!selectedSubNode || selectedSubNode.kind === 'external'))) && (
                  <>
                    <div className="p-3 rounded-lg bg-[#0F121C] border border-[#2A324B] space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="px-2 py-0.5 rounded font-mono text-[10px] border border-[#2A324B] text-[#E2E2EB]"
                          style={{
                            borderLeftWidth: 3,
                            borderLeftColor: ARCH_ZONE_META[selectedModule.zone].accentHex,
                          }}
                        >
                          {ARCH_ZONE_META[selectedModule.zone].label}
                        </span>
                        <span className="font-mono text-[10px] text-[#8B9BB2]">
                          {selectedModule.kind === 'external'
                            ? 'external'
                            : `${selectedModule.files.length} files`}
                        </span>
                      </div>
                      <div className="text-sm font-semibold text-[#F8FAFC]">
                        {selectedModule.name}
                      </div>
                      <p className="text-xs text-[#CBD5E1] leading-relaxed">
                        {selectedModule.responsibility}
                      </p>

                      {hierarchyLevel === 1 && (
                        <button
                          type="button"
                          onClick={() => drillToLevel2(selectedModule.id)}
                          className="mt-1 w-full py-1.5 px-3 rounded-md bg-[#8B5CF6]/20 border border-[#8B5CF6]/50 text-[#F8FAFC] font-medium text-xs hover:bg-[#8B5CF6]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] inline-flex items-center justify-center gap-1.5 transition-colors"
                        >
                          <span>Explore Module Files (Level 2)</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    {/* Files inside Module */}
                    {selectedModule.files.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-[11px] font-medium text-[#94A3B8]">
                          Important Files ({selectedModule.files.length})
                        </div>
                        <div className="space-y-1 max-h-52 overflow-y-auto pr-0.5">
                          {selectedModule.files.map((f) => (
                            <div
                              key={f.path}
                              className="flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded bg-[#0F121C] border border-[rgba(59,72,111,0.25)] hover:border-[#8B5CF6]/45"
                            >
                              <button
                                type="button"
                                onClick={() => drillToLevel3(f.path)}
                                className="font-mono text-[11px] text-[#E2E2EB] hover:text-[#67E8F9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#06B6D4] rounded truncate text-left flex-1"
                                title={`Inspect ${f.path} in Level 3`}
                              >
                                {f.path}
                              </button>
                              <button
                                type="button"
                                onClick={() => onOpenFileAtLine(f.path)}
                                title="Open in Code Viewer"
                                aria-label={`Open ${f.path} in Code Viewer`}
                                className="p-1 rounded text-[#8B9BB2] hover:text-[#ADC6FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] shrink-0"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Endpoints & Key Symbols */}
                    {(selectedModule.endpoints.length > 0 || selectedModule.symbols.length > 0) && (
                      <div className="space-y-1.5">
                        <div className="text-[11px] font-medium text-[#94A3B8]">
                          Key Symbols & Endpoints ({selectedModule.symbols.length})
                        </div>
                        <div className="space-y-1 max-h-40 overflow-y-auto pr-0.5">
                          {selectedModule.symbols.slice(0, 12).map((sym, idx) => (
                            <button
                              key={`${sym.filePath}:${sym.line}:${idx}`}
                              type="button"
                              onClick={() => onOpenFileAtLine(sym.filePath, sym.line)}
                              className="w-full flex items-center justify-between gap-2 px-2.5 py-1 rounded bg-[#0F121C] border border-[rgba(59,72,111,0.22)] hover:border-[#06B6D4]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#06B6D4] text-left"
                            >
                              <span className="font-mono text-[11px] text-[#CBD5E1] truncate">
                                {sym.name}
                              </span>
                              <span className="font-mono text-[10px] text-[#06B6D4] shrink-0">
                                L{sym.line}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* External Integrations */}
                    {selectedModule.externalPackages.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-[11px] font-medium text-[#94A3B8]">
                          External Packages ({selectedModule.externalPackages.length})
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {selectedModule.externalPackages.map((pkg) => (
                            <span
                              key={pkg}
                              className="px-2 py-0.5 rounded bg-[#0F121C] border border-[#2A324B] font-mono text-[10px] text-[#ADC6FF]"
                            >
                              {pkg}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Incoming & Outgoing Module Connections */}
                    <div className="space-y-2">
                      <div className="text-[11px] font-medium text-[#94A3B8]">
                        Incoming Dependencies ({selectedModuleNeighbors.incoming.length})
                      </div>
                      {selectedModuleNeighbors.incoming.length === 0 ? (
                        <p className="text-[11px] text-[#8B9BB2]">No incoming module imports.</p>
                      ) : (
                        <div className="space-y-1">
                          {selectedModuleNeighbors.incoming.map((edge) => {
                            const srcMod = hierarchy.modules.find((m) => m.id === edge.source);
                            return (
                              <button
                                key={edge.id}
                                type="button"
                                onClick={() =>
                                  hierarchyLevel === 2 && srcMod
                                    ? drillToLevel2(srcMod.id)
                                    : setSelectedModuleEdgeId(edge.id)
                                }
                                className="w-full text-left px-2.5 py-1.5 rounded bg-[#0F121C] border border-[rgba(59,72,111,0.25)] hover:border-[#06B6D4]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#06B6D4] font-mono text-[11px] text-[#CBD5E1] flex items-center justify-between gap-2"
                              >
                                <span className="truncate">← {srcMod?.name ?? edge.source}</span>
                                <span className="text-[10px] text-[#8B9BB2] shrink-0">
                                  {edge.importCount}x
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="text-[11px] font-medium text-[#94A3B8]">
                        Outgoing Dependencies ({selectedModuleNeighbors.outgoing.length})
                      </div>
                      {selectedModuleNeighbors.outgoing.length === 0 ? (
                        <p className="text-[11px] text-[#8B9BB2]">No outgoing module imports.</p>
                      ) : (
                        <div className="space-y-1">
                          {selectedModuleNeighbors.outgoing.map((edge) => {
                            const tgtMod = hierarchy.modules.find((m) => m.id === edge.target);
                            return (
                              <button
                                key={edge.id}
                                type="button"
                                onClick={() =>
                                  hierarchyLevel === 2 && tgtMod
                                    ? drillToLevel2(tgtMod.id)
                                    : setSelectedModuleEdgeId(edge.id)
                                }
                                className="w-full text-left px-2.5 py-1.5 rounded bg-[#0F121C] border border-[rgba(59,72,111,0.25)] hover:border-[#8B5CF6]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] font-mono text-[11px] text-[#CBD5E1] flex items-center justify-between gap-2"
                              >
                                <span className="truncate">→ {tgtMod?.name ?? edge.target}</span>
                                <span className="text-[10px] text-[#8B9BB2] shrink-0">
                                  {edge.importCount}x
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* LEVEL 2 SELECTED SUBGRAPH EDGE OR FILE NODE */}
                {hierarchyLevel === 2 && selectedSubEdge?.rawEdge && renderRawEdgeBlock(selectedSubEdge.rawEdge)}

                {hierarchyLevel === 2 &&
                  !selectedSubEdge &&
                  selectedSubNode &&
                  selectedSubNode.kind !== 'external' &&
                  selectedSubNode.filePath && (
                    <div className="space-y-3">
                      <div className="p-3 rounded-lg bg-[#0F121C] border border-[#2A324B] space-y-2">
                        <div className="font-mono text-xs font-semibold text-[#F8FAFC] break-all">
                          {selectedSubNode.filePath}
                        </div>
                        <div className="font-mono text-[11px] text-[#94A3B8]">
                          {selectedSubNode.sublabel}
                        </div>
                        <div className="flex flex-col gap-1.5 pt-1">
                          <button
                            type="button"
                            onClick={() => drillToLevel3(selectedSubNode.filePath!)}
                            className="w-full py-1.5 px-3 rounded-md bg-[#8B5CF6]/20 border border-[#8B5CF6]/50 text-[#F8FAFC] font-medium text-xs hover:bg-[#8B5CF6]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] inline-flex items-center justify-center gap-1.5 transition-colors"
                          >
                            <span>Inspect File & Functions (Level 3)</span>
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onOpenFileAtLine(selectedSubNode.filePath!, selectedSubNode.line)
                            }
                            className="w-full py-1.5 px-3 rounded-md bg-[#181D2D] border border-[#2A324B] text-[#E2E2EB] font-medium text-xs hover:border-[#3B82F6]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] inline-flex items-center justify-center gap-1.5 transition-colors"
                          >
                            <span>Open in Code Viewer</span>
                            <ExternalLink className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                {/* LEVEL 3: FILE & SYMBOLS INSPECTOR */}
                {hierarchyLevel === 3 && selectedSubEdge?.rawEdge && renderRawEdgeBlock(selectedSubEdge.rawEdge)}

                {hierarchyLevel === 3 &&
                  !selectedSubEdge &&
                  focusedFilePath &&
                  !level3Subgraph?.file && (
                    <div className="p-3 rounded-lg bg-[#0F121C] border border-[#F59E0B]/45 space-y-2.5">
                      <div className="font-mono text-[10px] uppercase tracking-wider text-[#F59E0B]">
                        File Unavailable in Index
                      </div>
                      <div className="font-mono text-xs text-[#F8FAFC] break-all">
                        {focusedFilePath}
                      </div>
                      <p className="text-xs text-[#94A3B8] leading-relaxed">
                        Level 3 inspection requires indexed file source content. Open in Code Viewer to view why it was skipped or return to the parent module.
                      </p>
                      <div className="flex flex-col gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenFileAtLine(focusedFilePath)}
                          className="w-full py-1.5 px-3 rounded-md bg-[#8B5CF6]/20 border border-[#8B5CF6]/50 text-[#F8FAFC] font-medium text-xs hover:bg-[#8B5CF6]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] transition-colors"
                        >
                          Check Status in Code Viewer
                        </button>
                        {focusedModuleMeta && (
                          <button
                            type="button"
                            onClick={() => drillToLevel2(focusedModuleMeta.id)}
                            className="w-full py-1.5 px-3 rounded-md bg-[#181D2D] border border-[#2A324B] text-[#E2E2EB] font-medium text-xs hover:border-[#06B6D4]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#06B6D4] transition-colors"
                          >
                            Return to Module (Level 2)
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                {hierarchyLevel === 3 && !selectedSubEdge && level3Subgraph?.file && (
                  <>
                    {selectedSymbol && (
                      <div className="p-3 rounded-lg bg-[#0F121C] border border-[#10B981]/60 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[10px] text-[#10B981] uppercase">
                            Selected Symbol · {selectedSymbol.kind}
                          </span>
                          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#10B981]/15 text-[#6EE7B7]">
                            Line {selectedSymbol.line}
                          </span>
                        </div>
                        <div className="font-mono text-xs font-semibold text-[#F8FAFC] break-all">
                          {selectedSymbol.name}
                        </div>
                        <div className="font-mono text-[11px] text-[#94A3B8] break-all">
                          {selectedSymbol.filePath}
                        </div>
                        {selectedSymbol.detail && (
                          <pre className="font-mono text-[10px] text-[#E2E2EB] whitespace-pre-wrap break-all bg-[#151926] p-2 rounded border border-[rgba(59,72,111,0.25)]">
                            {selectedSymbol.detail}
                          </pre>
                        )}
                        <div className="flex items-center gap-2 pt-0.5">
                          <button
                            type="button"
                            onClick={() => onOpenFileAtLine(selectedSymbol.filePath, selectedSymbol.line)}
                            className="flex-1 py-1.5 px-2.5 rounded-md bg-[#10B981]/20 border border-[#10B981]/50 text-[11px] font-medium text-[#F8FAFC] hover:bg-[#10B981]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#10B981] inline-flex items-center justify-center gap-1.5 transition-colors"
                          >
                            <span>Jump to Line {selectedSymbol.line}</span>
                            <ExternalLink className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setSelectedSubNodeId(null)}
                            aria-label="Clear selected symbol"
                            className="p-1.5 rounded-md bg-[#181D2D] border border-[#2A324B] text-[#94A3B8] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    )}

                    {selectedSubNode &&
                      selectedSubNode.id !== `l3:center:${level3Subgraph.file.path}` &&
                      selectedSubNode.filePath &&
                      selectedSubNode.kind !== 'symbol' && (
                        <div className="p-3 rounded-lg bg-[#0F121C] border border-[#06B6D4]/50 space-y-2">
                          <div className="font-mono text-[10px] text-[#06B6D4] uppercase">
                            Selected Related File
                          </div>
                          <div className="font-mono text-xs text-[#F8FAFC] break-all">
                            {selectedSubNode.filePath}
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => drillToLevel3(selectedSubNode.filePath!)}
                              className="flex-1 py-1 px-2.5 rounded bg-[#06B6D4]/20 border border-[#06B6D4]/45 text-[11px] text-[#67E8F9] hover:bg-[#06B6D4]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#06B6D4]"
                            >
                              Focus File
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                onOpenFileAtLine(selectedSubNode.filePath!, selectedSubNode.line)
                              }
                              className="py-1 px-2.5 rounded bg-[#181D2D] border border-[#2A324B] text-[11px] text-[#E2E2EB] hover:border-[#8B5CF6]/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                            >
                              Open
                            </button>
                          </div>
                        </div>
                      )}

                    <div className="p-3 rounded-lg bg-[#0F121C] border border-[#2A324B] space-y-2">
                      <div className="font-mono text-xs font-semibold text-[#F8FAFC] break-all">
                        {level3Subgraph.file.path}
                      </div>
                      <div className="font-mono text-[11px] text-[#94A3B8]">
                        {level3Subgraph.file.language} · {level3Subgraph.file.lines} lines ·{' '}
                        {level3Subgraph.symbolMeta.truncated
                          ? `${level3Subgraph.symbolMeta.shownCount}/${level3Subgraph.symbolMeta.totalDetected}`
                          : level3Subgraph.symbols.length}{' '}
                        symbols
                      </div>
                      <button
                        type="button"
                        onClick={() => onOpenFileAtLine(level3Subgraph.file!.path)}
                        className="mt-1 w-full py-1.5 px-3 rounded-md bg-[#8B5CF6]/20 border border-[#8B5CF6]/50 text-[#F8FAFC] font-medium text-xs hover:bg-[#8B5CF6]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] inline-flex items-center justify-center gap-1.5 transition-colors"
                      >
                        <span>Open File in Code Viewer</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Extracted Functions, Classes, Components, Endpoints */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-[#94A3B8]">
                          Extracted Symbols & Endpoints ({level3Subgraph.symbols.length})
                        </span>
                        {level3Subgraph.symbolMeta.truncated && (
                          <span
                            title="Prioritized endpoints, storage definitions, classes, components, and exported functions"
                            className="font-mono text-[10px] text-[#F59E0B]"
                          >
                            Top {level3Subgraph.symbolMeta.shownCount} of{' '}
                            {level3Subgraph.symbolMeta.totalDetected}
                          </span>
                        )}
                      </div>
                      {level3Subgraph.symbolMeta.truncated && (
                        <p className="text-[10px] font-mono text-[#94A3B8] bg-[#0F121C] border border-[#2A324B] rounded px-2 py-1">
                          Showing top {level3Subgraph.symbolMeta.shownCount} of{' '}
                          {level3Subgraph.symbolMeta.totalDetected} detected symbols (prioritizing endpoints, storage, classes, components & exports).
                        </p>
                      )}
                      {level3Subgraph.symbols.length === 0 ? (
                        <p className="text-[11px] text-[#8B9BB2]">
                          No functions, classes, components, or route handlers extracted in this file.
                        </p>
                      ) : (
                        <div className="space-y-1 max-h-60 overflow-y-auto pr-0.5">
                          {level3Subgraph.symbols.map((sym, idx) => {
                            const isSymSelected =
                              selectedSymbol !== null &&
                              selectedSymbol.name === sym.name &&
                              selectedSymbol.line === sym.line;
                            return (
                              <button
                                key={`${sym.kind}-${sym.name}-${sym.line}-${idx}`}
                                type="button"
                                onClick={() => onOpenFileAtLine(sym.filePath, sym.line)}
                                className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded border text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#10B981] transition-colors ${
                                  isSymSelected
                                    ? 'bg-[#10B981]/12 border-[#10B981]/70'
                                    : 'bg-[#0F121C] border-[rgba(59,72,111,0.25)] hover:border-[#10B981]/50'
                                }`}
                              >
                                <div className="min-w-0 flex items-center gap-1.5">
                                  <Sparkles className="w-3 h-3 text-[#10B981] shrink-0" />
                                  <span className="font-mono text-[11px] text-[#E2E2EB] truncate">
                                    {sym.name}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <span className="font-mono text-[10px] text-[#8B9BB2]">
                                    {sym.kind}
                                  </span>
                                  <span className="font-mono text-[10px] text-[#06B6D4]">
                                    L{sym.line}
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Imported By */}
                    <div className="space-y-1.5">
                      <div className="text-[11px] font-medium text-[#94A3B8]">
                        Imported By ({level3Subgraph.incomingEdges.length})
                      </div>
                      {level3Subgraph.incomingEdges.length === 0 ? (
                        <p className="text-[11px] text-[#8B9BB2]">No ingested files import this.</p>
                      ) : (
                        <div className="space-y-1">
                          {level3Subgraph.incomingEdges.map((edge) => (
                            <button
                              key={edge.id}
                              type="button"
                              onClick={() => onOpenFileAtLine(edge.sourcePath, edge.evidences[0]?.line)}
                              className="w-full text-left px-2.5 py-1.5 rounded bg-[#0F121C] border border-[rgba(59,72,111,0.25)] hover:border-[#06B6D4]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#06B6D4] font-mono text-[11px] text-[#CBD5E1] flex items-center justify-between gap-2"
                            >
                              <span className="truncate">← {edge.sourcePath}</span>
                              <span className="text-[10px] text-[#06B6D4] shrink-0">
                                L{edge.evidences[0]?.line ?? 1}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Outgoing Imports */}
                    <div className="space-y-1.5">
                      <div className="text-[11px] font-medium text-[#94A3B8]">
                        Outgoing Imports ({level3Subgraph.outgoingEdges.length})
                      </div>
                      {level3Subgraph.outgoingEdges.length === 0 ? (
                        <p className="text-[11px] text-[#8B9BB2]">No outgoing static imports.</p>
                      ) : (
                        <div className="space-y-1">
                          {level3Subgraph.outgoingEdges.map((edge) => (
                            <button
                              key={edge.id}
                              type="button"
                              onClick={() =>
                                edge.targetKind === 'internal'
                                  ? drillToLevel3(edge.targetPath)
                                  : onOpenFileAtLine(edge.sourcePath, edge.evidences[0]?.line)
                              }
                              className="w-full text-left px-2.5 py-1.5 rounded bg-[#0F121C] border border-[rgba(59,72,111,0.25)] hover:border-[#8B5CF6]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] font-mono text-[11px] text-[#CBD5E1] flex items-center justify-between gap-2"
                            >
                              <span className="truncate">→ {edge.targetPath}</span>
                              <span className="text-[10px] text-[#8B9BB2] shrink-0">
                                L{edge.evidences[0]?.line ?? 1}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

export const ArchitectureTab = memo(function ArchitectureTab(props: ArchitectureTabProps) {
  return (
    <ReactFlowProvider>
      <ArchitectureExplorerInner {...props} />
    </ReactFlowProvider>
  );
});

export default ArchitectureTab;
