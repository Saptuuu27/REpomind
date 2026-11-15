import type { ThinkingLevel } from '@google/genai';
import {
  classifyGeminiError,
  GEMINI_TEXT_MODEL,
  generateStructuredJson as generateGeminiStructuredJson,
  generateText as generateGeminiText,
  isGeminiConfigured,
} from './gemini.ts';

export const GROQ_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
export const GROQ_TEXT_MODEL = 'openai/gpt-oss-120b';

export type AiProviderName = 'groq' | 'gemini';

export type AiErrorCategory =
  | 'quota_exhausted'
  | 'rate_limit'
  | 'service_unavailable'
  | 'timeout'
  | 'auth_error'
  | 'invalid_response'
  | 'other';

export interface AiRetryOptions {
  maxRetries?: number;
  maxRetryDelayMs?: number;
  timeoutMs?: number;
  allowFallback?: boolean;
}

export class AiProviderError extends Error {
  readonly provider: AiProviderName;
  readonly category: AiErrorCategory;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly userMessage: string;

  constructor(params: {
    provider: AiProviderName;
    category: AiErrorCategory;
    retryable: boolean;
    statusCode?: number;
    userMessage: string;
    causeMessage?: string;
  }) {
    super(params.userMessage);
    this.name = 'AiProviderError';
    this.provider = params.provider;
    this.category = params.category;
    this.retryable = params.retryable;
    this.statusCode = params.statusCode;
    this.userMessage = params.userMessage;
    if (params.causeMessage && params.causeMessage !== params.userMessage) {
      this.cause = params.causeMessage;
    }
  }
}

const GEMINI_QUOTA_COOLDOWN_MS = 15 * 60 * 1000;
const GROQ_HARD_QUOTA_COOLDOWN_MS = 15 * 60 * 1000;
const GROQ_DEFAULT_RATE_COOLDOWN_MS = 60 * 1000;
let geminiQuotaExhaustedUntil = 0;
let groqCooldownUntil = 0;

export function isGeminiQuotaCooldownActive(): boolean {
  return Date.now() < geminiQuotaExhaustedUntil;
}

export function markGeminiQuotaExhausted(): void {
  geminiQuotaExhaustedUntil = Date.now() + GEMINI_QUOTA_COOLDOWN_MS;
}

export function isGroqCooldownActive(): boolean {
  return Date.now() < groqCooldownUntil;
}

export function markGroqCooldown(durationMs?: number | null): void {
  const boundedMs =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
      ? Math.min(Math.max(durationMs, 15_000), GROQ_HARD_QUOTA_COOLDOWN_MS)
      : GROQ_DEFAULT_RATE_COOLDOWN_MS;
  groqCooldownUntil = Math.max(groqCooldownUntil, Date.now() + boundedMs);
}

export function getGroqBaseUrl(): string {
  const configured = process.env.GROQ_BASE_URL?.trim();
  const base = configured || GROQ_DEFAULT_BASE_URL;
  return base.replace(/\/+$/, '');
}

export function getGroqModel(): string {
  return process.env.GROQ_MODEL?.trim() || GROQ_TEXT_MODEL;
}

export function isGroqConfigured(): boolean {
  const key = process.env.GROQ_API_KEY?.trim();
  return Boolean(key && key !== 'MY_GROQ_API_KEY');
}

export function isAiTextConfigured(): boolean {
  return isGroqConfigured() || isGeminiConfigured();
}

export function getPrimaryAiTextModel(): string {
  return isGroqConfigured() ? getGroqModel() : GEMINI_TEXT_MODEL;
}

export function sanitizeAiErrorText(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/\bgsk_[A-Za-z0-9_-]+/g, 'gsk_***')
    .replace(/\bAIza[A-Za-z0-9_-]{16,}/g, 'AIza***');
}

