import path from 'node:path';
import { ThinkingLevel, Type } from '@google/genai';
import type {
  AIAnalysis,
  ArchitectureEdge,
  ArchitectureEdgeEvidence,
  ArchitectureGraph,
  ArchitectureNode,
  DetectedFacts,
  DetectedFramework,
  EntryPoint,
  LanguageStat,
  SourceFile,
} from '../src/types.ts';
import {
  formatAiError,
  generateAiStructuredJson,
  getPrimaryAiTextModel,
  isAiTextConfigured,
} from './ai.ts';
import { getIngestLimits, type IngestedRepoPayload } from './github.ts';

interface KnownPackageRule {
  pkg: string;
  name: string;
  category: DetectedFramework['category'];
}

const KNOWN_NPM_PACKAGES: KnownPackageRule[] = [
  { pkg: 'react', name: 'React', category: 'framework' },
  { pkg: 'next', name: 'Next.js', category: 'framework' },
  { pkg: 'vue', name: 'Vue', category: 'framework' },
  { pkg: 'nuxt', name: 'Nuxt', category: 'framework' },
  { pkg: 'svelte', name: 'Svelte', category: 'framework' },
  { pkg: '@angular/core', name: 'Angular', category: 'framework' },
  { pkg: 'express', name: 'Express', category: 'framework' },
  { pkg: 'fastify', name: 'Fastify', category: 'framework' },
  { pkg: 'hono', name: 'Hono', category: 'framework' },
  { pkg: '@nestjs/core', name: 'NestJS', category: 'framework' },
  { pkg: 'koa', name: 'Koa', category: 'framework' },
  { pkg: 'vite', name: 'Vite', category: 'tooling' },
  { pkg: 'webpack', name: 'Webpack', category: 'tooling' },
  { pkg: 'typescript', name: 'TypeScript', category: 'tooling' },
  { pkg: 'tailwindcss', name: 'Tailwind CSS', category: 'styling' },
  { pkg: '@tailwindcss/vite', name: 'Tailwind CSS', category: 'styling' },
  { pkg: 'prisma', name: 'Prisma', category: 'database' },
  { pkg: '@prisma/client', name: 'Prisma', category: 'database' },
  { pkg: 'drizzle-orm', name: 'Drizzle ORM', category: 'database' },
  { pkg: 'mongoose', name: 'Mongoose', category: 'database' },
  { pkg: 'mongodb', name: 'MongoDB Driver', category: 'database' },
  { pkg: 'pg', name: 'PostgreSQL (pg)', category: 'database' },
  { pkg: 'redis', name: 'Redis', category: 'database' },
  { pkg: 'vitest', name: 'Vitest', category: 'testing' },
  { pkg: 'jest', name: 'Jest', category: 'testing' },
  { pkg: 'mocha', name: 'Mocha', category: 'testing' },
  { pkg: '@playwright/test', name: 'Playwright', category: 'testing' },
  { pkg: '@google/genai', name: 'Google GenAI SDK', category: 'ai' },
  { pkg: 'openai', name: 'OpenAI SDK', category: 'ai' },
  { pkg: 'langchain', name: 'LangChain', category: 'ai' },
  { pkg: '@xyflow/react', name: 'React Flow', category: 'framework' },
  { pkg: 'zod', name: 'Zod', category: 'tooling' },
  { pkg: 'zustand', name: 'Zustand', category: 'framework' },
];

const KNOWN_PY_PACKAGES: KnownPackageRule[] = [
  { pkg: 'fastapi', name: 'FastAPI', category: 'framework' },
  { pkg: 'django', name: 'Django', category: 'framework' },
  { pkg: 'flask', name: 'Flask', category: 'framework' },
  { pkg: 'starlette', name: 'Starlette', category: 'framework' },
  { pkg: 'sqlalchemy', name: 'SQLAlchemy', category: 'database' },
  { pkg: 'pymongo', name: 'PyMongo', category: 'database' },
  { pkg: 'motor', name: 'Motor (MongoDB Async)', category: 'database' },
  { pkg: 'pydantic', name: 'Pydantic', category: 'tooling' },
  { pkg: 'pytest', name: 'Pytest', category: 'testing' },
  { pkg: 'torch', name: 'PyTorch', category: 'ai' },
  { pkg: 'transformers', name: 'HuggingFace Transformers', category: 'ai' },
  { pkg: 'google-genai', name: 'Google GenAI SDK', category: 'ai' },
  { pkg: 'openai', name: 'OpenAI SDK', category: 'ai' },
  { pkg: 'numpy', name: 'NumPy', category: 'tooling' },
  { pkg: 'pandas', name: 'Pandas', category: 'tooling' },
];

function stripJsonComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

export function extractDetectedFacts(payload: IngestedRepoPayload): DetectedFacts {
  const limits = getIngestLimits();
  const {
    files,
    tree,
    eligibleFileCount,
    failedFiles,
    skippedBreakdown,
    truncatedByFileCap,
    truncatedBySizeCap,
  } = payload;

  // Language breakdown from ingested files
  const langMap = new Map<string, { files: number; lines: number; bytes: number }>();
  let totalLines = 0;
  let totalBytes = 0;

  for (const f of files) {
    totalLines += f.lines;
    totalBytes += f.size;
    const prev = langMap.get(f.language) ?? { files: 0, lines: 0, bytes: 0 };
    prev.files += 1;
    prev.lines += f.lines;
    prev.bytes += f.size;
    langMap.set(f.language, prev);
  }

  const languages: LanguageStat[] = Array.from(langMap.entries())
    .map(([language, stats]) => ({
      language,
      files: stats.files,
      lines: stats.lines,
      bytes: stats.bytes,
      percentage: totalBytes > 0 ? Math.round((stats.bytes / totalBytes) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const frameworks: DetectedFramework[] = [];
  const seenFrameworks = new Set<string>();
  const addFramework = (fw: DetectedFramework) => {
    if (!seenFrameworks.has(fw.name)) {
      seenFrameworks.add(fw.name);
      frameworks.push(fw);
    }
  };

  const entryPoints: EntryPoint[] = [];
  const seenEntries = new Set<string>();
  const addEntry = (entryPath: string, reason: string) => {
    if (!seenEntries.has(entryPath)) {
      seenEntries.add(entryPath);
      entryPoints.push({ path: entryPath, reason });
    }
  };

  let packageManifest: DetectedFacts['packageManifest'];

  // Inspect package.json (root preferred, or first package.json)
  const rootPkg =
    files.find((f) => f.path === 'package.json') ??
    files.find((f) => f.name === 'package.json');

  if (rootPkg) {
    try {
      const parsed = JSON.parse(rootPkg.content) as {
        name?: string;
        version?: string;
        main?: string;
        module?: string;
        bin?: string | Record<string, string>;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      const deps = parsed.dependencies ?? {};
      const devDeps = parsed.devDependencies ?? {};
      const allDeps = { ...deps, ...devDeps };

      packageManifest = {
        file: rootPkg.path,
        name: parsed.name,
        version: parsed.version,
        scripts: parsed.scripts,
        dependenciesCount: Object.keys(deps).length,
        devDependenciesCount: Object.keys(devDeps).length,
      };

      for (const rule of KNOWN_NPM_PACKAGES) {
        if (allDeps[rule.pkg]) {
          addFramework({
            name: rule.name,
            category: rule.category,
            evidenceFile: rootPkg.path,
            evidenceDetail: `dependency "${rule.pkg}": "${allDeps[rule.pkg]}"`,
          });
        }
      }

      if (parsed.main) {
        addEntry(parsed.main.replace(/^\.\//, ''), `Declared as "main" in ${rootPkg.path}`);
      }
      if (parsed.module) {
        addEntry(parsed.module.replace(/^\.\//, ''), `Declared as "module" in ${rootPkg.path}`);
      }
      if (typeof parsed.bin === 'string') {
        addEntry(parsed.bin.replace(/^\.\//, ''), `Declared as "bin" in ${rootPkg.path}`);
      } else if (parsed.bin && typeof parsed.bin === 'object') {
        for (const [binName, binPath] of Object.entries(parsed.bin)) {
          addEntry(binPath.replace(/^\.\//, ''), `Declared as CLI bin "${binName}" in ${rootPkg.path}`);
        }
      }
    } catch {
      // Malformed JSON
    }
  }

  // Inspect Python manifests
  for (const pyFile of files.filter(
    (f) => f.name === 'requirements.txt' || f.name === 'pyproject.toml'
  )) {
    const lowerContent = pyFile.content.toLowerCase();
    for (const rule of KNOWN_PY_PACKAGES) {
      const regex = new RegExp(`(^|[^a-z0-9_-])${rule.pkg}([^a-z0-9_-]|$)`, 'm');
      if (regex.test(lowerContent)) {
        addFramework({
          name: rule.name,
          category: rule.category,
          evidenceFile: pyFile.path,
          evidenceDetail: `Listed in ${pyFile.path}`,
        });
      }
    }
  }

  // Inspect Go, Rust, Docker
  const goMod = files.find((f) => f.name === 'go.mod');
  if (goMod) {
    addFramework({
      name: 'Go Modules',
      category: 'runtime',
      evidenceFile: goMod.path,
      evidenceDetail: 'go.mod module manifest present',
    });
  }
  const cargoToml = files.find((f) => f.name === 'Cargo.toml');
  if (cargoToml) {
    addFramework({
      name: 'Cargo (Rust)',
      category: 'runtime',
      evidenceFile: cargoToml.path,
      evidenceDetail: 'Cargo.toml crate manifest present',
    });
  }
  const dockerfile = files.find((f) => f.name.toLowerCase() === 'dockerfile');
  if (dockerfile) {
    addFramework({
      name: 'Docker',
      category: 'tooling',
      evidenceFile: dockerfile.path,
      evidenceDetail: 'Dockerfile present',
    });
  }
  const tsConfig = files.find((f) => f.name === 'tsconfig.json');
  if (tsConfig) {
    addFramework({
      name: 'TypeScript',
      category: 'tooling',
      evidenceFile: tsConfig.path,
      evidenceDetail: 'tsconfig.json compiler configuration present',
    });
  }

  // Common file-based entry points verified to exist in ingested files
  const filePathsSet = new Set(files.map((f) => f.path));
  const commonEntries = [
    'index.ts', 'index.js', 'server.ts', 'server.js', 'app.ts', 'app.js', 'main.py', 'app.py', 'main.go',
    'src/index.ts', 'src/index.tsx', 'src/index.js', 'src/main.ts', 'src/main.tsx', 'src/App.tsx', 'src/app.ts', 'src/server.ts',
    'lib/index.js', 'lib/index.ts', 'cmd/main.go', 'src/main.rs', 'src/lib.rs',
  ];
  for (const candidate of commonEntries) {
    if (filePathsSet.has(candidate)) {
      addEntry(candidate, 'Standard entry point filename present in repository');
    }
  }

  const totalTreeFiles = tree.filter((t) => t.type === 'blob').length;
  const skippedFileCount = tree.filter(
    (t) => t.type === 'blob' && !t.ingested && !t.failed
  ).length;

  return {
    languages,
    frameworks,
    entryPoints,
    totalTreeFiles,
    eligibleFileCount,
    ingestedFileCount: files.length,
    skippedFileCount,
    failedFileCount: failedFiles.length,
    skippedBreakdown,
    failedFiles,
    totalLinesOfCode: totalLines,
    totalBytesIngested: totalBytes,
    limitsApplied: {
      maxFiles: limits.MAX_INDEXABLE_FILES,
      maxFileBytes: limits.MAX_FILE_BYTES,
      maxTotalBytes: limits.MAX_TOTAL_BYTES,
      truncatedByFileCap,
      truncatedBySizeCap,
    },
    packageManifest,
  };
}

interface ParsedImport {
  specifier: string;
  importedNames: string[];
  line: number;
  rawStatement: string;
}

function parseJsTsImports(content: string): ParsedImport[] {
  const results: ParsedImport[] = [];
  const lines = content.split('\n');

  // Strip block comments roughly while preserving line indices
  const cleanedLines: string[] = [];
  let inBlockComment = false;
  for (const line of lines) {
    let out = line;
    if (inBlockComment) {
      const endIdx = out.indexOf('*/');
      if (endIdx >= 0) {
        out = out.slice(endIdx + 2);
        inBlockComment = false;
      } else {
        cleanedLines.push('');
        continue;
      }
    }
    const startIdx = out.indexOf('/*');
    if (startIdx >= 0) {
      const endIdx = out.indexOf('*/', startIdx + 2);
      if (endIdx >= 0) {
        out = out.slice(0, startIdx) + out.slice(endIdx + 2);
      } else {
        out = out.slice(0, startIdx);
        inBlockComment = true;
      }
    }
    const lineCommentIdx = out.indexOf('//');
    if (lineCommentIdx >= 0 && !out.slice(0, lineCommentIdx).includes('://')) {
      out = out.slice(0, lineCommentIdx);
    }
    cleanedLines.push(out);
  }

  const joined = cleanedLines.join('\n');

  // Helper to get 1-based line number from character index
  const lineAtOffset = (offset: number): number => {
    let line = 1;
    for (let i = 0; i < offset; i++) {
      if (joined.charCodeAt(i) === 10) line++;
    }
    return line;
  };

  // Match ES static imports and re-exports: import ... from 'x' / export ... from 'x'
  const esmRegex = /\b(?:import|export)\s+([\s\S]*?)\bfrom\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = esmRegex.exec(joined)) !== null) {
    const clause = match[1].replace(/\s+/g, ' ').trim();
    const spec = match[2];
    const line = lineAtOffset(match.index);
    const rawStatement = match[0].replace(/\s+/g, ' ').trim().slice(0, 140);
    results.push({
      specifier: spec,
      importedNames: clause ? [clause.slice(0, 60)] : ['*'],
      line,
      rawStatement,
    });
  }

  // Side-effect imports: import 'x'
  const sideEffectRegex = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]\s*;?/g;
  while ((match = sideEffectRegex.exec(joined)) !== null) {
    const spec = match[1];
    const line = lineAtOffset(match.index);
    results.push({
      specifier: spec,
      importedNames: ['(side-effect)'],
      line,
      rawStatement: match[0].trim().slice(0, 140),
    });
  }

  // require('x')
  const requireRegex = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRegex.exec(joined)) !== null) {
    const spec = match[1];
    const line = lineAtOffset(match.index);
    const rawLine = (lines[line - 1] ?? match[0]).trim().slice(0, 140);
    results.push({
      specifier: spec,
      importedNames: ['require'],
      line,
      rawStatement: rawLine,
    });
  }

  // Dynamic import('x')
  const dynRegex = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynRegex.exec(joined)) !== null) {
    const spec = match[1];
    const line = lineAtOffset(match.index);
    const rawLine = (lines[line - 1] ?? match[0]).trim().slice(0, 140);
    results.push({
      specifier: spec,
      importedNames: ['dynamic import()'],
      line,
      rawStatement: rawLine,
    });
  }

  return results;
}

function parsePythonImports(content: string): ParsedImport[] {
  const results: ParsedImport[] = [];
  const lines = content.split('\n');

  lines.forEach((rawLine, idx) => {
    const line = rawLine.split('#')[0].trim();
    if (!line) return;

    const fromMatch = /^from\s+([a-zA-Z0-9_.]+)\s+import\s+(.+)$/.exec(line);
    if (fromMatch) {
      results.push({
        specifier: fromMatch[1],
        importedNames: [fromMatch[2].trim().slice(0, 60)],
        line: idx + 1,
        rawStatement: line.slice(0, 140),
      });
      return;
    }

    const impMatch = /^import\s+([a-zA-Z0-9_.,\s]+)$/.exec(line);
    if (impMatch) {
      const modules = impMatch[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]);
      for (const mod of modules) {
        if (mod) {
          results.push({
            specifier: mod,
            importedNames: [mod],
            line: idx + 1,
            rawStatement: line.slice(0, 140),
          });
        }
      }
    }
  });

  return results;
}

function parseGoImports(content: string): ParsedImport[] {
  const results: ParsedImport[] = [];
  const lines = content.split('\n');
  let inBlock = false;

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (line.startsWith('import (')) {
      inBlock = true;
      return;
    }
    if (inBlock) {
      if (line.startsWith(')')) {
        inBlock = false;
        return;
      }
      const m = /"([^"]+)"/.exec(line);
      if (m) {
        results.push({
          specifier: m[1],
          importedNames: [m[1].split('/').pop() ?? m[1]],
          line: idx + 1,
          rawStatement: line.slice(0, 140),
        });
      }
      return;
    }
    const single = /^import\s+(?:[a-zA-Z0-9_]+\s+)?"([^"]+)"/.exec(line);
    if (single) {
      results.push({
        specifier: single[1],
        importedNames: [single[1].split('/').pop() ?? single[1]],
        line: idx + 1,
        rawStatement: line.slice(0, 140),
      });
    }
  });

  return results;
}

