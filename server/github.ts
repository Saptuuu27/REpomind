import type {
  FailedFileEntry,
  IngestionLiveStats,
  RepositoryMetadata,
  SkippedReasonSummary,
  SourceFile,
  TreeItem,
} from '../src/types.ts';

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function getIngestLimits() {
  return {
    MAX_INDEXABLE_FILES: parsePositiveIntEnv('MAX_INDEXABLE_FILES', 300),
    MAX_FILE_BYTES: parsePositiveIntEnv('MAX_FILE_BYTES', 160 * 1024),
    MAX_TOTAL_BYTES: parsePositiveIntEnv('MAX_TOTAL_BYTES', 8 * 1024 * 1024),
    BATCH_SIZE: 20,
    CONCURRENCY: 5,
  };
}

export const INGEST_LIMITS = getIngestLimits();

export interface ParsedRepoUrl {
  owner: string;
  repo: string;
}

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetAt: string;
}

let lastRateLimit: RateLimitInfo | undefined;

export function getLastGitHubRateLimit(): RateLimitInfo | undefined {
  return lastRateLimit;
}

export class GitHubApiError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'GitHubApiError';
    this.statusCode = statusCode;
  }
}

export function parseGitHubUrl(input: string): ParsedRepoUrl {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new GitHubApiError('Please provide a GitHub repository URL.', 400);
  }

  let owner = '';
  let repo = '';

  const shorthandMatch = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (shorthandMatch && !trimmed.includes('://') && !trimmed.includes('.')) {
    owner = shorthandMatch[1];
    repo = shorthandMatch[2];
  } else {
    let normalized = trimmed;
    if (!/^https?:\/\//i.test(normalized)) {
      if (/^github\.com\//i.test(normalized)) {
        normalized = `https://${normalized}`;
      } else {
        throw new GitHubApiError(
          'Invalid GitHub URL. Use https://github.com/owner/repo or owner/repo.',
          400
        );
      }
    }

    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      throw new GitHubApiError('Invalid URL format.', 400);
    }

    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
      throw new GitHubApiError(
        'Only public github.com repositories are supported.',
        400
      );
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) {
      throw new GitHubApiError(
        'URL must include both repository owner and name (e.g. https://github.com/expressjs/express).',
        400
      );
    }

    owner = parts[0];
    repo = parts[1].replace(/\.git$/i, '');
  }

  const validSegment = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
  if (!validSegment.test(owner) || !validSegment.test(repo) || owner === '..' || repo === '..') {
    throw new GitHubApiError('Invalid GitHub repository owner or name.', 400);
  }

  return { owner, repo };
}

function buildGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'RepoMind-Code-Intelligence/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function updateRateLimitFromHeaders(headers: Headers): void {
  const remaining = Number(headers.get('x-ratelimit-remaining'));
  const limit = Number(headers.get('x-ratelimit-limit'));
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (!Number.isNaN(remaining) && !Number.isNaN(limit) && !Number.isNaN(reset)) {
    lastRateLimit = {
      remaining,
      limit,
      resetAt: new Date(reset * 1000).toISOString(),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function githubFetchJson<T>(url: string, maxRetries = 2): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        headers: buildGitHubHeaders(),
        signal: controller.signal,
      });
      updateRateLimitFromHeaders(res.headers);

      if (res.status === 404) {
        throw new GitHubApiError(
          'Repository or branch not found. Ensure the repository exists and is public.',
          404
        );
      }
      if (res.status === 403 || res.status === 429) {
        const remaining = res.headers.get('x-ratelimit-remaining');
        const resetHeader = res.headers.get('x-ratelimit-reset');
        if (remaining === '0' && resetHeader) {
          const resetTime = new Date(Number(resetHeader) * 1000).toLocaleTimeString();
          throw new GitHubApiError(
            `GitHub API rate limit exceeded. Limit resets at ${resetTime}. Configure GITHUB_TOKEN on the server for higher limits.`,
            429
          );
        }
        if (res.status === 429 && attempt < maxRetries) {
          const retryAfterSec = Number(res.headers.get('retry-after') || '2');
          await sleep(Math.min(Math.max(retryAfterSec, 1), 8) * 1000);
          continue;
        }
        throw new GitHubApiError(
          'Access denied or rate-limited by GitHub API. Private repositories are not supported.',
          res.status
        );
      }
      if (res.status === 409) {
        throw new GitHubApiError('This GitHub repository is empty.', 409);
      }
      if (isRetryableHttpStatus(res.status) && attempt < maxRetries) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      if (!res.ok) {
        throw new GitHubApiError(
          `GitHub API error (${res.status}): ${res.statusText}`,
          res.status
        );
      }

      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (err instanceof GitHubApiError) {
        throw err;
      }
      if (attempt < maxRetries) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new GitHubApiError('Timed out while contacting GitHub API.', 504);
      }
      throw new GitHubApiError(
        `Failed to contact GitHub API: ${err instanceof Error ? err.message : String(err)}`,
        502
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new GitHubApiError('Failed to contact GitHub API.', 502);
}

