import { GoogleGenAI, ThinkingLevel } from '@google/genai';

export const GEMINI_TEXT_MODEL = 'gemini-4-hydrogen';
export const GEMINI_FALLBACK_TEXT_MODEL = 'gemini-3.1-flash-lite';
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2';

let cachedClient: GoogleGenAI | null = null;
let cachedKey: string | undefined;
let primaryOverloadedUntil = 0;

export function isGeminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY?.trim();
  return Boolean(key && key !== 'MY_GEMINI_API_KEY');
}

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add a valid key in Settings > Secrets to enable AI analysis, embeddings, and RAG.'
    );
  }
  if (!cachedClient || cachedKey !== apiKey) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    cachedKey = apiKey;
  }
  return cachedClient;
}

export type GeminiErrorCategory =
  | 'quota_exhausted'
  | 'rate_limit'
  | 'service_unavailable'
  | 'timeout'
  | 'auth_error'
  | 'other';

export class GeminiClassifiedError extends Error {
  readonly category: GeminiErrorCategory;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly userMessage: string;

  constructor(params: {
    category: GeminiErrorCategory;
    retryable: boolean;
    statusCode?: number;
    userMessage: string;
    causeMessage?: string;
  }) {
    super(params.userMessage);
    this.name = 'GeminiClassifiedError';
    this.category = params.category;
    this.retryable = params.retryable;
    this.statusCode = params.statusCode;
    this.userMessage = params.userMessage;
    if (params.causeMessage && params.causeMessage !== params.userMessage) {
      this.cause = params.causeMessage;
    }
  }
}

function extractErrorDetails(err: unknown): {
  rawMessage: string;
  statusCode?: number;
  combinedLower: string;
} {
  const rawMessage = err instanceof Error ? err.message : String(err);
  let statusCode: number | undefined;
  let extra = '';

  if (err && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    if (typeof record.status === 'number') statusCode = record.status;
    else if (typeof record.statusCode === 'number') statusCode = record.statusCode;
    else if (typeof record.code === 'number') statusCode = record.code;

    if (record.errorDetails !== undefined) {
      try {
        extra += ' ' + JSON.stringify(record.errorDetails);
      } catch {
        // Ignore unserializable errorDetails
      }
    }
    if (record.details !== undefined) {
      try {
        extra += ' ' + JSON.stringify(record.details);
      } catch {
        // Ignore unserializable details
      }
    }
  }

  if (statusCode === undefined) {
    const statusMatch = /\b(401|403|429|500|502|503|504)\b/.exec(rawMessage);
    if (statusMatch) {
      statusCode = Number(statusMatch[1]);
    }
  }

  return {
    rawMessage,
    statusCode,
    combinedLower: `${rawMessage} ${extra}`.toLowerCase(),
  };
}

