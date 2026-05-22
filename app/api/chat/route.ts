/**
 * POST /api/chat
 *
 * Body: {
 *   messages: ChatMessage[];
 *   credentials?: { provider, apiKey, baseUrl, model };
 *   memoryCredentials?: { enabled, vectorUrl, vectorToken, embeddingApiKey, userId };
 * }
 * Returns: Server-Sent Events stream of StreamEvent objects, one per line in
 *   `data: <json>\n\n` format.
 *
 * `credentials` is the user's BYO-key envelope from the browser (Settings →
 * paste your Kimi / Claude / OpenAI key). When supplied, it overrides server
 * env vars for this request only — we never persist it.
 *
 * `memoryCredentials` is the same BYO model applied to long-term memory:
 * when enabled and fully configured, the route runs a vector-similarity
 * query against Upstash Vector before invoking the LLM, prepends relevant
 * memories to the conversation, and (after the stream ends) fire-and-forget
 * upserts the latest user + assistant turn back into the store. All memory
 * operations are wrapped in try/catch — a misconfigured or down vector DB
 * NEVER crashes the chat flow.
 *
 * Client cancellation (request.signal aborted) propagates straight into the
 * upstream LLM stream so we stop billing tokens promptly.
 */

import { NextRequest } from 'next/server';

import { providerInfo, streamChat } from '@/lib/llm';
import { createMemoryClient, type MemoryRecord } from '@/lib/memory';
import type { StreamEvent } from '@/lib/stream-event';
import { nowIso, uid } from '@/lib/utils';
import type {
  ChatMessage,
  ChittiLlmCredentials,
  ChittiMemoryCredentials,
} from '@/types';

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

  // Parse the optional BYO memory envelope. Memory is fully optional — if
  // any field is missing OR `enabled === false` we just skip the whole
  // long-term-memory path and let the LLM run with its raw chat history.
  const rawMem = (body as { memoryCredentials?: unknown }).memoryCredentials;
  let memoryCredentials: ChittiMemoryCredentials | null = null;
  if (rawMem && typeof rawMem === 'object') {
    const m = rawMem as Record<string, unknown>;
    memoryCredentials = {
      enabled: m.enabled === true,
      vectorUrl: typeof m.vectorUrl === 'string' ? m.vectorUrl : undefined,
      vectorToken: typeof m.vectorToken === 'string' ? m.vectorToken : undefined,
      embeddingApiKey:
        typeof m.embeddingApiKey === 'string' ? m.embeddingApiKey : undefined,
      userId: typeof m.userId === 'string' ? m.userId : undefined,
    };
  }

  // Memory is usable only if every key + namespace is present AND enabled.
  function memoryReady(c: ChittiMemoryCredentials | null): c is ChittiMemoryCredentials & {
    vectorUrl: string;
    vectorToken: string;
    embeddingApiKey: string;
    userId: string;
  } {
    return Boolean(
      c &&
        c.enabled &&
        c.vectorUrl &&
        c.vectorToken &&
        c.embeddingApiKey &&
        c.userId,
    );
  }

  /**
   * Format memories as a bracketed block we inject as an extra user-role
   * message at the head of the conversation. This works uniformly across
   * Anthropic, OpenAI-compat, and Ollama because all three accept user
   * messages with arbitrary text content.
   */
  function formatMemoriesBlock(memories: MemoryRecord[]): string {
    const lines = memories.map((m) => {
      const day = m.createdAt ? m.createdAt.slice(0, 10) : '';
      const safe = m.text.replace(/\s+/g, ' ').trim();
      return `- [${m.role}${day ? ', ' + day : ''}] ${safe}`;
    });
    return [
      '<memories>',
      'Relevant facts from prior conversations with this user (use silently as context — do not announce that you are remembering):',
      ...lines,
      '</memories>',
    ].join('\n');
  }

  // Pull the latest user-authored message text so we can use it as the
  // semantic-search query against the vector store.
  function latestUserText(messages: ChatMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0) {
        return m.content.trim();
      }
    }
    return null;
  }

  // Augmented copy of the messages we hand to the LLM. We mutate this array
  // (not chatMessages) so the memory injection is purely an in-flight concern.
  let messagesForLlm: ChatMessage[] = chatMessages;

  if (memoryReady(memoryCredentials)) {
    const queryText = latestUserText(chatMessages);
    if (queryText) {
      try {
        const memClient = createMemoryClient({
          vectorUrl: memoryCredentials.vectorUrl,
          vectorToken: memoryCredentials.vectorToken,
          embeddingApiKey: memoryCredentials.embeddingApiKey,
          namespace: memoryCredentials.userId,
        });
        const memories = await memClient.query(queryText, 5);
        if (memories.length > 0) {
          const reminder: ChatMessage = {
            id: uid('mem-context'),
            role: 'user',
            content: formatMemoriesBlock(memories),
            createdAt: nowIso(),
          };
          messagesForLlm = [reminder, ...chatMessages];
        }
      } catch (e) {
        // Never break chat on a memory failure — log and continue.
        console.error(
          '[chitti.memory] pre-chat query failed:',
          e instanceof Error ? e.message : String(e),
        );
      }
    }
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

      // Captures the final assistant message so we can persist it to long-term
      // memory after the stream completes. Memory writes are fire-and-forget —
      // we never block the SSE close on them.
      let finalAssistant: ChatMessage | null = null;

      try {
        for await (const event of streamChat({
          messages: messagesForLlm,
          signal: request.signal,
          credentials,
        })) {
          if (closed || request.signal.aborted) break;
          if (event.type === 'done') {
            finalAssistant = event.finalMessage;
          }
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

        // Fire-and-forget: persist the latest exchange to long-term memory if
        // configured. Anything that goes wrong here lands in the server log;
        // the chat response has already been delivered to the client.
        if (memoryReady(memoryCredentials) && finalAssistant && !request.signal.aborted) {
          const userText = latestUserText(chatMessages);
          const assistantText = finalAssistant.content?.trim() ?? '';
          const records: {
            id: string;
            text: string;
            role: 'user' | 'assistant';
            createdAt: string;
          }[] = [];
          if (userText) {
            records.push({
              id: uid('mem'),
              text: userText,
              role: 'user',
              createdAt: nowIso(),
            });
          }
          if (assistantText) {
            records.push({
              id: uid('mem'),
              text: assistantText,
              role: 'assistant',
              createdAt: finalAssistant.createdAt || nowIso(),
            });
          }
          if (records.length > 0) {
            const creds = memoryCredentials;
            void (async () => {
              try {
                const memClient = createMemoryClient({
                  vectorUrl: creds.vectorUrl,
                  vectorToken: creds.vectorToken,
                  embeddingApiKey: creds.embeddingApiKey,
                  namespace: creds.userId,
                });
                await memClient.upsert(records);
              } catch (err) {
                console.error(
                  '[chitti.memory] post-chat upsert failed:',
                  err instanceof Error ? err.message : String(err),
                );
              }
            })();
          }
        }
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
