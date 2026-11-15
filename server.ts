import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ThinkingLevel } from '@google/genai';
import type {
  ChatMessage,
  HealthStatus,
  IndexingStatus,
  IngestionLiveStats,
  IngestProgressEvent,
  RepositoryRecord,
} from './src/types.ts';
import {
  extractArchitectureGraph,
  extractDetectedFacts,
} from './server/analyzer.ts';
import { DurablePersistenceError, sanitizeMongoErrorText, store } from './server/db.ts';
import { generateRepositoryDocs } from './server/docs.ts';
import { runStagedOverviewAnalysis } from './server/intelligence.ts';
import { MongoClient, ServerApiVersion } from 'mongodb';
import {
  formatAiError,
  generateAiText,
  getPrimaryAiTextModel,
  isGroqConfigured,
} from './server/ai.ts';
import {
  embedTexts,
  formatGeminiError,
  GEMINI_EMBEDDING_MODEL,
  GEMINI_TEXT_MODEL,
  generateText,
  isGeminiConfigured,
} from './server/gemini.ts';
import {
  fetchFullTreeEntries,
  fetchGitHubRepository,
  getIngestLimits,
  getLastGitHubRateLimit,
  getSkipReason,
  GitHubApiError,
  parseGitHubUrl,
  summarizeSkippedReasons,
} from './server/github.ts';
import { indexRepositoryEmbeddings, queryRepositoryRag } from './server/rag.ts';

const PORT = Number(process.env.PORT) || 3000;
const app = express();

app.use(express.json({ limit: '2mb' }));

// Simple per-IP request rate limiter for expensive AI/GitHub endpoints
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function checkRequestLimit(req: Request, maxPerMinute: number): boolean {
  const ip = req.ip || 'local';
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (bucket.count >= maxPerMinute) {
    return false;
  }
  bucket.count += 1;
  return true;
}

const inFlightIngestions = new Map<string, Promise<RepositoryRecord>>();
const inFlightOverviewAnalyses = new Map<string, Promise<RepositoryRecord>>();

function makeRepoId(owner: string, repo: string): string {
  return `${owner.toLowerCase()}__${repo.toLowerCase()}`;
}

function getErrorStatus(err: unknown, fallbackStatus = 500): number {
  if (err instanceof DurablePersistenceError) return err.statusCode;
  if (err instanceof GitHubApiError) return err.statusCode;
  return fallbackStatus;
}

function formatEndpointError(err: unknown, fallback: string): string {
  if (err instanceof DurablePersistenceError) return sanitizeMongoErrorText(err.message);
  if (err instanceof GitHubApiError) return err.message;
  if (err instanceof Error) return sanitizeMongoErrorText(formatAiError(err));
  return fallback;
}

export function isValidRepositoryId(id: string): boolean {
  if (!id || id.length < 2 || id.length > 200 || id.includes('..')) {
    return false;
  }
  if (/^__repomind_diag_selftest_/.test(id)) {
    return false;
  }
  return /^(?:__repomind_test_[a-zA-Z0-9._-]+|[a-zA-Z0-9][a-zA-Z0-9._-]{1,199})$/.test(id);
}

function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requireDiagnosticsAccess(req: Request, res: Response, next: NextFunction): void {
  if (!checkRequestLimit(req, 10)) {
    res.status(429).json({ error: 'Too many diagnostic requests. Please wait a minute.' });
    return;
  }

  const configuredToken = process.env.DIAGNOSTICS_TOKEN?.trim();
  if (configuredToken) {
    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const headerToken =
      typeof req.headers['x-diagnostics-token'] === 'string'
        ? req.headers['x-diagnostics-token'].trim()
        : '';
    const candidate = bearer || headerToken;
    const a = Buffer.from(candidate);
    const b = Buffer.from(configuredToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(403).json({
        error: 'Diagnostics endpoint requires a valid diagnostics authorization token.',
      });
      return;
    }
    next();
    return;
  }

  const forwardedFor = req.headers['x-forwarded-for'];
  const hasExternalForward =
    typeof forwardedFor === 'string' &&
    forwardedFor
      .split(',')
      .some((part) => part.trim().length > 0 && !isLoopbackIp(part.trim()));

  if (process.env.NODE_ENV === 'production' || !isLoopbackIp(req.socket?.remoteAddress) || hasExternalForward) {
    res.status(403).json({
      error:
        'Diagnostics endpoints are disabled for external requests unless DIAGNOSTICS_TOKEN is configured.',
    });
    return;
  }

  next();
}

app.param('id', (_req: Request, res: Response, next: NextFunction, id: string) => {
  if (!isValidRepositoryId(id)) {
    res.status(400).json({ error: 'Invalid repository ID format.' });
    return;
  }
  next();
});