function parseRetryAfterMs(retryAfterHeader: string | null): number | null {
  if (!retryAfterHeader) return null;
  const trimmed = retryAfterHeader.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

function parseBodyRetryDelayMs(cleanBody: string): number | null {
  const minSecMatch = /try again in\s+(?:(\d+)m)?(\d+(?:\.\d+)?)s/i.exec(cleanBody);
  if (minSecMatch) {
    const mins = minSecMatch[1] ? Number(minSecMatch[1]) : 0;
    const secs = Number(minSecMatch[2]);
    if (Number.isFinite(mins) && Number.isFinite(secs)) {
      return Math.ceil((mins * 60 + secs) * 1000);
    }
  }
  const minOnlyMatch = /try again in\s+(\d+(?:\.\d+)?)m\b/i.exec(cleanBody);
  if (minOnlyMatch) {
    const mins = Number(minOnlyMatch[1]);
    if (Number.isFinite(mins)) {
      return Math.ceil(mins * 60 * 1000);
    }
  }
  return null;
}

function classifyGroqHttpError(
  status: number,
  rawBody: string,
  retryAfterHeader: string | null
): { error: AiProviderError; retryAfterMs: number | null; isDailyOrBillingQuota: boolean } {
  const cleanBody = sanitizeAiErrorText(rawBody).slice(0, 500);
  const lower = cleanBody.toLowerCase();
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader) ?? parseBodyRetryDelayMs(cleanBody);

  if (
    status === 401 ||
    status === 403 ||
    lower.includes('invalid api key') ||
    lower.includes('invalid_api_key') ||
    lower.includes('unauthorized') ||
    lower.includes('authentication')
  ) {
    return {
      retryAfterMs: null,
      isDailyOrBillingQuota: false,
      error: new AiProviderError({
        provider: 'groq',
        category: 'auth_error',
        retryable: false,
        statusCode: status,
        userMessage:
          'Groq API authentication failed (HTTP ' +
          status +
          '). Verify GROQ_API_KEY in server environment secrets.',
        causeMessage: cleanBody,
      }),
    };
  }

  if (status === 429) {
    const isDailyOrBillingQuota =
      lower.includes('insufficient_quota') ||
      lower.includes('billing') ||
      lower.includes('spend limit') ||
      lower.includes('daily limit') ||
      lower.includes('limit reached for the day') ||
      lower.includes('tokens per day') ||
      lower.includes('requests per day');

    const isHardQuota =
      isDailyOrBillingQuota || (retryAfterMs !== null && retryAfterMs > 12_000);

    if (isHardQuota) {
      return {
        retryAfterMs,
        isDailyOrBillingQuota,
        error: new AiProviderError({
          provider: 'groq',
          category: 'quota_exhausted',
          retryable: false,
          statusCode: 429,
          userMessage:
            'Groq API quota or rate limit window exhausted (429). Routing cleanly to fallback or pausing retries.',
          causeMessage: cleanBody,
        }),
      };
    }

    return {
      retryAfterMs,
      isDailyOrBillingQuota: false,
      error: new AiProviderError({
        provider: 'groq',
        category: 'rate_limit',
        retryable: true,
        statusCode: 429,
        userMessage:
          'Groq API rate limit reached (429). Please retry shortly.',
        causeMessage: cleanBody,
      }),
    };
  }

  if (status >= 500) {
    return {
      retryAfterMs,
      isDailyOrBillingQuota: false,
      error: new AiProviderError({
        provider: 'groq',
        category: 'service_unavailable',
        retryable: true,
        statusCode: status,
        userMessage: `Groq service returned HTTP ${status}.`,
        causeMessage: cleanBody,
      }),
    };
  }

  return {
    retryAfterMs: null,
    isDailyOrBillingQuota: false,
    error: new AiProviderError({
      provider: 'groq',
      category: 'other',
      retryable: false,
      statusCode: status,
      userMessage: `Groq API request failed (HTTP ${status}): ${cleanBody || 'Unexpected error'}`,
      causeMessage: cleanBody,
    }),
  };
}



