'use client';

/**
 * Browser-side settings store (localStorage).
 *
 * Holds the user's BYO API keys for LLM (Claude/Kimi/OpenAI/etc.) and
 * TTS (ElevenLabs), plus voice tuning. Never sent to telemetry, only
 * forwarded to /api/chat and /api/tts on demand.
 *
 * SSR-safe: every read/write is guarded by typeof window.
 */

import type {
  AsrProviderId,
  ChittiAsrCredentials,
  ChittiLlmCredentials,
  ChittiMemoryCredentials,
  ChittiSettings,
  ChittiTtsCredentials,
  ChittiWakeWordCredentials,
  LlmProviderId,
  TtsProviderId,
  VoiceSettings,
} from '@/types';

const STORAGE_KEY = 'chitti.settings.v1';

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: true,
  autoListen: false,
  // Jarvis-leaning defaults: slightly faster, slightly deeper than neutral.
  rate: 1.05,
  pitch: 0.92,
  volume: 1.0,
};

export const DEFAULT_LLM_CREDENTIALS: ChittiLlmCredentials = {
  provider: 'auto',
};

export const DEFAULT_TTS_CREDENTIALS: ChittiTtsCredentials = {
  provider: 'browser',
  // "Daniel" — premium British male voice; closest preset to a Jarvis vibe.
  voiceId: 'onwK4e9ZLuTAKqWW03F9',
  modelId: 'eleven_turbo_v2_5',
};

/**
 * Mint a stable per-browser userId for memory namespacing.
 * Falls back to a non-crypto id when crypto.randomUUID is unavailable
 * (older Safari, non-secure contexts). Per-install uniqueness is enough —
 * the userId is only used as an Upstash filter literal.
 */
