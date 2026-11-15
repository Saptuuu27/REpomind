import type {
  ArchitectureEdge,
  ArchitectureEdgeEvidence,
  RepositoryRecord,
  SourceCitation,
  SourceFile,
} from '../types';

export type ArchZoneId =
  | 'frontend'
  | 'api'
  | 'backend'
  | 'services'
  | 'storage'
  | 'external'
  | 'infra';

export interface ArchZoneMeta {
  id: ArchZoneId;
  label: string;
  shortLabel: string;
  description: string;
  accentHex: string;
}

export const ARCH_ZONE_META: Record<ArchZoneId, ArchZoneMeta> = {
  frontend: {
    id: 'frontend',
    label: 'Frontend / Client',
    shortLabel: 'Frontend',
    description: 'UI views, pages, components, client contexts, and native shells',
    accentHex: '#8B5CF6',
  },
  api: {
    id: 'api',
    label: 'API / Routes',
    shortLabel: 'API / Routes',
    description: 'HTTP route handlers, REST endpoints, and request controllers',
    accentHex: '#06B6D4',
  },
  backend: {
    id: 'backend',
    label: 'Backend / Server',
    shortLabel: 'Backend',
    description: 'Server entry points, middleware, and runtime orchestration',
    accentHex: '#3B82F6',
  },
  services: {
    id: 'services',
    label: 'Services / Business Logic',
    shortLabel: 'Services',
    description: 'Core domain logic, utilities, parsers, and helper modules',
    accentHex: '#A78BFA',
  },
  storage: {
    id: 'storage',
    label: 'Database / Storage',
    shortLabel: 'Storage',
    description: 'Database clients, models, schemas, static data stores, and local persistence',
    accentHex: '#F59E0B',
  },
  external: {
    id: 'external',
    label: 'External Integrations',
    shortLabel: 'External',
    description: 'Third-party APIs, AI SDKs, frameworks, and runtime packages',
    accentHex: '#10B981',
  },
  infra: {
    id: 'infra',
    label: 'Build / Infrastructure',
    shortLabel: 'Build / Infra',
    description: 'Build configs, manifests, native build scripts, and deployment files',
    accentHex: '#94A3B8',
  },
};

export const ARCH_ZONE_ORDER: ArchZoneId[] = [
  'frontend',
  'api',
  'backend',
  'services',
  'storage',
  'external',
  'infra',
];

export type FlowEvidenceBasis = 'verified-call' | 'route-handler' | 'import-only' | 'inferred';

export interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'component' | 'endpoint' | 'storage' | 'network';
  filePath: string;
  line: number;
  detail?: string;
  exported?: boolean;
}

export interface FileSymbolMeta {
  totalDetected: number;
  shownCount: number;
  truncated: boolean;
}

export interface ArchModule {
  id: string;
  name: string;
  zone: ArchZoneId;
  directoryKey: string;
  kind: 'internal' | 'external';
  responsibility: string;
  files: SourceFile[];
  totalLines: number;
  symbols: CodeSymbol[];
  endpoints: Array<{ method: string; route: string; filePath: string; line: number }>;
  externalPackages: string[];
  evidence: SourceCitation[];
  inDegree: number;
  outDegree: number;
  position: { x: number; y: number };
}

export interface ArchModuleEdge {
  id: string;
  source: string;
  target: string;
  kind: 'internal' | 'external';
  evidenceBasis: FlowEvidenceBasis;
  importCount: number;
  evidences: Array<{
    sourcePath: string;
    targetPath: string;
    line: number;
    rawStatement: string;
  }>;
}

export interface ArchProcessFlow {
  id: string;
  title: string;
  trigger: string;
  summary: string;
  sourceKind: 'ai-consolidated' | 'static-verified';
  steps: Array<{
    stepNumber: number;
    layer: string;
    action: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
    evidenceBasis: FlowEvidenceBasis;
  }>;
  verificationNote: string;
}

export interface ArchitectureHierarchy {
  modules: ArchModule[];
  moduleEdges: ArchModuleEdge[];
  activeZones: ArchZoneId[];
  fileToModuleId: Map<string, string>;
  fileInternals: Map<string, CodeSymbol[]>;
  fileSymbolMeta: Map<string, FileSymbolMeta>;
  processFlows: ArchProcessFlow[];
  stats: {
    totalFiles: number;
    totalModules: number;
    activeZonesCount: number;
    internalModuleEdges: number;
    externalModuleEdges: number;
  };
}

const MAX_LEVEL1_NODES = 26;
const MAX_SYMBOLS_PER_FILE = 60;

function isInfraFile(file: SourceFile): boolean {
  const lower = file.path.toLowerCase();
  const base = file.name.toLowerCase();
  if (
    base === 'package.json' ||
    base.startsWith('tsconfig') ||
    base.startsWith('vite.config') ||
    base.startsWith('webpack.config') ||
    base.startsWith('next.config') ||
    base.startsWith('tailwind.config') ||
    base.startsWith('postcss.config') ||
    base.startsWith('capacitor.config') ||
    base === 'dockerfile' ||
    base.startsWith('docker-compose') ||
    base === 'makefile' ||
    base === 'pyproject.toml' ||
    base === 'cargo.toml' ||
    base === 'go.mod' ||
    base === '.env.example' ||
    base === '.gitignore' ||
    base.endsWith('.gradle') ||
    base.endsWith('.properties') ||
    base === 'proguard-rules.pro'
  ) {
    return true;
  }
  if (
    lower.startsWith('.github/') ||
    lower.includes('/gradle/') ||
    lower.includes('gradle-wrapper')
  ) {
    return true;
  }
  return false;
}

function symbolPriorityRank(sym: CodeSymbol): number {
  if (sym.kind === 'endpoint') return 0;
  if (sym.kind === 'storage') return 1;
  if (sym.kind === 'component' || sym.kind === 'class') return 2;
  if (sym.kind === 'network') return 3;
  if (sym.kind === 'function' && sym.exported) return 3;
  return 4;
}

