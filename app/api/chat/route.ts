/**
 * POST /api/chat
 *
 * Body: {
 *   messages: ChatMessage[];
 *   credentials?: { provider, apiKey, baseUrl, model }
 * }
 * Returns: Server-Sent Events stream of StreamEvent objects, one per line in
 *   `data: <json>\n\n` format.
 *
 * `credentials` is the user's BYO-key envelope from the browser (Settings →
 * paste your Kimi / Claude / OpenAI key). When supplied, it overrides server
 * env vars for this request only — we never persist it.
 *
 * Client cancellation (request.signal aborted) propagates straight into the
 * upstream LLM stream so we stop billing tokens promptly.
 */

import { NextRequest } from 'next/server';

import { providerInfo, streamChat } from '@/lib/llm';
import type { StreamEvent } from '@/lib/stream-event';
import type { ChatMessage, ChittiLlmCredentials } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel: allow long-running streams for multi-tool-call conversations.
// Max for Hobby is 60s; Pro is 300s. Set to 60 to work on both.
export const maxDuration = 60;

function sseEncode(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) {
    return new Response(
      JSON.stringify({ error: 'Body must include `messages: ChatMessage[]`.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const chatMessages = messages as ChatMessage[];

  // BYO-key envelope: if the browser passes credentials, they override env
  // for this request only. Fields are sanity-checked so malformed bodies
  // can't crash the route.
  const rawCreds = (body as { credentials?: unknown }).credentials;
  let credentials: ChittiLlmCredentials | null = null;
  if (rawCreds && typeof rawCreds === 'object') {
    const c = rawCreds as Record<string, unknown>;
    const provider = typeof c.provider === 'string' ? c.provider : undefined;
    const validProvider =
      provider === 'anthropic' ||
      provider === 'openai' ||
      provider === 'ollama' ||
      provider === 'auto'
        ? provider
        : 'auto';
    credentials = {
      provider: validProvider,
      apiKey: typeof c.apiKey === 'string' ? c.apiKey : undefined,
      baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl : undefined,
      model: typeof c.model === 'string' ? c.model : undefined,
    };
  }
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed; ignore.
        }
      };

      const onAbort = () => {
        // Stream consumer below also observes request.signal via streamChat,
        // but close the SSE channel promptly so the client unblocks.
        close();
      };
      request.signal.addEventListener('abort', onAbort);

      // Provider summary for logs — without leaking the API key. When the
      // user supplies their own key we log "byo" instead of the model name.
      const info = providerInfo();
      const byo = credentials?.apiKey ? 'byo' : 'env';
      console.log(
        `[chitti] provider=${info.provider} model=${info.model} oss=${info.openSource} creds=${byo}`,
      );

      try {
        for await (const event of streamChat({
          messages: chatMessages,
          signal: request.signal,
          credentials,
        })) {
          if (closed || request.signal.aborted) break;
          controller.enqueue(encoder.encode(sseEncode(event)));
        }
      } catch (e) {
        if (!closed) {
          const errEvent: StreamEvent = {
            type: 'error',
            error: e instanceof Error ? e.message : 'Unknown stream error',
          };
          try {
            controller.enqueue(encoder.encode(sseEncode(errEvent)));
          } catch {
            // Controller may already be closed; ignore.
          }
        }
      } finally {
        request.signal.removeEventListener('abort', onAbort);
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