export function classifyAiError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) return err;

  const geminiClassified = classifyGeminiError(err);
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'GeminiClassifiedError') {
    if (geminiClassified.category === 'quota_exhausted') {
      markGeminiQuotaExhausted();
    }
    return new AiProviderError({
      provider: 'gemini',
      category: geminiClassified.category,
      retryable: geminiClassified.retryable,
      statusCode: geminiClassified.statusCode,
      userMessage: sanitizeAiErrorText(geminiClassified.userMessage),
      causeMessage:
        typeof geminiClassified.cause === 'string'
          ? sanitizeAiErrorText(geminiClassified.cause)
          : undefined,
    });
  }

  const rawMsg = sanitizeAiErrorText(err instanceof Error ? err.message : String(err));
  const lower = rawMsg.toLowerCase();

  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('abort')) {
    return new AiProviderError({
      provider: 'groq',
      category: 'timeout',
      retryable: true,
      userMessage: `AI request timed out (${rawMsg.slice(0, 140)}).`,
      causeMessage: rawMsg,
    });
  }

  if (
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed') ||
    lower.includes('network')
  ) {
    return new AiProviderError({
      provider: 'groq',
      category: 'service_unavailable',
      retryable: true,
      userMessage: `AI network request failed transiently (${rawMsg.slice(0, 140)}).`,
      causeMessage: rawMsg,
    });
  }

  if (geminiClassified.category !== 'other') {
    if (geminiClassified.category === 'quota_exhausted') {
      markGeminiQuotaExhausted();
    }
    return new AiProviderError({
      provider: isGroqConfigured() ? 'groq' : 'gemini',
      category: geminiClassified.category,
      retryable: geminiClassified.retryable,
      statusCode: geminiClassified.statusCode,
      userMessage: sanitizeAiErrorText(geminiClassified.userMessage),
      causeMessage: rawMsg,
    });
  }

  return new AiProviderError({
    provider: isGroqConfigured() ? 'groq' : 'gemini',
    category: 'other',
    retryable: false,
    userMessage: rawMsg,
    causeMessage: rawMsg,
  });
}

export function formatAiError(err: unknown): string {
  return classifyAiError(err).userMessage;
}

interface GroqChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }> | null;
      reasoning?: string;
    };
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

function extractAssistantText(payload: GroqChatCompletionResponse): string {
  const choice = payload.choices?.[0];
  const rawContent = choice?.message?.content;

  let text = '';
  if (typeof rawContent === 'string') {
    text = rawContent;
  } else if (Array.isArray(rawContent)) {
    text = rawContent
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }

  const trimmed = text.trim();
  if (!trimmed) {
    const reason = choice?.finish_reason ?? 'unknown';
    throw new AiProviderError({
      provider: 'groq',
      category: 'invalid_response',
      retryable: reason === 'length',
      userMessage: `Groq returned empty assistant content (finish_reason=${reason}).`,
    });
  }

  return trimmed;
}