export function extractFileInternalsWithMeta(file: SourceFile): {
  symbols: CodeSymbol[];
  meta: FileSymbolMeta;
} {
  const symbols: CodeSymbol[] = [];
  const seen = new Set<string>();
  const lines = file.content.split('\n');
  const ext = file.extension.toLowerCase();

  const pushSymbol = (sym: CodeSymbol) => {
    const key = `${sym.kind}:${sym.name}:${sym.line}`;
    if (!seen.has(key)) {
      seen.add(key);
      symbols.push(sym);
    }
  };

  let gqlOperationSection: 'Query' | 'Mutation' | 'Subscription' | null = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;

    // Schema languages: SQL, Prisma, GraphQL
    if (ext === '.sql') {
      if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('/*')) continue;
      const ddlMatch = /^(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(TABLE|VIEW|INDEX|TYPE|SCHEMA|FUNCTION|TRIGGER|POLICY)|ALTER\s+(TABLE))\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."`]+)/i.exec(
        trimmed
      );
      if (ddlMatch) {
        const verb = ddlMatch[1] ? `CREATE ${ddlMatch[1].toUpperCase()}` : 'ALTER TABLE';
        pushSymbol({
          name: `${verb} ${ddlMatch[3]}`,
          kind: 'storage',
          filePath: file.path,
          line: lineNum,
          detail: trimmed.slice(0, 120),
          exported: true,
        });
      }
      continue;
    }

    if (ext === '.prisma') {
      if (!trimmed || trimmed.startsWith('//')) continue;
      const prismaDecl = /^(model|enum|type|datasource|generator|view)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
        trimmed
      );
      if (prismaDecl) {
        pushSymbol({
          name: `${prismaDecl[1]} ${prismaDecl[2]}`,
          kind: 'storage',
          filePath: file.path,
          line: lineNum,
          detail: trimmed.slice(0, 120),
          exported: true,
        });
      }
      continue;
    }

    if (ext === '.graphql' || ext === '.gql') {
      if (!trimmed || trimmed.startsWith('#')) continue;
      const gqlType = /^(?:extend\s+)?(type|input|interface|enum|union|scalar|schema)\s*([A-Za-z_][A-Za-z0-9_]*)?/.exec(
        trimmed
      );
      if (gqlType) {
        const kw = gqlType[1];
        const typeName = gqlType[2] ?? kw;
        if (typeName === 'Query' || typeName === 'Mutation' || typeName === 'Subscription') {
          gqlOperationSection = typeName;
          braceDepth = (trimmed.match(/\{/g)?.length ?? 0) - (trimmed.match(/\}/g)?.length ?? 0);
          pushSymbol({
            name: `${kw} ${typeName}`,
            kind: 'endpoint',
            filePath: file.path,
            line: lineNum,
            detail: trimmed.slice(0, 120),
            exported: true,
          });
        } else {
          gqlOperationSection = null;
          pushSymbol({
            name: `${kw} ${typeName}`,
            kind: kw === 'schema' ? 'storage' : 'class',
            filePath: file.path,
            line: lineNum,
            detail: trimmed.slice(0, 120),
            exported: true,
          });
        }
        continue;
      }

      if (gqlOperationSection) {
        braceDepth += (trimmed.match(/\{/g)?.length ?? 0) - (trimmed.match(/\}/g)?.length ?? 0);
        const opField = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|:)/.exec(trimmed);
        if (opField) {
          pushSymbol({
            name: `${gqlOperationSection.toUpperCase()} ${opField[1]}`,
            kind: 'endpoint',
            filePath: file.path,
            line: lineNum,
            detail: trimmed.slice(0, 120),
            exported: true,
          });
        }
        if (braceDepth <= 0) {
          gqlOperationSection = null;
        }
      } else {
        const namedOp = /^(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
        if (namedOp) {
          pushSymbol({
            name: `${namedOp[1].toUpperCase()} ${namedOp[2]}`,
            kind: 'network',
            filePath: file.path,
            line: lineNum,
            detail: trimmed.slice(0, 120),
            exported: true,
          });
        }
      }
      continue;
    }

    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
      continue;
    }

    // HTTP endpoints (Express / Fastify / Hono / Flask / FastAPI / Next.js)
    const expressRoute = /\b(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/i.exec(
      line
    );
    if (expressRoute) {
      pushSymbol({
        name: `${expressRoute[1].toUpperCase()} ${expressRoute[2]}`,
        kind: 'endpoint',
        filePath: file.path,
        line: lineNum,
        detail: trimmed.slice(0, 120),
        exported: true,
      });
    }

    const pyRoute = /@(?:app|router)\.(get|post|put|patch|delete|route)\s*\(\s*['"]([^'"]+)['"]/i.exec(
      line
    );
    if (pyRoute) {
      pushSymbol({
        name: `${pyRoute[1].toUpperCase()} ${pyRoute[2]}`,
        kind: 'endpoint',
        filePath: file.path,
        line: lineNum,
        detail: trimmed.slice(0, 120),
        exported: true,
      });
    }

    if (ext === '.go') {
      const goRoute = /\b(?:HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)"/.exec(line);
      if (goRoute) {
        pushSymbol({
          name: `ROUTE ${goRoute[1]}`,
          kind: 'endpoint',
          filePath: file.path,
          line: lineNum,
          detail: trimmed.slice(0, 120),
          exported: true,
        });
      }
    }

    // Client / Server fetch / axios calls
    const fetchMatch = /\bfetch\s*\(\s*['"`]([^'"`]+)['"`]/.exec(line);
    if (fetchMatch) {
      pushSymbol({
        name: `fetch(${fetchMatch[1]})`,
        kind: 'network',
        filePath: file.path,
        line: lineNum,
        detail: trimmed.slice(0, 120),
      });
    }

    // Storage declarations & DB client calls
    if (
      /\b(?:localStorage\.(?:getItem|setItem|removeItem)|indexedDB\.open|MongoClient|mongoose\.(?:model|Schema|connect)|prisma\.|supabase\.from|pg\.Pool|new\s+Pool\s*\()/.test(
        line
      )
    ) {
      const m = /(localStorage\.\w+|indexedDB\.open|MongoClient|mongoose\.\w+|prisma\.\w+|supabase\.from|pg\.Pool|new\s+Pool)/.exec(
        line
      );
      if (m) {
        pushSymbol({
          name: m[1],
          kind: 'storage',
          filePath: file.path,
          line: lineNum,
          detail: trimmed.slice(0, 120),
          exported: true,
        });
      }
    }

    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      const isExported = /^export\s+/.test(trimmed);
      const fnMatch = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(
        trimmed
      );
      if (fnMatch) {
        const name = fnMatch[1];
        const isComp = (ext === '.tsx' || ext === '.jsx') && /^[A-Z]/.test(name);
        pushSymbol({
          name,
          kind: isComp ? 'component' : 'function',
          filePath: file.path,
          line: lineNum,
          detail: trimmed.slice(0, 120),
          exported: isExported,
        });
        continue;
      }

      const arrowMatch = /^(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?=>/.exec(
        trimmed
      );
      if (arrowMatch) {
        const name = arrowMatch[1];
        const isComp = (ext === '.tsx' || ext === '.jsx') && /^[A-Z]/.test(name);
        pushSymbol({
          name,
          kind: isComp ? 'component' : 'function',
          filePath: file.path,
          line: lineNum,
          detail: trimmed.slice(0, 120),
          exported: isExported,
        });
        continue;
      }

      const classMatch = /^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
        trimmed
      );
      if (classMatch) {
        pushSymbol({
          name: classMatch[1],
          kind: 'class',
          filePath: file.path,
          line: lineNum,
          detail: trimmed.slice(0, 120),
          exported: isExported,
        });
      }
    } else if (ext === '.py') {
      const pyFn = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(trimmed);
      if (pyFn) {
        const isTopLevel = !/^\s/.test(line) && !pyFn[1].startsWith('_');
        pushSymbol({
          name: pyFn[1],
          kind: 'function',
          filePath: file.path,
          line: lineNum,
          detail: trimmed.slice(0, 120),
          exported: isTopLevel,
        });
      }
      const pyCls = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
      if (pyCls) {
        pushSymbol({
          name: pyCls[1],
          kind: 'class',
          filePath: file.path,
          line: lineNum,
          detail: trimmed.slice(0, 120),
          exported: true,
        });
      }
    } else if (ext === '.go') {
      const goFn = /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(trimmed);
      if (goFn) {
        pushSymbol({
          name: goFn[1],
          kind: 'function',
          filePath: file.path,
          line: lineNum,
          detail: trimmed.slice(0, 120),
          exported: /^[A-Z]/.test(goFn[1]),
        });
      }
      const goStruct = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)\b/.exec(trimmed);
      if (goStruct) {
        pushSymbol({
          name: goStruct[1],
          kind: 'class',
          filePath: file.path,
          line: lineNum,
          detail: trimmed.slice(0, 120),
          exported: /^[A-Z]/.test(goStruct[1]),
        });
      }
    } else if (ext === '.java') {
      const jCls = /(?:public|private|protected)?\s*(?:class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
        trimmed
      );
      if (jCls) {
        pushSymbol({
          name: jCls[1],
          kind: 'class',
          filePath: file.path,
          line: lineNum,
          detail: trimmed.slice(0, 120),
          exported: /\bpublic\b/.test(trimmed),
        });
      }
      const jMethod = /(?:public|private|protected)\s+(?:static\s+)?[A-Za-z0-9_<>\[\]]+\s+([a-z][A-Za-z0-9_]*)\s*\(/.exec(
        trimmed
      );
      if (jMethod && !['if', 'for', 'while', 'switch', 'catch'].includes(jMethod[1])) {
        pushSymbol({
          name: jMethod[1],
          kind: 'function',
          filePath: file.path,
          line: lineNum,
          detail: trimmed.slice(0, 120),
          exported: /\bpublic\b/.test(trimmed),
        });
      }
    }
  }

  const totalDetected = symbols.length;
  let bounded = symbols;
  if (symbols.length > MAX_SYMBOLS_PER_FILE) {
    bounded = [...symbols]
      .sort((a, b) => symbolPriorityRank(a) - symbolPriorityRank(b) || a.line - b.line)
      .slice(0, MAX_SYMBOLS_PER_FILE)
      .sort((a, b) => a.line - b.line);
  }

  return {
    symbols: bounded,
    meta: {
      totalDetected,
      shownCount: bounded.length,
      truncated: totalDetected > bounded.length,
    },
  };
}

export function extractFileInternals(file: SourceFile): CodeSymbol[] {
  return extractFileInternalsWithMeta(file).symbols;
}

function classifyFileZone(
  file: SourceFile,
  symbols: CodeSymbol[],
  edges: ArchitectureEdge[]
): ArchZoneId {
  const lower = file.path.toLowerCase();
  const ext = file.extension.toLowerCase();

  if (isInfraFile(file)) return 'infra';

  // Schema & DDL files (.prisma, .sql, .graphql/.gql) classified using path, content & context
  if (ext === '.prisma') {
    return 'storage';
  }
  if (ext === '.sql') {
    const looksLikeDbPath = /(?:^|\/)(?:db|database|sql|schema|schemas|migrations|seeds|queries|models)\//.test(
      lower
    );
    const hasSqlStatements = /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|INDEX|TYPE|SCHEMA)|ALTER\s+TABLE|SELECT\b|INSERT\s+INTO|UPDATE\s+[A-Za-z0-9_."`]+\s+SET|DELETE\s+FROM)\b/i.test(
      file.content
    );
    return looksLikeDbPath || hasSqlStatements ? 'storage' : 'infra';
  }
  if (ext === '.graphql' || ext === '.gql') {
    const definesApiOperations =
      /\b(?:extend\s+)?type\s+(?:Query|Mutation|Subscription)\b/.test(file.content) ||
      /(?:^|\/)(?:api|routes|resolvers|graphql)\//.test(lower);
    const looksLikeClientQuery =
      lower.startsWith('src/') &&
      /^(?:query|mutation|subscription|fragment)\s+/m.test(file.content);
    if (looksLikeClientQuery) return 'services';
    if (definesApiOperations) return 'api';
    const hasSchemaTypes =
      /\b(?:schema\s*\{|(?:type|input|interface|enum)\s+[A-Za-z_])/.test(file.content) ||
      /(?:^|\/)(?:db|database|schema|schemas|models|types)\//.test(lower);
    return hasSchemaTypes ? 'storage' : 'services';
  }

  // Endpoints / API routes
  const hasEndpoints = symbols.some((s) => s.kind === 'endpoint');
  if (
    hasEndpoints ||
    /(?:^|\/)(?:api|routes|controllers|endpoints)\//.test(lower) ||
    /\/api\/.+\.(ts|js|py)$/.test(lower)
  ) {
    // Wait: if this is pure client API wrapper (`src/api.ts`), classify as services unless it defines routes
    if (hasEndpoints || !lower.startsWith('src/')) {
      return 'api';
    }
  }

  // Database / Storage / Static Data Models
  const hasDbImport = edges.some(
    (e) =>
      e.sourcePath === file.path &&
      e.targetKind === 'external' &&
      /^(mongodb|mongoose|prisma|@prisma\/client|drizzle-orm|pg|redis|firebase|@supabase\/supabase-js|dexie|sql\.js)$/.test(
        e.targetPath
      )
  );
  if (
    hasDbImport ||
    /(?:^|\/)(?:db|database|models|schemas|migrations|stores|data|repositories)\//.test(lower) ||
    /(?:^|\/)(?:db|database|schema|models|store)\.(ts|tsx|js|jsx|py|go)$/.test(lower)
  ) {
    return 'storage';
  }

  // Backend / Server
  const hasServerImport = edges.some(
    (e) =>
      e.sourcePath === file.path &&
      e.targetKind === 'external' &&
      /^(express|fastify|hono|cors|@nestjs\/core)$/.test(e.targetPath)
  );
  if (
    hasServerImport ||
    lower === 'server.ts' ||
    lower === 'server.js' ||
    lower.startsWith('server/') ||
    lower.startsWith('backend/')
  ) {
    return 'backend';
  }

  // Native mobile shell vs Capacitor bridge internals
  if (lower.includes('capacitor-android/') || lower.includes('res/')) {
    return 'infra';
  }
  if (ext === '.java' && /activity|fragment|view|app/i.test(file.name)) {
    return 'frontend';
  }
  if (ext === '.xml' && lower.includes('androidmanifest')) {
    return 'infra';
  }

  // Frontend UI
  if (
    ext === '.tsx' ||
    ext === '.jsx' ||
    ext === '.vue' ||
    ext === '.svelte' ||
    ext === '.html' ||
    ext === '.css' ||
    ext === '.scss' ||
    /(?:^|\/)(?:pages|components|views|screens|layouts|ui|client)\//.test(lower)
  ) {
    return 'frontend';
  }

  // Services / Business Logic / Context / Utils
  if (
    /(?:^|\/)(?:services|utils|lib|helpers|core|engine|context|hooks|state|domain)\//.test(lower) ||
    ext === '.ts' ||
    ext === '.js' ||
    ext === '.py' ||
    ext === '.go' ||
    ext === '.java'
  ) {
    // Root scripts or client entry points
    if (lower === 'index.ts' || lower === 'src/main.ts' || lower === 'src/index.ts') {
      return 'frontend';
    }
    return 'services';
  }

  return 'infra';
}

function getModuleBucketKey(file: SourceFile, zone: ArchZoneId): string {
  const parts = file.path.split('/');
  if (parts.length === 1) {
    if (zone === 'backend') return 'root:server';
    if (zone === 'infra') return 'root:config';
    return `root:${file.name}`;
  }

  if (parts[0] === 'android') {
    if (parts[1] === 'capacitor-android') return 'android/capacitor-android';
    if (parts[1] === 'app') return 'android/app';
    return 'android/build';
  }

  if (parts.length >= 2) {
    // e.g. src/pages, src/components, server/utils, api
    if (parts.length === 2) return parts[0];
    return `${parts[0]}/${parts[1]}`;
  }

  return parts[0];
}

function formatModuleTitle(bucketKey: string, zone: ArchZoneId, files: SourceFile[]): string {
  if (bucketKey === 'root:config') return 'Root Config & Manifests';
  if (bucketKey === 'root:server') return files.length === 1 ? files[0].name : 'Root Server';
  if (bucketKey.startsWith('root:')) return bucketKey.slice(5);
  if (bucketKey === 'android/capacitor-android') return 'Capacitor Android Runtime';
  if (bucketKey === 'android/app') return zone === 'frontend' ? 'Android Native Shell' : 'Android App Config';
  if (bucketKey === 'android/build') return 'Android Gradle Build';

  const clean = bucketKey
    .replace(/^(src|app|server)\//, '')
    .split(/[/_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  if (!clean) return bucketKey;
  if (clean.toLowerCase() === 'api') return 'API Endpoints';
  return clean;
}

function isUsefulFileForArchitecture(file: SourceFile): boolean {
  const ext = file.extension.toLowerCase();
  if (
    [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.py',
      '.go',
      '.java',
      '.rs',
      '.php',
      '.vue',
      '.svelte',
      '.html',
      '.sql',
      '.prisma',
      '.graphql',
      '.gql',
    ].includes(ext)
  ) {
    return true;
  }
  if (isInfraFile(file)) return true;
  return false;
}

export function buildArchitectureHierarchy(repo: RepositoryRecord): ArchitectureHierarchy {
  const archFiles = repo.files.filter(isUsefulFileForArchitecture);
  const fileInternals = new Map<string, CodeSymbol[]>();
  const fileSymbolMeta = new Map<string, FileSymbolMeta>();

  for (const file of archFiles) {
    const extracted = extractFileInternalsWithMeta(file);
    fileInternals.set(file.path, extracted.symbols);
    fileSymbolMeta.set(file.path, extracted.meta);
  }

  // Lookup optional Phase 4 file summaries & module responsibilities
  const overviewFileSummary = new Map<string, string>();
  const overviewModuleResp = new Map<string, string>();
  if (repo.comprehensiveOverview) {
    for (const batch of repo.comprehensiveOverview.batches ?? []) {
      for (const fs of batch.fileSummaries ?? []) {
        overviewFileSummary.set(fs.filePath, fs.purpose);
      }
    }
    for (const mod of repo.comprehensiveOverview.applicationArchitecture?.moduleResponsibilities ?? []) {
      overviewModuleResp.set(mod.directoryOrFile, mod.responsibility);
      for (const kf of mod.keyFiles ?? []) {
        overviewModuleResp.set(kf, mod.responsibility);
      }
    }
  }

  // Group internal files into raw buckets (zone + bucketKey)
  const rawGroups = new Map<
    string,
    { zone: ArchZoneId; bucketKey: string; files: SourceFile[] }
  >();

  for (const file of archFiles) {
    const syms = fileInternals.get(file.path) ?? [];
    const zone = classifyFileZone(file, syms, repo.architecture.edges);
    const bucketKey = getModuleBucketKey(file, zone);
    const groupKey = `${zone}::${bucketKey}`;
    const existing = rawGroups.get(groupKey) ?? { zone, bucketKey, files: [] };
    existing.files.push(file);
    rawGroups.set(groupKey, existing);
  }

  const internalGroupList = Array.from(rawGroups.values());
  const externalNodesRaw = repo.architecture.nodes
    .filter((n) => n.kind === 'external')
    .sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path));

  // Reserve at least 1 slot for external packages when external deps exist so total always <= MAX_LEVEL1_NODES
  const MAX_INTERNAL_MODULES =
    externalNodesRaw.length > 0 ? Math.min(20, MAX_LEVEL1_NODES - 1) : MAX_LEVEL1_NODES;

  if (internalGroupList.length > MAX_INTERNAL_MODULES) {
    const byZone = new Map<ArchZoneId, typeof internalGroupList>();
    for (const g of internalGroupList) {
      const arr = byZone.get(g.zone) ?? [];
      arr.push(g);
      byZone.set(g.zone, arr);
    }

    // Pass 1: cap each zone to top 2 buckets + 1 remainder bucket
    let workingList: typeof internalGroupList = [];
    for (const [zone, groups] of byZone.entries()) {
      groups.sort((a, b) => b.files.length - a.files.length || a.bucketKey.localeCompare(b.bucketKey));
      if (groups.length <= 3) {
        workingList.push(...groups);
      } else {
        workingList.push(...groups.slice(0, 2));
        workingList.push({
          zone,
          bucketKey: `${zone}:other`,
          files: groups.slice(2).flatMap((g) => g.files),
        });
      }
    }

    // Pass 2: if total across all zones still exceeds MAX_INTERNAL_MODULES, iteratively merge smallest groups within a zone
    while (workingList.length > MAX_INTERNAL_MODULES) {
      const countsByZone = new Map<ArchZoneId, typeof workingList>();
      for (const g of workingList) {
        const arr = countsByZone.get(g.zone) ?? [];
        arr.push(g);
        countsByZone.set(g.zone, arr);
      }
      const expandableZones = Array.from(countsByZone.entries())
        .filter(([, arr]) => arr.length >= 2)
        .sort((a, b) => b[1].length - a[1].length);

      if (expandableZones.length === 0) break;

      const [targetZone, zoneGroups] = expandableZones[0];
      zoneGroups.sort((a, b) => a.files.length - b.files.length || a.bucketKey.localeCompare(b.bucketKey));
      const a = zoneGroups[0];
      const b = zoneGroups[1];
      const mergedBucket = {
        zone: targetZone,
        bucketKey: `${targetZone}:other`,
        files: [...a.files, ...b.files],
      };
      workingList = workingList.filter((g) => g !== a && g !== b);
      const existingOther = workingList.find(
        (g) => g.zone === targetZone && g.bucketKey === `${targetZone}:other`
      );
      if (existingOther) {
        existingOther.files.push(...mergedBucket.files);
      } else {
        workingList.push(mergedBucket);
      }
    }

    internalGroupList.length = 0;
    internalGroupList.push(...workingList.slice(0, MAX_INTERNAL_MODULES));
  }

  const modules: ArchModule[] = [];
  const fileToModuleId = new Map<string, string>();

  for (const group of internalGroupList) {
    const id = `mod:${group.zone}:${group.bucketKey}`;
    const allSymbols = group.files.flatMap((f) => fileInternals.get(f.path) ?? []);
    const endpoints = allSymbols
      .filter((s) => s.kind === 'endpoint')
      .map((s) => {
        const [method, ...rest] = s.name.split(' ');
        return { method, route: rest.join(' '), filePath: s.filePath, line: s.line };
      });

    const extPkgs = Array.from(
      new Set(
        repo.architecture.edges
          .filter((e) => e.targetKind === 'external' && group.files.some((f) => f.path === e.sourcePath))
          .map((e) => e.targetPath)
      )
    );

    // Derive responsibility strictly from observed files / Phase 4 summaries
    let responsibility =
      overviewModuleResp.get(group.bucketKey) ||
      overviewModuleResp.get(group.files[0]?.path ?? '') ||
      overviewFileSummary.get(group.files[0]?.path ?? '');

    if (!responsibility) {
      if (endpoints.length > 0) {
        responsibility = `Handles ${endpoints.length} HTTP endpoint(s) (${endpoints
          .slice(0, 2)
          .map((e) => e.route)
          .join(', ')})`;
      } else if (group.zone === 'infra') {
        responsibility = `Project configuration & build manifests (${group.files.length} files)`;
      } else {
        const topSym = allSymbols.slice(0, 3).map((s) => s.name);
        responsibility =
          topSym.length > 0
            ? `${group.files.length} file(s) defining ${topSym.join(', ')}`
            : `${group.files.length} source file(s) in ${group.bucketKey}`;
      }
    }

    const evidence: SourceCitation[] = group.files.slice(0, 4).map((f) => {
      const firstSym = (fileInternals.get(f.path) ?? [])[0];
      return {
        filePath: f.path,
        startLine: firstSym?.line ?? 1,
        endLine: firstSym?.line ?? 1,
        symbol: firstSym?.name,
      };
    });

    for (const f of group.files) {
      fileToModuleId.set(f.path, id);
    }

    modules.push({
      id,
      name:
        group.bucketKey.endsWith(':other')
          ? `Other ${ARCH_ZONE_META[group.zone].shortLabel}`
          : formatModuleTitle(group.bucketKey, group.zone, group.files),
      zone: group.zone,
      directoryKey: group.bucketKey,
      kind: 'internal',
      responsibility,
      files: group.files.sort((a, b) => a.path.localeCompare(b.path)),
      totalLines: group.files.reduce((sum, f) => sum + f.lines, 0),
      symbols: allSymbols,
      endpoints,
      externalPackages: extPkgs,
      evidence,
      inDegree: 0,
      outDegree: 0,
      position: { x: 0, y: 0 },
    });
  }

  // Add External Integration nodes strictly within MAX_LEVEL1_NODES budget
  const remainingSlots = Math.max(0, MAX_LEVEL1_NODES - modules.length);
  const pkgToModuleId = new Map<string, string>();

  if (externalNodesRaw.length > 0 && remainingSlots > 0) {
    let directPkgs = externalNodesRaw;
    let overflowPkgs: typeof externalNodesRaw = [];

    if (externalNodesRaw.length > remainingSlots) {
      if (remainingSlots === 1) {
        directPkgs = [];
        overflowPkgs = externalNodesRaw;
      } else {
        directPkgs = externalNodesRaw.slice(0, remainingSlots - 1);
        overflowPkgs = externalNodesRaw.slice(remainingSlots - 1);
      }
    }

    for (const pkgNode of directPkgs) {
      const id = `mod:external:${pkgNode.path}`;
      pkgToModuleId.set(pkgNode.path, id);
      const callers = repo.architecture.edges
        .filter((e) => e.targetKind === 'external' && e.targetPath === pkgNode.path)
        .slice(0, 3)
        .map((e) => ({
          filePath: e.sourcePath,
          startLine: e.evidences[0]?.line ?? 1,
          endLine: e.evidences[0]?.line ?? 1,
          snippet: e.evidences[0]?.rawStatement,
        }));

      modules.push({
        id,
        name: pkgNode.path,
        zone: 'external',
        directoryKey: pkgNode.path,
        kind: 'external',
        responsibility: `Imported by ${pkgNode.inDegree} source file(s)`,
        files: [],
        totalLines: 0,
        symbols: [],
        endpoints: [],
        externalPackages: [pkgNode.path],
        evidence: callers,
        inDegree: 0,
        outDegree: 0,
        position: { x: 0, y: 0 },
      });
    }

    if (overflowPkgs.length > 0 && modules.length < MAX_LEVEL1_NODES) {
      const id = 'mod:external:__other_packages';
      for (const p of overflowPkgs) {
        pkgToModuleId.set(p.path, id);
      }
      modules.push({
        id,
        name:
          directPkgs.length === 0
            ? `External Packages (${overflowPkgs.length})`
            : `Other Packages (${overflowPkgs.length})`,
        zone: 'external',
        directoryKey: 'other-external',
        kind: 'external',
        responsibility: overflowPkgs
          .slice(0, 4)
          .map((p) => p.path)
          .join(', '),
        files: [],
        totalLines: 0,
        symbols: [],
        endpoints: [],
        externalPackages: overflowPkgs.map((p) => p.path),
        evidence: [],
        inDegree: 0,
        outDegree: 0,
        position: { x: 0, y: 0 },
      });
    }
  }

  // Build Module-to-Module edges from static architecture edges
  const edgeAcc = new Map<string, ArchModuleEdge>();
  const modMap = new Map(modules.map((m) => [m.id, m]));

  for (const edge of repo.architecture.edges) {
    const srcModId = fileToModuleId.get(edge.sourcePath);
    const tgtModId =
      edge.targetKind === 'internal'
        ? fileToModuleId.get(edge.targetPath)
        : pkgToModuleId.get(edge.targetPath);

    if (!srcModId || !tgtModId || srcModId === tgtModId) continue;
    const key = `${srcModId}->${tgtModId}`;
    const existing = edgeAcc.get(key) ?? {
      id: key,
      source: srcModId,
      target: tgtModId,
      kind: edge.targetKind,
      evidenceBasis: 'import-only' as FlowEvidenceBasis,
      importCount: 0,
      evidences: [],
    };
    existing.importCount += edge.evidences.length;
    if (existing.evidences.length < 10) {
      for (const ev of edge.evidences) {
        if (existing.evidences.length >= 10) break;
        existing.evidences.push({
          sourcePath: edge.sourcePath,
          targetPath: edge.targetPath,
          line: ev.line,
          rawStatement: ev.rawStatement,
        });
      }
    }
    edgeAcc.set(key, existing);
  }

  // Detect verified HTTP fetch -> route handler connections across modules
  const allEndpoints = modules.flatMap((m) => m.endpoints.map((ep) => ({ modId: m.id, ...ep })));
  if (allEndpoints.length > 0) {
    for (const mod of modules) {
      const networkCalls = mod.symbols.filter((s) => s.kind === 'network');
      for (const call of networkCalls) {
        const pathMatch = /fetch\(([^)]+)\)/.exec(call.name)?.[1] ?? '';
        const cleanUrl = pathMatch.split('?')[0];
        const targetEp = allEndpoints.find(
          (ep) => ep.modId !== mod.id && cleanUrl.startsWith(ep.route.replace(/:[^/]+/g, ''))
        );
        if (targetEp) {
          const key = `${mod.id}->${targetEp.modId}`;
          const existing = edgeAcc.get(key) ?? {
            id: key,
            source: mod.id,
            target: targetEp.modId,
            kind: 'internal' as const,
            evidenceBasis: 'route-handler' as FlowEvidenceBasis,
            importCount: 0,
            evidences: [],
          };
          existing.evidenceBasis = 'route-handler';
          existing.importCount += 1;
          existing.evidences.unshift({
            sourcePath: call.filePath,
            targetPath: targetEp.filePath,
            line: call.line,
            rawStatement: `${call.detail ?? call.name} → ${targetEp.method} ${targetEp.route}`,
          });
          edgeAcc.set(key, existing);
        }
      }
    }
  }

  const moduleEdges = Array.from(edgeAcc.values());
  for (const e of moduleEdges) {
    const s = modMap.get(e.source);
    const t = modMap.get(e.target);
    if (s) s.outDegree += 1;
    if (t) t.inDegree += 1;
  }

  // Determine active zones & compute clean Zone-Column non-overlapping positions
  const activeZones = ARCH_ZONE_ORDER.filter((z) => modules.some((m) => m.zone === z));
  const COL_X_STEP = 310;
  const ROW_Y_STEP = 128;
  const ZONE_HEADER_OFFSET = 72;

  activeZones.forEach((zone, colIdx) => {
    const zoneMods = modules
      .filter((m) => m.zone === zone)
      .sort((a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree) || a.name.localeCompare(b.name));
    zoneMods.forEach((m, rowIdx) => {
      m.position = {
        x: colIdx * COL_X_STEP + 20,
        y: ZONE_HEADER_OFFSET + rowIdx * ROW_Y_STEP,
      };
    });
  });

  const processFlows = buildProcessFlows(repo, modules, fileInternals, fileToModuleId);

  return {
    modules,
    moduleEdges,
    activeZones,
    fileToModuleId,
    fileInternals,
    fileSymbolMeta,
    processFlows,
    stats: {
      totalFiles: repo.files.length,
      totalModules: modules.length,
      activeZonesCount: activeZones.length,
      internalModuleEdges: moduleEdges.filter((e) => e.kind === 'internal').length,
      externalModuleEdges: moduleEdges.filter((e) => e.kind === 'external').length,
    },
  };
}

function buildProcessFlows(
  repo: RepositoryRecord,
  modules: ArchModule[],
  fileInternals: Map<string, CodeSymbol[]>,
  _fileToModuleId: Map<string, string>
): ArchProcessFlow[] {
  const flows: ArchProcessFlow[] = [];
  const fileMap = new Map(repo.files.map((f) => [f.path, f]));

  // 1. Include validated executionFlows from Phase 4 ComprehensiveOverview when available
  for (const [idx, flow] of (repo.comprehensiveOverview?.executionFlows ?? []).entries()) {
    const validSteps = flow.steps.filter((s) => fileMap.has(s.filePath));
    if (validSteps.length === 0) continue;
    flows.push({
      id: `ai-flow-${idx}`,
      title: flow.title,
      trigger: flow.trigger,
      summary: flow.summary,
      sourceKind: 'ai-consolidated',
      steps: validSteps,
      verificationNote: flow.verificationNote,
    });
  }

  // 2. Deterministic Frontend fetch -> Backend Route Handler flow
  const allEndpoints = modules.flatMap((m) => m.endpoints);
  for (const [filePath, syms] of fileInternals.entries()) {
    if (flows.length >= 6) break;
    const netCall = syms.find((s) => s.kind === 'network');
    if (!netCall) continue;
    const urlMatch = /fetch\(([^)]+)\)/.exec(netCall.name)?.[1] ?? '';
    const ep = allEndpoints.find((e) => urlMatch.startsWith(e.route.replace(/:[^/]+/g, '')));
    if (ep && ep.filePath !== filePath) {
      flows.push({
        id: `static-route-${filePath}-${ep.route}`,
        title: `Client Request → ${ep.method} ${ep.route}`,
        trigger: `Client invocation in ${filePath}`,
        summary: `Client module issues a request to ${ep.route}, handled by server route ${ep.method} ${ep.route}.`,
        sourceKind: 'static-verified',
        steps: [
          {
            stepNumber: 1,
            layer: 'Frontend / Client',
            action: netCall.detail ?? netCall.name,
            filePath,
            startLine: netCall.line,
            endLine: netCall.line,
            evidenceBasis: 'verified-call',
          },
          {
            stepNumber: 2,
            layer: 'API / Route Handler',
            action: `${ep.method} ${ep.route} route handler`,
            filePath: ep.filePath,
            startLine: ep.line,
            endLine: ep.line,
            evidenceBasis: 'route-handler',
          },
        ],
        verificationNote:
          'Verified from static fetch() URL matching server route definition. Intermediate state updates are not traced dynamically.',
      });
    }
  }

  // 3. Deterministic Client Storage / External SDK interaction flow
  for (const mod of modules) {
    if (flows.length >= 6) break;
    if (mod.zone !== 'frontend' && mod.zone !== 'services') continue;
    const storageSym = mod.symbols.find((s) => s.kind === 'storage');
    if (storageSym && !flows.some((f) => f.steps.some((st) => st.filePath === storageSym.filePath))) {
      flows.push({
        id: `static-storage-${storageSym.filePath}`,
        title: `State & Persistence via ${storageSym.name}`,
        trigger: `Operation in ${storageSym.filePath}`,
        summary: `Source code in ${mod.name} reads or writes persistent state via ${storageSym.name}.`,
        sourceKind: 'static-verified',
        steps: [
          {
            stepNumber: 1,
            layer: ARCH_ZONE_META[mod.zone].label,
            action: storageSym.detail ?? `Invokes ${storageSym.name}`,
            filePath: storageSym.filePath,
            startLine: storageSym.line,
            endLine: storageSym.line,
            evidenceBasis: 'verified-call',
          },
        ],
        verificationNote: 'Directly observed storage call in indexed source line.',
      });
    }
  }

  // 4. Entry-point static import chain (explicitly labeled import-only!)
  const entry = repo.detectedFacts.entryPoints.find((e) =>
    repo.architecture.edges.some((edge) => edge.sourcePath === e.path && edge.targetKind === 'internal')
  );
  if (entry) {
    const firstImport = repo.architecture.edges.find(
      (edge) => edge.sourcePath === entry.path && edge.targetKind === 'internal'
    );
    if (firstImport) {
      const secondImport = repo.architecture.edges.find(
        (edge) => edge.sourcePath === firstImport.targetPath && edge.targetKind === 'internal'
      );
      const steps: ArchProcessFlow['steps'] = [
        {
          stepNumber: 1,
          layer: 'Entry Point',
          action: `Entry module ${entry.path} imports ${firstImport.targetPath}`,
          filePath: entry.path,
          startLine: firstImport.evidences[0]?.line ?? 1,
          endLine: firstImport.evidences[0]?.line ?? 1,
          evidenceBasis: 'import-only',
        },
        {
          stepNumber: 2,
          layer: 'Imported Module',
          action: `Loaded module ${firstImport.targetPath}`,
          filePath: firstImport.targetPath,
          startLine: 1,
          endLine: 1,
          evidenceBasis: 'import-only',
        },
      ];
      if (secondImport) {
        steps.push({
          stepNumber: 3,
          layer: 'Downstream Dependency',
          action: `Imports ${secondImport.targetPath}`,
          filePath: secondImport.targetPath,
          startLine: secondImport.evidences[0]?.line ?? 1,
          endLine: secondImport.evidences[0]?.line ?? 1,
          evidenceBasis: 'import-only',
        });
      }
      flows.push({
        id: 'static-import-boot',
        title: `Static Module Dependency Chain from ${entry.path}`,
        trigger: 'Application boot / module load',
        summary: 'Static ES/module import hierarchy originating at a detected entry point.',
        sourceKind: 'static-verified',
        steps,
        verificationNote:
          'Import-only relationship: static imports prove compile/load dependency, NOT runtime execution sequence.',
      });
    }
  }

  return flows;
}

