import { ThinkingLevel, Type } from '@google/genai';
import type {
  AIAnalysis,
  ArchitectureGraph,
  ComprehensiveOverview,
  DetectedFacts,
  EvidenceConfidence,
  IssueCategory,
  OverviewBatchResult,
  OverviewProgressEvent,
  RepositoryMetadata,
  RepositoryRecord,
  SourceCitation,
  SourceFile,
  TechStackGroup,
  TechStackItem,
} from '../src/types.ts';
import { DurablePersistenceError, store } from './db.ts';
import {
  type AiErrorCategory,
  classifyAiError,
  formatAiError,
  generateAiStructuredJson,
  getPrimaryAiTextModel,
  isAiTextConfigured,
} from './ai.ts';

const MAX_FILES_PER_BATCH = 22;
const MAX_CHARS_PER_BATCH = 42_000;
const MAX_FILE_CHARS_IN_BATCH = 4_000;
const INTER_BATCH_PAUSE_MS = 1000;

interface TechRule {
  pkg: string;
  name: string;
  group: TechStackGroup;
  importHints: string[];
}

const TECH_RULES: TechRule[] = [
  // Frontend
  { pkg: 'react', name: 'React', group: 'Frontend', importHints: ['react', 'react-dom'] },
  { pkg: 'react-dom', name: 'React DOM', group: 'Frontend', importHints: ['react-dom'] },
  { pkg: 'react-router-dom', name: 'React Router', group: 'Frontend', importHints: ['react-router-dom', 'react-router'] },
  { pkg: 'next', name: 'Next.js', group: 'Frontend', importHints: ['next/', 'next'] },
  { pkg: 'vue', name: 'Vue.js', group: 'Frontend', importHints: ['vue'] },
  { pkg: 'svelte', name: 'Svelte', group: 'Frontend', importHints: ['svelte'] },
  { pkg: '@angular/core', name: 'Angular', group: 'Frontend', importHints: ['@angular/core'] },
  { pkg: 'tailwindcss', name: 'Tailwind CSS', group: 'Frontend', importHints: ['tailwindcss', '@import "tailwindcss"'] },
  { pkg: '@tailwindcss/vite', name: 'Tailwind CSS Vite Plugin', group: 'Build & Dev Tools', importHints: ['@tailwindcss/vite'] },
  { pkg: 'lucide-react', name: 'Lucide React Icons', group: 'Frameworks & Libraries', importHints: ['lucide-react'] },
  { pkg: '@xyflow/react', name: 'React Flow', group: 'Frameworks & Libraries', importHints: ['@xyflow/react'] },
  { pkg: 'recharts', name: 'Recharts', group: 'Frameworks & Libraries', importHints: ['recharts'] },
  { pkg: 'framer-motion', name: 'Framer Motion', group: 'Frameworks & Libraries', importHints: ['framer-motion'] },
  { pkg: 'zustand', name: 'Zustand', group: 'Frameworks & Libraries', importHints: ['zustand'] },
  { pkg: '@radix-ui/react-dialog', name: 'Radix UI', group: 'Frameworks & Libraries', importHints: ['@radix-ui/'] },
  { pkg: 'three', name: 'Three.js', group: 'Frameworks & Libraries', importHints: ['three'] },
  { pkg: 'leaflet', name: 'Leaflet', group: 'Frameworks & Libraries', importHints: ['leaflet'] },

  // Mobile / Native Bridge
  { pkg: '@capacitor/core', name: 'Capacitor', group: 'Frameworks & Libraries', importHints: ['@capacitor/core', '@capacitor/'] },
  { pkg: '@capacitor/android', name: 'Capacitor Android', group: 'Build & Dev Tools', importHints: ['@capacitor/android', 'capacitor-android'] },
  { pkg: '@capacitor/camera', name: 'Capacitor Camera', group: 'APIs & Integrations', importHints: ['@capacitor/camera'] },
  { pkg: '@capacitor/geolocation', name: 'Capacitor Geolocation', group: 'APIs & Integrations', importHints: ['@capacitor/geolocation'] },
  { pkg: '@capacitor/preferences', name: 'Capacitor Preferences', group: 'Database & Storage', importHints: ['@capacitor/preferences'] },

  // Backend
  { pkg: 'express', name: 'Express.js', group: 'Backend', importHints: ['express'] },
  { pkg: 'fastify', name: 'Fastify', group: 'Backend', importHints: ['fastify'] },
  { pkg: 'hono', name: 'Hono', group: 'Backend', importHints: ['hono'] },
  { pkg: '@nestjs/core', name: 'NestJS', group: 'Backend', importHints: ['@nestjs/core'] },
  { pkg: 'cors', name: 'CORS Middleware', group: 'Backend', importHints: ['cors'] },
  { pkg: 'dotenv', name: 'dotenv', group: 'Backend', importHints: ['dotenv'] },
  { pkg: 'fastapi', name: 'FastAPI', group: 'Backend', importHints: ['fastapi'] },
  { pkg: 'django', name: 'Django', group: 'Backend', importHints: ['django'] },
  { pkg: 'flask', name: 'Flask', group: 'Backend', importHints: ['flask'] },

  // Database & Storage
  { pkg: 'mongodb', name: 'MongoDB Driver', group: 'Database & Storage', importHints: ['mongodb'] },
  { pkg: 'mongoose', name: 'Mongoose ODM', group: 'Database & Storage', importHints: ['mongoose'] },
  { pkg: '@supabase/supabase-js', name: 'Supabase Client', group: 'Database & Storage', importHints: ['@supabase/supabase-js'] },
  { pkg: 'firebase', name: 'Firebase SDK', group: 'Database & Storage', importHints: ['firebase/'] },
  { pkg: 'prisma', name: 'Prisma', group: 'Database & Storage', importHints: ['prisma'] },
  { pkg: '@prisma/client', name: 'Prisma Client', group: 'Database & Storage', importHints: ['@prisma/client'] },
  { pkg: 'drizzle-orm', name: 'Drizzle ORM', group: 'Database & Storage', importHints: ['drizzle-orm'] },
  { pkg: 'pg', name: 'PostgreSQL (pg)', group: 'Database & Storage', importHints: ['pg'] },
  { pkg: 'redis', name: 'Redis', group: 'Database & Storage', importHints: ['redis'] },
  { pkg: 'dexie', name: 'Dexie (IndexedDB)', group: 'Database & Storage', importHints: ['dexie'] },
  { pkg: 'sql.js', name: 'sql.js (SQLite)', group: 'Database & Storage', importHints: ['sql.js'] },

  // APIs & AI
  { pkg: '@google/genai', name: 'Google GenAI SDK', group: 'APIs & Integrations', importHints: ['@google/genai'] },
  { pkg: 'openai', name: 'OpenAI SDK', group: 'APIs & Integrations', importHints: ['openai'] },
  { pkg: 'axios', name: 'Axios HTTP Client', group: 'APIs & Integrations', importHints: ['axios'] },
  { pkg: 'zod', name: 'Zod Validation', group: 'Frameworks & Libraries', importHints: ['zod'] },
  { pkg: '@mediapipe/tasks-vision', name: 'MediaPipe Vision', group: 'APIs & Integrations', importHints: ['@mediapipe/'] },
  { pkg: '@tensorflow/tfjs', name: 'TensorFlow.js', group: 'APIs & Integrations', importHints: ['@tensorflow/tfjs'] },
  { pkg: 'face-api.js', name: 'face-api.js', group: 'APIs & Integrations', importHints: ['face-api.js'] },
  { pkg: 'qrcode', name: 'QRCode Generator', group: 'Frameworks & Libraries', importHints: ['qrcode'] },
  { pkg: 'html5-qrcode', name: 'html5-qrcode Scanner', group: 'Frameworks & Libraries', importHints: ['html5-qrcode'] },
  { pkg: 'jspdf', name: 'jsPDF', group: 'Frameworks & Libraries', importHints: ['jspdf'] },

  // Build & Dev Tools
  { pkg: 'vite', name: 'Vite', group: 'Build & Dev Tools', importHints: ['vite'] },
  { pkg: 'typescript', name: 'TypeScript', group: 'Build & Dev Tools', importHints: ['.ts', '.tsx'] },
  { pkg: 'tsx', name: 'tsx Runner', group: 'Build & Dev Tools', importHints: ['tsx'] },
  { pkg: 'eslint', name: 'ESLint', group: 'Build & Dev Tools', importHints: ['eslint'] },
  { pkg: 'vitest', name: 'Vitest', group: 'Build & Dev Tools', importHints: ['vitest'] },
  { pkg: 'jest', name: 'Jest', group: 'Build & Dev Tools', importHints: ['jest'] },
  { pkg: '@vitejs/plugin-react', name: 'Vite React Plugin', group: 'Build & Dev Tools', importHints: ['@vitejs/plugin-react'] },
];

