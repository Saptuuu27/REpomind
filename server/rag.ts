import crypto from 'node:crypto';
import { ThinkingLevel, Type } from '@google/genai';
import type {
  ChatMessage,
  Citation,
  CodeChunk,
  RepositoryRecord,
  SourceFile,
} from '../src/types.ts';
import {
  generateAiStructuredJson,
  getPrimaryAiTextModel,
  isAiTextConfigured,
} from './ai.ts';
import { DurablePersistenceError, store } from './db.ts';
import {
  classifyGeminiError,
  embedBatch,
  embedTexts,
  GEMINI_EMBEDDING_MODEL,
  type GeminiErrorCategory,
  isGeminiConfigured,
} from './gemini.ts';

const LINES_PER_CHUNK = 100;
const OVERLAP_LINES = 15;
const EMBED_BATCH_SIZE = 20;
const INTER_BATCH_DELAY_MS = 800;

const LEXICAL_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'by', 'can', 'code',
  'codebase', 'configure', 'configured', 'could', 'describe', 'did', 'do', 'does',
  'doing', 'done', 'each', 'explain', 'file', 'files', 'find', 'for', 'from',
  'function', 'functions', 'get', 'give', 'has', 'have', 'having', 'how', 'if',
  'implement', 'implemented', 'in', 'into', 'is', 'it', 'its', 'list', 'me',
  'method', 'methods', 'more', 'most', 'my', 'no', 'not', 'of', 'on', 'or', 'our',
  'please', 'project', 'repo', 'repository', 'say', 'see', 'should', 'show', 'so',
  'some', 'such', 'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'to', 'up', 'use', 'used', 'using', 'very',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will',
  'with', 'work', 'works', 'working', 'would', 'you', 'your',
]);

function getMaxChunksPerRepo(): number {
  const raw = process.env.MAX_CHUNKS_PER_REPO;
  if (!raw) return 600;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 600;
}

function chunkPriority(filePath: string): number {
  const lower = filePath.toLowerCase();
  if (/^(src|source|app|lib|server|api|core|packages|backend|frontend|client)\//.test(lower)) {
    if (/\.(test|spec)\./.test(lower)) return 2;
    return 5;
  }
  if (/^readme/.test(lower) || lower === 'package.json' || lower === 'pyproject.toml') {
    return 4;
  }
  if (/^(test|tests|__tests__|\.github)\//.test(lower) || /\.(test|spec)\./.test(lower)) {
    return 1;
  }
  return 3;
}

export function chunkSourceFiles(repoId: string, files: SourceFile[]): CodeChunk[] {
  const maxChunks = getMaxChunksPerRepo();
  const prioritized = [...files].sort(
    (a, b) => chunkPriority(b.path) - chunkPriority(a.path) || a.path.localeCompare(b.path)
  );

  const perFileChunks: CodeChunk[][] = [];
  let totalGenerated = 0;

  for (const file of prioritized) {
    const lines = file.content.split('\n');
    if (lines.length === 0) continue;

    const fileChunks: CodeChunk[] = [];
    let startIdx = 0;
    while (startIdx < lines.length) {
      const endIdx = Math.min(lines.length, startIdx + LINES_PER_CHUNK);
      const slice = lines.slice(startIdx, endIdx).join('\n').trim();

      if (slice.length > 0) {
        const startLine = startIdx + 1;
        const endLine = endIdx;
        const content = slice.slice(0, 4000);
        fileChunks.push({
          id: crypto
            .createHash('sha1')
            .update(`${repoId}:${file.path}:${startLine}-${endLine}`)
            .digest('hex')
            .slice(0, 16),
          repoId,
          filePath: file.path,
          startLine,
          endLine,
          language: file.language,
          content,
          embedding: [],
        });
      }

      if (endIdx >= lines.length) break;
      startIdx += LINES_PER_CHUNK - OVERLAP_LINES;
    }

    if (fileChunks.length > 0) {
      perFileChunks.push(fileChunks);
      totalGenerated += fileChunks.length;
    }
  }

  if (totalGenerated <= maxChunks) {
    return perFileChunks.flat();
  }

  // Round-robin selection across files so every indexed file has RAG coverage before hitting maxChunks
  const selected: CodeChunk[] = [];
  let pass = 0;
  while (selected.length < maxChunks) {
    let addedInPass = false;
    for (const fileChunks of perFileChunks) {
      if (pass < fileChunks.length) {
        selected.push(fileChunks[pass]);
        addedInPass = true;
        if (selected.length >= maxChunks) break;
      }
    }
    if (!addedInPass) break;
    pass++;
  }

  // Preserve clean file-path and line ordering
  const priorityIndex = new Map(prioritized.map((f, idx) => [f.path, idx]));
  selected.sort(
    (a, b) =>
      (priorityIndex.get(a.filePath) ?? 0) - (priorityIndex.get(b.filePath) ?? 0) ||
      a.startLine - b.startLine
  );

  return selected;
}