const SKIP_DIRS = [
  '.git/',
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  '.nuxt/',
  '.output/',
  'out/',
  'target/',
  'vendor/',
  '__pycache__/',
  '.venv/',
  'venv/',
  'env/',
  'coverage/',
  '.cache/',
  '.parcel-cache/',
  '.turbo/',
  '.vite/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.idea/',
  '.vscode/',
  'bin/',
  'obj/',
  'android/app/src/main/assets/public/',
  'ios/app/app/public/',
  'android/.gradle/',
  'android/app/build/',
  'android/capacitor-android/build/',
  'android/capacitor-cordova-android-plugins/build/',
];

const SKIP_FILENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'cargo.lock',
  'poetry.lock',
  'gemfile.lock',
  'composer.lock',
  'go.sum',
  'pipfile.lock',
  'uv.lock',
  'pdm.lock',
  '.ds_store',
  'thumbs.db',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
]);

const BINARY_MEDIA_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.tiff', '.ico', '.icns',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.mp3', '.wav', '.ogg', '.flac', '.m4a',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.pyc', '.pyo', '.class', '.jar',
  '.sqlite', '.sqlite3', '.db', '.psd', '.ai', '.sketch', '.fig',
]);

const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.kts', '.scala',
  '.rb', '.php', '.cs', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hh',
  '.swift', '.dart', '.lua', '.r', '.sh', '.bash', '.zsh', '.ps1',
  '.sql', '.graphql', '.gql', '.prisma', '.proto',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.astro',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.ini', '.conf', '.cfg',
  '.properties', '.gradle', '.cmake',
  '.md', '.mdx', '.txt', '.rst',
]);

const SUPPORTED_EXACT_NAMES = new Set([
  'dockerfile',
  'makefile',
  'cmakelists.txt',
  'procfile',
  'gemfile',
  'rakefile',
  'readme',
  'license',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.editorconfig',
  '.eslintrc',
  '.prettierrc',
  '.nvmrc',
  '.node-version',
  '.python-version',
  '.env.example',
  '.env.sample',
  '.env.template',
]);