function findLinesMatching(
  files: SourceFile[],
  matcher: (line: string, file: SourceFile) => boolean,
  maxHits = 3
): SourceCitation[] {
  const citations: SourceCitation[] = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let idx = 0; idx < lines.length; idx++) {
      if (matcher(lines[idx], file)) {
        citations.push({
          filePath: file.path,
          startLine: idx + 1,
          endLine: idx + 1,
          snippet: lines[idx].trim().slice(0, 140),
        });
        if (citations.length >= maxHits) return citations;
      }
    }
  }
  return citations;
}

export function scanEnvironmentVariables(files: SourceFile[]): Array<{
  name: string;
  required: 'required' | 'optional' | 'unknown';
  purpose: string;
  references: SourceCitation[];
}> {
  const varMap = new Map<string, SourceCitation[]>();

  const addRef = (name: string, citation: SourceCitation) => {
    if (!name || name.length < 2) return;
    const arr = varMap.get(name) ?? [];
    if (!arr.some((c) => c.filePath === citation.filePath && c.startLine === citation.startLine)) {
      arr.push(citation);
    }
    varMap.set(name, arr);
  };

  for (const file of files) {
    const lines = file.content.split('\n');
    const isEnvTemplate =
      file.name === '.env.example' ||
      file.name === '.env.sample' ||
      file.name === '.env.template' ||
      file.name.endsWith('.env.example');

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (isEnvTemplate) {
        const envKey = /^\s*([A-Z][A-Z0-9_]{1,60})\s*=/.exec(line);
        if (envKey) {
          // Record key name only — never include any value after "="
          addRef(envKey[1], {
            filePath: file.path,
            startLine: idx + 1,
            endLine: idx + 1,
            snippet: `${envKey[1]}=<declared in template>`,
          });
        }
        continue;
      }

      const patterns = [
        /\bprocess\.env\.([A-Z][A-Z0-9_]{1,60})\b/g,
        /\bimport\.meta\.env\.([A-Z][A-Z0-9_]{1,60})\b/g,
        /\bos\.(?:getenv|environ\.get)\(\s*['"]([A-Z][A-Z0-9_]{1,60})['"]/g,
      ];
      for (const rx of patterns) {
        let m: RegExpExecArray | null;
        while ((m = rx.exec(line)) !== null) {
          addRef(m[1], {
            filePath: file.path,
            startLine: idx + 1,
            endLine: idx + 1,
            snippet: line.trim().slice(0, 140),
          });
        }
      }
    }
  }

  return Array.from(varMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, references]) => ({
      name,
      required: name === 'PORT' ? 'optional' : 'unknown',
      purpose: `Referenced in ${references[0].filePath}:${references[0].startLine}`,
      references: references.slice(0, 5),
    }));
}

interface ManifestInventory {
  scripts: Array<{ name: string; command: string; sourceFile: string }>;
  packageNames: Map<string, { version: string; file: string }>;
  techStack: TechStackItem[];
}

