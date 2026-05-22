/**
 * LLM provider router.
 *
 * Picks the streaming backend at runtime so the rest of the app stays
 * provider-agnostic. Two providers are supported today:
 *
 *   - `anthropic`  → proprietary Claude API (default when ANTHROPIC_API_KEY is set)
 *   - `ollama`     → open-source local models via the Ollama server
 *
 * Selection precedence:
 *   1. Explicit env: LLM_PROVIDER=anthropic|ollama
 *   2. Implicit:     ANTHROPIC_API_KEY present → anthropic; else → ollama
 *
 * Both providers yield the same StreamEvent union, so the chat route doesn't
 * need to know which one it's talking to.
 */

import { streamChittiResponse } from '@/lib/claude';
import { streamOllamaResponse } from '@/lib/ollama';
import type { StreamEvent } from '@/lib/stream-event';
import type { ChatMessage } from '@/types';

export type { StreamEvent } from '@/lib/stream-event';

export type LlmProvider = 'anthropic' | 'ollama';

export function resolveProvider(): LlmProvider {
  const explicit = (process.env.LLM_PROVIDER ?? '').toLowerCase().trim();
  if (explicit === 'anthropic' || explicit === 'ollama') {
    return explicit;
  }
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'ollama';
}

export function providerInfo(): { provider: LlmProvider; model: string; openSource: boolean } {
  const provider = resolveProvider();
  if (provider === 'anthropic') {
    return {
      provider,
      model: process.env.CHITTI_MODEL ?? 'claude-sonnet-4-6',
      openSource: false,
    };
  }
  return {
    provider,
    model: process.env.OLLAMA_MODEL ?? 'llama3.1:8b',
    openSource: true,
  };
}

/**
 * Stream a Chitti response using whichever provider is configured.
 * The chat route should call this and forward events as SSE.
 */
export function streamChat(args: {
  messages: ChatMessage[];
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent, void, unknown> {
  const provider = resolveProvider();
  if (provider === 'ollama') {
    return streamOllamaResponse(args);
  }
  return streamChittiResponse(args);
}