function resolveImportToFile(
  sourcePath: string,
  specifier: string,
  ingestedPaths: Set<string>,
  tsAliases: Array<{ prefix: string; targetPrefix: string }>
): { resolvedPath: string; kind: 'internal' } | { resolvedPath: string; kind: 'external' } {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.';
  let candidateBase: string | null = null;

  if (isRelative) {
    const sourceDir = path.posix.dirname(sourcePath);
    candidateBase = path.posix.normalize(path.posix.join(sourceDir, specifier));
  } else {
    for (const alias of tsAliases) {
      if (specifier.startsWith(alias.prefix)) {
        const rest = specifier.slice(alias.prefix.length);
        candidateBase = path.posix.normalize(path.posix.join(alias.targetPrefix, rest));
        break;
      }
    }
  }

  // Python dotted module check (e.g. from app.utils import x -> app/utils.py)
  if (!candidateBase && sourcePath.endsWith('.py')) {
    if (specifier.startsWith('.')) {
      const dots = /^(\.+)(.*)$/.exec(specifier);
      if (dots) {
        let dir = path.posix.dirname(sourcePath);
        for (let i = 1; i < dots[1].length; i++) {
          dir = path.posix.dirname(dir);
        }
        const modPath = dots[2].replace(/\./g, '/');
        candidateBase = modPath ? path.posix.join(dir, modPath) : dir;
      }
    } else {
      const modPath = specifier.replace(/\./g, '/');
      if (
        ingestedPaths.has(`${modPath}.py`) ||
        ingestedPaths.has(`${modPath}/__init__.py`)
      ) {
        candidateBase = modPath;
      }
    }
  }

  if (candidateBase) {
    const extensions = [
      '',
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.py',
      '.json',
      '.css',
      '/index.ts',
      '/index.tsx',
      '/index.js',
      '/index.jsx',
      '/__init__.py',
    ];

    // Also strip .js/.mjs if TS uses ESM-style .js imports pointing to .ts files
    const stripped = candidateBase.replace(/\.(js|mjs|cjs)$/, '');
    const bases = stripped !== candidateBase ? [candidateBase, stripped] : [candidateBase];

    for (const base of bases) {
      for (const ext of extensions) {
        const testPath = `${base}${ext}`.replace(/^\.\//, '');
        if (ingestedPaths.has(testPath)) {
          return { resolvedPath: testPath, kind: 'internal' };
        }
      }
    }
  }

  // External package: normalize scoped (@org/pkg/sub -> @org/pkg) or regular (pkg/sub -> pkg)
  let externalName = specifier;
  if (!isRelative) {
    if (specifier.startsWith('@')) {
      const parts = specifier.split('/');
      externalName = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
    } else if (!specifier.startsWith('node:')) {
      externalName = specifier.split('/')[0];
    }
  }

  return { resolvedPath: externalName, kind: 'external' };
}

function extractTsAliases(files: SourceFile[]): Array<{ prefix: string; targetPrefix: string }> {
  const tsConfig = files.find((f) => f.path === 'tsconfig.json');
  if (!tsConfig) return [{ prefix: '@/', targetPrefix: '' }];
  try {
    const parsed = JSON.parse(stripJsonComments(tsConfig.content)) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const baseUrl = parsed.compilerOptions?.baseUrl?.replace(/^\.\//, '') ?? '';
    const paths = parsed.compilerOptions?.paths ?? {};
    const aliases: Array<{ prefix: string; targetPrefix: string }> = [];
    for (const [pattern, targets] of Object.entries(paths)) {
      if (!targets || targets.length === 0) continue;
      const prefix = pattern.replace(/\*$/, '');
      const target = targets[0].replace(/\*$/, '').replace(/^\.\//, '');
      aliases.push({
        prefix,
        targetPrefix: baseUrl ? path.posix.join(baseUrl, target) : target,
      });
    }
    if (aliases.length === 0) {
      aliases.push({ prefix: '@/', targetPrefix: '' });
    }
    return aliases;
  } catch {
    return [{ prefix: '@/', targetPrefix: '' }];
  }
}

export function extractArchitectureGraph(files: SourceFile[]): ArchitectureGraph {
  const ingestedPaths = new Set(files.map((f) => f.path));
  const tsAliases = extractTsAliases(files);

  const edgeAccumulator = new Map<
    string,
    {
      sourcePath: string;
      targetPath: string;
      targetKind: 'internal' | 'external';
      evidences: ArchitectureEdgeEvidence[];
    }
  >();

  let parsedFilesCount = 0;

  for (const file of files) {
    const ext = file.extension.toLowerCase();
    let imports: ParsedImport[] = [];

    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      parsedFilesCount++;
      imports = parseJsTsImports(file.content);
    } else if (ext === '.py') {
      parsedFilesCount++;
      imports = parsePythonImports(file.content);
    } else if (ext === '.go') {
      parsedFilesCount++;
      imports = parseGoImports(file.content);
    }

    for (const imp of imports) {
      const resolved = resolveImportToFile(file.path, imp.specifier, ingestedPaths, tsAliases);
      if (resolved.kind === 'internal' && resolved.resolvedPath === file.path) {
        continue;
      }

      const key = `${file.path}=>${resolved.kind}:${resolved.resolvedPath}`;
      const existing = edgeAccumulator.get(key) ?? {
        sourcePath: file.path,
        targetPath: resolved.resolvedPath,
        targetKind: resolved.kind,
        evidences: [],
      };
      existing.evidences.push({
        line: imp.line,
        rawStatement: imp.rawStatement,
        specifiers: imp.importedNames,
      });
      edgeAccumulator.set(key, existing);
    }
  }

  // Build nodes only for files involved in edges OR key code files (no fake connections)
  const fileByPath = new Map(files.map((f) => [f.path, f]));
  const nodeMap = new Map<string, ArchitectureNode>();

  const ensureNode = (nodePath: string, kind: 'internal' | 'external') => {
    const id = kind === 'internal' ? `file:${nodePath}` : `ext:${nodePath}`;
    const existing = nodeMap.get(id);
    if (existing) return existing;

    const fileMeta = kind === 'internal' ? fileByPath.get(nodePath) : undefined;
    const directory =
      kind === 'external'
        ? 'external'
        : nodePath.includes('/')
        ? nodePath.slice(0, nodePath.lastIndexOf('/'))
        : 'root';

    const node: ArchitectureNode = {
      id,
      label: nodePath.split('/').pop() ?? nodePath,
      path: nodePath,
      directory,
      kind,
      language: fileMeta?.language,
      lines: fileMeta?.lines,
      inDegree: 0,
      outDegree: 0,
      position: { x: 0, y: 0 },
    };
    nodeMap.set(id, node);
    return node;
  };

  // Add all source code files that were parsed so isolated modules are also honestly visible
  for (const file of files) {
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go'].includes(file.extension)) {
      ensureNode(file.path, 'internal');
    }
  }

  const edges: ArchitectureEdge[] = [];
  let internalEdgeCount = 0;
  let externalEdgeCount = 0;

  for (const [, rawEdge] of edgeAccumulator.entries()) {
    const sourceNode = ensureNode(rawEdge.sourcePath, 'internal');
    const targetNode = ensureNode(rawEdge.targetPath, rawEdge.targetKind);

    sourceNode.outDegree += 1;
    targetNode.inDegree += 1;

    if (rawEdge.targetKind === 'internal') internalEdgeCount++;
    else externalEdgeCount++;

    edges.push({
      id: `${sourceNode.id}->${targetNode.id}`,
      source: sourceNode.id,
      target: targetNode.id,
      sourcePath: rawEdge.sourcePath,
      targetPath: rawEdge.targetPath,
      targetKind: rawEdge.targetKind,
      evidences: rawEdge.evidences,
    });
  }

  // Deterministic layered layout grouped by directory & connectivity
  const internalNodes = Array.from(nodeMap.values()).filter((n) => n.kind === 'internal');
  const externalNodes = Array.from(nodeMap.values()).filter((n) => n.kind === 'external');

  // Group internal nodes by directory, sorted alphabetically
  const dirGroups = new Map<string, ArchitectureNode[]>();
  for (const node of internalNodes) {
    const arr = dirGroups.get(node.directory) ?? [];
    arr.push(node);
    dirGroups.set(node.directory, arr);
  }

  const sortedDirs = Array.from(dirGroups.keys()).sort((a, b) => {
    if (a === 'root') return -1;
    if (b === 'root') return 1;
    return a.localeCompare(b);
  });

  const COL_WIDTH = 300;
  const ROW_HEIGHT = 115;

  sortedDirs.forEach((dir, colIdx) => {
    const group = dirGroups.get(dir) ?? [];
    // Sort within directory: higher outDegree / entry points near top
    group.sort((a, b) => b.outDegree + b.inDegree - (a.outDegree + a.inDegree) || a.path.localeCompare(b.path));
    group.forEach((node, rowIdx) => {
      node.position = {
        x: colIdx * COL_WIDTH,
        y: rowIdx * ROW_HEIGHT,
      };
    });
  });

  // Position external packages in the rightmost column
  externalNodes.sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path));
  const extColX = Math.max(1, sortedDirs.length) * COL_WIDTH + 60;
  externalNodes.forEach((node, rowIdx) => {
    node.position = {
      x: extColX,
      y: rowIdx * 95,
    };
  });

  const extractionNotes: string[] = [
    `Parsed static import/require statements across ${parsedFilesCount} source files.`,
    `Detected ${internalEdgeCount} internal module edges and ${externalEdgeCount} external dependency edges.`,
    'Every edge is backed by an exact line number and import statement; unlinked files have no detected static imports within ingested files.',
  ];

  return {
    nodes: Array.from(nodeMap.values()),
    edges,
    internalEdgeCount,
    externalEdgeCount,
    parsedFilesCount,
    extractionNotes,
  };
}

