/**
 * POST /api/memory
 *
 * Two operations on the user's BYO vector store (Upstash Vector):
 *
 *   { op: 'upsert', credentials, records: [{ text, role, createdAt }, ...] }
 *      → embed each record, upsert into the user's namespace
 *      → server generates ids
 *      → returns { ok: true } or { ok: true, skipped: true } if memory off
 *
 *   { op: 'query', credentials, text, topK?: number }
 *      → embed the query, run a top-K cosine-similarity search
 *      → returns { memories: MemoryRecord[] }
 *
 * Trust model: identical to /api/chat — the browser sends credentials in
 * the body, we forward to Upstash/OpenAI for this single call, never persist.
 *
 * Failure mode: if credentials are missing OR `enabled === false`, we
 * respond 200 with an empty/skipped payload so the chat flow never breaks
 * on a half-configured memory setup.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';

import { createMemoryClient, type MemoryRecord } from '@/lib/memory';
import { uid } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CredentialsSchema = z.object({
  vectorUrl: z.string().url().optional(),
  vectorToken: z.string().min(8).optional(),
  embeddingApiKey: z.string().min(8).optional(),
  userId: z.string().min(1).optional(),
  enabled: z.boolean(),
});

const UpsertRecordSchema = z.object({
  text: z.string().min(1).max(8000),
  role: z.enum(['user', 'assistant']),
  createdAt: z.string().min(1),
});

const BodySchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('upsert'),
    credentials: CredentialsSchema,
    records: z.array(UpsertRecordSchema).min(1).max(20),
  }),
  z.object({
    op: z.literal('query'),
    credentials: CredentialsSchema,
    text: z.string().min(1).max(4000),
    topK: z.number().int().min(1).max(20).optional(),
  }),
]);

type ParsedBody = z.infer<typeof BodySchema>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** True when every BYO credential the memory client needs is present. */
function credentialsComplete(c: z.infer<typeof CredentialsSchema>): boolean {
  return Boolean(
    c.enabled &&
      c.vectorUrl &&
      c.vectorToken &&
      c.embeddingApiKey &&
      c.userId,
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: 'bad_request', detail: parsed.error.message }, 400);
  }

  const data: ParsedBody = parsed.data;
  const { credentials } = data;

  // Memory disabled OR missing keys → no-op so the chat path never breaks.
  if (!credentialsComplete(credentials)) {
    if (data.op === 'query') {
      return json({ memories: [] satisfies MemoryRecord[] });
    }
    return json({ ok: true, skipped: true });
  }

  let client;
  try {
    client = createMemoryClient({
      vectorUrl: credentials.vectorUrl as string,
      vectorToken: credentials.vectorToken as string,
      embeddingApiKey: credentials.embeddingApiKey as string,
      namespace: credentials.userId as string,
    });
  } catch (e) {
    console.error('[chitti.memory] init failed:', e);
    return json(
      { error: 'memory_init_failed', detail: e instanceof Error ? e.message : 'unknown' },
      500,
    );
  }

  if (data.op === 'query') {
    try {
      const memories = await client.query(data.text, data.topK ?? 5);
      return json({ memories });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown';
      console.error('[chitti.memory.query] failed:', msg);
      // Soft-fail: empty memories so the caller can still continue chatting.
      return json({ memories: [] satisfies MemoryRecord[], warning: msg });
    }
  }

  // op === 'upsert'
  try {
    const records = data.records.map((r) => ({
      id: uid('mem'),
      text: r.text,
      role: r.role,
      createdAt: r.createdAt,
    }));
    await client.upsert(records);
    return json({ ok: true, count: records.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    console.error('[chitti.memory.upsert] failed:', msg);
    return json({ ok: false, error: msg }, 200);
  }
}