async function runFullIngestion(
  repoUrl: string,
  forceRefresh: boolean,
  emit: (event: IngestProgressEvent) => void
): Promise<RepositoryRecord> {
  emit({
    stage: 'validating',
    message: 'Validating GitHub repository URL...',
    progress: 5,
  });

  const parsed = parseGitHubUrl(repoUrl);
  const repoId = makeRepoId(parsed.owner, parsed.repo);

  if (!forceRefresh) {
    const existing = await store.getRepository(repoId);
    if (existing) {
      const ageMs = Date.now() - new Date(existing.ingestedAt).getTime();
      const isCompleteCache =
        (existing.indexingStatus === 'complete' || existing.indexingStatus === undefined) &&
        existing.embeddingsReady &&
        existing.files.length > 0;
      if (ageMs < 15 * 60 * 1000 && isCompleteCache) {
        const cachedEmbeddingsCount =
          existing.embeddingsCount ?? (existing.embeddingsReady ? existing.chunkCount : 0);
        emit({
          stage: 'complete',
          message: `Loaded cached snapshot for ${existing.metadata.fullName} (${existing.metadata.commitSha.slice(0, 7)}).`,
          progress: 100,
          repositoryId: existing.id,
          stats: {
            totalTreeFiles: existing.detectedFacts.totalTreeFiles,
            eligibleFiles:
              existing.detectedFacts.eligibleFileCount ?? existing.detectedFacts.ingestedFileCount,
            indexedFiles: existing.detectedFacts.ingestedFileCount,
            skippedFiles: existing.detectedFacts.skippedFileCount,
            failedFiles: existing.detectedFacts.failedFileCount ?? 0,
            chunksCreated: existing.chunkCount,
            embeddingsGenerated: cachedEmbeddingsCount,
            indexingStatus: existing.indexingStatus ?? 'complete',
            skippedBreakdown: existing.detectedFacts.skippedBreakdown ?? [],
            failedFileDetails: existing.detectedFacts.failedFiles ?? [],
          },
        });
        return existing;
      }
    }
  }

  const existingInFlight = inFlightIngestions.get(repoId);
  if (existingInFlight) {
    return existingInFlight;
  }

  const pipelinePromise = (async () => {
    const liveStats: IngestionLiveStats = {
      totalTreeFiles: 0,
      eligibleFiles: 0,
      indexedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      chunksCreated: 0,
      embeddingsGenerated: 0,
      indexingStatus: 'indexing',
      skippedBreakdown: [],
      failedFileDetails: [],
    };

    const payload = await fetchGitHubRepository(repoUrl, (stage, message, progress, stats) => {
      if (stats) {
        Object.assign(liveStats, stats);
      }
      emit({ stage, message, progress, stats: { ...liveStats } });
    });

    liveStats.totalTreeFiles = payload.tree.filter((t) => t.type === 'blob').length;
    liveStats.eligibleFiles = payload.eligibleFileCount;
    liveStats.indexedFiles = payload.files.length;
    liveStats.failedFiles = payload.failedFiles.length;
    liveStats.skippedFiles = payload.tree.filter(
      (t) => t.type === 'blob' && !t.ingested && !t.failed
    ).length;
    liveStats.skippedBreakdown = payload.skippedBreakdown;
    liveStats.failedFileDetails = payload.failedFiles.slice(0, 20);

    emit({
      stage: 'analyzing-facts',
      message: `Computing deterministic metrics across ${payload.files.length} indexed files...`,
      progress: 62,
      stats: { ...liveStats },
    });
    const detectedFacts = extractDetectedFacts(payload);

    emit({
      stage: 'extracting-architecture',
      message: 'Parsing static imports and building dependency graph...',
      progress: 68,
      stats: { ...liveStats },
    });
    const architecture = extractArchitectureGraph(payload.files);

    const previous = await store.getRepository(repoId);
    const sameCommitAsPrevious =
      previous?.metadata.commitSha === payload.metadata.commitSha;

    const initialIndexingStatus: IndexingStatus =
      payload.files.length === 0 ? 'failed' : 'indexing';

    const initialRecord: RepositoryRecord = {
      id: repoId,
      metadata: payload.metadata,
      tree: payload.tree,
      files: payload.files,
      readmePath: payload.readmePath,
      readmeContent: payload.readmeContent,
      detectedFacts,
      aiAnalysis: sameCommitAsPrevious && previous?.aiAnalysis
        ? previous.aiAnalysis
        : {
            status: 'unavailable',
            model: getPrimaryAiTextModel(),
            generatedAt: new Date().toISOString(),
            summary: 'Generating staged repository-wide intelligence...',
            architecturalPattern: 'Pending staged analysis',
            keyCapabilities: [],
            modules: [],
            caveats: [],
          },
      architecture,
      docs: sameCommitAsPrevious ? previous.docs : null,
      ...(sameCommitAsPrevious && previous?.comprehensiveOverview
        ? { comprehensiveOverview: previous.comprehensiveOverview }
        : {}),
      chunkCount: sameCommitAsPrevious ? previous.chunkCount : 0,
      embeddingsCount: sameCommitAsPrevious ? previous.embeddingsCount : 0,
      embeddingsReady: sameCommitAsPrevious ? previous.embeddingsReady : false,
      indexingStatus: initialIndexingStatus,
      embeddingModel: sameCommitAsPrevious ? previous.embeddingModel : null,
      ingestedAt: new Date().toISOString(),
    };

    // Checkpoint 1: Durably persist repository files, tree, facts, and architecture BEFORE any Gemini calls
    emit({
      stage: 'saving',
      message: `Persisting ${payload.files.length} indexed files and dependency graph before AI indexing...`,
      progress: 70,
      stats: { ...liveStats },
    });
    await store.saveRepository(initialRecord);
    if (!(await store.confirmRepositoryPersisted(repoId))) {
      throw new DurablePersistenceError(
        `Repository ${repoId} could not be confirmed in persistent storage before embedding.`
      );
    }

    emit({
      stage: 'embedding',
      message: 'Chunking source files and generating vector embeddings...',
      progress: 72,
      stats: { ...liveStats },
    });
    const embeddingResult = await indexRepositoryEmbeddings(
      repoId,
      payload.files,
      (embeddingsGenerated, totalChunks) => {
        liveStats.chunksCreated = totalChunks;
        liveStats.embeddingsGenerated = embeddingsGenerated;
        const embPct =
          totalChunks > 0 ? 72 + Math.round((embeddingsGenerated / totalChunks) * 12) : 84;
        emit({
          stage: 'embedding',
          message:
            totalChunks > 0
              ? `Generated ${embeddingsGenerated}/${totalChunks} vector embeddings...`
              : 'No text chunks to embed.',
          progress: embPct,
          stats: { ...liveStats },
        });
      }
    );

    liveStats.chunksCreated = embeddingResult.chunkCount;
    liveStats.embeddingsGenerated = embeddingResult.embeddingsCount;

    const indexingStatus: IndexingStatus =
      payload.files.length === 0 ||
      (embeddingResult.chunkCount > 0 && embeddingResult.embeddingsCount === 0 && isGeminiConfigured())
        ? 'failed'
        : payload.failedFiles.length > 0 ||
          payload.truncatedByFileCap ||
          payload.truncatedBySizeCap ||
          (embeddingResult.chunkCount > 0 && !embeddingResult.embeddingsReady)
        ? 'partial'
        : 'complete';

    liveStats.indexingStatus = indexingStatus;

    // Checkpoint 2: Targeted update for embedding metrics without overwriting docs/chat/chunks
    await store.updateRepositoryFields(repoId, {
      chunkCount: embeddingResult.chunkCount,
      embeddingsCount: embeddingResult.embeddingsCount,
      embeddingsReady: embeddingResult.embeddingsReady,
      indexingStatus,
      embeddingModel: embeddingResult.embeddingModel,
      embeddingError: embeddingResult.error ?? '',
    });

    const recordForOverview: RepositoryRecord = {
      ...initialRecord,
      chunkCount: embeddingResult.chunkCount,
      embeddingsCount: embeddingResult.embeddingsCount,
      embeddingsReady: embeddingResult.embeddingsReady,
      indexingStatus,
      embeddingModel: embeddingResult.embeddingModel,
      embeddingError: embeddingResult.error ?? '',
    };

    emit({
      stage: 'ai-analysis',
      message: `Running staged repository-wide analysis across ${payload.files.length} eligible files...`,
      progress: 85,
      stats: { ...liveStats },
    });

    const { overview: comprehensiveOverview, aiAnalysis } = await runStagedOverviewAnalysis({
      repo: recordForOverview,
      mode: forceRefresh ? 'full' : 'resume',
      persistIncremental: true,
      onProgress: (ev) => {
        const mappedPct = 85 + Math.round((ev.progress / 100) * 11);
        emit({
          stage: 'ai-analysis',
          message: ev.message,
          progress: mappedPct,
          stats: { ...liveStats },
        });
      },
    });

    emit({
      stage: 'saving',
      message: 'Confirming durable repository persistence...',
      progress: 97,
      stats: { ...liveStats },
    });

    // Checkpoint 3: Targeted update for final analysis & timestamp, then verify persisted read-back
    const finalIngestedAt = new Date().toISOString();
    await store.updateRepositoryFields(repoId, {
      aiAnalysis,
      comprehensiveOverview,
      ingestedAt: finalIngestedAt,
    });

    if (!(await store.confirmRepositoryPersisted(repoId))) {
      throw new DurablePersistenceError(
        `Repository ${repoId} persistence could not be confirmed after analysis.`
      );
    }

    store.clearInMemoryCache(repoId);
    const persistedRecord = await store.getRepository(repoId);
    if (!persistedRecord) {
      throw new DurablePersistenceError(
        `Repository ${repoId} could not be read back from storage after saving.`
      );
    }

    const completionMsg =
      indexingStatus === 'complete'
        ? `Indexed ${persistedRecord.metadata.fullName}: ${detectedFacts.ingestedFileCount}/${detectedFacts.eligibleFileCount} eligible files, ${embeddingResult.embeddingsCount}/${embeddingResult.chunkCount} embeddings ready.`
        : indexingStatus === 'partial'
        ? `Partially indexed ${persistedRecord.metadata.fullName}: ${detectedFacts.ingestedFileCount}/${detectedFacts.eligibleFileCount} eligible files, ${embeddingResult.embeddingsCount}/${embeddingResult.chunkCount} embeddings ready.`
        : `Indexing failed for ${persistedRecord.metadata.fullName}: ${embeddingResult.error || 'No files or embeddings were produced.'}`;

    emit({
      stage: 'complete',
      message: completionMsg,
      progress: 100,
      repositoryId: persistedRecord.id,
      stats: { ...liveStats },
    });

    return persistedRecord;
  })();

  inFlightIngestions.set(repoId, pipelinePromise);
  try {
    return await pipelinePromise;
  } finally {
    inFlightIngestions.delete(repoId);
  }
}

