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
  ChittiLlmCredentials,
  ChittiSettings,
  ChittiTtsCredentials,
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

export const DEFAULT_SETTINGS: ChittiSettings = {
  llm: DEFAULT_LLM_CREDENTIALS,
  tts: DEFAULT_TTS_CREDENTIALS,
  voice: DEFAULT_VOICE_SETTINGS,
};

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function loadSettings(): ChittiSettings {
  if (!isBrowser()) return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ChittiSettings>;
    // Merge with defaults so newly-added fields don't break existing users.
    return {
      llm: { ...DEFAULT_LLM_CREDENTIALS, ...(parsed.llm ?? {}) },
      tts: { ...DEFAULT_TTS_CREDENTIALS, ...(parsed.tts ?? {}) },
      voice: { ...DEFAULT_VOICE_SETTINGS, ...(parsed.voice ?? {}) },
    };
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

/** Convenience: provider-only setter for the radio buttons in Settings. */
export function setLlmProvider(provider: LlmProviderId): ChittiSettings {
  return patchSettings({ llm: { ...loadSettings().llm, provider } });
}

export function setTtsProvider(provider: TtsProviderId): ChittiSettings {
  return patchSettings({ tts: { ...loadSettings().tts, provider } });
}