export interface SubgraphNodeItem {
  id: string;
  label: string;
  sublabel: string;
  kind: 'focus-file' | 'upstream' | 'downstream' | 'external' | 'symbol';
  filePath?: string;
  line?: number;
  linesCount?: number;
  moduleId?: string;
  zone?: ArchZoneId;
  symbolKind?: CodeSymbol['kind'];
  symbolDetail?: string;
  position: { x: number; y: number };
}

export interface SubgraphEdgeItem {
  id: string;
  source: string;
  target: string;
  label: string;
  direction: 'incoming' | 'outgoing' | 'internal' | 'external';
  rawEdge?: ArchitectureEdge;
}

export function buildLevel2Subgraph(
  hierarchy: ArchitectureHierarchy,
  repo: RepositoryRecord,
  moduleId: string,
  includeExternal: boolean
): {
  nodes: SubgraphNodeItem[];
  edges: SubgraphEdgeItem[];
  module: ArchModule | null;
  incomingModules: ArchModule[];
  outgoingModules: ArchModule[];
} {
  const mod = hierarchy.modules.find((m) => m.id === moduleId) ?? null;
  if (!mod) {
    return { nodes: [], edges: [], module: null, incomingModules: [], outgoingModules: [] };
  }

  const modMap = new Map(hierarchy.modules.map((m) => [m.id, m]));
  const incomingMods = hierarchy.moduleEdges
    .filter((e) => e.target === mod.id)
    .map((e) => modMap.get(e.source))
    .filter((m): m is ArchModule => Boolean(m));
  const outgoingMods = hierarchy.moduleEdges
    .filter((e) => e.source === mod.id && (includeExternal || e.kind === 'internal'))
    .map((e) => modMap.get(e.target))
    .filter((m): m is ArchModule => Boolean(m));

  const nodes: SubgraphNodeItem[] = [];
  const edges: SubgraphEdgeItem[] = [];
  const addedIds = new Set<string>();

  if (mod.kind === 'external') {
    // Center external package, left all internal files importing it
    const pkgName = mod.directoryKey;
    const callers = repo.architecture.edges.filter(
      (e) => e.targetKind === 'external' && mod.externalPackages.includes(e.targetPath)
    );
    callers.slice(0, 14).forEach((e, idx) => {
      const nId = `l2:caller:${e.sourcePath}`;
      if (!addedIds.has(nId)) {
        addedIds.add(nId);
        nodes.push({
          id: nId,
          label: e.sourcePath.split('/').pop() ?? e.sourcePath,
          sublabel: e.sourcePath,
          kind: 'upstream',
          filePath: e.sourcePath,
          line: e.evidences[0]?.line,
          position: { x: 20, y: 20 + idx * 96 },
        });
      }
      edges.push({
        id: `l2edge:${nId}->center:${idx}`,
        source: nId,
        target: `l2:center:${mod.id}`,
        label: `L${e.evidences[0]?.line ?? 1} · import-only`,
        direction: 'incoming',
        rawEdge: e,
      });
    });

    nodes.push({
      id: `l2:center:${mod.id}`,
      label: mod.name,
      sublabel: 'External Integration',
      kind: 'external',
      moduleId: mod.id,
      zone: 'external',
      position: { x: 380, y: Math.max(20, Math.floor((Math.min(callers.length, 14) * 96) / 2) - 40) },
    });

    return { nodes, edges, module: mod, incomingModules: incomingMods, outgoingModules: outgoingMods };
  }

  // Internal module: show up to 16 internal files in the center column, upstream callers on left, downstream deps on right
  const focusFiles = mod.files.slice(0, 16);
  const focusPathSet = new Set(focusFiles.map((f) => f.path));

  focusFiles.forEach((f, idx) => {
    const syms = hierarchy.fileInternals.get(f.path) ?? [];
    const nId = `l2:file:${f.path}`;
    addedIds.add(nId);
    nodes.push({
      id: nId,
      label: f.name,
      sublabel: syms.length > 0 ? `${f.lines} ln · ${syms.length} symbols` : `${f.lines} ln`,
      kind: 'focus-file',
      filePath: f.path,
      linesCount: f.lines,
      moduleId: mod.id,
      zone: mod.zone,
      position: { x: 340, y: 20 + idx * 94 },
    });
  });

  // Internal edges within this module
  for (const edge of repo.architecture.edges) {
    if (
      edge.targetKind === 'internal' &&
      focusPathSet.has(edge.sourcePath) &&
      focusPathSet.has(edge.targetPath)
    ) {
      edges.push({
        id: `l2in:${edge.id}`,
        source: `l2:file:${edge.sourcePath}`,
        target: `l2:file:${edge.targetPath}`,
        label: `L${edge.evidences[0]?.line ?? 1}`,
        direction: 'internal',
        rawEdge: edge,
      });
    }
  }

  // Upstream files importing files in this module
  const upstreamEdges = repo.architecture.edges.filter(
    (e) =>
      e.targetKind === 'internal' &&
      focusPathSet.has(e.targetPath) &&
      !focusPathSet.has(e.sourcePath)
  );
  const upstreamBySource = new Map<string, ArchitectureEdge[]>();
  for (const e of upstreamEdges) {
    const arr = upstreamBySource.get(e.sourcePath) ?? [];
    arr.push(e);
    upstreamBySource.set(e.sourcePath, arr);
  }
  Array.from(upstreamBySource.entries())
    .slice(0, 10)
    .forEach(([srcPath, edgeList], idx) => {
      const nId = `l2:up:${srcPath}`;
      if (!addedIds.has(nId)) {
        addedIds.add(nId);
        nodes.push({
          id: nId,
          label: srcPath.split('/').pop() ?? srcPath,
          sublabel: srcPath,
          kind: 'upstream',
          filePath: srcPath,
          moduleId: hierarchy.fileToModuleId.get(srcPath),
          position: { x: 20, y: 20 + idx * 94 },
        });
      }
      for (const e of edgeList) {
        edges.push({
          id: `l2up:${e.id}`,
          source: nId,
          target: `l2:file:${e.targetPath}`,
          label: `L${e.evidences[0]?.line ?? 1}`,
          direction: 'incoming',
          rawEdge: e,
        });
      }
    });

  // Downstream targets imported by files in this module
  const downstreamEdges = repo.architecture.edges.filter(
    (e) =>
      focusPathSet.has(e.sourcePath) &&
      (e.targetKind === 'internal'
        ? !focusPathSet.has(e.targetPath)
        : includeExternal)
  );
  const downstreamByTarget = new Map<string, ArchitectureEdge[]>();
  for (const e of downstreamEdges) {
    const tKey = `${e.targetKind}:${e.targetPath}`;
    const arr = downstreamByTarget.get(tKey) ?? [];
    arr.push(e);
    downstreamByTarget.set(tKey, arr);
  }
  Array.from(downstreamByTarget.entries())
    .slice(0, 12)
    .forEach(([tKey, edgeList], idx) => {
      const sample = edgeList[0];
      const nId = `l2:down:${tKey}`;
      if (!addedIds.has(nId)) {
        addedIds.add(nId);
        nodes.push({
          id: nId,
          label:
            sample.targetKind === 'external'
              ? sample.targetPath
              : sample.targetPath.split('/').pop() ?? sample.targetPath,
          sublabel: sample.targetKind === 'external' ? 'external package' : sample.targetPath,
          kind: sample.targetKind === 'external' ? 'external' : 'downstream',
          filePath: sample.targetKind === 'internal' ? sample.targetPath : undefined,
          moduleId:
            sample.targetKind === 'internal'
              ? hierarchy.fileToModuleId.get(sample.targetPath)
              : undefined,
          position: { x: 670, y: 20 + idx * 94 },
        });
      }
      for (const e of edgeList) {
        edges.push({
          id: `l2down:${e.id}`,
          source: `l2:file:${e.sourcePath}`,
          target: nId,
          label: `L${e.evidences[0]?.line ?? 1}`,
          direction: e.targetKind === 'external' ? 'external' : 'outgoing',
          rawEdge: e,
        });
      }
    });

  return {
    nodes,
    edges,
    module: mod,
    incomingModules: incomingMods,
    outgoingModules: outgoingMods,
  };
}