app.get('/api/health', async (_req: Request, res: Response) => {
  try {
    await store.init();
  } catch {
    // Health endpoint intentionally returns degraded persistence status rather than crashing with 500
  }
  const mongoErr = store.getLastMongoError();
  const status: HealthStatus = {
    ok: store.getMode() !== 'unavailable',
    persistence: store.getMode(),
    persistenceStatus: store.getPersistenceStatus(),
    isDurable: store.isDurable(),
    databaseName: store.getDatabaseName(),
    mongodbConfigured: store.isMongoConfigured(),
    mongodbConnected: store.isMongoConnected(),
    geminiConfigured: isGeminiConfigured(),
    groqConfigured: isGroqConfigured(),
    aiTextModel: getPrimaryAiTextModel(),
    githubTokenConfigured: Boolean(process.env.GITHUB_TOKEN?.trim()),
    maxIndexableFiles: getIngestLimits().MAX_INDEXABLE_FILES,
    rateLimit: getLastGitHubRateLimit(),
    ...(mongoErr ? { mongodbError: mongoErr } : {}),
  };
  res.json(status);
});

app.post(
  '/api/diagnostics/persistence-test',
  requireDiagnosticsAccess,
  async (_req: Request, res: Response) => {
    try {
      const report = await store.runPersistenceSelfTest();
      res.status(report.persistenceVerified ? 200 : 503).json(report);
    } catch (err) {
      res.status(503).json({
        connected: false,
        readSuccessful: false,
        writeSuccessful: false,
        persistenceVerified: false,
        persistenceMode: store.getMode(),
        isDurable: store.isDurable(),
        databaseName: store.getDatabaseName(),
        error: sanitizeMongoErrorText(
          err instanceof Error ? err.message : 'Persistence self-test failed.'
        ),
      });
    }
  }
);