async function callGroqChatCompletion(params: {
  systemInstruction: string;
  prompt: string;
  maxTokens: number;
  jsonMode?: boolean;
  temperature?: number;
  retryOptions?: AiRetryOptions;
}): Promise<{ text: string; model: string }> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GROQ_API_KEY') {
    throw new AiProviderError({
      provider: 'groq',
      category: 'auth_error',
      retryable: false,
      statusCode: 401,
      userMessage: 'GROQ_API_KEY is not configured on the server.',
    });
  }

  const baseUrl = getGroqBaseUrl();
  const model = getGroqModel();
  const maxRetries = Math.min(params.retryOptions?.maxRetries ?? 2, 3);
  const maxRetryDelayMs = Math.min(params.retryOptions?.maxRetryDelayMs ?? 8_000, 10_000);
  const timeoutMs = params.retryOptions?.timeoutMs ?? 40_000;

  let lastError: AiProviderError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const bodyPayload: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: params.systemInstruction },
          { role: 'user', content: params.prompt },
        ],
        temperature: params.temperature ?? 0.1,
        max_tokens: params.maxTokens,
      };

      if (params.jsonMode) {
        bodyPayload.response_format = { type: 'json_object' };
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const rawErrBody = await res.text().catch(() => '');
        const { error, retryAfterMs, isDailyOrBillingQuota } = classifyGroqHttpError(
          res.status,
          rawErrBody,
          res.headers.get('retry-after')
        );
        lastError = error;

        if (error.category === 'quota_exhausted') {
          markGroqCooldown(
            isDailyOrBillingQuota
              ? GROQ_HARD_QUOTA_COOLDOWN_MS
              : retryAfterMs ?? GROQ_DEFAULT_RATE_COOLDOWN_MS
          );
        }

        if (!error.retryable || attempt === maxRetries) {
          if (error.category === 'rate_limit') {
            markGroqCooldown(retryAfterMs ?? 30_000);
          }
          throw error;
        }

        // For 429 rate limits, allow at most 1 bounded retry respecting Retry-After
        if (error.category === 'rate_limit') {
          if (attempt >= 1) {
            markGroqCooldown(retryAfterMs ?? 30_000);
            throw error;
          }
          const delayMs = Math.min(retryAfterMs ?? 2_000, maxRetryDelayMs);
          console.info(
            `[RepoMind AI] Groq 429 rate limit on attempt ${attempt + 1}/${maxRetries + 1}; waiting ${delayMs}ms`
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        const backoffMs = Math.min(1_000 * Math.pow(2, attempt), maxRetryDelayMs);
        console.info(
          `[RepoMind AI] Groq ${error.category} on attempt ${attempt + 1}/${maxRetries + 1}; retrying in ${backoffMs}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      const data = (await res.json()) as GroqChatCompletionResponse;
      const text = extractAssistantText(data);
      return {
        text,
        model: data.model || model,
      };
    } catch (err) {
      if (err instanceof AiProviderError) {
        lastError = err;
        if (!err.retryable || attempt === maxRetries) {
          throw err;
        }
        const backoffMs = Math.min(1_000 * Math.pow(2, attempt), maxRetryDelayMs);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      const isAbort = err instanceof Error && err.name === 'AbortError';
      const classified = isAbort
        ? new AiProviderError({
            provider: 'groq',
            category: 'timeout',
            retryable: true,
            userMessage: `Groq request timed out after ${Math.round(timeoutMs / 1000)}s.`,
          })
        : classifyAiError(err);

      lastError = classified;
      if (!classified.retryable || attempt === maxRetries) {
        throw classified;
      }

      const backoffMs = Math.min(1_000 * Math.pow(2, attempt), maxRetryDelayMs);
      console.info(
        `[RepoMind AI] Groq ${classified.category} on attempt ${attempt + 1}/${maxRetries + 1}; retrying in ${backoffMs}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    } finally {
      clearTimeout(timer);
    }
  }

  throw (
    lastError ??
    new AiProviderError({
      provider: 'groq',
      category: 'other',
      retryable: false,
      userMessage: 'Groq request failed after bounded retries.',
    })
  );
}

export function geminiSchemaToJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const typeMap: Record<string, string> = {
    OBJECT: 'object',
    ARRAY: 'array',
    STRING: 'string',
    NUMBER: 'number',
    INTEGER: 'integer',
    BOOLEAN: 'boolean',
    NULL: 'null',
  };

  const out: Record<string, unknown> = {};

  if (typeof schema.type === 'string') {
    out.type = typeMap[schema.type.toUpperCase()] ?? schema.type.toLowerCase();
  }
  if (typeof schema.description === 'string') {
    out.description = schema.description;
  }
  if (Array.isArray(schema.enum)) {
    out.enum = schema.enum;
  }
  if (Array.isArray(schema.required)) {
    out.required = schema.required;
  }
  if (schema.items && typeof schema.items === 'object') {
    out.items = geminiSchemaToJsonSchema(schema.items as Record<string, unknown>);
  }
  if (schema.properties && typeof schema.properties === 'object') {
    const propsOut: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(schema.properties as Record<string, unknown>)) {
      if (val && typeof val === 'object') {
        propsOut[key] = geminiSchemaToJsonSchema(val as Record<string, unknown>);
      }
    }
    out.properties = propsOut;
  }

  return out;
}

function parseJsonResponse<T>(rawText: string, schema?: Record<string, unknown>): T {
  let cleaned = rawText.trim();

  // Strip optional markdown code fences if the model wrapped JSON
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(cleaned);
  if (fenced) {
    cleaned = fenced[1].trim();
  } else {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace && (firstBrace > 0 || lastBrace < cleaned.length - 1)) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new AiProviderError({
      provider: 'groq',
      category: 'invalid_response',
      retryable: true,
      userMessage: `Model returned invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`,
    });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AiProviderError({
      provider: 'groq',
      category: 'invalid_response',
      retryable: true,
      userMessage: 'Model JSON response was not a JSON object.',
    });
  }

  if (schema && Array.isArray(schema.required)) {
    const obj = parsed as Record<string, unknown>;
    const missing = schema.required.filter(
      (k): k is string => typeof k === 'string' && !(k in obj)
    );
    if (missing.length > 0) {
      throw new AiProviderError({
        provider: 'groq',
        category: 'invalid_response',
        retryable: true,
        userMessage: `Model JSON response omitted required field(s): ${missing.join(', ')}`,
      });
    }
  }

  return parsed as T;
}