export function scanManifestsAndTechStack(
  files: SourceFile[],
  architecture: ArchitectureGraph
): ManifestInventory {
  const scripts: Array<{ name: string; command: string; sourceFile: string }> = [];
  const packageNames = new Map<string, { version: string; file: string }>();

  for (const file of files) {
    if (file.name === 'package.json') {
      try {
        const parsed = JSON.parse(file.content) as {
          scripts?: Record<string, string>;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        if (parsed.scripts) {
          for (const [name, command] of Object.entries(parsed.scripts)) {
            scripts.push({ name, command, sourceFile: file.path });
          }
        }
        const allDeps = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
        for (const [pkg, version] of Object.entries(allDeps)) {
          if (!packageNames.has(pkg)) {
            packageNames.set(pkg, { version: String(version), file: file.path });
          }
        }
      } catch {
        // Ignore malformed package.json
      }
    }
  }

  // Index external packages directly seen imported in static architecture graph
  const importedPackages = new Set<string>(
    architecture.nodes.filter((n) => n.kind === 'external').map((n) => n.path)
  );

  const techStack: TechStackItem[] = [];
  const seenNames = new Set<string>();

  for (const rule of TECH_RULES) {
    const manifestEntry = packageNames.get(rule.pkg);
    const hasEdge = rule.importHints.some((hint) => importedPackages.has(hint));
    const sourceEvidence = findLinesMatching(
      files,
      (line, file) => {
        if (file.name === 'package.json' || file.name === 'package-lock.json') return false;
        if (rule.pkg === 'typescript') {
          return file.extension === '.ts' || file.extension === '.tsx';
        }
        return rule.importHints.some(
          (hint) =>
            line.includes(`'${hint}`) ||
            line.includes(`"${hint}`) ||
            (hint.startsWith('@import') && line.includes(hint))
        );
      },
      3
    );

    if (!manifestEntry && !hasEdge && sourceEvidence.length === 0) continue;
    if (seenNames.has(rule.name)) continue;
    seenNames.add(rule.name);

    const verification: TechStackItem['verification'] =
      sourceEvidence.length > 0 || hasEdge
        ? 'verified-in-source'
        : manifestEntry
        ? 'manifest-only'
        : 'source-only';

    techStack.push({
      name: rule.name,
      group: rule.group,
      verification,
      versionOrDetail: manifestEntry?.version,
      manifestFile: manifestEntry?.file,
      sourceEvidence,
    });
  }

  // Detect Web / Browser APIs & Native config directly in source files
  const storageBrowserEvidence = findLinesMatching(
    files,
    (line) =>
      /\blocalStorage\.(getItem|setItem|removeItem)\b/.test(line) ||
      /\bindexedDB\.open\b/.test(line) ||
      /\bsessionStorage\.(getItem|setItem)\b/.test(line),
    3
  );
  if (storageBrowserEvidence.length > 0 && !seenNames.has('Browser LocalStorage / IndexedDB')) {
    seenNames.add('Browser LocalStorage / IndexedDB');
    techStack.push({
      name: 'Browser LocalStorage / IndexedDB',
      group: 'Database & Storage',
      verification: 'source-only',
      sourceEvidence: storageBrowserEvidence,
    });
  }

  const cameraWebRtcEvidence = findLinesMatching(
    files,
    (line) =>
      /\bnavigator\.mediaDevices\.getUserMedia\b/.test(line) ||
      /\bHTMLVideoElement\b/.test(line),
    2
  );
  if (cameraWebRtcEvidence.length > 0 && !seenNames.has('Web MediaDevices / Camera API')) {
    seenNames.add('Web MediaDevices / Camera API');
    techStack.push({
      name: 'Web MediaDevices / Camera API',
      group: 'APIs & Integrations',
      verification: 'source-only',
      sourceEvidence: cameraWebRtcEvidence,
    });
  }

  const androidManifest = files.find((f) => f.name === 'AndroidManifest.xml');
  if (androidManifest && !seenNames.has('Android Native Shell')) {
    seenNames.add('Android Native Shell');
    techStack.push({
      name: 'Android Native Shell',
      group: 'Build & Dev Tools',
      verification: 'verified-in-source',
      manifestFile: androidManifest.path,
      sourceEvidence: [
        {
          filePath: androidManifest.path,
          startLine: 1,
          endLine: Math.min(8, androidManifest.lines),
          snippet: 'AndroidManifest.xml configuration',
        },
      ],
    });
  }

  return { scripts, packageNames, techStack };
}

interface DeterministicCodeSignals {
  endpoints: Array<{ filePath: string; line: number; snippet: string }>;
  networkCalls: Array<{ filePath: string; line: number; snippet: string }>;
  storageUsages: Array<{ kind: string; filePath: string; line: number; snippet: string }>;
  emptyCatchBlocks: SourceCitation[];
  largeFiles: Array<{ path: string; lines: number }>;
  hasBackendFiles: boolean;
}

export function scanCodeSignals(files: SourceFile[]): DeterministicCodeSignals {
  const endpoints: Array<{ filePath: string; line: number; snippet: string }> = [];
  const networkCalls: Array<{ filePath: string; line: number; snippet: string }> = [];
  const storageUsages: Array<{ kind: string; filePath: string; line: number; snippet: string }> = [];
  const emptyCatchBlocks: SourceCitation[] = [];
  const largeFiles: Array<{ path: string; lines: number }> = [];
  let hasBackendFiles = false;

  for (const file of files) {
    const ext = file.extension.toLowerCase();
    const isCode = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java'].includes(ext);
    if (!isCode) continue;

    if (file.lines >= 450) {
      largeFiles.push({ path: file.path, lines: file.lines });
    }

    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (
        /\b(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`]/.test(line) ||
        /@(?:app|router)\.(get|post|put|patch|delete)\s*\(/.test(line)
      ) {
        hasBackendFiles = true;
        if (endpoints.length < 30) {
          endpoints.push({ filePath: file.path, line: i + 1, snippet: trimmed.slice(0, 140) });
        }
      }

      if (/\bfetch\s*\(/.test(line) || /\baxios\.(get|post|put|delete)\s*\(/.test(line)) {
        if (networkCalls.length < 25) {
          networkCalls.push({ filePath: file.path, line: i + 1, snippet: trimmed.slice(0, 140) });
        }
      }

      if (/\b(?:MongoClient|mongoose\.|createClient\(|supabase\.from|firebase|localStorage\.|indexedDB\.open|Preferences\.(?:get|set)|prisma\.)/.test(line)) {
        const kindMatch = /(MongoClient|mongoose|supabase|firebase|localStorage|indexedDB|Preferences|prisma)/.exec(line);
        if (storageUsages.length < 25) {
          storageUsages.push({
            kind: kindMatch?.[1] ?? 'storage',
            filePath: file.path,
            line: i + 1,
            snippet: trimmed.slice(0, 140),
          });
        }
      }

      // Single-line or next-line empty catch block detection
      if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(line)) {
        if (emptyCatchBlocks.length < 10) {
          emptyCatchBlocks.push({
            filePath: file.path,
            startLine: i + 1,
            endLine: i + 1,
            snippet: trimmed.slice(0, 120),
          });
        }
      } else if (
        /\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/.test(line) &&
        i + 1 < lines.length &&
        /^\s*\}\s*$/.test(lines[i + 1])
      ) {
        if (emptyCatchBlocks.length < 10) {
          emptyCatchBlocks.push({
            filePath: file.path,
            startLine: i + 1,
            endLine: i + 2,
            snippet: `${trimmed} }`,
          });
        }
      }
    }
  }

  return {
    endpoints,
    networkCalls,
    storageUsages,
    emptyCatchBlocks,
    largeFiles: largeFiles.sort((a, b) => b.lines - a.lines),
    hasBackendFiles,
  };
}

function getFolderBucket(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length === 1) return 'root';
  if (parts.length === 2) return parts[0];
  return `${parts[0]}/${parts[1]}`;
}

export function buildFolderInventory(files: SourceFile[]): Array<{
  folder: string;
  fileCount: number;
  totalLines: number;
  sampleFiles: string[];
}> {
  const map = new Map<string, { files: SourceFile[]; totalLines: number }>();
  for (const f of files) {
    const folder = getFolderBucket(f.path);
    const entry = map.get(folder) ?? { files: [], totalLines: 0 };
    entry.files.push(f);
    entry.totalLines += f.lines;
    map.set(folder, entry);
  }
  return Array.from(map.entries())
    .map(([folder, info]) => ({
      folder,
      fileCount: info.files.length,
      totalLines: info.totalLines,
      sampleFiles: [...info.files]
        .sort((a, b) => b.lines - a.lines)
        .slice(0, 6)
        .map((f) => f.path),
    }))
    .sort((a, b) => {
      if (a.folder === 'root') return -1;
      if (b.folder === 'root') return 1;
      return b.fileCount - a.fileCount || a.folder.localeCompare(b.folder);
    });
}

function formatNumberedFileForBatch(file: SourceFile): string {
  const lines = file.content.split('\n');
  const formatSlice = (startIdx: number, endIdx: number) =>
    lines
      .slice(startIdx, endIdx)
      .map((line, i) => `${startIdx + i + 1}| ${line}`)
      .join('\n');

  const fullFormatted = formatSlice(0, lines.length);
  if (fullFormatted.length <= MAX_FILE_CHARS_IN_BATCH) {
    return `### FILE: ${file.path} (${file.language}, ${file.lines} lines)\n\`\`\`\n${fullFormatted}\n\`\`\``;
  }

  // Keep head (imports/declarations) and tail (exports/main logic) with exact line numbers
  let headEnd = Math.min(lines.length, 65);
  let headText = formatSlice(0, headEnd);
  while (headText.length > 2600 && headEnd > 20) {
    headEnd -= 10;
    headText = formatSlice(0, headEnd);
  }

  let tailStart = Math.max(headEnd, lines.length - 35);
  let tailText = formatSlice(tailStart, lines.length);
  while (tailText.length > 1300 && tailStart < lines.length - 10) {
    tailStart += 5;
    tailText = formatSlice(tailStart, lines.length);
  }

  if (tailStart <= headEnd) {
    return `### FILE: ${file.path} (${file.language}, ${file.lines} lines)\n\`\`\`\n${formatSlice(0, lines.length).slice(0, MAX_FILE_CHARS_IN_BATCH)}\n\`\`\``;
  }

  return (
    `### FILE: ${file.path} (${file.language}, ${file.lines} lines — middle lines ${headEnd + 1}-${tailStart} omitted)\n` +
    `\`\`\`\n${headText}\n... [lines ${headEnd + 1}-${tailStart} omitted] ...\n${tailText}\n\`\`\``
  );
}

export function createAnalysisBatches(files: SourceFile[]): OverviewBatchResult[] {
  // Group files by folder bucket so cohesive modules stay in the same batch
  const sorted = [...files].sort((a, b) => {
    const ba = getFolderBucket(a.path);
    const bb = getFolderBucket(b.path);
    if (ba !== bb) {
      if (ba === 'root') return -1;
      if (bb === 'root') return 1;
      return ba.localeCompare(bb);
    }
    return a.path.localeCompare(b.path);
  });

  const batches: OverviewBatchResult[] = [];
  let currentFiles: SourceFile[] = [];
  let currentChars = 0;

  const flushBatch = () => {
    if (currentFiles.length === 0) return;
    const idx = batches.length + 1;
    const buckets = Array.from(new Set(currentFiles.map((f) => getFolderBucket(f.path))));
    const bucketSummary =
      buckets.length <= 2 ? buckets.join(' & ') : `${buckets[0]} + ${buckets.length - 1} dirs`;
    batches.push({
      batchId: `batch_${String(idx).padStart(2, '0')}`,
      label: `Batch ${idx} · ${bucketSummary}`,
      filePaths: currentFiles.map((f) => f.path),
      totalLines: currentFiles.reduce((acc, f) => acc + f.lines, 0),
      status: 'pending',
      fileSummaries: [],
      observedCapabilities: [],
      executionNotes: [],
      storageSignals: [],
      issuesObserved: [],
    });
    currentFiles = [];
    currentChars = 0;
  };

  for (const file of sorted) {
    const estimatedChars = Math.min(file.content.length + 250, MAX_FILE_CHARS_IN_BATCH + 300);
    if (
      currentFiles.length > 0 &&
      (currentFiles.length >= MAX_FILES_PER_BATCH || currentChars + estimatedChars > MAX_CHARS_PER_BATCH)
    ) {
      flushBatch();
    }
    currentFiles.push(file);
    currentChars += estimatedChars;
  }
  flushBatch();

  return batches;
}

async function analyzeSingleBatch(
  metadata: RepositoryMetadata,
  batch: OverviewBatchResult,
  fileMap: Map<string, SourceFile>
): Promise<OverviewBatchResult> {
  const batchFiles = batch.filePaths
    .map((p) => fileMap.get(p))
    .filter((f): f is SourceFile => Boolean(f));

  const codePayload = batchFiles.map(formatNumberedFileForBatch).join('\n\n');

  const aiRes = await generateAiStructuredJson<{
    fileSummaries: Array<{
      filePath: string;
      purpose: string;
      keySymbols: string[];
      interactions: string[];
    }>;
    observedCapabilities: string[];
    executionNotes: string[];
    storageSignals: string[];
    issuesObserved: Array<{
      title: string;
      severity: 'high' | 'medium' | 'low';
      description: string;
      filePath: string;
      startLine: number;
      endLine: number;
    }>;
  }>({
    systemInstruction:
      'You are analyzing one batch of source files from a real repository. ' +
      'Summarize EVERY file supplied in this batch accurately using ONLY what is visible in the numbered source lines. ' +
      'Do NOT invent functions, endpoints, databases, or workflows not present in the code. ' +
      'For any issueObserved, cite exact filePath, startLine, and endLine from the numbered lines shown.',
    prompt: `REPOSITORY: ${metadata.fullName}
BATCH: ${batch.label} (${batchFiles.length} files)

SOURCE FILES IN THIS BATCH:
${codePayload}`,
    thinkingLevel: ThinkingLevel.LOW,
    maxTokens: 6144,
    retryOptions: { maxRetries: 1, timeoutMs: 30_000 },
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        fileSummaries: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              filePath: { type: Type.STRING },
              purpose: { type: Type.STRING },
              keySymbols: { type: Type.ARRAY, items: { type: Type.STRING } },
              interactions: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ['filePath', 'purpose', 'keySymbols', 'interactions'],
          },
        },
        observedCapabilities: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        executionNotes: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Verified runtime interactions, API calls, event handlers, or routing observed in this batch.',
        },
        storageSignals: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Any DB queries, schemas, localStorage, IndexedDB, or state persistence observed.',
        },
        issuesObserved: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              severity: { type: Type.STRING, enum: ['high', 'medium', 'low'] },
              description: { type: Type.STRING },
              filePath: { type: Type.STRING },
              startLine: { type: Type.INTEGER },
              endLine: { type: Type.INTEGER },
            },
            required: ['title', 'severity', 'description', 'filePath', 'startLine', 'endLine'],
          },
        },
      },
      required: [
        'fileSummaries',
        'observedCapabilities',
        'executionNotes',
        'storageSignals',
        'issuesObserved',
      ],
    },
  });
  const response = aiRes.data;

  const validFileSet = new Set(batch.filePaths);
  const clampLine = (fp: string, ln: number | undefined): number | undefined => {
    const f = fileMap.get(fp);
    if (!f || typeof ln !== 'number' || !Number.isFinite(ln)) return undefined;
    return Math.max(1, Math.min(f.lines, Math.round(ln)));
  };

  return {
    ...batch,
    status: 'complete',
    fileSummaries: (response.fileSummaries ?? []).filter((fs) => validFileSet.has(fs.filePath)),
    observedCapabilities: response.observedCapabilities ?? [],
    executionNotes: response.executionNotes ?? [],
    storageSignals: response.storageSignals ?? [],
    issuesObserved: (response.issuesObserved ?? [])
      .filter((iss) => validFileSet.has(iss.filePath))
      .map((iss) => ({
        title: iss.title,
        severity: iss.severity === 'high' || iss.severity === 'low' ? iss.severity : 'medium',
        description: iss.description,
        filePath: iss.filePath,
        startLine: clampLine(iss.filePath, iss.startLine),
        endLine: clampLine(iss.filePath, iss.endLine),
      })),
    analyzedAt: new Date().toISOString(),
    errorMessage: undefined,
  };
}