export function classifyGeminiError(err: unknown): GeminiClassifiedError {
  if (err instanceof GeminiClassifiedError) return err;

  const { rawMessage, statusCode, combinedLower } = extractErrorDetails(err);

  // 1. Authentication / permission failure (non-retryable, no failover)
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    combinedLower.includes('api_key_invalid') ||
    combinedLower.includes('api key not valid') ||
    combinedLower.includes('permission_denied') ||
    combinedLower.includes('not configured')
  ) {
    return new GeminiClassifiedError({
      category: 'auth_error',
      retryable: false,
      statusCode: statusCode ?? 401,
      userMessage:
        'Gemini API key is invalid, missing, or lacks permission. Please verify GEMINI_API_KEY in Settings > Secrets.',
      causeMessage: rawMessage,
    });
  }

  // 2. Hard Quota Exhaustion vs 3. Temporary Rate Limit (429 / RESOURCE_EXHAUSTED)
  const is429OrExhausted =
    statusCode === 429 ||
    combinedLower.includes('resource_exhausted') ||
    combinedLower.includes('429');

  const hasHardQuotaSignals =
    combinedLower.includes('exceeded your current quota') ||
    combinedLower.includes('check your plan and billing') ||
    combinedLower.includes('quotafailure') ||
    combinedLower.includes('quota_limit') ||
    combinedLower.includes('quotametric') ||
    combinedLower.includes('quotaid') ||
    combinedLower.includes('limit: 0') ||
    combinedLower.includes('limit:0') ||
    combinedLower.includes('perday') ||
    combinedLower.includes('per_day') ||
    combinedLower.includes('daily limit') ||
    combinedLower.includes('insufficient quota') ||
    combinedLower.includes('billing') ||
    (combinedLower.includes('quota') &&
      !combinedLower.includes('requestsperminute') &&
      !combinedLower.includes('tokensperminute') &&
      !combinedLower.includes('rate limit'));

  if (is429OrExhausted && hasHardQuotaSignals) {
    return new GeminiClassifiedError({
      category: 'quota_exhausted',
      retryable: false,
      statusCode: 429,
      userMessage:
        'Gemini API quota is exhausted (429 RESOURCE_EXHAUSTED). Retries and model failover were stopped immediately; completed files, chunks, and checkpoints remain saved and can be resumed once quota recovers.',
      causeMessage: rawMessage,
    });
  }

  if (is429OrExhausted || combinedLower.includes('rate limit') || combinedLower.includes('too many requests')) {
    return new GeminiClassifiedError({
      category: 'rate_limit',
      retryable: true,
      statusCode: 429,
      userMessage:
        'Gemini API temporary rate limit reached (429). Retrying briefly with bounded backoff.',
      causeMessage: rawMessage,
    });
  }

  // 4. Service Unavailable / transient 5xx
  if (
    statusCode === 503 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 504 ||
    combinedLower.includes('unavailable') ||
    combinedLower.includes('high demand') ||
    combinedLower.includes('overloaded') ||
    combinedLower.includes('service unavailable')
  ) {
    return new GeminiClassifiedError({
      category: 'service_unavailable',
      retryable: true,
      statusCode: statusCode ?? 503,
      userMessage:
        'Gemini service is temporarily unavailable (503 UNAVAILABLE). Please retry pending batches.',
      causeMessage: rawMessage,
    });
  }

  // 5. Network timeout / transient transport failures
  if (
    combinedLower.includes('timed out') ||
    combinedLower.includes('etimedout') ||
    combinedLower.includes('econnreset') ||
    combinedLower.includes('fetch failed') ||
    combinedLower.includes('network')
  ) {
    return new GeminiClassifiedError({
      category: 'timeout',
      retryable: true,
      userMessage: `Gemini network request timed out or failed transiently (${rawMessage.slice(0, 120)}).`,
      causeMessage: rawMessage,
    });
  }

  // Transient embedding count/shape anomalies
  if (
    combinedLower.includes('embedding count mismatch') ||
    combinedLower.includes('received empty embedding') ||
    combinedLower.includes('received empty or invalid embedding')
  ) {
    return new GeminiClassifiedError({
      category: 'other',
      retryable: true,
      userMessage: rawMessage,
      causeMessage: rawMessage,
    });
  }

  return new GeminiClassifiedError({
    category: 'other',
    retryable: false,
    statusCode,
    userMessage: rawMessage,
    causeMessage: rawMessage,
  });
}

function parseRetryDelayMs(msg: string): number | null {
  const secMatch = /retry(?:\s+in|Delay"?\s*:\s*"?)(\d+(?:\.\d+)?)s/i.exec(msg);
  if (secMatch) {
    const secs = Number(secMatch[1]);
    if (Number.isFinite(secs) && secs > 0) {
      return Math.min(Math.ceil(secs * 1000) + 500, 65_000);
    }
  }
  return null;
}