function newUserId(): string {
  if (
    typeof globalThis !== 'undefined' &&
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export const DEFAULT_MEMORY_CREDENTIALS: ChittiMemoryCredentials = {
  enabled: false,
  userId: newUserId(),
};

export const DEFAULT_ASR_CREDENTIALS: ChittiAsrCredentials = {
  provider: 'browser',
  model: 'whisper-large-v3',
};

export const DEFAULT_WAKE_WORD_CREDENTIALS: ChittiWakeWordCredentials = {
  enabled: false,
  keyword: 'jarvis',
  sensitivity: 0.5,
};

export const DEFAULT_SETTINGS: ChittiSettings = {
  llm: DEFAULT_LLM_CREDENTIALS,
  tts: DEFAULT_TTS_CREDENTIALS,
  voice: DEFAULT_VOICE_SETTINGS,
  memory: DEFAULT_MEMORY_CREDENTIALS,
  asr: DEFAULT_ASR_CREDENTIALS,
  wakeWord: DEFAULT_WAKE_WORD_CREDENTIALS,
};

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function loadSettings(): ChittiSettings {
  if (!isBrowser()) return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // First-time load — persist defaults so the freshly-minted memory
      // userId becomes stable across reloads. Without this, every page
      // reload would generate a new namespace and orphan prior memories.
      saveSettings(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<ChittiSettings>;
    // Merge with defaults so newly-added fields don't break existing users.
    const merged: ChittiSettings = {
      llm: { ...DEFAULT_LLM_CREDENTIALS, ...(parsed.llm ?? {}) },
      tts: { ...DEFAULT_TTS_CREDENTIALS, ...(parsed.tts ?? {}) },
      voice: { ...DEFAULT_VOICE_SETTINGS, ...(parsed.voice ?? {}) },
      memory: { ...DEFAULT_MEMORY_CREDENTIALS, ...(parsed.memory ?? {}) },
      asr: { ...DEFAULT_ASR_CREDENTIALS, ...(parsed.asr ?? {}) },
      wakeWord: { ...DEFAULT_WAKE_WORD_CREDENTIALS, ...(parsed.wakeWord ?? {}) },
    };
    // If a stored profile lacks a userId (e.g. user upgraded from a pre-memory
    // build) write one back so it's stable thereafter.
    if (!parsed.memory?.userId && merged.memory.userId) {
      saveSettings(merged);
    }
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: ChittiSettings): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* Quota exceeded or disabled — non-fatal. */
  }
}

export function patchSettings(patch: Partial<ChittiSettings>): ChittiSettings {
  const cur = loadSettings();
  const next: ChittiSettings = {
    llm: patch.llm ? { ...cur.llm, ...patch.llm } : cur.llm,
    tts: patch.tts ? { ...cur.tts, ...patch.tts } : cur.tts,
    voice: patch.voice ? { ...cur.voice, ...patch.voice } : cur.voice,
    memory: patch.memory ? { ...cur.memory, ...patch.memory } : cur.memory,
    asr: patch.asr ? { ...cur.asr, ...patch.asr } : cur.asr,
    wakeWord: patch.wakeWord
      ? { ...cur.wakeWord, ...patch.wakeWord }
      : cur.wakeWord,
  };
  saveSettings(next);
  return next;
}

export function clearSettings(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Build the LLM credentials envelope to send to /api/chat. If the user
 * hasn't entered a key, we send no credentials at all and the server
 * falls back to its env vars (so existing Vercel deployments keep working).
 */
export function getLlmRequestCredentials(): ChittiLlmCredentials | null {
  const { llm } = loadSettings();
  if (llm.provider === 'auto' && !llm.apiKey) return null;
  // Trim string fields so accidental whitespace from paste doesn't break auth.
  const trim = (s: string | undefined) => (typeof s === 'string' ? s.trim() : s);
  return {
    provider: llm.provider,
    apiKey: trim(llm.apiKey),
    baseUrl: trim(llm.baseUrl),
    model: trim(llm.model),
  };
}

export function getTtsRequestCredentials(): ChittiTtsCredentials | null {
  const { tts } = loadSettings();
  if (tts.provider === 'browser') return null;
  if (!tts.apiKey || tts.apiKey.trim().length === 0) return null;
  const trim = (s: string | undefined) => (typeof s === 'string' ? s.trim() : s);
  return {
    provider: tts.provider,
    apiKey: trim(tts.apiKey),
    voiceId: trim(tts.voiceId),
    modelId: trim(tts.modelId),
  };
}

/**
 * Build the memory credentials envelope to send to /api/chat (and /api/memory).
 * Returns `null` when memory is disabled or any required field is empty —
 * the route handlers treat null as "skip the long-term-memory layer entirely".
 */
export function getMemoryRequestCredentials(): ChittiMemoryCredentials | null {
  const { memory } = loadSettings();
  if (!memory.enabled) return null;
  const trim = (s: string | undefined) => (typeof s === 'string' ? s.trim() : s);
  const vectorUrl = trim(memory.vectorUrl);
  const vectorToken = trim(memory.vectorToken);
  const embeddingApiKey = trim(memory.embeddingApiKey);
  const userId = trim(memory.userId);
  if (!vectorUrl || !vectorToken || !embeddingApiKey || !userId) return null;
  return {
    enabled: true,
    vectorUrl,
    vectorToken,
    embeddingApiKey,
    userId,
  };
}

/**
 * Build the ASR credentials envelope for /api/asr. Returns null when the
 * user is on the default browser-Web-Speech path so the client can keep
 * using `createRecognition()` and skip the round-trip to Groq.
 */
export function getAsrRequestCredentials(): ChittiAsrCredentials | null {
  const { asr } = loadSettings();
  if (asr.provider !== 'groq') return null;
  if (!asr.apiKey || asr.apiKey.trim().length === 0) return null;
  const trim = (s: string | undefined) => (typeof s === 'string' ? s.trim() : s);
  return {
    provider: asr.provider,
    apiKey: trim(asr.apiKey),
    model: trim(asr.model),
    language: trim(asr.language),
  };
}

/** Convenience: provider-only setter for the radio buttons in Settings. */
export function setLlmProvider(provider: LlmProviderId): ChittiSettings {
  return patchSettings({ llm: { ...loadSettings().llm, provider } });
}

export function setTtsProvider(provider: TtsProviderId): ChittiSettings {
  return patchSettings({ tts: { ...loadSettings().tts, provider } });
}

export function setAsrProvider(provider: AsrProviderId): ChittiSettings {
  return patchSettings({ asr: { ...loadSettings().asr, provider } });
}
