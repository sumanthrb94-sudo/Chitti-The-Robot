/**
 * Client for the /api/chat SSE endpoint.
 *
 * Wire format (matches Team A's contract):
 *   data: {"type":"text","delta":"hello"}\n\n
 *   data: {"type":"tool_use","tool":{...}}\n\n
 *   data: {"type":"done","finalMessage":{...}}\n\n
 *
 * This module is environment-agnostic — it relies on the global fetch + ReadableStream
 * (available in Node 18+ and all modern browsers).
 */

import type { Artifact, ChatMessage } from '@/types';

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; tool: { id: string; name: string; input: unknown } }
  | { type: 'tool_result'; toolUseId: string; result: unknown; artifact?: Artifact }
  | { type: 'done'; finalMessage: ChatMessage }
  | { type: 'error'; error: string };

export interface StreamChatArgs {
  messages: ChatMessage[];
  onEvent: (event: StreamEvent) => void;
  signal?: AbortSignal;
}

/**
 * POST /api/chat and dispatch SSE events to `onEvent`.
 * Resolves when the stream ends. Throws on network / HTTP errors
 * (also emits an `error` event before throwing for UI symmetry).
 */
export async function streamChat({
  messages,
  onEvent,
  signal,
}: StreamChatArgs): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ messages }),
      signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'network_error';
    // AbortError is a normal user-initiated cancel — don't surface as an error event.
    if (msg !== 'AbortError' && !(e instanceof DOMException && e.name === 'AbortError')) {
      onEvent({ type: 'error', error: msg });
    }
    throw e;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = `HTTP ${response.status}: ${text || response.statusText}`;
    onEvent({ type: 'error', error });
    throw new Error(error);
  }

  if (!response.body) {
    const error = 'No response body';
    onEvent({ type: 'error', error });
    throw new Error(error);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line (\n\n).
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        dispatchFrame(frame, onEvent);
      }
    }
    // Drain any trailing buffered frame (no terminating \n\n).
    if (buffer.trim().length > 0) {
      dispatchFrame(buffer, onEvent);
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      // user-initiated abort, silent
      return;
    }
    const msg = e instanceof Error ? e.message : 'stream_error';
    onEvent({ type: 'error', error: msg });
    throw e;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Parse a single SSE frame and emit the parsed StreamEvent.
 * A frame can be multiple `data:` / comment lines.
 */
function dispatchFrame(
  frame: string,
  onEvent: (event: StreamEvent) => void,
): void {
  const lines = frame.split('\n');
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue; // SSE comment / heartbeat
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return;
  const raw = dataLines.join('\n');
  if (raw === '[DONE]') return; // tolerate OpenAI-style terminator
  try {
    const parsed = JSON.parse(raw) as StreamEvent;
    onEvent(parsed);
  } catch {
    // If the server sent plain text deltas instead of JSON, treat as text chunk.
    onEvent({ type: 'text', delta: raw });
  }
}