export function detectLanguageFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'Dockerfile';
  if (base === 'makefile' || base === 'cmakelists.txt') return 'Makefile';
  if (base.endsWith('.tsx')) return 'TypeScript (TSX)';
  if (base.endsWith('.ts') || base.endsWith('.mts') || base.endsWith('.cts')) return 'TypeScript';
  if (base.endsWith('.jsx')) return 'JavaScript (JSX)';
  if (base.endsWith('.js') || base.endsWith('.mjs') || base.endsWith('.cjs')) return 'JavaScript';
  if (base.endsWith('.py') || base.endsWith('.pyi')) return 'Python';
  if (base.endsWith('.go')) return 'Go';
  if (base.endsWith('.rs')) return 'Rust';
  if (base.endsWith('.java')) return 'Java';
  if (base.endsWith('.kt') || base.endsWith('.kts')) return 'Kotlin';
  if (base.endsWith('.rb')) return 'Ruby';
  if (base.endsWith('.php')) return 'PHP';
  if (base.endsWith('.cs')) return 'C#';
  if (base.endsWith('.cpp') || base.endsWith('.cc') || base.endsWith('.cxx') || base.endsWith('.hpp') || base.endsWith('.hh')) {
    return 'C++';
  }
  if (base.endsWith('.c') || base.endsWith('.h')) return 'C';
  if (base.endsWith('.swift')) return 'Swift';
  if (base.endsWith('.vue')) return 'Vue';
  if (base.endsWith('.svelte')) return 'Svelte';
  if (base.endsWith('.html') || base.endsWith('.htm')) return 'HTML';
  if (base.endsWith('.css') || base.endsWith('.scss') || base.endsWith('.sass') || base.endsWith('.less')) {
    return 'CSS';
  }
  if (base.endsWith('.sql')) return 'SQL';
  if (base.endsWith('.sh') || base.endsWith('.bash') || base.endsWith('.zsh')) return 'Shell';
  if (base.endsWith('.json') || base.endsWith('.jsonc')) return 'JSON';
  if (base.endsWith('.yaml') || base.endsWith('.yml')) return 'YAML';
  if (base.endsWith('.toml')) return 'TOML';
  if (base.endsWith('.md') || base.endsWith('.mdx')) return 'Markdown';
  return 'Text';
}

function isSkippedDirPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const normalized = lower.endsWith('/') ? lower : `${lower}/`;
  return SKIP_DIRS.some((dir) => normalized.startsWith(dir) || normalized.includes(`/${dir}`));
}

export function getSkipReason(filePath: string, size?: number, maxFileBytes = 160 * 1024): string | null {
  const lower = filePath.toLowerCase();
  const base = lower.split('/').pop() ?? lower;

  if (SKIP_DIRS.some((dir) => lower.startsWith(dir) || lower.includes(`/${dir}`))) {
    return 'Ignored build/vendor directory';
  }
  if (SKIP_FILENAMES.has(base)) {
    return 'Lockfile or excluded config skipped';
  }
  if (
    base.endsWith('.min.js') ||
    base.endsWith('.min.mjs') ||
    base.endsWith('.min.css') ||
    base.endsWith('.bundle.js') ||
    base.endsWith('.bundle.css') ||
    base.endsWith('.chunk.js') ||
    base.endsWith('.chunk.css') ||
    base.endsWith('.map')
  ) {
    return 'Generated bundle or sourcemap skipped';
  }

  const dotIdx = base.lastIndexOf('.');
  const ext = dotIdx >= 0 ? base.slice(dotIdx) : '';

  if (
    BINARY_MEDIA_EXTENSIONS.has(ext) ||
    base.endsWith('.tar.gz') ||
    base.endsWith('.tar.bz2') ||
    base.endsWith('.tar.xz')
  ) {
    return 'Binary or media file skipped';
  }

  const isDockerfileVariant = base.startsWith('dockerfile.');
  const isEnvTemplate =
    base.startsWith('.env.') &&
    (base.endsWith('.example') || base.endsWith('.sample') || base.endsWith('.template'));

  if (
    !SUPPORTED_EXTENSIONS.has(ext) &&
    !SUPPORTED_EXACT_NAMES.has(base) &&
    !isDockerfileVariant &&
    !isEnvTemplate
  ) {
    return 'Unsupported or binary file type';
  }

  if (typeof size === 'number' && size > maxFileBytes) {
    return `Exceeds ${Math.round(maxFileBytes / 1024)}KB file size cap`;
  }

  return null;
}

