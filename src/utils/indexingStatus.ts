import type {
  IndexingStatus,
  IngestionLiveStats,
  RepositoryRecord,
  RepositorySummary,
} from '../types';

export function getResolvedEmbeddingsCount(repo: {
  chunkCount: number;
  embeddingsCount?: number;
  embeddingsReady: boolean;
}): number {
  if (typeof repo.embeddingsCount === 'number' && Number.isFinite(repo.embeddingsCount)) {
    return Math.max(0, Math.min(repo.embeddingsCount, repo.chunkCount));
  }
  return repo.embeddingsReady ? repo.chunkCount : 0;
}

export function areAllEmbeddingsGenerated(repo: {
  chunkCount: number;
  embeddingsCount?: number;
  embeddingsReady: boolean;
}): boolean {
  if (repo.chunkCount <= 0) return true;
  return repo.embeddingsReady === true && getResolvedEmbeddingsCount(repo) >= repo.chunkCount;
}

export function deriveRecordIndexingStatus(repo: RepositoryRecord): IndexingStatus {
  const ingestedCount = repo.detectedFacts.ingestedFileCount;
  const failedCount = repo.detectedFacts.failedFileCount ?? 0;
  const hasFileGaps =
    failedCount > 0 ||
    repo.detectedFacts.limitsApplied.truncatedByFileCap ||
    repo.detectedFacts.limitsApplied.truncatedBySizeCap;
  const allEmbedded = areAllEmbeddingsGenerated(repo);

  if (repo.indexingStatus === 'failed' || ingestedCount === 0) {
    return 'failed';
  }
  if (repo.indexingStatus === 'indexing') {
    return 'indexing';
  }
  if (repo.indexingStatus === 'partial' || !allEmbedded || hasFileGaps) {
    return 'partial';
  }
  return 'complete';
}

export function deriveSummaryIndexingStatus(repo: RepositorySummary): IndexingStatus {
  const allEmbedded = areAllEmbeddingsGenerated(repo);
  if (repo.indexingStatus === 'failed' || repo.ingestedFileCount === 0) {
    return 'failed';
  }
  if (repo.indexingStatus === 'indexing') {
    return 'indexing';
  }
  if (repo.indexingStatus === 'partial' || !allEmbedded) {
    return 'partial';
  }
  return 'complete';
}

export function deriveLiveStatsIndexingStatus(
  stats: Partial<IngestionLiveStats> | undefined,
  isIngesting: boolean,
  stage?: string
): IndexingStatus {
  if (!stats) return isIngesting ? 'indexing' : 'partial';
  if (stats.indexingStatus === 'failed') return 'failed';
  if (stats.indexingStatus === 'partial') return 'partial';
  if (isIngesting && stage !== 'complete') {
    return stats.indexingStatus ?? 'indexing';
  }
  const chunks = stats.chunksCreated ?? 0;
  const embeds = stats.embeddingsGenerated ?? 0;
  const failed = stats.failedFiles ?? 0;
  if ((stats.indexedFiles ?? 0) === 0) return 'failed';
  if (failed > 0 || (chunks > 0 && embeds < chunks)) {
    return 'partial';
  }
  return stats.indexingStatus ?? 'complete';
}