export async function indexRepositoryEmbeddings(
  repoId: string,
  files: SourceFile[],
  onProgress?: (embeddingsGenerated: number, totalChunks: number) => void
): Promise<{
  chunkCount: number;
  embeddingsCount: number;
  embeddingsReady: boolean;
  embeddingModel: string | null;
  error?: string;
  errorCategory?: GeminiErrorCategory;
}> {
  const chunks = chunkSourceFiles(repoId, files);
  if (chunks.length === 0) {
    await store.saveChunks(repoId, [], { allowClear: files.length === 0 });
    onProgress?.(0, 0);
    return {
      chunkCount: 0,
      embeddingsCount: 0,
      embeddingsReady: false,
      embeddingModel: null,
      error: 'No non-empty text chunks extracted from repository.',
    };
  }

  // Reuse already-valid embeddings if chunk ID & content are unchanged (allows seamless resume on partial runs)
  const existingChunks = await store.getChunks(repoId);
  const existingById = new Map<string, CodeChunk>();
  for (const ec of existingChunks) {
    if (Array.isArray(ec.embedding) && ec.embedding.length > 0) {
      existingById.set(ec.id, ec);
    }
  }
  let reusedCount = 0;
  for (const chunk of chunks) {
    const prev = existingById.get(chunk.id);
    if (prev && prev.content === chunk.content) {
      chunk.embedding = prev.embedding;
      reusedCount++;
    }
  }

  // Durably persist chunks (and reused embeddings) BEFORE starting external Gemini embedding calls
  await store.saveChunks(repoId, chunks);
  onProgress?.(reusedCount, chunks.length);

  if (!isGeminiConfigured()) {
    return {
      chunkCount: chunks.length,
      embeddingsCount: reusedCount,
      embeddingsReady: false,
      embeddingModel: null,
      error: 'GEMINI_API_KEY is not configured. Chunks were saved without embeddings.',
      errorCategory: 'auth_error',
    };
  }

  const missingChunks = chunks.filter(
    (c) => !Array.isArray(c.embedding) || c.embedding.length === 0
  );

  let embeddingsGenerated = reusedCount;
  let batchError: string | undefined;
  let batchErrorCategory: GeminiErrorCategory | undefined;

  for (let i = 0; i < missingChunks.length; i += EMBED_BATCH_SIZE) {
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, INTER_BATCH_DELAY_MS));
    }

    const batchChunks = missingChunks.slice(i, i + EMBED_BATCH_SIZE);
    const textsToEmbed = batchChunks.map(
      (c) => `File: ${c.filePath} (lines ${c.startLine}-${c.endLine}, ${c.language})\n${c.content}`
    );

    try {
      const batchVectors = await embedBatch(textsToEmbed);
      if (batchVectors.length !== batchChunks.length) {
        throw new Error(
          `Batch embedding mismatch: expected ${batchChunks.length}, received ${batchVectors.length}`
        );
      }
      for (let j = 0; j < batchChunks.length; j++) {
        const vec = batchVectors[j];
        if (!Array.isArray(vec) || vec.length === 0) {
          throw new Error(`Invalid vector returned for chunk ${batchChunks[j].filePath}`);
        }
        batchChunks[j].embedding = vec;
      }

      // Checkpoint each completed embedding batch immediately so partial progress survives quota exhaustion or crashes
      await store.saveChunkBatch(repoId, batchChunks);
      embeddingsGenerated += batchChunks.length;
      onProgress?.(embeddingsGenerated, chunks.length);
    } catch (err) {
      if (err instanceof DurablePersistenceError) {
        throw err;
      }
      const classified = classifyGeminiError(err);
      batchError = classified.userMessage;
      batchErrorCategory = classified.category;
      // Stop immediately (especially on quota_exhausted / auth_error); completed batch checkpoints remain persisted
      break;
    }
  }

  const validEmbeddedCount = chunks.filter(
    (c) => Array.isArray(c.embedding) && c.embedding.length > 0
  ).length;
  const allComplete =
    !batchError && chunks.length > 0 && validEmbeddedCount === chunks.length;

  return {
    chunkCount: chunks.length,
    embeddingsCount: validEmbeddedCount,
    embeddingsReady: allComplete,
    embeddingModel: allComplete ? GEMINI_EMBEDDING_MODEL : null,
    error: allComplete
      ? undefined
      : batchError ||
        `Incomplete embeddings: generated ${validEmbeddedCount} of ${chunks.length} required vectors.`,
    ...(allComplete ? {} : { errorCategory: batchErrorCategory }),
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function computeLexicalBonus(query: string, chunk: CodeChunk): number {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length >= 2 && !LEXICAL_STOP_WORDS.has(t));
  if (tokens.length === 0) return 0;

  const lowerPath = chunk.filePath.toLowerCase();
  const lowerContent = chunk.content.toLowerCase();
  let bonus = 0;

  for (const token of tokens) {
    if (lowerPath.includes(token)) bonus += 0.08;
    else if (lowerContent.includes(token)) bonus += 0.025;
  }
  return Math.min(bonus, 0.22);
}

