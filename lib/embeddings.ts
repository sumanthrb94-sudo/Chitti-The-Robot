/**
 * OpenAI embeddings client (server-only).
 *
 * Thin REST wrapper over POST https://api.openai.com/v1/embeddings — no SDK
 * dependency, so any deployment target with `fetch` (Node 18+ / Edge runtime)
 * can drive it. Used by the memory subsystem to convert chat turns into
 * 1536-dim vectors before upserting to Upstash Vector.
 *
 * Pricing note: text-embedding-3-small is $0.02 / 1M tokens — embedding
 * roughly 50 short user/assistant turns costs a fraction of a cent.
 */

/** Vector dimension returned by text-embedding-3-small. */
export const EMBEDDING_DIMS = 1536;

const EMBEDDING_MODEL = 'text-embedding-3-small';
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
/** 6s upper bound on a single embedding call — keeps the chat path responsive. */
const TIMEOUT_MS = 6000;

interface OpenAIEmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
    object: string;
  }>;
  model: string;
  object: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

interface OpenAIErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

/**
 * Embed a single piece of text into a 1536-dimension vector using
 * OpenAI's `text-embedding-3-small` model.
 *
 * Throws a descriptive Error on any failure — caller decides whether to
 * swallow or propagate (memory.ts swallows so chat keeps flowing).
 */
export async function embedText(text: string, apiKey: string): Promise<number[]> {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('embedText: missing OpenAI API key');
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('embedText: input text is empty');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(`embedText: request timed out after ${TIMEOUT_MS}ms`);
    }
    throw new Error(
      `embedText: network error — ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as OpenAIErrorBody;
      detail = body.error?.message ?? '';
    } catch {
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
    }
    throw new Error(
      `embedText: OpenAI returned ${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`,
    );
  }

  let payload: OpenAIEmbeddingResponse;
  try {
    payload = (await res.json()) as OpenAIEmbeddingResponse;
  } catch (e) {
    throw new Error(
      `embedText: failed to parse OpenAI response — ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const embedding = payload.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('embedText: OpenAI response missing embedding array');
  }
  if (embedding.length !== EMBEDDING_DIMS) {
    // Not strictly fatal, but a strong signal something changed upstream —
    // surface it so the caller can decide whether to abort the upsert.
    throw new Error(
      `embedText: expected ${EMBEDDING_DIMS}-dim vector, got ${embedding.length}`,
    );
  }
  return embedding;
}