function scoreFilePriority(filePath: string): number {
  const lower = filePath.toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  const depth = filePath.split('/').length;

  if (base.startsWith('readme')) return 1000;
  if (
    base === 'package.json' ||
    base === 'pyproject.toml' ||
    base === 'requirements.txt' ||
    base === 'cargo.toml' ||
    base === 'go.mod' ||
    base === 'pom.xml' ||
    base === 'build.gradle' ||
    base === 'dockerfile' ||
    base === 'tsconfig.json' ||
    base === 'vite.config.ts' ||
    base === 'vite.config.js'
  ) {
    return 950 - depth * 10;
  }
  if (
    /^(index|main|app|server|cli|mod|lib)\.(ts|tsx|js|jsx|py|go|rs|java|php)$/.test(base) ||
    /\/(index|main|app|server|cli)\.(ts|tsx|js|jsx|py|go|rs|php)$/.test(lower)
  ) {
    return 880 - depth * 10;
  }
  if (/^(src|source|app|lib|server|api|core|packages|cmd|internal|pkg|backend|frontend|client)\//.test(lower)) {
    if (/\.(test|spec)\./.test(base)) return 450 - depth * 8;
    return 800 - depth * 10;
  }
  if (/\.(test|spec)\./.test(base) || lower.includes('__tests__/') || lower.startsWith('test/') || lower.startsWith('tests/')) {
    return 350 - depth * 8;
  }
  if (base.endsWith('.md') || base.endsWith('.mdx')) {
    return 300 - depth * 5;
  }
  return 600 - depth * 10;
}

type FetchFileResult =
  | { status: 'ok'; content: string; bytes: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

function decodeIfText(bytes: Uint8Array, maxFileBytes: number): FetchFileResult {
  if (bytes.byteLength > maxFileBytes) {
    return {
      status: 'skipped',
      reason: `Exceeds ${Math.round(maxFileBytes / 1024)}KB file size cap`,
    };
  }
  const checkLen = Math.min(bytes.length, 2048);
  for (let i = 0; i < checkLen; i++) {
    if (bytes[i] === 0) {
      return { status: 'skipped', reason: 'Binary file detected' };
    }
  }
  const content = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (bytes.byteLength > 16 * 1024) {
    const lineCount = content.split('\n').length;
    if (bytes.byteLength / Math.max(lineCount, 1) > 650) {
      return { status: 'skipped', reason: 'Generated bundle or minified file skipped' };
    }
  }
  return {
    status: 'ok',
    content,
    bytes: bytes.byteLength,
  };
}

async function fetchFileContentWithRetry(
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  maxFileBytes: number
): Promise<FetchFileResult> {
  const encodedPath = filePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(
    branch
  )}/${encodedPath}`;

  let lastFailure = 'Unknown fetch failure';

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 14000);
    try {
      const headers: Record<string, string> = {
        'User-Agent': 'RepoMind-Code-Intelligence/1.0',
      };
      const token = process.env.GITHUB_TOKEN?.trim();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const res = await fetch(rawUrl, { headers, signal: controller.signal });

      if (res.ok) {
        const buffer = await res.arrayBuffer();
        return decodeIfText(new Uint8Array(buffer), maxFileBytes);
      }

      if (res.status === 404) {
        lastFailure = 'File not found at target branch (404)';
        break;
      }

      if (isRetryableHttpStatus(res.status)) {
        lastFailure = `GitHub raw CDN HTTP ${res.status}`;
        const retryAfter = Number(res.headers.get('retry-after') || '0');
        const delayMs = retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 400 * Math.pow(2, attempt);
        await sleep(delayMs);
        continue;
      }

      lastFailure = `GitHub raw CDN HTTP ${res.status}`;
      break;
    } catch (err) {
      lastFailure =
        err instanceof Error && err.name === 'AbortError'
          ? 'Timed out downloading file'
          : err instanceof Error
          ? err.message
          : 'Network error downloading file';
      if (attempt < 2) {
        await sleep(400 * Math.pow(2, attempt));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  // Fallback to GitHub REST Contents API if raw CDN failed transiently or returned 404 for special chars
  try {
    const contentsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(
      branch
    )}`;
    const data = await githubFetchJson<{
      type?: string;
      encoding?: string;
      content?: string;
      size?: number;
    }>(contentsUrl, 1);

    if (data.type === 'file' && data.encoding === 'base64' && typeof data.content === 'string') {
      const buf = Buffer.from(data.content.replace(/\n/g, ''), 'base64');
      return decodeIfText(new Uint8Array(buf), maxFileBytes);
    }
    return { status: 'failed', reason: lastFailure };
  } catch (err) {
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : lastFailure,
    };
  }
}

