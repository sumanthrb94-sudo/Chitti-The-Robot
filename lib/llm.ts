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
 * Selection precedence (per request, with optional BYO credentials):
 *   1. The request's `LlmCredentials.provider` if set (and != 'auto')
 *   2. Explicit env: LLM_PROVIDER=anthropic|ollama|openai
 *   3. Implicit:
 *        OPENAI_API_KEY present    → openai
 *        ANTHROPIC_API_KEY present → anthropic
 *        otherwise                 → ollama
 *
 * Callers can also pass `apiKey`, `baseUrl`, `model` in credentials to
 * override env vars — that's how the Settings modal feeds user-pasted
 * keys through without server-side env config.
 */

import { streamChittiResponse } from '@/lib/claude';
import { streamOllamaResponse } from '@/lib/ollama';
import { streamOpenAIResponse } from '@/lib/openai-compat';
import type { StreamEvent } from '@/lib/stream-event';
import type { ChatMessage, ChittiLlmCredentials } from '@/types';

export type { StreamEvent } from '@/lib/stream-event';

export type LlmProvider = 'anthropic' | 'ollama' | 'openai';

export interface ResolvedCredentials {
  provider: LlmProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export function resolveProvider(
  override?: ChittiLlmCredentials | null,
): LlmProvider {
  if (override && override.provider && override.provider !== 'auto') {
    if (
      override.provider === 'anthropic' ||
      override.provider === 'openai' ||
      override.provider === 'ollama'
    ) {
      return override.provider;
    }
  }
  // If override carries an apiKey but no provider, infer from where the key
  // would naturally be valid. Anthropic keys start with sk-ant-; OpenAI-style
  // keys (incl. Kimi/OpenRouter) start with sk- (without ant-).
  if (override?.apiKey) {
    if (override.apiKey.startsWith('sk-ant-')) return 'anthropic';
    if (override.apiKey.startsWith('sk-')) return 'openai';
  }
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
 * Detect a friendly brand name from the OpenAI-compatible base URL —
 * powers the "KIMI K2" / "OPENROUTER" / "GROQ" labelling in the UI chip.
 */
function inferOpenAIBrand(baseUrl: string): string {
  const u = baseUrl.toLowerCase();
  if (u.includes('kimi.com') || u.includes('moonshot')) return 'kimi';
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
      model:
        process.env.OPENAI_MODEL ??
        (brand === 'kimi'
          ? 'kimi-k2.6'
          : brand === 'groq'
            ? 'llama-3.3-70b-versatile'
            : brand === 'deepseek'
              ? 'deepseek-chat'
              : 'gpt-4o-mini'),
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
 *
 * If `credentials` is supplied, those take precedence over env vars
 * for THIS request only (nothing is persisted).
 */
export function streamChat(args: {
  messages: ChatMessage[];
  signal?: AbortSignal;
  credentials?: ChittiLlmCredentials | null;
}): AsyncGenerator<StreamEvent, void, unknown> {
  const provider = resolveProvider(args.credentials);
  const inner = {
    messages: args.messages,
    signal: args.signal,
    apiKey: args.credentials?.apiKey,
    baseUrl: args.credentials?.baseUrl,
    model: args.credentials?.model,
  };
  if (provider === 'openai') return streamOpenAIResponse(inner);
  if (provider === 'ollama') return streamOllamaResponse(inner);
  return streamChittiResponse(inner);
}