export interface RetryOptions {
  maxRetries?: number;
  maxRetryDelayMs?: number;
  timeoutMs?: number;
  allowFallback?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Gemini request timed out after ${Math.round(timeoutMs / 1000)}s (${label}).`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function shouldFailoverToAlternateModel(classified: GeminiClassifiedError): boolean {
  // NEVER fail over to another model when quota is exhausted or auth failed (shared project quota)
  if (classified.category === 'quota_exhausted' || classified.category === 'auth_error') {
    return false;
  }
  return (
    classified.category === 'service_unavailable' ||
    classified.category === 'timeout' ||
    classified.category === 'rate_limit'
  );
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: number | RetryOptions = 3
): Promise<T> {
  const opts: RetryOptions =
    typeof options === 'number' ? { maxRetries: options } : options;
  const maxRetries = opts.maxRetries ?? 3;
  const maxRetryDelayMs = opts.maxRetryDelayMs ?? 15_000;
  let lastClassified: GeminiClassifiedError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const classified = classifyGeminiError(err);
      lastClassified = classified;

      // Immediately abort without any retry on confirmed quota exhaustion, auth error, or non-retryable failure
      if (!classified.retryable || attempt === maxRetries) {
        throw classified;
      }

      // Bound temporary rate-limit retries tightly (at most 2 retries)
      if (classified.category === 'rate_limit' && attempt >= Math.min(maxRetries, 2)) {
        throw classified;
      }

      const rawCause =
        typeof classified.cause === 'string' ? classified.cause : classified.message;
      const hintedMs = parseRetryDelayMs(rawCause);
      const rawBackoff =
        classified.category === 'rate_limit'
          ? hintedMs ?? Math.min(2500 * Math.pow(2, attempt), maxRetryDelayMs)
          : 1200 * Math.pow(2, attempt);
      const backoffMs = Math.min(rawBackoff, maxRetryDelayMs);

      console.warn(
        `[RepoMind Gemini] ${classified.category} on attempt ${attempt + 1}/${maxRetries + 1}; waiting ${backoffMs}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw lastClassified ?? new Error('Gemini request failed after retries.');
}

export function formatGeminiError(err: unknown): string {
  return classifyGeminiError(err).userMessage;
}

export async function generateStructuredJson<T>(params: {
  systemInstruction: string;
  prompt: string;
  responseSchema: Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
  retryOptions?: RetryOptions;
}): Promise<T> {
  const ai = getGeminiClient();
  const timeoutMs = params.retryOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowFallback = params.retryOptions?.allowFallback !== false;

  const invokeWithModel = async (model: string, retryOpts: RetryOptions): Promise<T> => {
    const safeThinking =
      model === GEMINI_FALLBACK_TEXT_MODEL && params.thinkingLevel === ThinkingLevel.XHIGH
        ? ThinkingLevel.HIGH
        : params.thinkingLevel ?? ThinkingLevel.LOW;
    const response = await withRetry(
      () =>
        withTimeout(
          ai.models.generateContent({
            model,
            contents: params.prompt,
            config: {
              systemInstruction: params.systemInstruction,
              responseMimeType: 'application/json',
              responseSchema: params.responseSchema,
              thinkingConfig: {
                thinkingLevel: safeThinking,
              },
            },
          }),
          timeoutMs,
          model
        ),
      retryOpts
    );

    const text = response.text?.trim();
    if (!text) {
      throw new Error(`Gemini (${model}) returned an empty response.`);
    }
    return JSON.parse(text) as T;
  };

  if (allowFallback && Date.now() < primaryOverloadedUntil) {
    return await invokeWithModel(GEMINI_FALLBACK_TEXT_MODEL, {
      maxRetries: 1,
      maxRetryDelayMs: 10_000,
      timeoutMs: Math.max(timeoutMs, 35_000),
    });
  }

  try {
    return await invokeWithModel(
      GEMINI_TEXT_MODEL,
      params.retryOptions ?? { maxRetries: 1, maxRetryDelayMs: 8_000 }
    );
  } catch (err) {
    const classified = classifyGeminiError(err);
    if (allowFallback && shouldFailoverToAlternateModel(classified)) {
      primaryOverloadedUntil = Date.now() + 120_000;
      console.warn(
        `[RepoMind Gemini] ${GEMINI_TEXT_MODEL} ${classified.category}; failing over to ${GEMINI_FALLBACK_TEXT_MODEL} for 120s.`
      );
      return await invokeWithModel(GEMINI_FALLBACK_TEXT_MODEL, {
        maxRetries: 1,
        maxRetryDelayMs: 10_000,
        timeoutMs: Math.max(timeoutMs, 35_000),
      });
    }
    throw classified;
  }
}