interface GitHubRepoApiResponse {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  size: number;
  language: string | null;
  license: { spdx_id?: string; name?: string } | null;
  topics?: string[];
  updated_at: string;
  owner: { login: string };
}

interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

interface GitHubTreeApiResponse {
  sha: string;
  truncated: boolean;
  tree: GitHubTreeEntry[];
}

export async function fetchFullTreeEntries(
  owner: string,
  repo: string,
  branch: string
): Promise<{ sha: string; entries: GitHubTreeEntry[]; truncatedByGitHub: boolean }> {
  const rootRecursive = await githubFetchJson<GitHubTreeApiResponse>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(
      branch
    )}?recursive=1`
  );

  if (!rootRecursive.truncated) {
    return {
      sha: rootRecursive.sha,
      entries: rootRecursive.tree,
      truncatedByGitHub: false,
    };
  }

  // Fallback paginated recursive subtree traversal for very large repositories where ?recursive=1 truncates
  const MAX_DISCOVERED_ENTRIES = 6000;
  const collected: GitHubTreeEntry[] = [];
  const queue: Array<{ sha: string; prefix: string }> = [{ sha: rootRecursive.sha, prefix: '' }];
  const visitedTreeShas = new Set<string>();

  while (queue.length > 0 && collected.length < MAX_DISCOVERED_ENTRIES) {
    const current = queue.shift()!;
    if (visitedTreeShas.has(current.sha)) continue;
    visitedTreeShas.add(current.sha);

    const subtree = await githubFetchJson<GitHubTreeApiResponse>(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(current.sha)}`
    );

    for (const item of subtree.tree) {
      const fullPath = current.prefix ? `${current.prefix}/${item.path}` : item.path;
      const entry: GitHubTreeEntry = { ...item, path: fullPath };
      collected.push(entry);
      if (item.type === 'tree' && !isSkippedDirPath(fullPath)) {
        queue.push({ sha: item.sha, prefix: fullPath });
      }
      if (collected.length >= MAX_DISCOVERED_ENTRIES) break;
    }
  }

  return {
    sha: rootRecursive.sha,
    entries: collected,
    truncatedByGitHub: collected.length >= MAX_DISCOVERED_ENTRIES,
  };
}