function buildSkeletonOverview(params: {
  repo: RepositoryRecord;
  batches: OverviewBatchResult[];
  manifestInv: ManifestInventory;
  envVars: ReturnType<typeof scanEnvironmentVariables>;
  codeSignals: DeterministicCodeSignals;
  folderInv: ReturnType<typeof buildFolderInventory>;
}): ComprehensiveOverview {
  const { repo, batches, manifestInv, envVars, codeSignals, folderInv } = params;
  const completed = batches.filter((b) => b.status === 'complete');
  const failed = batches.filter((b) => b.status === 'failed');
  const analyzedFiles = completed.reduce((acc, b) => acc + b.filePaths.length, 0);

  const runCommands = manifestInv.scripts
    .filter((s) => ['dev', 'start', 'serve', 'android', 'ios'].includes(s.name))
    .map((s) => `npm run ${s.name}  # ${s.command} (${s.sourceFile})`);
  const buildCommands = manifestInv.scripts
    .filter((s) => ['build', 'preview', 'lint', 'typecheck', 'test'].includes(s.name))
    .map((s) => `npm run ${s.name}  # ${s.command} (${s.sourceFile})`);

  const verifiedIssues: ComprehensiveOverview['improvementOpportunities']['verifiedIssues'] = [];
  if (codeSignals.emptyCatchBlocks.length > 0) {
    verifiedIssues.push({
      title: 'Silent empty catch block(s) detected',
      category: 'error-handling',
      severity: 'medium',
      description: `Found ${codeSignals.emptyCatchBlocks.length} empty catch block(s) that swallow errors without logging or surfacing feedback.`,
      evidence: codeSignals.emptyCatchBlocks.slice(0, 4),
    });
  }
  if (codeSignals.largeFiles.length > 0) {
    verifiedIssues.push({
      title: 'Large source files (>= 450 lines)',
      category: 'maintainability',
      severity: 'low',
      description: `${codeSignals.largeFiles.length} file(s) exceed 450 lines (${codeSignals.largeFiles.slice(0, 3).map((f) => `${f.path}: ${f.lines} ln`).join(', ')}).`,
      evidence: codeSignals.largeFiles.slice(0, 4).map((f) => ({
        filePath: f.path,
        startLine: 1,
        endLine: Math.min(20, f.lines),
        snippet: `${f.lines} lines`,
      })),
    });
  }
  if (!repo.readmePath) {
    verifiedIssues.push({
      title: 'No README file found at repository root',
      category: 'documentation',
      severity: 'medium',
      description: 'No README documentation file was discovered among indexed repository files.',
      evidence: [],
    });
  }

  return {
    version: 1,
    status: 'analyzing',
    model: getPrimaryAiTextModel(),
    startedAt: new Date().toISOString(),
    commitSha: repo.metadata.commitSha,
    coverage: {
      analyzedFiles,
      totalEligibleFiles: repo.files.length,
      completedBatches: completed.length,
      totalBatches: batches.length,
      failedBatches: failed.length,
    },
    batches,
    projectIdentity: {
      name: repo.metadata.name,
      shortDescription:
        repo.metadata.description ||
        repo.aiAnalysis?.summary?.split('\n')[0] ||
        'Repository awaiting full staged synthesis.',
      mainPurpose: repo.aiAnalysis?.summary || 'Pending staged repository-wide synthesis.',
      problemSolved: 'Pending staged synthesis across repository files.',
      intendedUsers: [],
      primaryUseCases: repo.aiAnalysis?.keyCapabilities ?? [],
      evidence: repo.readmePath
        ? [{ filePath: repo.readmePath, startLine: 1, endLine: 20 }]
        : [],
      confidence: 'low',
    },
    technologyStack: manifestInv.techStack,
    projectStructure: {
      summary: `${repo.files.length} indexed source files organized across ${folderInv.length} top folder groups.`,
      entryPoints: repo.detectedFacts.entryPoints.map((e) => ({
        path: e.path,
        reason: e.reason,
        role: e.reason,
        line: 1,
      })),
      folderGuide: folderInv.map((fi) => ({
        folder: fi.folder,
        purpose: `${fi.fileCount} files (${fi.totalLines.toLocaleString()} lines)`,
        fileCount: fi.fileCount,
        importantFiles: fi.sampleFiles.map((p) => ({
          path: p,
          role: 'Source file in folder',
          keySymbols: [],
        })),
      })),
    },
    applicationArchitecture: {
      architecturalPattern: repo.aiAnalysis?.architecturalPattern || 'Pending analysis',
      summary: repo.aiAnalysis?.summary || 'Pending staged analysis.',
      layersObserved: [],
      moduleResponsibilities: (repo.aiAnalysis?.modules ?? []).map((m) => ({
        ...m,
        dependsOn: [],
      })),
      internalDependenciesSummary: `${repo.architecture.internalEdgeCount} static internal module edges detected across ${repo.architecture.parsedFilesCount} parsed files.`,
      externalIntegrations: [],
      storageApproach:
        codeSignals.storageUsages.length > 0
          ? `Observed storage usages: ${Array.from(new Set(codeSignals.storageUsages.map((s) => s.kind))).join(', ')}`
          : 'No explicit database or local persistence detected yet.',
      evidence: [],
      confidence: 'low',
    },
    coreFeatures: [],
    executionFlows: [],
    databaseAndModels: {
      hasDatabase: codeSignals.storageUsages.some((s) =>
        ['MongoClient', 'mongoose', 'supabase', 'firebase', 'prisma'].includes(s.kind)
      ),
      summary:
        codeSignals.storageUsages.length > 0
          ? `Detected ${codeSignals.storageUsages.length} storage-related reference(s).`
          : 'No database engine or persistence model detected in scanned source files.',
      technologies: Array.from(new Set(codeSignals.storageUsages.map((s) => s.kind))),
      collectionsOrTables: [],
      schemasAndModels: [],
      relationships: [],
      persistenceAndCaching: 'Pending full synthesis.',
      evidence: codeSignals.storageUsages.slice(0, 5).map((s) => ({
        filePath: s.filePath,
        startLine: s.line,
        endLine: s.line,
        snippet: s.snippet,
      })),
    },
    developerGuide: {
      prerequisites: [],
      installCommands: manifestInv.packageNames.size > 0 ? ['npm install'] : [],
      runCommands,
      buildCommands,
      importantScripts: manifestInv.scripts.slice(0, 15),
      environmentVariables: envVars,
      contributorEntryPoints: repo.detectedFacts.entryPoints.map((e) => ({
        path: e.path,
        reason: e.reason,
      })),
    },
    improvementOpportunities: {
      verifiedIssues,
      suggestions: [],
    },
    caveats: repo.aiAnalysis?.caveats ?? [],
  };
}