export async function generateText(params: {
  systemInstruction: string;
  prompt: string;
  thinkingLevel?: ThinkingLevel;
  retryOptions?: RetryOptions;
}): Promise<string> {
  const ai = getGeminiClient();
  const timeoutMs = params.retryOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowFallback = params.retryOptions?.allowFallback !== false;

  const invokeWithModel = async (model: string, retryOpts: RetryOptions): Promise<string> => {
    const safeThinking =
      model === GEMINI_FALLBACK_TEXT_MODEL && params.thinkingLevel === ThinkingLevel.XHIGH
        ? ThinkingLevel.HIGH
        : params.thinkingLevel ?? ThinkingLevel.MEDIUM;
    const response = await withRetry(
      () =>
        withTimeout(
          ai.models.generateContent({
            model,
            contents: params.prompt,
            config: {
              systemInstruction: params.systemInstruction,
              thinkingConfig: {
                thinkingLevel: safeThinking,
              },
            },
          }),
          timeoutMs,
          model
        ),
      retryOpts
    );

    const text = response.text?.trim();
    if (!text) {
      throw new Error(`Gemini (${model}) returned an empty response.`);
    }
    return text;
  };

  if (allowFallback && Date.now() < primaryOverloadedUntil) {
    return await invokeWithModel(GEMINI_FALLBACK_TEXT_MODEL, {
      maxRetries: 1,
      maxRetryDelayMs: 10_000,
      timeoutMs: Math.max(timeoutMs, 35_000),
    });
  }

  try {
    return await invokeWithModel(
      GEMINI_TEXT_MODEL,
      params.retryOptions ?? { maxRetries: 1, maxRetryDelayMs: 8_000 }
    );
  } catch (err) {
    const classified = classifyGeminiError(err);
    if (allowFallback && shouldFailoverToAlternateModel(classified)) {
      primaryOverloadedUntil = Date.now() + 120_000;
      console.warn(
        `[RepoMind Gemini] ${GEMINI_TEXT_MODEL} ${classified.category}; failing over to ${GEMINI_FALLBACK_TEXT_MODEL} for 120s.`
      );
      return await invokeWithModel(GEMINI_FALLBACK_TEXT_MODEL, {
        maxRetries: 1,
        maxRetryDelayMs: 10_000,
        timeoutMs: Math.max(timeoutMs, 35_000),
      });
    }
    throw classified;
  }
}

export async function embedBatch(
  batch: string[],
  retryOptions: RetryOptions = { maxRetries: 2, maxRetryDelayMs: 10_000, timeoutMs: 30_000 }
): Promise<number[][]> {
  if (batch.length === 0) return [];
  const ai = getGeminiClient();
  const timeoutMs = retryOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const contentObjects = batch.map((text) => ({
    role: 'user',
    parts: [{ text }],
  }));

  return withRetry(async () => {
    const result = await withTimeout(
      ai.models.embedContent({
        model: GEMINI_EMBEDDING_MODEL,
        contents: contentObjects,
        config: {
          outputDimensionality: 768,
        },
      }),
      timeoutMs,
      GEMINI_EMBEDDING_MODEL
    );

    const embeddings = result.embeddings ?? [];
    if (embeddings.length !== batch.length) {
      throw new Error(
        `Embedding count mismatch: expected ${batch.length}, received ${embeddings.length}`
      );
    }

    return embeddings.map((emb, idx) => {
      if (
        !emb.values ||
        emb.values.length === 0 ||
        !emb.values.every((v) => typeof v === 'number' && Number.isFinite(v))
      ) {
        throw new Error(`Received empty or invalid embedding vector at batch index ${idx}.`);
      }
      return emb.values;
    });
  }, retryOptions);
}

export async function embedTexts(
  texts: string[],
  onBatchComplete?: (embeddedCount: number, totalCount: number) => void
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const batchSize = 20;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    const batch = texts.slice(i, i + batchSize);
    const batchVectors = await embedBatch(batch);
    allEmbeddings.push(...batchVectors);
    onBatchComplete?.(allEmbeddings.length, texts.length);
  }

  if (allEmbeddings.length !== texts.length) {
    throw new Error(
      `Total embedding count mismatch: expected ${texts.length}, received ${allEmbeddings.length}`
    );
  }

  return allEmbeddings;
}
