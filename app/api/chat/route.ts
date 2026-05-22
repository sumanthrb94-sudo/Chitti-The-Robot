/**
 * POST /api/chat
 *
 * Body: { messages: ChatMessage[] }
 * Returns: Server-Sent Events stream of StreamEvent objects, one per line in
 *   `data: <json>\n\n` format. Client cancellation (request.signal aborted)
 *   propagates straight into the Anthropic stream so we stop billing tokens.
 */

import { NextRequest } from 'next/server';

import { streamChittiResponse, type StreamEvent } from '@/lib/claude';
import type { ChatMessage } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
        // Stream consumer below also observes request.signal via streamChittiResponse,
        // but close the SSE channel promptly so the client unblocks.
        close();
      };
      request.signal.addEventListener('abort', onAbort);

      try {
        for await (const event of streamChittiResponse({
          messages: chatMessages,
          signal: request.signal,
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