function sanitizeCitations(
  rawCitations: Array<{ filePath?: string; startLine?: number; endLine?: number; symbol?: string; snippet?: string }> | undefined,
  fileMap: Map<string, SourceFile>
): SourceCitation[] {
  if (!Array.isArray(rawCitations)) return [];
  const valid: SourceCitation[] = [];
  for (const cit of rawCitations) {
    if (!cit || typeof cit.filePath !== 'string') continue;
    const f = fileMap.get(cit.filePath);
    if (!f) continue;
    const startLine =
      typeof cit.startLine === 'number' && Number.isFinite(cit.startLine)
        ? Math.max(1, Math.min(f.lines, Math.round(cit.startLine)))
        : undefined;
    const endLine =
      typeof cit.endLine === 'number' && Number.isFinite(cit.endLine)
        ? Math.max(startLine ?? 1, Math.min(f.lines, Math.round(cit.endLine)))
        : startLine;
    valid.push({
      filePath: f.path,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      ...(cit.symbol ? { symbol: cit.symbol.slice(0, 80) } : {}),
      ...(cit.snippet ? { snippet: cit.snippet.slice(0, 160) } : {}),
    });
  }
  return valid;
}

async function consolidateOverview(params: {
  repo: RepositoryRecord;
  batches: OverviewBatchResult[];
  manifestInv: ManifestInventory;
  envVars: ReturnType<typeof scanEnvironmentVariables>;
  codeSignals: DeterministicCodeSignals;
  folderInv: ReturnType<typeof buildFolderInventory>;
}): Promise<ComprehensiveOverview> {
  const { repo, batches, manifestInv, envVars, codeSignals, folderInv } = params;
  const fileMap = new Map(repo.files.map((f) => [f.path, f]));
  const skeleton = buildSkeletonOverview(params);

  const completedBatches = batches.filter((b) => b.status === 'complete');
  const failedBatches = batches.filter((b) => b.status === 'failed');
  const analyzedFilesCount = completedBatches.reduce((sum, b) => sum + b.filePaths.length, 0);

  if (!isAiTextConfigured() || completedBatches.length === 0) {
    return {
      ...skeleton,
      status: !isAiTextConfigured() ? 'partial' : 'failed',
      completedAt: new Date().toISOString(),
      errorMessage: !isAiTextConfigured()
        ? 'No AI text provider is configured; showing deterministic source analysis only.'
        : failedBatches[0]?.errorMessage || 'All analysis batches failed.',
    };
  }

  const batchDigests = completedBatches
    .map((b) => {
      const filesText = b.fileSummaries
        .map(
          (fs) =>
            `  - ${fs.filePath}: ${fs.purpose}${fs.keySymbols.length ? ` [symbols: ${fs.keySymbols.slice(0, 6).join(', ')}]` : ''}${fs.interactions.length ? ` [interactions: ${fs.interactions.slice(0, 4).join('; ')}]` : ''}`
        )
        .join('\n');
      return (
        `[${b.label} — ${b.filePaths.length} files]\n` +
        `${filesText}\n` +
        (b.observedCapabilities.length ? `  Capabilities: ${b.observedCapabilities.join('; ')}\n` : '') +
        (b.executionNotes.length ? `  Execution notes: ${b.executionNotes.join('; ')}\n` : '') +
        (b.storageSignals.length ? `  Storage signals: ${b.storageSignals.join('; ')}` : '')
      );
    })
    .join('\n\n');

  const edgeDigest = repo.architecture.edges
    .filter((e) => e.targetKind === 'internal')
    .slice(0, 45)
    .map((e) => `- ${e.sourcePath} -> ${e.targetPath} (L${e.evidences[0]?.line ?? 1})`)
    .join('\n');

  const folderDigest = folderInv
    .map((f) => `- ${f.folder} (${f.fileCount} files, ${f.totalLines} lines): ${f.sampleFiles.join(', ')}`)
    .join('\n');

  const prompt = `Synthesize a comprehensive, source-grounded developer intelligence report for this repository using ALL analyzed batch digests and deterministic code signals below.

REPOSITORY METADATA:
- Full name: ${repo.metadata.fullName}
- GitHub Description: ${repo.metadata.description ?? 'None'}
- Primary Language: ${repo.metadata.primaryLanguage ?? 'Unknown'}
- Default Branch: ${repo.metadata.defaultBranch}
- Indexed Eligible Files: ${repo.files.length} (Analyzed across batches: ${analyzedFilesCount})

README EXCERPT:
${repo.readmeContent ? repo.readmeContent.slice(0, 5000) : '(No README present)'}

FOLDER INVENTORY:
${folderDigest}

MANIFEST SCRIPTS:
${manifestInv.scripts.map((s) => `- [${s.sourceFile}] ${s.name}: ${s.command}`).join('\n') || '(No scripts)'}

DETECTED ENVIRONMENT VARIABLE NAMES:
${envVars.map((v) => `- ${v.name} (in ${v.references[0]?.filePath}:${v.references[0]?.startLine})`).join('\n') || '(None detected)'}

DETECTED HTTP ENDPOINTS:
${codeSignals.endpoints.map((ep) => `- ${ep.filePath}:${ep.line} -> ${ep.snippet}`).join('\n') || '(No backend route handlers detected)'}

DETECTED NETWORK / API CALLS:
${codeSignals.networkCalls.map((nc) => `- ${nc.filePath}:${nc.line} -> ${nc.snippet}`).join('\n') || '(None detected)'}

DETECTED STORAGE / DATABASE CALLS:
${codeSignals.storageUsages.map((su) => `- [${su.kind}] ${su.filePath}:${su.line} -> ${su.snippet}`).join('\n') || '(None detected)'}

VERIFIED INTERNAL DEPENDENCY EDGES (sample):
${edgeDigest || '(None)'}

STAGED BATCH ANALYSIS DIGESTS (ALL ANALYZED FILES):
${batchDigests.slice(0, 90_000)}`;

  const citationSchema = {
    type: Type.OBJECT,
    properties: {
      filePath: { type: Type.STRING },
      startLine: { type: Type.INTEGER },
      endLine: { type: Type.INTEGER },
      symbol: { type: Type.STRING },
    },
    required: ['filePath'],
  };

  const confidenceSchema = {
    type: Type.STRING,
    enum: ['high', 'medium', 'low'],
  };

  const aiRes = await generateAiStructuredJson<{
    projectIdentity: {
      name: string;
      shortDescription: string;
      mainPurpose: string;
      problemSolved: string;
      intendedUsers: string[];
      primaryUseCases: string[];
      evidence: Array<{ filePath: string; startLine?: number; endLine?: number; symbol?: string }>;
      confidence: EvidenceConfidence;
    };
    projectStructure: {
      summary: string;
      entryPoints: Array<{ path: string; reason: string; role: string; line?: number }>;
      folderGuide: Array<{
        folder: string;
        purpose: string;
        importantFiles: Array<{ path: string; role: string; keySymbols: string[] }>;
      }>;
    };
    applicationArchitecture: {
      architecturalPattern: string;
      summary: string;
      layersObserved: Array<{ name: string; description: string; files: string[] }>;
      moduleResponsibilities: Array<{
        name: string;
        directoryOrFile: string;
        responsibility: string;
        keyFiles: string[];
        dependsOn: string[];
      }>;
      internalDependenciesSummary: string;
      externalIntegrations: Array<{
        name: string;
        purpose: string;
        evidence: Array<{ filePath: string; startLine?: number; endLine?: number; symbol?: string }>;
      }>;
      storageApproach: string;
      evidence: Array<{ filePath: string; startLine?: number; endLine?: number; symbol?: string }>;
      confidence: EvidenceConfidence;
    };
    coreFeatures: Array<{
      name: string;
      description: string;
      relevantFiles: string[];
      keyFunctionsOrEndpoints: string[];
      evidence: Array<{ filePath: string; startLine?: number; endLine?: number; symbol?: string }>;
      confidence: EvidenceConfidence;
    }>;
    executionFlows: Array<{
      title: string;
      trigger: string;
      summary: string;
      steps: Array<{
        stepNumber: number;
        layer: string;
        action: string;
        filePath: string;
        startLine?: number;
        endLine?: number;
        evidenceBasis: 'verified-call' | 'route-handler' | 'import-only' | 'inferred';
      }>;
      verificationNote: string;
    }>;
    databaseAndModels: {
      hasDatabase: boolean;
      summary: string;
      technologies: string[];
      collectionsOrTables: Array<{
        name: string;
        purpose: string;
        evidence: Array<{ filePath: string; startLine?: number; endLine?: number; symbol?: string }>;
      }>;
      schemasAndModels: Array<{
        name: string;
        fieldsSummary: string;
        evidence: Array<{ filePath: string; startLine?: number; endLine?: number; symbol?: string }>;
      }>;
      relationships: string[];
      persistenceAndCaching: string;
      evidence: Array<{ filePath: string; startLine?: number; endLine?: number; symbol?: string }>;
    };
    developerGuide: {
      prerequisites: string[];
      installCommands: string[];
      runCommands: string[];
      buildCommands: string[];
      envVarPurposes: Array<{ name: string; required: 'required' | 'optional' | 'unknown'; purpose: string }>;
      contributorEntryPoints: Array<{ path: string; reason: string }>;
    };
    improvementOpportunities: {
      verifiedIssues: Array<{
        title: string;
        category: IssueCategory;
        severity: 'high' | 'medium' | 'low';
        description: string;
        evidence: Array<{ filePath: string; startLine?: number; endLine?: number; symbol?: string }>;
      }>;
      suggestions: Array<{
        title: string;
        category: IssueCategory;
        rationale: string;
        relatedFiles: string[];
      }>;
    };
    caveats: string[];
  }>({
    systemInstruction:
      'You are a principal software architect producing a source-grounded repository intelligence dashboard. ' +
      'STRICT ACCURACY RULES: ' +
      '1) ONLY describe features, APIs, databases, layers, workflows, and files directly supported by the supplied batch digests and code signals. ' +
      '2) If there is no backend server or no database in the codebase, explicitly state that instead of inventing one. ' +
      '3) In executionFlows, distinguish verified call/route chains ("verified-call", "route-handler") from "import-only" or "inferred" connections—never claim import order proves runtime execution. ' +
      '4) In improvementOpportunities, put ONLY issues directly observed in code into verifiedIssues with exact filePath/lines, and put architectural recommendations/hypotheses into suggestions. ' +
      '5) Never expose actual secret values.',
    prompt,
    thinkingLevel: ThinkingLevel.LOW,
    maxTokens: 8192,
    retryOptions: { maxRetries: 1, maxRetryDelayMs: 8_000, timeoutMs: 45_000 },
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        projectIdentity: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            shortDescription: { type: Type.STRING },
            mainPurpose: { type: Type.STRING },
            problemSolved: { type: Type.STRING },
            intendedUsers: { type: Type.ARRAY, items: { type: Type.STRING } },
            primaryUseCases: { type: Type.ARRAY, items: { type: Type.STRING } },
            evidence: { type: Type.ARRAY, items: citationSchema },
            confidence: confidenceSchema,
          },
          required: [
            'name',
            'shortDescription',
            'mainPurpose',
            'problemSolved',
            'intendedUsers',
            'primaryUseCases',
            'evidence',
            'confidence',
          ],
        },
        projectStructure: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            entryPoints: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  path: { type: Type.STRING },
                  reason: { type: Type.STRING },
                  role: { type: Type.STRING },
                  line: { type: Type.INTEGER },
                },
                required: ['path', 'reason', 'role'],
              },
            },
            folderGuide: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  folder: { type: Type.STRING },
                  purpose: { type: Type.STRING },
                  importantFiles: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        path: { type: Type.STRING },
                        role: { type: Type.STRING },
                        keySymbols: { type: Type.ARRAY, items: { type: Type.STRING } },
                      },
                      required: ['path', 'role', 'keySymbols'],
                    },
                  },
                },
                required: ['folder', 'purpose', 'importantFiles'],
              },
            },
          },
          required: ['summary', 'entryPoints', 'folderGuide'],
        },
        applicationArchitecture: {
          type: Type.OBJECT,
          properties: {
            architecturalPattern: { type: Type.STRING },
            summary: { type: Type.STRING },
            layersObserved: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  description: { type: Type.STRING },
                  files: { type: Type.ARRAY, items: { type: Type.STRING } },
                },
                required: ['name', 'description', 'files'],
              },
            },
            moduleResponsibilities: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  directoryOrFile: { type: Type.STRING },
                  responsibility: { type: Type.STRING },
                  keyFiles: { type: Type.ARRAY, items: { type: Type.STRING } },
                  dependsOn: { type: Type.ARRAY, items: { type: Type.STRING } },
                },
                required: ['name', 'directoryOrFile', 'responsibility', 'keyFiles', 'dependsOn'],
              },
            },
            internalDependenciesSummary: { type: Type.STRING },
            externalIntegrations: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  purpose: { type: Type.STRING },
                  evidence: { type: Type.ARRAY, items: citationSchema },
                },
                required: ['name', 'purpose', 'evidence'],
              },
            },
            storageApproach: { type: Type.STRING },
            evidence: { type: Type.ARRAY, items: citationSchema },
            confidence: confidenceSchema,
          },
          required: [
            'architecturalPattern',
            'summary',
            'layersObserved',
            'moduleResponsibilities',
            'internalDependenciesSummary',
            'externalIntegrations',
            'storageApproach',
            'evidence',
            'confidence',
          ],
        },
        coreFeatures: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              description: { type: Type.STRING },
              relevantFiles: { type: Type.ARRAY, items: { type: Type.STRING } },
              keyFunctionsOrEndpoints: { type: Type.ARRAY, items: { type: Type.STRING } },
              evidence: { type: Type.ARRAY, items: citationSchema },
              confidence: confidenceSchema,
            },
            required: [
              'name',
              'description',
              'relevantFiles',
              'keyFunctionsOrEndpoints',
              'evidence',
              'confidence',
            ],
          },
        },
        executionFlows: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              trigger: { type: Type.STRING },
              summary: { type: Type.STRING },
              steps: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    stepNumber: { type: Type.INTEGER },
                    layer: { type: Type.STRING },
                    action: { type: Type.STRING },
                    filePath: { type: Type.STRING },
                    startLine: { type: Type.INTEGER },
                    endLine: { type: Type.INTEGER },
                    evidenceBasis: {
                      type: Type.STRING,
                      enum: ['verified-call', 'route-handler', 'import-only', 'inferred'],
                    },
                  },
                  required: ['stepNumber', 'layer', 'action', 'filePath', 'evidenceBasis'],
                },
              },
              verificationNote: { type: Type.STRING },
            },
            required: ['title', 'trigger', 'summary', 'steps', 'verificationNote'],
          },
        },
        databaseAndModels: {
          type: Type.OBJECT,
          properties: {
            hasDatabase: { type: Type.BOOLEAN },
            summary: { type: Type.STRING },
            technologies: { type: Type.ARRAY, items: { type: Type.STRING } },
            collectionsOrTables: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  purpose: { type: Type.STRING },
                  evidence: { type: Type.ARRAY, items: citationSchema },
                },
                required: ['name', 'purpose', 'evidence'],
              },
            },
            schemasAndModels: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  fieldsSummary: { type: Type.STRING },
                  evidence: { type: Type.ARRAY, items: citationSchema },
                },
                required: ['name', 'fieldsSummary', 'evidence'],
              },
            },
            relationships: { type: Type.ARRAY, items: { type: Type.STRING } },
            persistenceAndCaching: { type: Type.STRING },
            evidence: { type: Type.ARRAY, items: citationSchema },
          },
          required: [
            'hasDatabase',
            'summary',
            'technologies',
            'collectionsOrTables',
            'schemasAndModels',
            'relationships',
            'persistenceAndCaching',
            'evidence',
          ],
        },
        developerGuide: {
          type: Type.OBJECT,
          properties: {
            prerequisites: { type: Type.ARRAY, items: { type: Type.STRING } },
            installCommands: { type: Type.ARRAY, items: { type: Type.STRING } },
            runCommands: { type: Type.ARRAY, items: { type: Type.STRING } },
            buildCommands: { type: Type.ARRAY, items: { type: Type.STRING } },
            envVarPurposes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  required: { type: Type.STRING, enum: ['required', 'optional', 'unknown'] },
                  purpose: { type: Type.STRING },
                },
                required: ['name', 'required', 'purpose'],
              },
            },
            contributorEntryPoints: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  path: { type: Type.STRING },
                  reason: { type: Type.STRING },
                },
                required: ['path', 'reason'],
              },
            },
          },
          required: [
            'prerequisites',
            'installCommands',
            'runCommands',
            'buildCommands',
            'envVarPurposes',
            'contributorEntryPoints',
          ],
        },
        improvementOpportunities: {
          type: Type.OBJECT,
          properties: {
            verifiedIssues: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  category: {
                    type: Type.STRING,
                    enum: ['architecture', 'documentation', 'error-handling', 'performance', 'maintainability'],
                  },
                  severity: { type: Type.STRING, enum: ['high', 'medium', 'low'] },
                  description: { type: Type.STRING },
                  evidence: { type: Type.ARRAY, items: citationSchema },
                },
                required: ['title', 'category', 'severity', 'description', 'evidence'],
              },
            },
            suggestions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  category: {
                    type: Type.STRING,
                    enum: ['architecture', 'documentation', 'error-handling', 'performance', 'maintainability'],
                  },
                  rationale: { type: Type.STRING },
                  relatedFiles: { type: Type.ARRAY, items: { type: Type.STRING } },
                },
                required: ['title', 'category', 'rationale', 'relatedFiles'],
              },
            },
          },
          required: ['verifiedIssues', 'suggestions'],
        },
        caveats: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: [
        'projectIdentity',
        'projectStructure',
        'applicationArchitecture',
        'coreFeatures',
        'executionFlows',
        'databaseAndModels',
        'developerGuide',
        'improvementOpportunities',
        'caveats',
      ],
    },
  });
  const synthesized = aiRes.data;

  // Deterministic cross-check & merge
  const filterPaths = (paths: string[]) => (paths ?? []).filter((p) => fileMap.has(p));
  const folderCountMap = new Map(folderInv.map((fi) => [fi.folder, fi.fileCount]));

  const envPurposeMap = new Map(
    (synthesized.developerGuide?.envVarPurposes ?? []).map((e) => [e.name, e])
  );
  const mergedEnvVars = envVars.map((ev) => {
    const llm = envPurposeMap.get(ev.name);
    return {
      ...ev,
      required: llm?.required ?? ev.required,
      purpose: llm?.purpose || ev.purpose,
    };
  });

  // Combine deterministic issues + cross-checked batch/LLM issues (avoiding duplicates)
  const verifiedIssues = [...skeleton.improvementOpportunities.verifiedIssues];
  const seenIssueTitles = new Set(verifiedIssues.map((v) => v.title.toLowerCase()));
  for (const iss of synthesized.improvementOpportunities?.verifiedIssues ?? []) {
    const validEv = sanitizeCitations(iss.evidence, fileMap);
    if (validEv.length === 0) continue; // Only keep verified issues that cite actual existing files!
    if (!seenIssueTitles.has(iss.title.toLowerCase())) {
      seenIssueTitles.add(iss.title.toLowerCase());
      verifiedIssues.push({
        title: iss.title,
        category: iss.category,
        severity: iss.severity,
        description: iss.description,
        evidence: validEv,
      });
    }
  }

  // Also include verified batch-level issues if few verified issues exist
  for (const b of completedBatches) {
    for (const iss of b.issuesObserved) {
      if (verifiedIssues.length >= 12) break;
      if (!fileMap.has(iss.filePath)) continue;
      if (seenIssueTitles.has(iss.title.toLowerCase())) continue;
      seenIssueTitles.add(iss.title.toLowerCase());
      verifiedIssues.push({
        title: iss.title,
        category: 'maintainability',
        severity: iss.severity,
        description: iss.description,
        evidence: [
          {
            filePath: iss.filePath,
            startLine: iss.startLine,
            endLine: iss.endLine,
          },
        ],
      });
    }
  }

  const finalStatus: ComprehensiveOverview['status'] =
    failedBatches.length > 0 ? 'partial' : 'complete';

  const caveats = Array.from(
    new Set([
      ...(synthesized.caveats ?? []),
      ...(failedBatches.length > 0
        ? [`${failedBatches.length} batch(es) failed during staged analysis and can be retried without losing completed batches.`]
        : []),
      ...(repo.detectedFacts.skippedFileCount > 0
        ? [`${repo.detectedFacts.skippedFileCount} repository tree item(s) (media, binaries, build/vendor directories) were excluded by ingestion filters.`]
        : []),
    ])
  );

  return {
    version: 1,
    status: finalStatus,
    model: aiRes.model,
    startedAt: skeleton.startedAt,
    completedAt: new Date().toISOString(),
    commitSha: repo.metadata.commitSha,
    coverage: {
      analyzedFiles: analyzedFilesCount,
      totalEligibleFiles: repo.files.length,
      completedBatches: completedBatches.length,
      totalBatches: batches.length,
      failedBatches: failedBatches.length,
    },
    batches,
    projectIdentity: {
      ...synthesized.projectIdentity,
      evidence: sanitizeCitations(synthesized.projectIdentity.evidence, fileMap),
    },
    technologyStack: manifestInv.techStack,
    projectStructure: {
      summary: synthesized.projectStructure.summary,
      entryPoints: (synthesized.projectStructure.entryPoints ?? [])
        .filter((e) => fileMap.has(e.path))
        .map((e) => ({
          ...e,
          line: e.line ? Math.max(1, Math.min(fileMap.get(e.path)!.lines, e.line)) : 1,
        })),
      folderGuide: (synthesized.projectStructure.folderGuide ?? []).map((fg) => ({
        folder: fg.folder,
        purpose: fg.purpose,
        fileCount: folderCountMap.get(fg.folder) ?? fg.importantFiles.filter((f) => fileMap.has(f.path)).length,
        importantFiles: fg.importantFiles.filter((f) => fileMap.has(f.path)),
      })),
    },
    applicationArchitecture: {
      ...synthesized.applicationArchitecture,
      layersObserved: (synthesized.applicationArchitecture.layersObserved ?? []).map((l) => ({
        ...l,
        files: filterPaths(l.files),
      })),
      moduleResponsibilities: (synthesized.applicationArchitecture.moduleResponsibilities ?? []).map(
        (m) => ({
          ...m,
          keyFiles: filterPaths(m.keyFiles),
        })
      ),
      externalIntegrations: (synthesized.applicationArchitecture.externalIntegrations ?? []).map(
        (ext) => ({
          ...ext,
          evidence: sanitizeCitations(ext.evidence, fileMap),
        })
      ),
      evidence: sanitizeCitations(synthesized.applicationArchitecture.evidence, fileMap),
    },
    coreFeatures: (synthesized.coreFeatures ?? []).map((feat) => ({
      ...feat,
      relevantFiles: filterPaths(feat.relevantFiles),
      evidence: sanitizeCitations(feat.evidence, fileMap),
    })),
    executionFlows: (synthesized.executionFlows ?? []).map((flow) => ({
      ...flow,
      steps: (flow.steps ?? [])
        .filter((step) => fileMap.has(step.filePath))
        .map((step, i) => {
          const f = fileMap.get(step.filePath)!;
          const startLine =
            typeof step.startLine === 'number'
              ? Math.max(1, Math.min(f.lines, Math.round(step.startLine)))
              : undefined;
          const endLine =
            typeof step.endLine === 'number'
              ? Math.max(startLine ?? 1, Math.min(f.lines, Math.round(step.endLine)))
              : startLine;
          return {
            ...step,
            stepNumber: i + 1,
            startLine,
            endLine,
          };
        }),
    })),
    databaseAndModels: {
      ...synthesized.databaseAndModels,
      collectionsOrTables: (synthesized.databaseAndModels.collectionsOrTables ?? []).map((c) => ({
        ...c,
        evidence: sanitizeCitations(c.evidence, fileMap),
      })),
      schemasAndModels: (synthesized.databaseAndModels.schemasAndModels ?? []).map((s) => ({
        ...s,
        evidence: sanitizeCitations(s.evidence, fileMap),
      })),
      evidence: sanitizeCitations(synthesized.databaseAndModels.evidence, fileMap),
    },
    developerGuide: {
      prerequisites: synthesized.developerGuide.prerequisites ?? [],
      installCommands:
        synthesized.developerGuide.installCommands?.length > 0
          ? synthesized.developerGuide.installCommands
          : skeleton.developerGuide.installCommands,
      runCommands:
        synthesized.developerGuide.runCommands?.length > 0
          ? synthesized.developerGuide.runCommands
          : skeleton.developerGuide.runCommands,
      buildCommands:
        synthesized.developerGuide.buildCommands?.length > 0
          ? synthesized.developerGuide.buildCommands
          : skeleton.developerGuide.buildCommands,
      importantScripts: manifestInv.scripts.slice(0, 15),
      environmentVariables: mergedEnvVars,
      contributorEntryPoints: (synthesized.developerGuide.contributorEntryPoints ?? []).filter((e) =>
        fileMap.has(e.path)
      ),
    },
    improvementOpportunities: {
      verifiedIssues,
      suggestions: (synthesized.improvementOpportunities?.suggestions ?? []).map((s) => ({
        ...s,
        relatedFiles: filterPaths(s.relatedFiles),
      })),
    },
    caveats,
    errorMessage:
      failedBatches.length > 0
        ? `${failedBatches.length} batch(es) encountered errors and can be retried.`
        : undefined,
  };
}