app.get('/api/diagnostics', requireDiagnosticsAccess, async (req: Request, res: Response) => {
  const scope = typeof req.query.scope === 'string' ? req.query.scope : 'all';
  const targetRepoId =
    typeof req.query.repoId === 'string' && isValidRepositoryId(req.query.repoId)
      ? req.query.repoId
      : 'saptuuu27__aeva-id';

  const envStatus = {
    GROQ_API_KEY: isGroqConfigured(),
    GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY?.trim() && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
    MONGODB_URI: Boolean(process.env.MONGODB_URI?.trim()),
    GITHUB_TOKEN: Boolean(process.env.GITHUB_TOKEN?.trim()),
  };

  if (scope === 'mongodb') {
    try {
      const inspection = await store.inspectMongoDatabases(targetRepoId);
      res.json({
        scope: 'mongodb',
        readOnly: true,
        envStatus: { MONGODB_URI: envStatus.MONGODB_URI },
        mongodbInspection: inspection,
      });
    } catch (err) {
      res.status(500).json({
        scope: 'mongodb',
        readOnly: true,
        error: err instanceof Error ? err.message : 'MongoDB diagnostic inspection failed.',
      });
    }
    return;
  }

  const results: Record<string, { status: 'PASS' | 'FAIL'; detail?: string; error?: string }> = {};

  // 0. Groq Primary Text Generation
  try {
    if (!envStatus.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY is not present in process.env.');
    }
    const groqRes = await generateAiText({
      systemInstruction: 'Reply with a single short phrase confirming connectivity.',
      prompt: 'Respond with: OK',
      maxTokens: 512,
      retryOptions: { maxRetries: 0, timeoutMs: 25_000, allowFallback: false },
    });
    results.groqText = {
      status: 'PASS',
      detail: `Model ${groqRes.model} responded (${groqRes.text.slice(0, 60)})`,
    };
  } catch (err) {
    results.groqText = {
      status: 'FAIL',
      error: formatAiError(err),
    };
  }

  // 1. Gemini Text Generation
  try {
    if (!envStatus.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not present in process.env.');
    }
    const text = await generateText({
      systemInstruction: 'Reply with a single short phrase confirming connectivity.',
      prompt: 'Respond with: OK',
      thinkingLevel: ThinkingLevel.LOW,
      retryOptions: { maxRetries: 0, timeoutMs: 30_000 },
    });
    results.geminiText = {
      status: 'PASS',
      detail: `Model ${GEMINI_TEXT_MODEL} responded (${text.slice(0, 60)})`,
    };
  } catch (err) {
    results.geminiText = {
      status: 'FAIL',
      error: formatGeminiError(err),
    };
  }

  // 2. Gemini Embedding Generation (multi-item batch test to verify batch count fix)
  try {
    if (!envStatus.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not present in process.env.');
    }
    const sampleBatch = ['function hello() {}', 'export const x = 1;', 'import express from "express";'];
    const vectors = await embedTexts(sampleBatch);
    results.geminiEmbedding = {
      status: 'PASS',
      detail: `Model ${GEMINI_EMBEDDING_MODEL} returned ${vectors.length}/${sampleBatch.length} vectors (dim=${vectors[0]?.length ?? 0})`,
    };
  } catch (err) {
    results.geminiEmbedding = {
      status: 'FAIL',
      error: formatGeminiError(err),
    };
  }

  // 3. MongoDB Atlas Connection
  try {
    const rawUri = process.env.MONGODB_URI ?? '';
    const uri = rawUri.trim();
    if (!uri) {
      throw new Error('MONGODB_URI is not present in process.env.');
    }
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 6000,
      connectTimeoutMS: 6000,
      family: 4,
      serverApi: {
        version: ServerApiVersion.v1,
        strict: false,
        deprecationErrors: false,
      },
    });
    try {
      await client.connect();
      await client.db('repomind').command({ ping: 1 });
      results.mongodb = {
        status: 'PASS',
        detail: 'Connected to MongoDB and ping succeeded.',
      };
    } finally {
      await client.close().catch(() => {});
    }
  } catch (err) {
    const raw = process.env.MONGODB_URI ?? '';
    const trimmed = raw.trim();
    const hints: string[] = [];
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) hints.push('wrapped in quotes');
    if (trimmed.includes('MONGODB_URI=')) hints.push('contains "MONGODB_URI=" prefix');
    if (!trimmed.startsWith('mongodb://') && !trimmed.startsWith('mongodb+srv://')) {
      hints.push('does not start with "mongodb://" or "mongodb+srv://"');
    }
    if (/\s/.test(trimmed)) hints.push('contains whitespace or newlines');
    if (trimmed.includes('<') || trimmed.includes('>')) {
      hints.push('contains "<" or ">" placeholder characters');
    }
    const afterScheme = trimmed.replace(/^mongodb(?:\+srv)?:\/\//, '');
    const authority = afterScheme.split('/')[0].split('?')[0];
    const atCount = (authority.match(/@/g) ?? []).length;
    if (atCount > 1) {
      hints.push(`authority contains ${atCount} "@" characters (unencoded "@" in username/password must be %40)`);
    } else if (atCount === 0 && authority.length === 0) {
      hints.push('empty host/authority');
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('SSL alert number 80') || errMsg.includes('tlsv1 alert internal error')) {
      hints.push(
        'MongoDB Atlas closed the TLS handshake (SSL alert 80). This most commonly occurs when the server IP is not allowed in Atlas Network Access (IP Access List must include 0.0.0.0/0 for cloud environments).'
      );
    }
    results.mongodb = {
      status: 'FAIL',
      error: hints.length > 0 ? `${errMsg.trim()} — ${hints.join('; ')}` : errMsg.trim(),
    };
  }

  // 4. GitHub API Authentication
  try {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      throw new Error('GITHUB_TOKEN is not present in process.env.');
    }
    const ghRes = await fetch('https://api.github.com/rate_limit', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'RepoMind-Diagnostics/1.0',
      },
    });
    const body = (await ghRes.json().catch(() => ({}))) as {
      message?: string;
      resources?: { core?: { limit?: number; remaining?: number } };
    };
    if (!ghRes.ok) {
      throw new Error(`GitHub HTTP ${ghRes.status}: ${body.message || ghRes.statusText}`);
    }
    const core = body.resources?.core;
    results.github = {
      status: 'PASS',
      detail: `Authenticated GitHub API (core limit=${core?.limit}, remaining=${core?.remaining})`,
    };
  } catch (err) {
    results.github = {
      status: 'FAIL',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  res.json({ envStatus, results });
});

