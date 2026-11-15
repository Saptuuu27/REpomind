import type { RepositoryRecord, SourceFile } from '../types';

export interface ResolvedRepoFile {
  file: SourceFile | null;
  resolvedPath: string | null;
  status: 'found' | 'skipped' | 'failed' | 'missing';
  skipReason?: string;
}

export function normalizeRepoPath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/**
 * Resolves a file path from an AI citation, architecture node, or user selection
 * against the indexed repository files and full repository tree.
 */
export function resolveRepoFilePath(
  repo: RepositoryRecord | null | undefined,
  rawPath: string | null | undefined
): ResolvedRepoFile {
  if (!repo || !rawPath) {
    return { file: null, resolvedPath: null, status: 'missing' };
  }

  const normalized = normalizeRepoPath(rawPath);
  if (!normalized) {
    return { file: null, resolvedPath: null, status: 'missing' };
  }

  // 1. Exact normalized match in indexed files
  const exact = repo.files.find((f) => normalizeRepoPath(f.path) === normalized);
  if (exact) {
    return { file: exact, resolvedPath: exact.path, status: 'found' };
  }

  // 2. Case-insensitive exact match
  const lower = normalized.toLowerCase();
  const caseInsensitive = repo.files.find(
    (f) => normalizeRepoPath(f.path).toLowerCase() === lower
  );
  if (caseInsensitive) {
    return {
      file: caseInsensitive,
      resolvedPath: caseInsensitive.path,
      status: 'found',
    };
  }

  // 3. Unambiguous suffix match (e.g., citation omitted root prefix)
  const suffixMatches = repo.files.filter((f) => {
    const p = normalizeRepoPath(f.path).toLowerCase();
    return p.endsWith(`/${lower}`);
  });
  if (suffixMatches.length === 1) {
    return {
      file: suffixMatches[0],
      resolvedPath: suffixMatches[0].path,
      status: 'found',
    };
  }

  // 4. Inspect full tree to distinguish skipped / failed vs non-existent
  const treeItem = repo.tree.find((t) => {
    if (t.type !== 'blob') return false;
    const tp = normalizeRepoPath(t.path);
    return tp === normalized || tp.toLowerCase() === lower;
  });

  if (treeItem) {
    if (treeItem.failed) {
      return {
        file: null,
        resolvedPath: treeItem.path,
        status: 'failed',
        skipReason: treeItem.skipReason || 'Failed to download or decode from GitHub',
      };
    }
    return {
      file: null,
      resolvedPath: treeItem.path,
      status: 'skipped',
      skipReason: treeItem.skipReason || 'Excluded by repository ingestion filter',
    };
  }

  return {
    file: null,
    resolvedPath: normalized,
    status: 'missing',
  };
}