export function retrieveRelevantChunks(
  chunks: CodeChunk[],
  queryVector: number[],
  question: string,
  limit = 8
): Array<{ chunk: CodeChunk; semantic: number; combinedScore: number }> {
  return chunks
    .filter((c) => c.embedding && c.embedding.length > 0)
    .map((chunk) => {
      const semantic = cosineSimilarity(queryVector, chunk.embedding);
      const lexical = computeLexicalBonus(question, chunk);
      return {
        chunk,
        semantic,
        combinedScore: semantic + lexical,
      };
    })
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit);
}

function extractQueryTerms(question: string): string[] {
  const rawTokens = question.match(/[A-Za-z0-9_./-]+/g) ?? [];
  const terms = new Set<string>();

  for (const raw of rawTokens) {
    const cleaned = raw.replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, '');
    if (!cleaned) continue;

    const lower = cleaned.toLowerCase();
    if (lower.length >= 2 && !LEXICAL_STOP_WORDS.has(lower)) {
      terms.add(lower);
    }

    // Split camelCase / PascalCase / snake_case / path segments into sub-tokens
    const splitParts = cleaned
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length >= 2 && !LEXICAL_STOP_WORDS.has(p));

    for (const part of splitParts) {
      terms.add(part);
    }
  }

  return Array.from(terms);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
    if (count >= 12) break;
  }
  return count;
}

export interface LexicalRetrievalItem {
  chunk: CodeChunk;
  rawScore: number;
  normalizedScore: number;
  matchedTerms: string[];
}

