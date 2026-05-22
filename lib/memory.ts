/**
 * Server-only client for Chitti's long-term memory.
 *
 * Backed by Upstash Vector (REST). We pick Upstash because:
 *   - REST-only (no SDK / no extra dep)
 *   - 10k vectors on the free tier, no credit card required
 *   - Works fine inside Vercel's Node runtime
 *
 * Lifecycle:
 *   1. After each turn, `/api/chat` upserts the user message + assistant
 *      reply into the vector DB, keyed by a per-user `namespace` so
 *      multi-tenant deployments stay isolated.
 *   2. Before each new turn, `/api/chat` queries the top-K most similar
 *      memories and injects them as a contextual hint to the LLM.
 *
 * Errors NEVER crash the chat flow — every call is wrapped in try/catch at
 * the route layer. We surface descriptive messages so the server console
 * tells the operator exactly what failed.
 */

import { EMBEDDING_DIMS, embedText } from '@/lib/embeddings';

const TIMEOUT_MS = 6000;
const DEFAULT_TOP_K = 5;
/** Minimum cosine similarity to keep a result. Tuned to drop weak hits. */
const SIMILARITY_FLOOR = 0.7;

export interface MemoryRecord {
  id: string;
  text: string;
  role: 'user' | 'assistant';
  createdAt: string;
  /** Cosine similarity to the query — only present on `query()` results. */
  score?: number;
}

export interface MemoryClient {
  upsert(
    records: {
      id: string;
      text: string;
      role: 'user' | 'assistant';
      createdAt: string;
    }[],
  ): Promise<void>;
  query(text: string, topK?: number): Promise<MemoryRecord[]>;
}

/* ─────────────────────────  Upstash response shapes  ───────────────────────── */

interface UpstashMetadata {
  text?: string;
  role?: string;
  createdAt?: string;
  namespace?: string;
}

interface UpstashQueryResult {
  id: string;
  score: number;
  vector?: number[];
  metadata?: UpstashMetadata;
}

interface UpstashQueryResponse {
  result?: UpstashQueryResult[];
  // Some Upstash versions return a top-level array, others wrap in `result`.
}

/* ─────────────────────────  Helpers  ───────────────────────── */

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

async function postJson(
  url: string,
  token: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
}

function withTimeout(): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Escape a namespace for safe inclusion in an Upstash filter expression.
 * Upstash uses single-quoted strings — we strip the only character that
 * could break out of the literal.
 */
function escapeNamespace(ns: string): string {
  return ns.replace(/'/g, '');
}

/* ─────────────────────────  Factory  ───────────────────────── */

export function createMemoryClient(opts: {
  vectorUrl: string;
  vectorToken: string;
  embeddingApiKey: string;
  /** userId — keeps users isolated within a shared vector DB. */
  namespace: string;
}): MemoryClient {
  if (!opts.vectorUrl) throw new Error('createMemoryClient: vectorUrl is required');
  if (!opts.vectorToken) throw new Error('createMemoryClient: vectorToken is required');
  if (!opts.embeddingApiKey)
    throw new Error('createMemoryClient: embeddingApiKey is required');
  if (!opts.namespace) throw new Error('createMemoryClient: namespace is required');

  const base = trimTrailingSlash(opts.vectorUrl);
  const safeNamespace = escapeNamespace(opts.namespace);

  async function upsert(
    records: {
      id: string;
      text: string;
      role: 'user' | 'assistant';
      createdAt: string;
    }[],
  ): Promise<void> {
    if (records.length === 0) return;

    // Embed everything in parallel — keeps the post-chat hook fast.
    const vectors = await Promise.all(
      records.map((r) => embedText(r.text, opts.embeddingApiKey)),
    );

    const payload = records.map((r, i) => ({
      id: r.id,
      vector: vectors[i],
      metadata: {
        text: r.text,
        role: r.role,
        createdAt: r.createdAt,
        namespace: opts.namespace,
      },
    }));

    // Sanity-check dims so we fail loudly if OpenAI ever returns the wrong shape.
    for (const v of vectors) {
      if (v.length !== EMBEDDING_DIMS) {
        throw new Error(
          `memory.upsert: bad embedding dimension ${v.length}, expected ${EMBEDDING_DIMS}`,
        );
      }
    }

    const { signal, clear } = withTimeout();
    let res: Response;
    try {
      res = await postJson(`${base}/upsert`, opts.vectorToken, payload, signal);
    } catch (e) {
      clear();
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw new Error(`memory.upsert: timed out after ${TIMEOUT_MS}ms`);
      }
      throw new Error(
        `memory.upsert: network error — ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      clear();
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      throw new Error(
        `memory.upsert: Upstash returned ${res.status} ${res.statusText}${detail ? ' — ' + detail.slice(0, 300) : ''}`,
      );
    }
  }

  async function query(text: string, topK: number = DEFAULT_TOP_K): Promise<MemoryRecord[]> {
    const vector = await embedText(text, opts.embeddingApiKey);

    const { signal, clear } = withTimeout();
    let res: Response;
    try {
      res = await postJson(
        `${base}/query`,
        opts.vectorToken,
        {
          vector,
          topK,
          includeMetadata: true,
          filter: `namespace = '${safeNamespace}'`,
        },
        signal,
      );
    } catch (e) {
      clear();
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw new Error(`memory.query: timed out after ${TIMEOUT_MS}ms`);
      }
      throw new Error(
        `memory.query: network error — ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      clear();
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      throw new Error(
        `memory.query: Upstash returned ${res.status} ${res.statusText}${detail ? ' — ' + detail.slice(0, 300) : ''}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (e) {
      throw new Error(
        `memory.query: invalid JSON from Upstash — ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Upstash returns either { result: [...] } or [...] directly depending on
    // the API version; tolerate both shapes.
    let rows: UpstashQueryResult[] = [];
    if (Array.isArray(parsed)) {
      rows = parsed as UpstashQueryResult[];
    } else if (parsed && typeof parsed === 'object') {
      const maybe = (parsed as UpstashQueryResponse).result;
      if (Array.isArray(maybe)) rows = maybe;
    }

    const out: MemoryRecord[] = [];
    for (const row of rows) {
      if (typeof row.score !== 'number' || row.score < SIMILARITY_FLOOR) continue;
      const md = row.metadata ?? {};
      const role = md.role === 'assistant' ? 'assistant' : 'user';
      const text = typeof md.text === 'string' ? md.text : '';
      if (!text) continue;
      out.push({
        id: row.id,
        text,
        role,
        createdAt: typeof md.createdAt === 'string' ? md.createdAt : '',
        score: row.score,
      });
    }
    return out;
  }

  return { upsert, query };
}