function canUseGeminiFallback(allowFallback?: boolean): boolean {
  return allowFallback !== false && isGeminiConfigured() && !isGeminiQuotaCooldownActive();
}

export async function generateAiText(params: {
  systemInstruction: string;
  prompt: string;
  thinkingLevel?: ThinkingLevel;
  maxTokens?: number;
  retryOptions?: AiRetryOptions;
}): Promise<{ text: string; model: string; provider: AiProviderName }> {
  const allowFallback = params.retryOptions?.allowFallback !== false;

  if (isGroqConfigured() && !(isGroqCooldownActive() && canUseGeminiFallback(allowFallback))) {
    try {
      const res = await callGroqChatCompletion({
        systemInstruction: params.systemInstruction,
        prompt: params.prompt,
        // Generous completion budget so reasoning models (openai/gpt-oss-120b) emit full content
        maxTokens: Math.max(params.maxTokens ?? 4096, 1024),
        jsonMode: false,
        temperature: 0.15,
        retryOptions: params.retryOptions,
      });
      return { text: res.text, model: res.model, provider: 'groq' };
    } catch (groqErr) {
      const classified = classifyAiError(groqErr);
      const shouldFallback =
        classified.category !== 'auth_error' && canUseGeminiFallback(allowFallback);

      if (!shouldFallback) {
        throw classified;
      }

      console.info(
        `[RepoMind AI] Routing text generation to Gemini fallback (${classified.category}).`
      );
      try {
        const text = await generateGeminiText({
          systemInstruction: params.systemInstruction,
          prompt: params.prompt,
          thinkingLevel: params.thinkingLevel,
          retryOptions: {
            maxRetries: 0,
            timeoutMs: params.retryOptions?.timeoutMs ?? 30_000,
            allowFallback: false,
          },
        });
        return { text, model: GEMINI_TEXT_MODEL, provider: 'gemini' };
      } catch (geminiErr) {
        const gemClassified = classifyGeminiError(geminiErr);
        if (gemClassified.category === 'quota_exhausted') {
          markGeminiQuotaExhausted();
        }
        console.warn(
          `[RepoMind AI] Gemini fallback failed after Groq ${classified.category}: ${gemClassified.userMessage}`
        );
        throw classified;
      }
    }
  }

  if (isGeminiConfigured() && !isGeminiQuotaCooldownActive()) {
    try {
      const text = await generateGeminiText({
        systemInstruction: params.systemInstruction,
        prompt: params.prompt,
        thinkingLevel: params.thinkingLevel,
        retryOptions: {
          maxRetries: params.retryOptions?.maxRetries ?? 1,
          maxRetryDelayMs: params.retryOptions?.maxRetryDelayMs ?? 8_000,
          timeoutMs: params.retryOptions?.timeoutMs ?? 30_000,
          allowFallback,
        },
      });
      return { text, model: GEMINI_TEXT_MODEL, provider: 'gemini' };
    } catch (geminiErr) {
      const gemClassified = classifyGeminiError(geminiErr);
      if (gemClassified.category === 'quota_exhausted') {
        markGeminiQuotaExhausted();
      }
      throw classifyAiError(geminiErr);
    }
  }

  throw new AiProviderError({
    provider: 'groq',
    category: isGeminiQuotaCooldownActive() ? 'quota_exhausted' : 'auth_error',
    retryable: false,
    userMessage: isGeminiQuotaCooldownActive()
      ? 'No AI text provider is available (GROQ_API_KEY missing and Gemini quota is exhausted).'
      : 'No AI text provider is configured. Set GROQ_API_KEY or GEMINI_API_KEY in server secrets.',
  });
}