app.get('/api/repositories', async (_req: Request, res: Response) => {
  try {
    const list = await store.listRepositories();
    res.json({ repositories: list });
  } catch (err) {
    res.status(getErrorStatus(err)).json({
      error: err instanceof Error ? err.message : 'Failed to list repositories.',
    });
  }
});

app.get('/api/repositories/:id', async (req: Request, res: Response) => {
  try {
    const repo = await store.getRepository(req.params.id);
    if (!repo) {
      res.status(404).json({ error: 'Repository not found.' });
      return;
    }
    res.json({ repository: repo });
  } catch (err) {
    res.status(getErrorStatus(err)).json({
      error: err instanceof Error ? err.message : 'Failed to load repository.',
    });
  }
});

app.delete('/api/repositories/:id', async (req: Request, res: Response) => {
  try {
    await store.deleteRepository(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(getErrorStatus(err)).json({
      error: err instanceof Error ? err.message : 'Failed to delete repository.',
    });
  }
});

app.post('/api/repositories/ingest', async (req: Request, res: Response) => {
  if (!checkRequestLimit(req, 20)) {
    res.status(429).json({ error: 'Too many ingestion requests. Please wait a minute.' });
    return;
  }

  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  const forceRefresh = Boolean(req.body?.forceRefresh);
  const wantsStream =
    req.query.stream === 'true' ||
    req.headers.accept?.includes('text/event-stream');

  if (!wantsStream) {
    try {
      const repo = await runFullIngestion(url, forceRefresh, () => {});
      res.json({ repository: repo });
    } catch (err) {
      const status = getErrorStatus(err);
      res.status(status).json({
        error: err instanceof Error ? err.message : 'Repository ingestion failed.',
      });
    }
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let clientClosed = false;
  req.on('aborted', () => {
    clientClosed = true;
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true;
    }
  });

  const sendEvent = (event: string, data: unknown) => {
    if (clientClosed || res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const repository = await runFullIngestion(url, forceRefresh, (progressEvent) => {
      sendEvent('progress', progressEvent);
    });
    sendEvent('done', { repository });
    if (!clientClosed && !res.writableEnded && !res.destroyed) res.end();
  } catch (err) {
    const message = formatEndpointError(err, 'Repository ingestion failed.');
    sendEvent('error', {
      stage: 'error',
      message,
      progress: 0,
    });
    if (!clientClosed && !res.writableEnded && !res.destroyed) res.end();
  }
});

app.post('/api/repositories/:id/reanalyze', async (req: Request, res: Response) => {
  if (!checkRequestLimit(req, 15)) {
    res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
    return;
  }

  try {
    const repo = await store.getRepository(req.params.id);
    if (!repo) {
      res.status(404).json({ error: 'Repository not found.' });
      return;
    }

    const { overview: comprehensiveOverview, aiAnalysis } = await runStagedOverviewAnalysis({
      repo,
      mode: 'full',
      persistIncremental: true,
    });
    const embeddingResult = await indexRepositoryEmbeddings(repo.id, repo.files);

    const indexingStatus: IndexingStatus =
      repo.files.length === 0 ||
      (embeddingResult.chunkCount > 0 && embeddingResult.embeddingsCount === 0 && isGeminiConfigured())
        ? 'failed'
        : (repo.detectedFacts.failedFileCount ?? 0) > 0 ||
          repo.detectedFacts.limitsApplied.truncatedByFileCap ||
          repo.detectedFacts.limitsApplied.truncatedBySizeCap ||
          (embeddingResult.chunkCount > 0 && !embeddingResult.embeddingsReady)
        ? 'partial'
        : 'complete';

    await store.updateRepositoryFields(repo.id, {
      aiAnalysis,
      comprehensiveOverview,
      chunkCount: embeddingResult.chunkCount,
      embeddingsCount: embeddingResult.embeddingsCount,
      embeddingsReady: embeddingResult.embeddingsReady,
      indexingStatus,
      embeddingModel: embeddingResult.embeddingModel,
      embeddingError: embeddingResult.error ?? '',
    });

    store.clearInMemoryCache(repo.id);
    const updated = (await store.getRepository(repo.id)) ?? {
      ...repo,
      aiAnalysis,
      comprehensiveOverview,
      chunkCount: embeddingResult.chunkCount,
      embeddingsCount: embeddingResult.embeddingsCount,
      embeddingsReady: embeddingResult.embeddingsReady,
      indexingStatus,
      embeddingModel: embeddingResult.embeddingModel,
      embeddingError: embeddingResult.error ?? '',
    };
    res.json({ repository: updated });
  } catch (err) {
    res.status(getErrorStatus(err)).json({ error: formatEndpointError(err, 'Re-analysis failed.') });
  }
});

app.post('/api/repositories/:id/overview/analyze', async (req: Request, res: Response) => {
  if (!checkRequestLimit(req, 15)) {
    res.status(429).json({ error: 'Too many analysis requests. Please wait a minute.' });
    return;
  }

  const repoId = req.params.id;
  const mode = req.body?.mode === 'full' ? 'full' : 'resume';
  const retryBatchIds = Array.isArray(req.body?.retryBatchIds)
    ? req.body.retryBatchIds.filter((id: unknown): id is string => typeof id === 'string')
    : [];
  const wantsStream =
    req.query.stream === 'true' || Boolean(req.headers.accept?.includes('text/event-stream'));

  let repo: RepositoryRecord | null;
  try {
    repo = await store.getRepository(repoId);
  } catch (err) {
    res.status(getErrorStatus(err)).json({ error: formatEndpointError(err, 'Failed to load repository.') });
    return;
  }
  if (!repo) {
    res.status(404).json({ error: 'Repository not found.' });
    return;
  }

  const execute = async (emitProgress?: (ev: import('./src/types.ts').OverviewProgressEvent) => void) => {
    const existingFlight = inFlightOverviewAnalyses.get(repoId);
    if (existingFlight) {
      return existingFlight;
    }
    const promise = (async () => {
      const { overview, aiAnalysis } = await runStagedOverviewAnalysis({
        repo,
        mode,
        retryBatchIds,
        persistIncremental: true,
        onProgress: emitProgress,
      });
      const updated = (await store.getRepository(repoId)) ?? {
        ...repo,
        comprehensiveOverview: overview,
        aiAnalysis,
      };
      return updated;
    })();

    inFlightOverviewAnalyses.set(repoId, promise);
    try {
      return await promise;
    } finally {
      inFlightOverviewAnalyses.delete(repoId);
    }
  };

  if (!wantsStream) {
    try {
      const repository = await execute();
      res.json({ repository });
    } catch (err) {
      res.status(getErrorStatus(err)).json({ error: formatEndpointError(err, 'Overview analysis failed.') });
    }
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let clientClosed = false;
  req.on('aborted', () => {
    clientClosed = true;
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true;
    }
  });

  const sendEvent = (event: string, data: unknown) => {
    if (clientClosed || res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const repository = await execute((progressEvent) => {
      sendEvent('progress', progressEvent);
    });
    sendEvent('done', { repository });
    if (!clientClosed && !res.writableEnded && !res.destroyed) res.end();
  } catch (err) {
    sendEvent('error', {
      stage: 'error',
      message: formatEndpointError(err, 'Overview analysis failed.'),
      progress: 0,
    });
    if (!clientClosed && !res.writableEnded && !res.destroyed) res.end();
  }
});

app.post('/api/repositories/:id/reconcile', async (req: Request, res: Response) => {
  try {
    const repo = await store.getRepository(req.params.id);
    if (!repo) {
      res.status(404).json({ error: 'Repository not found.' });
      return;
    }

    const limits = getIngestLimits();
    const liveTree = await fetchFullTreeEntries(
      repo.metadata.owner,
      repo.metadata.name,
      repo.metadata.defaultBranch
    );

    const existingFilesByPath = new Map(repo.files.map((f) => [f.path, f]));
    const existingTreeByPath = new Map(repo.tree.map((t) => [t.path, t]));
    const seenPaths = new Set<string>();
    const updatedTree: typeof repo.tree = [];

    for (const entry of liveTree.entries) {
      if (entry.type !== 'blob' && entry.type !== 'tree') continue;
      if (seenPaths.has(entry.path)) continue;
      seenPaths.add(entry.path);

      if (entry.type === 'tree') {
        updatedTree.push({ path: entry.path, type: 'tree', sha: entry.sha });
        continue;
      }

      const existingFile = existingFilesByPath.get(entry.path);
      const prevTreeItem = existingTreeByPath.get(entry.path);
      if (existingFile) {
        updatedTree.push({
          path: entry.path,
          type: 'blob',
          size: entry.size,
          sha: entry.sha,
          ingested: true,
          failed: false,
        });
        continue;
      }

      if (prevTreeItem?.failed) {
        updatedTree.push({
          path: entry.path,
          type: 'blob',
          size: entry.size,
          sha: entry.sha,
          ingested: false,
          failed: true,
          skipReason: prevTreeItem.skipReason,
        });
        continue;
      }

      const reason =
        getSkipReason(entry.path, entry.size, limits.MAX_FILE_BYTES) ??
        prevTreeItem?.skipReason ??
        'Not yet fetched';

      updatedTree.push({
        path: entry.path,
        type: 'blob',
        size: entry.size,
        sha: entry.sha,
        ingested: false,
        failed: false,
        skipReason: reason,
      });
    }

    const skippedBreakdown = summarizeSkippedReasons(updatedTree);
    const blobs = updatedTree.filter((t) => t.type === 'blob');
    const failedFiles = blobs
      .filter((t) => t.failed)
      .map((t) => ({ path: t.path, reason: t.skipReason || 'Fetch failed' }));
    const skippedCount = blobs.filter((t) => !t.ingested && !t.failed).length;
    const eligibleCount = blobs.filter(
      (t) =>
        t.ingested ||
        t.failed ||
        t.skipReason?.startsWith('Skipped due to') ||
        t.skipReason === 'Not yet fetched'
    ).length;

    const updatedFacts = {
      ...repo.detectedFacts,
      totalTreeFiles: blobs.length,
      eligibleFileCount: eligibleCount,
      ingestedFileCount: repo.files.length,
      skippedFileCount: skippedCount,
      failedFileCount: failedFiles.length,
      skippedBreakdown,
      failedFiles,
      limitsApplied: {
        ...repo.detectedFacts.limitsApplied,
        maxFiles: limits.MAX_INDEXABLE_FILES,
        maxFileBytes: limits.MAX_FILE_BYTES,
        maxTotalBytes: limits.MAX_TOTAL_BYTES,
      },
    };

    const updated: RepositoryRecord = {
      ...repo,
      tree: updatedTree,
      detectedFacts: updatedFacts,
    };

    await store.updateRepositoryFields(repo.id, {
      tree: updatedTree,
      detectedFacts: updatedFacts,
    });

    const classification = {
      successfullyIndexed: [] as Array<{ path: string; size?: number }>,
      excludedByFileType: [] as Array<{ path: string; size?: number; reason: string }>,
      excludedByFileSize: [] as Array<{ path: string; size?: number; reason: string }>,
      excludedByDirectory: [] as Array<{ path: string; size?: number; reason: string }>,
      githubFetchFailure: [] as Array<{ path: string; size?: number; reason: string }>,
      parsingFailure: [] as Array<{ path: string; size?: number; reason: string }>,
      otherReason: [] as Array<{ path: string; size?: number; reason: string }>,
    };

    for (const item of blobs) {
      if (item.ingested) {
        classification.successfullyIndexed.push({ path: item.path, size: item.size });
      } else if (item.failed) {
        classification.githubFetchFailure.push({
          path: item.path,
          size: item.size,
          reason: item.skipReason || 'GitHub fetch failure',
        });
      } else {
        const reason = item.skipReason || 'Other';
        if (reason === 'Ignored build/vendor directory') {
          classification.excludedByDirectory.push({ path: item.path, size: item.size, reason });
        } else if (reason.includes('size cap')) {
          classification.excludedByFileSize.push({ path: item.path, size: item.size, reason });
        } else if (
          reason === 'Binary or media file skipped' ||
          reason === 'Unsupported or binary file type' ||
          reason === 'Lockfile or excluded config skipped' ||
          reason.startsWith('Generated bundle') ||
          reason === 'Binary file detected'
        ) {
          classification.excludedByFileType.push({ path: item.path, size: item.size, reason });
        } else {
          classification.otherReason.push({ path: item.path, size: item.size, reason });
        }
      }
    }

    res.json({
      repository: updated,
      reconciliation: {
        totalDiscoveredFiles: blobs.length,
        treeTruncatedByGitHub: liveTree.truncatedByGitHub,
        maxIndexableFiles: limits.MAX_INDEXABLE_FILES,
        counts: {
          successfullyIndexed: classification.successfullyIndexed.length,
          excludedByFileType: classification.excludedByFileType.length,
          excludedByFileSize: classification.excludedByFileSize.length,
          excludedByDirectory: classification.excludedByDirectory.length,
          githubFetchFailure: classification.githubFetchFailure.length,
          parsingFailure: classification.parsingFailure.length,
          otherReason: classification.otherReason.length,
        },
        embeddingsPreserved: {
          chunkCount: updated.chunkCount,
          embeddingsCount: updated.embeddingsCount ?? (updated.embeddingsReady ? updated.chunkCount : 0),
          embeddingsReady: updated.embeddingsReady,
        },
        details: {
          excludedByDirectory: classification.excludedByDirectory,
          excludedByFileSize: classification.excludedByFileSize,
          excludedByFileType: classification.excludedByFileType,
          githubFetchFailure: classification.githubFetchFailure,
          parsingFailure: classification.parsingFailure,
          otherReason: classification.otherReason,
        },
      },
    });
  } catch (err) {
    const status = getErrorStatus(err);
    res.status(status).json({
      error: err instanceof Error ? err.message : 'Reconciliation failed.',
    });
  }
});

app.get('/api/repositories/:id/chat', async (req: Request, res: Response) => {
  try {
    const messages = await store.getChatMessages(req.params.id);
    res.json({ messages });
  } catch (err) {
    res.status(getErrorStatus(err)).json({
      error: err instanceof Error ? err.message : 'Failed to load chat messages.',
    });
  }
});

app.delete('/api/repositories/:id/chat', async (req: Request, res: Response) => {
  try {
    await store.clearChatMessages(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(getErrorStatus(err)).json({
      error: err instanceof Error ? err.message : 'Failed to clear chat messages.',
    });
  }
});

app.post('/api/repositories/:id/chat', async (req: Request, res: Response) => {
  if (!checkRequestLimit(req, 30)) {
    res.status(429).json({ error: 'Too many chat requests. Please wait a minute.' });
    return;
  }

  try {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question) {
      res.status(400).json({ error: 'Please enter a question.' });
      return;
    }

    const repo = await store.getRepository(req.params.id);
    if (!repo) {
      res.status(404).json({ error: 'Repository not found.' });
      return;
    }

    const history = await store.getChatMessages(repo.id);
    const ragResponse = await queryRepositoryRag(repo, question, history);

    const now = Date.now();
    const userMessage: ChatMessage = {
      id: `msg_${now}_u`,
      repoId: repo.id,
      role: 'user',
      content: question,
      createdAt: new Date(now).toISOString(),
    };

    const assistantMessage: ChatMessage = {
      id: `msg_${now + 1}_a`,
      repoId: repo.id,
      role: 'assistant',
      content: ragResponse.answer,
      citations: ragResponse.citations,
      insufficientEvidence: ragResponse.insufficientEvidence,
      model: ragResponse.model,
      createdAt: new Date(now + 1).toISOString(),
    };

    await store.appendChatMessages(repo.id, [userMessage, assistantMessage]);

    // Targeted update on repo ONLY if embeddings are actually complete and ready
    if (
      ragResponse.embeddingsReady &&
      (!repo.embeddingsReady || repo.embeddingsCount !== ragResponse.embeddingsCount)
    ) {
      let nextIndexingStatus = repo.indexingStatus;
      if (repo.indexingStatus === 'failed' || repo.indexingStatus === 'partial') {
        const hasFileGaps =
          (repo.detectedFacts.failedFileCount ?? 0) > 0 ||
          repo.detectedFacts.limitsApplied.truncatedByFileCap ||
          repo.detectedFacts.limitsApplied.truncatedBySizeCap;
        nextIndexingStatus = hasFileGaps ? 'partial' : 'complete';
      }
      await store.updateRepositoryFields(repo.id, {
        embeddingsReady: true,
        embeddingsCount: ragResponse.embeddingsCount,
        chunkCount: ragResponse.chunkCount,
        embeddingError: '',
        ...(nextIndexingStatus ? { indexingStatus: nextIndexingStatus } : {}),
      });
    }

    res.json({
      userMessage,
      assistantMessage,
      embeddingsReady: ragResponse.embeddingsReady,
      retrievalMode: ragResponse.retrievalMode,
    });
  } catch (err) {
    res.status(getErrorStatus(err)).json({ error: formatEndpointError(err, 'Chat query failed.') });
  }
});

app.post('/api/repositories/:id/docs', async (req: Request, res: Response) => {
  if (!checkRequestLimit(req, 12)) {
    res.status(429).json({ error: 'Too many documentation generation requests.' });
    return;
  }

  try {
    const repo = await store.getRepository(req.params.id);
    if (!repo) {
      res.status(404).json({ error: 'Repository not found.' });
      return;
    }

    const docs = await generateRepositoryDocs(repo);
    if (docs.status === 'error') {
      res.status(500).json({ error: docs.errorMessage || 'Documentation generation failed.' });
      return;
    }

    await store.updateRepositoryFields(repo.id, { docs });
    res.json({ docs });
  } catch (err) {
    res.status(getErrorStatus(err)).json({ error: formatEndpointError(err, 'Documentation generation failed.') });
  }
});

async function startServer() {
  void store.init();

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[RepoMind] Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[RepoMind] Fatal server startup error:', err);
  process.exit(1);
});