export function retrieveLexicalChunks(
  chunks: CodeChunk[],
  question: string,
  limit = 8
): { items: LexicalRetrievalItem[]; queryTerms: string[] } {
  const queryTerms = extractQueryTerms(question);
  if (queryTerms.length === 0 || chunks.length === 0) {
    return { items: [], queryTerms };
  }

  const lowerDocs = chunks.map((chunk) => ({
    chunk,
    lowerPath: chunk.filePath.toLowerCase(),
    lowerContent: chunk.content.toLowerCase(),
  }));

  // Document frequency across chunks for IDF weighting
  const dfMap = new Map<string, number>();
  for (const term of queryTerms) {
    let df = 0;
    for (const doc of lowerDocs) {
      if (doc.lowerPath.includes(term) || doc.lowerContent.includes(term)) {
        df++;
      }
    }
    dfMap.set(term, df);
  }

  const totalDocs = chunks.length;
  const maxPossibleIdfSum = queryTerms.reduce((sum, term) => {
    const df = dfMap.get(term) ?? 0;
    const idf = Math.log(1 + (totalDocs + 1) / (df + 1));
    return sum + idf;
  }, 0);

  const scored: LexicalRetrievalItem[] = [];

  for (const { chunk, lowerPath, lowerContent } of lowerDocs) {
    const pathBase = lowerPath.split('/').pop() ?? lowerPath;
    const matchedTerms: string[] = [];
    let score = 0;
    let symbolOrPathMatch = false;

    for (const term of queryTerms) {
      const df = dfMap.get(term) ?? 0;
      if (df === 0) continue;

      const idf = Math.log(1 + (totalDocs + 1) / (df + 1));
      const inPath = lowerPath.includes(term);
      const exactFile = pathBase === term || pathBase.startsWith(`${term}.`);
      const contentHits = countOccurrences(lowerContent, term);

      if (!inPath && contentHits === 0) continue;
      matchedTerms.push(term);

      let termScore = 0;
      if (exactFile) {
        termScore += 3.2 * idf;
        symbolOrPathMatch = true;
      } else if (inPath) {
        termScore += 2.0 * idf;
        symbolOrPathMatch = true;
      }

      if (contentHits > 0) {
        // Word-boundary / symbol declaration boost
        const boundaryRx = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
        const symbolRx = new RegExp(
          `\\b(?:export|function|const|let|var|class|interface|type|def|async)\\s+[A-Za-z0-9_]*${escapeRegex(term)}`,
          'i'
        );
        const hasBoundary = boundaryRx.test(chunk.content);
        const hasSymbolDecl = symbolRx.test(chunk.content);
        if (hasSymbolDecl) {
          symbolOrPathMatch = true;
        }
        const tfWeight = 1 + Math.log(contentHits);
        const precisionBoost = hasSymbolDecl ? 1.85 : hasBoundary ? 1.35 : 0.75;
        termScore += tfWeight * precisionBoost * idf;
      }

      score += termScore;
    }

    if (matchedTerms.length === 0) continue;

    // Coverage multiplier rewards chunks matching more distinct query concepts
    const coverageRatio = matchedTerms.length / queryTerms.length;
    const coverageMultiplier = 0.65 + 0.75 * coverageRatio;
    // Slight tie-breaker for core source files over test specs
    const priorityFactor = 0.92 + chunkPriority(chunk.filePath) * 0.03;
    const rawScore = score * coverageMultiplier * priorityFactor;

    // Enforce sensible minimum relevance threshold:
    // - If the query has multiple distinct concepts and only 1 weak non-symbol hit matched, reject noise
    const passesThreshold =
      queryTerms.length === 1
        ? rawScore >= 1.1 || symbolOrPathMatch
        : matchedTerms.length >= 2
        ? rawScore >= 1.8
        : symbolOrPathMatch && rawScore >= 2.2;

    if (!passesThreshold) continue;

    const denom = Math.max(maxPossibleIdfSum * 3.5, 4);
    const normalizedScore = Math.max(0.15, Math.min(0.98, rawScore / denom));

    scored.push({
      chunk,
      rawScore,
      normalizedScore,
      matchedTerms,
    });
  }

  scored.sort(
    (a, b) =>
      b.rawScore - a.rawScore ||
      b.matchedTerms.length - a.matchedTerms.length ||
      chunkPriority(b.chunk.filePath) - chunkPriority(a.chunk.filePath)
  );

  return {
    items: scored.slice(0, limit),
    queryTerms,
  };
}

export interface RagQueryDeps {
  dataStore?: typeof store;
  embedQuery?: (question: string) => Promise<number[]>;
  generateGroundedAnswer?: (params: {
    prompt: string;
    systemInstruction: string;
  }) => Promise<{
    answer: string;
    insufficientEvidence: boolean;
    usedChunkIndices: number[];
    model?: string;
  }>;
}

