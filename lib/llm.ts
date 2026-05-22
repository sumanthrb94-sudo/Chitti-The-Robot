/**
 * LLM provider router.
 *
 * Picks the streaming backend at runtime so the rest of the app stays
 * provider-agnostic. Three providers are supported:
 *
 *   - `anthropic` → proprietary Claude API
 *   - `ollama`    → open-source local models via the Ollama server
 *   - `openai`    → any OpenAI Chat Completions-compatible endpoint
 *                   (Moonshot/Kimi, OpenAI, OpenRouter, Together, Groq,
 *                    DeepSeek, vLLM, LM Studio, …)
 *
 * Selection precedence:
 *   1. Explicit env: LLM_PROVIDER=anthropic|ollama|openai
 *   2. Implicit:
 *        OPENAI_API_KEY present    → openai
 *        ANTHROPIC_API_KEY present → anthropic
 *        otherwise                 → ollama
 *
 * All providers yield the same StreamEvent union, so the chat route doesn't
 * need to know which one it's talking to.
 */

import { streamChittiResponse } from '@/lib/claude';
import { streamOllamaResponse } from '@/lib/ollama';
import { streamOpenAIResponse } from '@/lib/openai-compat';
import type { StreamEvent } from '@/lib/stream-event';
import type { ChatMessage } from '@/types';

export type { StreamEvent } from '@/lib/stream-event';

export type LlmProvider = 'anthropic' | 'ollama' | 'openai';

export function resolveProvider(): LlmProvider {
  const explicit = (process.env.LLM_PROVIDER ?? '').toLowerCase().trim();
  if (
    explicit === 'anthropic' ||
    explicit === 'ollama' ||
    explicit === 'openai'
  ) {
    return explicit;
  }
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'ollama';
}

/**
 * Try to detect a friendly brand name from the OpenAI-compatible base URL
 * — useful for surfacing "KIMI" / "OPENROUTER" / "GROQ" in the UI chip.
 */
function inferOpenAIBrand(baseUrl: string): string {
  const u = baseUrl.toLowerCase();
  if (u.includes('moonshot')) return 'kimi';
  if (u.includes('openrouter')) return 'openrouter';
  if (u.includes('together')) return 'together';
  if (u.includes('groq')) return 'groq';
  if (u.includes('deepseek')) return 'deepseek';
  if (u.includes('mistral')) return 'mistral';
  if (u.includes('localhost') || u.includes('127.0.0.1')) return 'local';
  return 'openai';
}

export function providerInfo(): {
  provider: LlmProvider;
  /** Display label shown in the UI — may differ from `provider` for OpenAI-compatible (e.g. "kimi") */
  brand: string;
  model: string;
  openSource: boolean;
} {
  const provider = resolveProvider();
  if (provider === 'anthropic') {
    return {
      provider,
      brand: 'claude',
      model: process.env.CHITTI_MODEL ?? 'claude-sonnet-4-6',
      openSource: false,
    };
  }
  if (provider === 'openai') {
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const brand = inferOpenAIBrand(baseUrl);
    return {
      provider,
      brand,
      // Sensible default model per brand when OPENAI_MODEL is unset.
      model:
        process.env.OPENAI_MODEL ??
        (brand === 'kimi'
          ? 'kimi-k2-0905-preview'
          : brand === 'groq'
            ? 'llama-3.3-70b-versatile'
            : brand === 'deepseek'
              ? 'deepseek-chat'
              : 'gpt-4o-mini'),
      // Kimi/DeepSeek/etc. are OSS-weighted in practice but we mark only the
      // truly self-hostable case as openSource. Brands like Kimi-K2 are
      // open-weight; flagging them as open is accurate.
      openSource:
        brand === 'kimi' || brand === 'deepseek' || brand === 'local',
    };
  }
  return {
    provider,
    brand: 'ollama',
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
  if (provider === 'openai') return streamOpenAIResponse(args);
  if (provider === 'ollama') return streamOllamaResponse(args);
  return streamChittiResponse(args);
}