export async function generateAiAnalysis(
  payload: IngestedRepoPayload,
  facts: DetectedFacts,
  architecture: ArchitectureGraph
): Promise<AIAnalysis> {
  if (!isAiTextConfigured()) {
    return {
      status: 'unavailable',
      model: getPrimaryAiTextModel(),
      generatedAt: new Date().toISOString(),
      summary:
        'AI analysis is unavailable because no AI text provider (GROQ_API_KEY or GEMINI_API_KEY) is configured on the server. Deterministic facts and static architecture graph are still available.',
      architecturalPattern: 'Not analyzed (AI provider missing)',
      keyCapabilities: [],
      modules: [],
      caveats: ['Configure GROQ_API_KEY or GEMINI_API_KEY in server secrets to generate AI architectural insights.'],
    };
  }

  try {
    const fileListPreview =
      payload.files.length <= 220
        ? payload.files
            .map((f) => `- ${f.path} (${f.language}, ${f.lines} lines)`)
            .join('\n')
        : [
            ...payload.files
              .slice(0, 220)
              .map((f) => `- ${f.path} (${f.language}, ${f.lines} lines)`),
            `... and ${payload.files.length - 220} additional indexed files.`,
          ].join('\n');

    const readmeExcerpt = payload.readmeContent
      ? payload.readmeContent.slice(0, 4000)
      : '(No README found)';

    // Include excerpts of key non-README files (entry points + manifests + top connected files)
    const entrySet = new Set(facts.entryPoints.map((e) => e.path));
    const connectedSet = new Set(
      architecture.nodes
        .filter((n) => n.kind === 'internal')
        .sort((a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree))
        .slice(0, 12)
        .map((n) => n.path)
    );

    const sampleFiles = payload.files
      .filter(
        (f) =>
          f.path !== payload.readmePath &&
          (entrySet.has(f.path) ||
            connectedSet.has(f.path) ||
            f.name === 'package.json' ||
            f.name === 'pyproject.toml' ||
            f.name === 'Cargo.toml' ||
            f.name === 'go.mod')
      )
      .slice(0, 14);

    const codeSamples = sampleFiles
      .map((f) => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 2200)}\n\`\`\``)
      .join('\n\n');

    const prompt = `Analyze this real GitHub repository strictly from the observed facts and ingested source files below.

REPOSITORY METADATA:
- Full name: ${payload.metadata.fullName}
- Description: ${payload.metadata.description ?? 'None'}
- Primary language (GitHub): ${payload.metadata.primaryLanguage ?? 'Unknown'}
- Default branch: ${payload.metadata.defaultBranch}

DETECTED FACTS (Deterministic):
- Total files in repo tree: ${facts.totalTreeFiles}
- Files ingested for inspection: ${facts.ingestedFileCount}
- Detected languages: ${facts.languages.map((l) => `${l.language} (${l.percentage}%)`).join(', ')}
- Detected frameworks/tools: ${facts.frameworks.map((fw) => `${fw.name} [${fw.evidenceFile}]`).join(', ') || 'None detected in manifests'}
- Entry points: ${facts.entryPoints.map((e) => e.path).join(', ') || 'None explicitly declared'}

INGESTED FILE LIST:
${fileListPreview}

README EXCERPT:
${readmeExcerpt}

KEY SOURCE FILE EXCERPTS:
${codeSamples}`;

    const aiRes = await generateAiStructuredJson<{
      summary: string;
      architecturalPattern: string;
      keyCapabilities: string[];
      modules: Array<{
        name: string;
        directoryOrFile: string;
        responsibility: string;
        keyFiles: string[];
      }>;
      caveats: string[];
    }>({
      systemInstruction:
        'You are a senior software architect. Produce an accurate, evidence-grounded architectural analysis of the repository. ONLY reference file paths, libraries, and behaviors directly observed in the supplied repository files. Do NOT fabricate features, endpoints, or modules. If something is unclear or truncated due to ingestion limits, note it in caveats.',
      prompt,
      thinkingLevel: ThinkingLevel.LOW,
      maxTokens: 4096,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: {
            type: Type.STRING,
            description: '2-3 paragraph architectural summary grounded in the actual files.',
          },
          architecturalPattern: {
            type: Type.STRING,
            description: 'Short label for the observed architecture (e.g. Modular Express REST API + React SPA, CLI Library, Monorepo Package).',
          },
          keyCapabilities: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Concrete capabilities implemented in the observed code.',
          },
          modules: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                directoryOrFile: { type: Type.STRING },
                responsibility: { type: Type.STRING },
                keyFiles: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              required: ['name', 'directoryOrFile', 'responsibility', 'keyFiles'],
            },
            description: 'Actual modules or directories observed in the repo and their responsibilities.',
          },
          caveats: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Gaps, skipped files, or uncertainties due to partial tree ingestion.',
          },
        },
        required: ['summary', 'architecturalPattern', 'keyCapabilities', 'modules', 'caveats'],
      },
    });
    const result = aiRes.data;

    // Filter module keyFiles to only files that genuinely exist in the tree
    const validPaths = new Set(payload.tree.map((t) => t.path));
    const sanitizedModules = (result.modules ?? []).map((m) => ({
      ...m,
      keyFiles: (m.keyFiles ?? []).filter((kf) => validPaths.has(kf)),
    }));

    return {
      status: 'complete',
      model: aiRes.model,
      generatedAt: new Date().toISOString(),
      summary: result.summary,
      architecturalPattern: result.architecturalPattern,
      keyCapabilities: result.keyCapabilities ?? [],
      modules: sanitizedModules,
      caveats: result.caveats ?? [],
    };
  } catch (err) {
    const msg = formatAiError(err);
    return {
      status: 'error',
      model: getPrimaryAiTextModel(),
      generatedAt: new Date().toISOString(),
      summary: 'AI architectural analysis failed.',
      architecturalPattern: 'Analysis Error',
      keyCapabilities: [],
      modules: [],
      caveats: [],
      errorMessage: msg,
    };
  }
}