export function buildLevel3FileSubgraph(
  hierarchy: ArchitectureHierarchy,
  repo: RepositoryRecord,
  filePath: string
): {
  file: SourceFile | null;
  symbols: CodeSymbol[];
  symbolMeta: FileSymbolMeta;
  incomingEdges: ArchitectureEdge[];
  outgoingEdges: ArchitectureEdge[];
  nodes: SubgraphNodeItem[];
  edges: SubgraphEdgeItem[];
} {
  const file = repo.files.find((f) => f.path === filePath) ?? null;
  if (!file) {
    return {
      file: null,
      symbols: [],
      symbolMeta: { totalDetected: 0, shownCount: 0, truncated: false },
      incomingEdges: [],
      outgoingEdges: [],
      nodes: [],
      edges: [],
    };
  }

  const cachedSymbols = hierarchy.fileInternals.get(file.path);
  const cachedMeta = hierarchy.fileSymbolMeta.get(file.path);
  const fallback = cachedSymbols && cachedMeta ? null : extractFileInternalsWithMeta(file);
  const symbols = cachedSymbols ?? fallback!.symbols;
  const symbolMeta = cachedMeta ?? fallback!.meta;

  const incomingEdges = repo.architecture.edges.filter(
    (e) => e.targetKind === 'internal' && e.targetPath === file.path
  );
  const outgoingEdges = repo.architecture.edges.filter((e) => e.sourcePath === file.path);

  const nodes: SubgraphNodeItem[] = [];
  const edges: SubgraphEdgeItem[] = [];

  const centerId = `l3:center:${file.path}`;
  const centerY = Math.max(
    40,
    Math.floor((Math.max(incomingEdges.length, outgoingEdges.length, 2) * 92) / 2) - 40
  );

  nodes.push({
    id: centerId,
    label: file.name,
    sublabel: `${file.language} · ${file.lines} lines`,
    kind: 'focus-file',
    filePath: file.path,
    linesCount: file.lines,
    position: { x: 350, y: centerY },
  });

  incomingEdges.slice(0, 12).forEach((edge, idx) => {
    const nId = `l3:in:${edge.sourcePath}`;
    nodes.push({
      id: nId,
      label: edge.sourcePath.split('/').pop() ?? edge.sourcePath,
      sublabel: edge.sourcePath,
      kind: 'upstream',
      filePath: edge.sourcePath,
      line: edge.evidences[0]?.line,
      position: { x: 20, y: 20 + idx * 92 },
    });
    edges.push({
      id: `l3ein:${edge.id}`,
      source: nId,
      target: centerId,
      label: `L${edge.evidences[0]?.line ?? 1} · import`,
      direction: 'incoming',
      rawEdge: edge,
    });
  });

  outgoingEdges.slice(0, 12).forEach((edge, idx) => {
    const nId = `l3:out:${edge.targetKind}:${edge.targetPath}`;
    nodes.push({
      id: nId,
      label:
        edge.targetKind === 'external'
          ? edge.targetPath
          : edge.targetPath.split('/').pop() ?? edge.targetPath,
      sublabel: edge.targetKind === 'external' ? 'external package' : edge.targetPath,
      kind: edge.targetKind === 'external' ? 'external' : 'downstream',
      filePath: edge.targetKind === 'internal' ? edge.targetPath : undefined,
      line: edge.evidences[0]?.line,
      position: { x: 680, y: 20 + idx * 92 },
    });
    edges.push({
      id: `l3eout:${edge.id}`,
      source: centerId,
      target: nId,
      label: `L${edge.evidences[0]?.line ?? 1} · import`,
      direction: edge.targetKind === 'external' ? 'external' : 'outgoing',
      rawEdge: edge,
    });
  });

  // Also show top prioritized symbols below the center file node when useful
  symbols.slice(0, 6).forEach((sym, idx) => {
    const sId = `l3:sym:${idx}:${sym.name}`;
    nodes.push({
      id: sId,
      label: sym.name,
      sublabel: `${sym.kind} · line ${sym.line}`,
      kind: 'symbol',
      filePath: file.path,
      line: sym.line,
      symbolKind: sym.kind,
      symbolDetail: sym.detail,
      position: { x: 350, y: centerY + 110 + idx * 78 },
    });
    edges.push({
      id: `l3esym:${idx}`,
      source: centerId,
      target: sId,
      label: `L${sym.line}`,
      direction: 'internal',
    });
  });

  return { file, symbols, symbolMeta, incomingEdges, outgoingEdges, nodes, edges };
}

export function getEdgeEvidencePreview(evidences: ArchitectureEdgeEvidence[]): string {
  if (evidences.length === 0) return '';
  return evidences[0].rawStatement;
}