export async function queryRepositoryRag(
  repo: RepositoryRecord,
  question: string,
  recentHistory: ChatMessage[],
  deps?: RagQueryDeps
): Promise<{
  answer: string;
  citations: Citation[];
  insufficientEvidence: boolean;
  model: string;
  embeddingsCount: number;
  chunkCount: number;
  embeddingsReady: boolean;
  retrievalMode: 'hybrid-vector' | 'lexical-fallback';
}> {
  const activeStore = deps?.dataStore ?? store;
  const usingCustomAi = Boolean(deps?.embedQuery && deps?.generateGroundedAnswer);

  if (!usingCustomAi && !isAiTextConfigured()) {
    throw new Error(
      'No AI text provider is configured on the server. Add GROQ_API_KEY (or GEMINI_API_KEY) to use the RAG assistant.'
    );
  }

  const chunks = await activeStore.getChunks(repo.id);
  if (chunks.length === 0) {
    throw new Error('No code chunks are indexed for this repository.');
  }

  const embeddedChunks = chunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0);
  const hasCompleteEmbeddings = embeddedChunks.length > 0 && embeddedChunks.length === chunks.length;

  type RetrievedEntry = {
    chunk: CodeChunk;
    score: number;
    scoreLabel: string;
  };

  let retrievalMode: 'hybrid-vector' | 'lexical-fallback' = 'lexical-fallback';
  let topK: RetrievedEntry[] = [];

  if (embeddedChunks.length > 0 && (deps?.embedQuery || isGeminiConfigured())) {
    try {
      const queryVector = deps?.embedQuery
        ? await deps.embedQuery(question)
        : (await embedTexts([question]))[0];

      const vectorResults = retrieveRelevantChunks(chunks, queryVector, question, 8);
      const bestSemantic = vectorResults[0]?.semantic ?? 0;

      if (vectorResults.length > 0 && (bestSemantic >= 0.18 || vectorResults[0].combinedScore >= 0.24)) {
        retrievalMode = 'hybrid-vector';
        topK = vectorResults.map((item) => ({
          chunk: item.chunk,
          score: item.semantic,
          scoreLabel: `similarity=${item.semantic.toFixed(3)}`,
        }));
      } else {
        retrievalMode = 'hybrid-vector';
        topK = [];
      }
    } catch (err) {
      // Never block chat if query embedding fails (e.g. Gemini quota exhausted); fall back to lexical retrieval
      console.warn(
        `[RepoMind RAG] Query embedding unavailable (${err instanceof Error ? err.message : String(err)}); using lexical retrieval fallback.`
      );
      retrievalMode = 'lexical-fallback';
    }
  }

  if (retrievalMode === 'lexical-fallback') {
    const lexical = retrieveLexicalChunks(chunks, question, 8);
    topK = lexical.items.map((item) => ({
      chunk: item.chunk,
      score: item.normalizedScore,
      scoreLabel: `lexicalScore=${item.normalizedScore.toFixed(3)} (matched: ${item.matchedTerms.join(', ')})`,
    }));
  }

  if (topK.length === 0) {
    const retrievalNote =
      retrievalMode === 'lexical-fallback'
        ? `Retrieved via lexical fallback across ${chunks.length} persisted chunks (vector embeddings are not generated: ${embeddedChunks.length}/${chunks.length}).`
        : `Checked ${chunks.length} embedded chunks via vector retrieval.`;

    return {
      answer:
        `The indexed files of **${repo.metadata.fullName}** (${repo.detectedFacts.ingestedFileCount} indexed of ${repo.detectedFacts.eligibleFileCount ?? repo.detectedFacts.ingestedFileCount} eligible files, ${chunks.length} code chunks) do not contain sufficient evidence to answer this question.\n\n` +
        `Note: ${retrievalNote} ${repo.detectedFacts.skippedFileCount > 0 ? `${repo.detectedFacts.skippedFileCount} files in the repository tree were skipped.` : 'All eligible files were checked.'}`,
      citations: [],
      insufficientEvidence: true,
      model: getPrimaryAiTextModel(),
      embeddingsCount: embeddedChunks.length,
      chunkCount: chunks.length,
      embeddingsReady: hasCompleteEmbeddings,
      retrievalMode,
    };
  }

  const contextBlocks = topK
    .map(
      (item, idx) =>
        `[CHUNK ${idx}] File: ${item.chunk.filePath} (lines ${item.chunk.startLine}-${item.chunk.endLine}) | retrieval=${retrievalMode} | ${item.scoreLabel}\n\`\`\`${item.chunk.language.toLowerCase()}\n${item.chunk.content}\n\`\`\``
    )
    .join('\n\n');

  const historyText = recentHistory
    .slice(-4)
    .map((m) => `${m.role === 'user' ? 'Developer' : 'RepoMind'}: ${m.content.slice(0, 600)}`)
    .join('\n');

  const prompt = `REPOSITORY: ${repo.metadata.fullName} (branch: ${repo.metadata.defaultBranch})
Ingested files: ${repo.detectedFacts.ingestedFileCount} of ${repo.detectedFacts.totalTreeFiles} total files.
Detected languages: ${repo.detectedFacts.languages.map((l) => l.language).join(', ')}
Retrieval mode: ${retrievalMode} (${embeddedChunks.length}/${chunks.length} vector embeddings available)

${historyText ? `RECENT CONVERSATION:\n${historyText}\n\n` : ''}RETRIEVED CODE CHUNKS:
${contextBlocks}

DEVELOPER QUESTION:
${question}`;

  const systemInstruction =
    'You are RepoMind, a strictly grounded codebase assistant. Answer the developer question using ONLY the retrieved code chunks and repository metadata provided. ' +
    'Every factual claim about the codebase MUST cite the exact file path and line range in Markdown code format like `path/to/file.ts:12-45`. ' +
    'NEVER assume, extrapolate, or invent files, functions, API routes, environment variables, or behavior not directly visible in the retrieved chunks. ' +
    'If the retrieved chunks do not contain sufficient evidence to answer part or all of the question, set insufficientEvidence=true, return usedChunkIndices=[], and explicitly state what is missing or not observed in the indexed code.';

  let result: {
    answer: string;
    insufficientEvidence: boolean;
    usedChunkIndices: number[];
  };
  let modelUsed = getPrimaryAiTextModel();

  if (deps?.generateGroundedAnswer) {
    const custom = await deps.generateGroundedAnswer({ prompt, systemInstruction });
    result = custom;
    if (custom.model) modelUsed = custom.model;
  } else {
    const aiRes = await generateAiStructuredJson<{
      answer: string;
      insufficientEvidence: boolean;
      usedChunkIndices: number[];
    }>({
      systemInstruction,
      prompt,
      thinkingLevel: ThinkingLevel.LOW,
      maxTokens: 4096,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          answer: {
            type: Type.STRING,
            description:
              'Clear Markdown answer citing exact filePath:startLine-endLine references from the retrieved chunks.',
          },
          insufficientEvidence: {
            type: Type.BOOLEAN,
            description:
              'True if the retrieved chunks do not provide enough evidence to reliably answer the question.',
          },
          usedChunkIndices: {
            type: Type.ARRAY,
            items: { type: Type.INTEGER },
            description: '0-based indices of the RETRIEVED CODE CHUNKS actually used to support the answer.',
          },
        },
        required: ['answer', 'insufficientEvidence', 'usedChunkIndices'],
      },
    });
    result = aiRes.data;
    modelUsed = aiRes.model;
  }

  const validIndices = Array.from(
    new Set(
      (result.usedChunkIndices ?? []).filter(
        (idx) => Number.isInteger(idx) && idx >= 0 && idx < topK.length
      )
    )
  );

  const selectedItems = result.insufficientEvidence
    ? validIndices.map((idx) => topK[idx])
    : validIndices.length > 0
    ? validIndices.map((idx) => topK[idx])
    : topK.slice(0, 3);

  const citations: Citation[] = selectedItems.map((item) => ({
    filePath: item.chunk.filePath,
    startLine: item.chunk.startLine,
    endLine: item.chunk.endLine,
    similarity: Math.round(item.score * 1000) / 1000,
    snippet: item.chunk.content.split('\n').slice(0, 12).join('\n'),
  }));

  return {
    answer: result.answer,
    citations,
    insufficientEvidence: Boolean(result.insufficientEvidence),
    model: modelUsed,
    embeddingsCount: embeddedChunks.length,
    chunkCount: chunks.length,
    embeddingsReady: hasCompleteEmbeddings,
    retrievalMode,
  };
}
