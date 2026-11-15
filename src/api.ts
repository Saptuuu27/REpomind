import type {
  ChatMessage,
  GeneratedDocs,
  HealthStatus,
  IngestProgressEvent,
  OverviewProgressEvent,
  RepositoryRecord,
  RepositorySummary,
} from './types';

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed with status ${res.status}`);
  }
  return data;
}

export async function fetchHealth(): Promise<HealthStatus> {
  const res = await fetch('/api/health');
  return parseJsonOrThrow<HealthStatus>(res);
}

export async function listRepositories(): Promise<RepositorySummary[]> {
  const res = await fetch('/api/repositories');
  const data = await parseJsonOrThrow<{ repositories: RepositorySummary[] }>(res);
  return data.repositories;
}

export async function getRepository(id: string): Promise<RepositoryRecord> {
  const res = await fetch(`/api/repositories/${encodeURIComponent(id)}`);
  const data = await parseJsonOrThrow<{ repository: RepositoryRecord }>(res);
  return data.repository;
}

export async function deleteRepository(id: string): Promise<void> {
  const res = await fetch(`/api/repositories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  await parseJsonOrThrow<{ ok: boolean }>(res);
}

interface StreamOptions {
  signal?: AbortSignal;
}

export async function consumeSseStream<TEvent>(
  res: Response,
  fallbackError: string,
  onProgress: (event: TEvent) => void
): Promise<RepositoryRecord> {
  if (!res.ok || !res.body) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error || `${fallbackError} (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalRepo: RepositoryRecord | null = null;
  let streamError: string | null = null;

  const processBlock = (block: string) => {
    const trimmed = block.trim();
    if (!trimmed) return;
    const lines = trimmed.split('\n');
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    const dataStr = dataLines.join('\n');
    if (!dataStr) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      throw new Error(`${fallbackError}: received malformed event payload from server.`);
    }

    if (eventName === 'progress') {
      onProgress(parsed as unknown as TEvent);
    } else if (eventName === 'done') {
      finalRepo = (parsed as { repository: RepositoryRecord }).repository;
    } else if (eventName === 'error') {
      streamError = (parsed as { message?: string }).message || fallbackError;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode().replace(/\r\n/g, '\n');
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        processBlock(block);
      }
    }

    if (buffer.trim().length > 0) {
      for (const block of buffer.split('\n\n')) {
        processBlock(block);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (streamError) {
    throw new Error(streamError);
  }
  if (!finalRepo) {
    throw new Error(`${fallbackError}: stream ended before returning a repository.`);
  }
  return finalRepo;
}

export async function ingestRepositoryStream(
  url: string,
  forceRefresh: boolean,
  onProgress: (event: IngestProgressEvent) => void,
  options?: StreamOptions
): Promise<RepositoryRecord> {
  const res = await fetch('/api/repositories/ingest?stream=true', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ url, forceRefresh }),
    signal: options?.signal,
  });

  return consumeSseStream<IngestProgressEvent>(res, 'Ingestion failed', onProgress);
}

export async function analyzeOverviewStream(
  id: string,
  options: { mode?: 'resume' | 'full'; retryBatchIds?: string[] },
  onProgress: (event: OverviewProgressEvent) => void,
  streamOptions?: StreamOptions
): Promise<RepositoryRecord> {
  const res = await fetch(
    `/api/repositories/${encodeURIComponent(id)}/overview/analyze?stream=true`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(options),
      signal: streamOptions?.signal,
    }
  );

  return consumeSseStream<OverviewProgressEvent>(
    res,
    'Overview analysis failed',
    onProgress
  );
}

export async function reanalyzeRepository(id: string): Promise<RepositoryRecord> {
  const res = await fetch(`/api/repositories/${encodeURIComponent(id)}/reanalyze`, {
    method: 'POST',
  });
  const data = await parseJsonOrThrow<{ repository: RepositoryRecord }>(res);
  return data.repository;
}

export async function getChatHistory(id: string): Promise<ChatMessage[]> {
  const res = await fetch(`/api/repositories/${encodeURIComponent(id)}/chat`);
  const data = await parseJsonOrThrow<{ messages: ChatMessage[] }>(res);
  return data.messages;
}

export async function clearChatHistory(id: string): Promise<void> {
  const res = await fetch(`/api/repositories/${encodeURIComponent(id)}/chat`, {
    method: 'DELETE',
  });
  await parseJsonOrThrow<{ ok: boolean }>(res);
}

export async function sendChatQuestion(
  id: string,
  question: string
): Promise<{
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  embeddingsReady?: boolean;
  retrievalMode?: 'hybrid-vector' | 'lexical-fallback';
}> {
  const res = await fetch(`/api/repositories/${encodeURIComponent(id)}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  return parseJsonOrThrow<{
    userMessage: ChatMessage;
    assistantMessage: ChatMessage;
    embeddingsReady?: boolean;
    retrievalMode?: 'hybrid-vector' | 'lexical-fallback';
  }>(res);
}

export async function generateDocs(id: string): Promise<GeneratedDocs> {
  const res = await fetch(`/api/repositories/${encodeURIComponent(id)}/docs`, {
    method: 'POST',
  });
  const data = await parseJsonOrThrow<{ docs: GeneratedDocs }>(res);
  return data.docs;
}