export function deriveLegacyAiAnalysis(overview: ComprehensiveOverview): AIAnalysis {
  return {
    status: overview.status === 'failed' ? 'error' : overview.status === 'idle' ? 'unavailable' : 'complete',
    model: overview.model,
    generatedAt: overview.completedAt ?? overview.startedAt,
    summary: overview.projectIdentity.mainPurpose || overview.projectIdentity.shortDescription,
    architecturalPattern: overview.applicationArchitecture.architecturalPattern,
    keyCapabilities: overview.coreFeatures.map((f) => `${f.name}: ${f.description}`),
    modules: overview.applicationArchitecture.moduleResponsibilities.map((m) => ({
      name: m.name,
      directoryOrFile: m.directoryOrFile,
      responsibility: m.responsibility,
      keyFiles: m.keyFiles,
    })),
    caveats: overview.caveats,
    ...(overview.errorMessage ? { errorMessage: overview.errorMessage } : {}),
  };
}

export async function runStagedOverviewAnalysis(params: {
  repo: RepositoryRecord;
  mode?: 'resume' | 'full';
  retryBatchIds?: string[];
  onProgress?: (event: OverviewProgressEvent) => void;
  persistIncremental?: boolean;
}): Promise<{ overview: ComprehensiveOverview; aiAnalysis: AIAnalysis }> {
  const {
    repo,
    mode = 'resume',
    retryBatchIds = [],
    onProgress,
    persistIncremental = true,
  } = params;

  const fileMap = new Map(repo.files.map((f) => [f.path, f]));
  const manifestInv = scanManifestsAndTechStack(repo.files, repo.architecture);
  const envVars = scanEnvironmentVariables(repo.files);
  const codeSignals = scanCodeSignals(repo.files);
  const folderInv = buildFolderInventory(repo.files);

  const freshBatches = createAnalysisBatches(repo.files);
  let batches: OverviewBatchResult[] = freshBatches;

  // Resume completed batches when commitSha & batch layout match and mode === 'resume'
  const existing = repo.comprehensiveOverview;
  if (
    mode === 'resume' &&
    existing &&
    existing.commitSha === repo.metadata.commitSha &&
    existing.batches.length === freshBatches.length
  ) {
    const retrySet = new Set(retryBatchIds);
    const existingById = new Map(existing.batches.map((b) => [b.batchId, b]));
    batches = freshBatches.map((fresh) => {
      const prev = existingById.get(fresh.batchId);
      if (prev && prev.status === 'complete' && !retrySet.has(fresh.batchId)) {
        return prev;
      }
      if (prev && prev.status === 'failed' && retrySet.size > 0 && !retrySet.has(fresh.batchId)) {
        return prev;
      }
      return fresh;
    });
  }

  let currentOverview = buildSkeletonOverview({
    repo,
    batches,
    manifestInv,
    envVars,
    codeSignals,
    folderInv,
  });

  const emitSnapshot = (
    stage: OverviewProgressEvent['stage'],
    message: string,
    progress: number,
    currentBatchLabel?: string,
    includeOverview = false
  ) => {
    const completedBatches = batches.filter((b) => b.status === 'complete').length;
    const failedBatches = batches.filter((b) => b.status === 'failed').length;
    const analyzedFiles = batches
      .filter((b) => b.status === 'complete')
      .reduce((acc, b) => acc + b.filePaths.length, 0);

    onProgress?.({
      stage,
      message,
      progress,
      analyzedFiles,
      totalEligibleFiles: repo.files.length,
      completedBatches,
      totalBatches: batches.length,
      failedBatches,
      currentBatchLabel,
      ...(includeOverview ? { overview: currentOverview } : {}),
    });
  };

  emitSnapshot(
    'preparing',
    `Prepared ${batches.length} module batches covering ${repo.files.length} eligible source files...`,
    4
  );

  if (!isAiTextConfigured()) {
    const fallbackOverview: ComprehensiveOverview = {
      ...currentOverview,
      status: 'partial',
      completedAt: new Date().toISOString(),
      errorMessage: 'No AI text provider is configured; deterministic intelligence only.',
    };
    const syncedAi = deriveLegacyAiAnalysis(fallbackOverview);
    if (persistIncremental) {
      await store.saveComprehensiveOverview(repo.id, fallbackOverview, syncedAi);
    }
    return { overview: fallbackOverview, aiAnalysis: syncedAi };
  }

  if (persistIncremental) {
    await store.saveComprehensiveOverview(repo.id, currentOverview);
  }

  const retrySet = new Set(retryBatchIds);
  const pendingIndices = batches
    .map((b, idx) => ({ b, idx }))
    .filter(({ b }) => {
      if (mode === 'resume' && retrySet.size > 0) {
        return retrySet.has(b.batchId);
      }
      return b.status === 'pending' || b.status === 'failed';
    });

  let haltedEarlyReason: string | undefined;
  let haltedCategory: AiErrorCategory | undefined;

  for (let step = 0; step < pendingIndices.length; step++) {
    const { idx } = pendingIndices[step];
    const batch = batches[idx];
    batches[idx] = { ...batch, status: 'running', errorMessage: undefined };

    const pctBefore = 6 + Math.round(((idx + 0.1) / Math.max(batches.length, 1)) * 78);
    emitSnapshot(
      'batch',
      `Analyzing ${batch.label} (${batch.filePaths.length} files)...`,
      pctBefore,
      batch.label
    );

    if (step > 0) {
      await new Promise((resolve) => setTimeout(resolve, INTER_BATCH_PAUSE_MS));
    }

    try {
      const doneBatch = await analyzeSingleBatch(repo.metadata, batch, fileMap);
      batches[idx] = doneBatch;
    } catch (err) {
      if (err instanceof DurablePersistenceError) {
        throw err;
      }
      const classified = classifyAiError(err);
      batches[idx] = {
        ...batch,
        status: 'failed',
        errorMessage: classified.userMessage,
      };
      if (classified.category === 'quota_exhausted' || classified.category === 'auth_error') {
        haltedEarlyReason = classified.userMessage;
        haltedCategory = classified.category;
      }
    }

    const completedCount = batches.filter((b) => b.status === 'complete').length;
    const failedCount = batches.filter((b) => b.status === 'failed').length;
    const analyzedFiles = batches
      .filter((b) => b.status === 'complete')
      .reduce((acc, b) => acc + b.filePaths.length, 0);

    currentOverview = {
      ...currentOverview,
      ...(haltedEarlyReason
        ? { status: 'partial' as const, errorMessage: haltedEarlyReason }
        : {}),
      batches: [...batches],
      coverage: {
        analyzedFiles,
        totalEligibleFiles: repo.files.length,
        completedBatches: completedCount,
        totalBatches: batches.length,
        failedBatches: failedCount,
      },
    };

    if (persistIncremental) {
      await store.saveComprehensiveOverview(repo.id, currentOverview);
    }

    const pctAfter = 6 + Math.round(((idx + 1) / Math.max(batches.length, 1)) * 78);
    emitSnapshot(
      'batch',
      haltedEarlyReason
        ? `Halted batch analysis (${completedCount}/${batches.length} complete): ${haltedEarlyReason}`
        : `Processed ${completedCount}/${batches.length} batches (${analyzedFiles}/${repo.files.length} files)${failedCount > 0 ? `, ${failedCount} failed` : ''}`,
      pctAfter,
      batch.label,
      true
    );

    if (haltedEarlyReason) {
      break;
    }
  }

  let finalOverview: ComprehensiveOverview;
  if (haltedEarlyReason) {
    finalOverview = {
      ...currentOverview,
      status: 'partial',
      completedAt: new Date().toISOString(),
      errorMessage:
        haltedCategory === 'quota_exhausted'
          ? `${haltedEarlyReason} Preserved ${currentOverview.coverage.completedBatches}/${currentOverview.coverage.totalBatches} completed batches for resume.`
          : haltedEarlyReason,
    };
  } else {
    emitSnapshot(
      'consolidating',
      `Consolidating batch summaries and cross-checking source citations across ${repo.files.length} files...`,
      88
    );

    try {
      finalOverview = await consolidateOverview({
        repo,
        batches,
        manifestInv,
        envVars,
        codeSignals,
        folderInv,
      });
    } catch (err) {
      if (err instanceof DurablePersistenceError) {
        throw err;
      }
      finalOverview = {
        ...currentOverview,
        status: 'partial',
        completedAt: new Date().toISOString(),
        errorMessage: `Consolidation failed: ${formatAiError(err)}. Completed batches are preserved.`,
      };
    }
  }

  const syncedAi = deriveLegacyAiAnalysis(finalOverview);

  emitSnapshot('saving', 'Persisting comprehensive intelligence overview...', 96);
  if (persistIncremental) {
    await store.saveComprehensiveOverview(repo.id, finalOverview, syncedAi);
  }

  currentOverview = finalOverview;
  emitSnapshot(
    'complete',
    finalOverview.status === 'complete'
      ? `Comprehensive intelligence complete (${finalOverview.coverage.analyzedFiles}/${finalOverview.coverage.totalEligibleFiles} files analyzed).`
      : `Partial intelligence saved (${finalOverview.coverage.completedBatches}/${finalOverview.coverage.totalBatches} batches complete).`,
    100,
    undefined,
    true
  );

  return { overview: finalOverview, aiAnalysis: syncedAi };
}