export async function generateAiStructuredJson<T>(params: {
  systemInstruction: string;
  prompt: string;
  responseSchema: Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
  maxTokens?: number;
  retryOptions?: AiRetryOptions;
}): Promise<{ data: T; model: string; provider: AiProviderName }> {
  const allowFallback = params.retryOptions?.allowFallback !== false;

  if (isGroqConfigured() && !(isGroqCooldownActive() && canUseGeminiFallback(allowFallback))) {
    const jsonSchema = geminiSchemaToJsonSchema(params.responseSchema);
    const schemaInstruction =
      `${params.systemInstruction}\n\n` +
      `OUTPUT FORMAT REQUIREMENT:\n` +
      `Respond ONLY with a single valid JSON object (no markdown fences, no commentary) conforming strictly to this JSON Schema:\n` +
      `${JSON.stringify(jsonSchema)}`;

    const maxAttempts = Math.min(params.retryOptions?.maxRetries ?? 1, 2) + 1;
    let lastError: AiProviderError | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await callGroqChatCompletion({
          systemInstruction: schemaInstruction,
          prompt: params.prompt,
          maxTokens: Math.max(params.maxTokens ?? 6144, 2048),
          jsonMode: true,
          temperature: 0.05,
          retryOptions: {
            ...params.retryOptions,
            // HTTP-level retries are already bounded inside callGroqChatCompletion
            maxRetries: attempt === 0 ? params.retryOptions?.maxRetries ?? 1 : 0,
          },
        });
        const data = parseJsonResponse<T>(res.text, jsonSchema);
        return { data, model: res.model, provider: 'groq' };
      } catch (err) {
        const classified = classifyAiError(err);
        lastError = classified;
        if (classified.category === 'invalid_response' && attempt + 1 < maxAttempts) {
          console.info(
            `[RepoMind AI] Retrying Groq structured JSON parse (${classified.userMessage})`
          );
          continue;
        }
        break;
      }
    }

    const finalGroqErr = lastError!;
    const shouldFallback =
      finalGroqErr.category !== 'auth_error' && canUseGeminiFallback(allowFallback);

    if (!shouldFallback) {
      throw finalGroqErr;
    }

    console.info(
      `[RepoMind AI] Routing structured JSON to Gemini fallback (${finalGroqErr.category}).`
    );
    try {
      const data = await generateGeminiStructuredJson<T>({
        systemInstruction: params.systemInstruction,
        prompt: params.prompt,
        responseSchema: params.responseSchema,
        thinkingLevel: params.thinkingLevel,
        retryOptions: {
          maxRetries: 0,
          timeoutMs: params.retryOptions?.timeoutMs ?? 35_000,
          allowFallback: false,
        },
      });
      return { data, model: GEMINI_TEXT_MODEL, provider: 'gemini' };
    } catch (geminiErr) {
      const gemClassified = classifyGeminiError(geminiErr);
      if (gemClassified.category === 'quota_exhausted') {
        markGeminiQuotaExhausted();
      }
      console.warn(
        `[RepoMind AI] Gemini fallback failed after Groq ${finalGroqErr.category}: ${gemClassified.userMessage}`
      );
      throw finalGroqErr;
    }
  }

  if (isGeminiConfigured() && !isGeminiQuotaCooldownActive()) {
    try {
      const data = await generateGeminiStructuredJson<T>({
        systemInstruction: params.systemInstruction,
        prompt: params.prompt,
        responseSchema: params.responseSchema,
        thinkingLevel: params.thinkingLevel,
        retryOptions: {
          maxRetries: params.retryOptions?.maxRetries ?? 1,
          maxRetryDelayMs: params.retryOptions?.maxRetryDelayMs ?? 8_000,
          timeoutMs: params.retryOptions?.timeoutMs ?? 35_000,
          allowFallback,
        },
      });
      return { data, model: GEMINI_TEXT_MODEL, provider: 'gemini' };
    } catch (geminiErr) {
      const gemClassified = classifyGeminiError(geminiErr);
      if (gemClassified.category === 'quota_exhausted') {
        markGeminiQuotaExhausted();
      }
      throw classifyAiError(geminiErr);
    }
  }

  throw new AiProviderError({
    provider: 'groq',
    category: isGeminiQuotaCooldownActive() ? 'quota_exhausted' : 'auth_error',
    retryable: false,
    userMessage: isGeminiQuotaCooldownActive()
      ? 'No AI text provider is available (GROQ_API_KEY missing and Gemini quota is exhausted).'
      : 'No AI text provider is configured. Set GROQ_API_KEY or GEMINI_API_KEY in server secrets.',
  });
}