export function summarizeSkippedReasons(items: TreeItem[]): SkippedReasonSummary[] {
  const map = new Map<string, number>();
  for (const item of items) {
    if (item.type !== 'blob' || item.ingested || item.failed || !item.skipReason) continue;
    map.set(item.skipReason, (map.get(item.skipReason) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

export interface IngestedRepoPayload {
  metadata: RepositoryMetadata;
  tree: TreeItem[];
  files: SourceFile[];
  readmePath: string | null;
  readmeContent: string | null;
  eligibleFileCount: number;
  failedFiles: FailedFileEntry[];
  skippedBreakdown: SkippedReasonSummary[];
  truncatedByFileCap: boolean;
  truncatedBySizeCap: boolean;
  treeTruncatedByGitHub: boolean;
}

export async function fetchGitHubRepository(
  repoUrlOrSlug: string,
  onProgress?: (
    stage: 'fetching-metadata' | 'fetching-tree' | 'fetching-files',
    message: string,
    progress: number,
    stats?: Partial<IngestionLiveStats>
  ) => void
): Promise<IngestedRepoPayload> {
  const limits = getIngestLimits();
  const { owner, repo } = parseGitHubUrl(repoUrlOrSlug);

  onProgress?.('fetching-metadata', `Fetching metadata for ${owner}/${repo}...`, 10);
  const repoData = await githubFetchJson<GitHubRepoApiResponse>(
    `https://api.github.com/repos/${owner}/${repo}`
  );

  const defaultBranch = repoData.default_branch || 'main';
  onProgress?.('fetching-tree', `Fetching repository file tree (${defaultBranch})...`, 20);
  const treeResult = await fetchFullTreeEntries(owner, repo, defaultBranch);

  const metadata: RepositoryMetadata = {
    owner: repoData.owner.login,
    name: repoData.name,
    fullName: repoData.full_name,
    description: repoData.description,
    htmlUrl: repoData.html_url,
    defaultBranch,
    commitSha: treeResult.sha,
    stars: repoData.stargazers_count,
    forks: repoData.forks_count,
    openIssues: repoData.open_issues_count,
    sizeKb: repoData.size,
    primaryLanguage: repoData.language,
    license: repoData.license?.spdx_id || repoData.license?.name || null,
    topics: repoData.topics ?? [],
    updatedAt: repoData.updated_at,
  };

  const treeItems: TreeItem[] = [];
  const candidates: Array<{ item: TreeItem; priority: number }> = [];
  const seenPaths = new Set<string>();

  for (const entry of treeResult.entries) {
    if (entry.type !== 'blob' && entry.type !== 'tree') continue;
    if (seenPaths.has(entry.path)) continue;
    seenPaths.add(entry.path);

    if (entry.type === 'tree') {
      treeItems.push({
        path: entry.path,
        type: 'tree',
        sha: entry.sha,
      });
      continue;
    }

    const skipReason = getSkipReason(entry.path, entry.size, limits.MAX_FILE_BYTES);
    const treeItem: TreeItem = {
      path: entry.path,
      type: 'blob',
      size: entry.size,
      sha: entry.sha,
      ingested: false,
      skipReason: skipReason ?? undefined,
    };
    treeItems.push(treeItem);

    if (!skipReason) {
      candidates.push({
        item: treeItem,
        priority: scoreFilePriority(entry.path),
      });
    }
  }

  const totalTreeFiles = treeItems.filter((t) => t.type === 'blob').length;
  const eligibleFileCount = candidates.length;

  candidates.sort((a, b) => b.priority - a.priority || a.item.path.localeCompare(b.item.path));

  const selected = candidates.slice(0, limits.MAX_INDEXABLE_FILES);
  const truncatedByFileCap = candidates.length > limits.MAX_INDEXABLE_FILES;
  for (let i = limits.MAX_INDEXABLE_FILES; i < candidates.length; i++) {
    candidates[i].item.skipReason = `Skipped due to ${limits.MAX_INDEXABLE_FILES}-file MAX_INDEXABLE_FILES limit`;
  }

  const initialSkippedCount = treeItems.filter(
    (t) => t.type === 'blob' && !t.ingested && !t.failed && Boolean(t.skipReason)
  ).length;

  onProgress?.(
    'fetching-files',
    `Discovered ${eligibleFileCount} eligible source files (${selected.length} scheduled for indexing)...`,
    28,
    {
      totalTreeFiles,
      eligibleFiles: eligibleFileCount,
      indexedFiles: 0,
      skippedFiles: initialSkippedCount,
      failedFiles: 0,
      indexingStatus: 'indexing',
      skippedBreakdown: summarizeSkippedReasons(treeItems),
    }
  );

  const files: SourceFile[] = [];
  const failedFiles: FailedFileEntry[] = [];
  const ingestedPathSet = new Set<string>();
  let totalBytes = 0;
  let truncatedBySizeCap = false;
  let processed = 0;

  // Process selected files in controlled batches with bounded concurrency
  for (let batchStart = 0; batchStart < selected.length; batchStart += limits.BATCH_SIZE) {
    if (batchStart > 0) {
      await sleep(75);
    }
    const batch = selected.slice(batchStart, batchStart + limits.BATCH_SIZE);
    let batchCursor = 0;

    async function batchWorker() {
      while (batchCursor < batch.length) {
        const candidate = batch[batchCursor++];
        if (ingestedPathSet.has(candidate.item.path)) {
          processed++;
          continue;
        }

        if (totalBytes >= limits.MAX_TOTAL_BYTES) {
          candidate.item.skipReason = `Skipped due to ${Math.round(
            limits.MAX_TOTAL_BYTES / (1024 * 1024)
          )}MB total ingestion size cap`;
          truncatedBySizeCap = true;
          processed++;
          continue;
        }

        const result = await fetchFileContentWithRetry(
          metadata.owner,
          metadata.name,
          defaultBranch,
          candidate.item.path,
          limits.MAX_FILE_BYTES
        );
        processed++;

        if (result.status === 'skipped') {
          candidate.item.skipReason = result.reason;
          continue;
        }
        if (result.status === 'failed') {
          candidate.item.failed = true;
          candidate.item.skipReason = result.reason;
          failedFiles.push({ path: candidate.item.path, reason: result.reason });
          continue;
        }

        if (totalBytes + result.bytes > limits.MAX_TOTAL_BYTES && files.length > 0) {
          candidate.item.skipReason = `Skipped due to ${Math.round(
            limits.MAX_TOTAL_BYTES / (1024 * 1024)
          )}MB total ingestion size cap`;
          truncatedBySizeCap = true;
          continue;
        }

        totalBytes += result.bytes;
        ingestedPathSet.add(candidate.item.path);
        candidate.item.ingested = true;
        candidate.item.failed = false;
        candidate.item.skipReason = undefined;

        const fileName = candidate.item.path.split('/').pop() ?? candidate.item.path;
        const dotIdx = fileName.lastIndexOf('.');
        const extension = dotIdx >= 0 ? fileName.slice(dotIdx).toLowerCase() : '';

        files.push({
          path: candidate.item.path,
          name: fileName,
          extension,
          language: detectLanguageFromPath(candidate.item.path),
          size: result.bytes,
          lines: result.content.split('\n').length,
          content: result.content,
          sha: candidate.item.sha,
        });
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(limits.CONCURRENCY, Math.max(batch.length, 1)) }, () =>
        batchWorker()
      )
    );

    const skippedNow = treeItems.filter(
      (t) => t.type === 'blob' && !t.ingested && !t.failed && Boolean(t.skipReason)
    ).length;
    const pct = 28 + Math.round((processed / Math.max(selected.length, 1)) * 32);
    onProgress?.(
      'fetching-files',
      `Indexed ${files.length} of ${selected.length} scheduled files (${failedFiles.length} failed)...`,
      pct,
      {
        totalTreeFiles,
        eligibleFiles: eligibleFileCount,
        indexedFiles: files.length,
        skippedFiles: skippedNow,
        failedFiles: failedFiles.length,
        skippedBreakdown: summarizeSkippedReasons(treeItems),
        failedFileDetails: failedFiles.slice(0, 20),
      }
    );
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  const readmeFile =
    files.find((f) => /^readme\.md$/i.test(f.path)) ??
    files.find((f) => /^readme(\.[a-z]+)?$/i.test(f.name)) ??
    null;

  return {
    metadata,
    tree: treeItems,
    files,
    readmePath: readmeFile?.path ?? null,
    readmeContent: readmeFile?.content ?? null,
    eligibleFileCount,
    failedFiles,
    skippedBreakdown: summarizeSkippedReasons(treeItems),
    truncatedByFileCap,
    truncatedBySizeCap,
    treeTruncatedByGitHub: treeResult.truncatedByGitHub,
  };
}
