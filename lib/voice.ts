/**
 * Browser-only Web Speech wrappers + ElevenLabs streaming TTS client.
 *
 * Server-safe — every function no-ops or returns null when window /
 * SpeechRecognition / speechSynthesis are missing.
 *
 * speak() picks the best available path:
 *   1. If the caller passes ElevenLabs credentials, stream audio from
 *      /api/tts and play it via <audio>.
 *   2. Otherwise use SpeechSynthesisUtterance, picking the most Jarvis-
 *      adjacent voice on the device (Daniel / UK Male / etc).
 */

import type { ChittiTtsCredentials, VoiceSettings } from '@/types';

/* ─────────────────────────  Capability checks  ───────────────────────── */

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function getSpeechRecognitionCtor():
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | (new () => any)
  | null {
  if (!isBrowser()) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | (new () => any)
    | null;
}

export function isVoiceInputSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

export function isVoiceOutputSupported(): boolean {
  return isBrowser() && typeof window.speechSynthesis !== 'undefined';
}

/* ─────────────────────────  Recognition (mic → text)  ───────────────────────── */

export interface RecognitionHandle {
  start(): void;
  stop(): void;
  abort(): void;
}

export interface CreateRecognitionOptions {
  onResult: (text: string, isFinal: boolean) => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
  continuous?: boolean;
  lang?: string;
}

export function createRecognition(
  opts: CreateRecognitionOptions,
): RecognitionHandle | null {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognition: any = new Ctor();
  recognition.continuous = opts.continuous ?? false;
  recognition.interimResults = true;
  recognition.lang = opts.lang ?? 'en-US';
  recognition.maxAlternatives = 1;

  let stopped = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recognition.onresult = (event: any) => {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0]?.transcript ?? '';
      if (result.isFinal) final += transcript;
      else interim += transcript;
    }
    if (final) opts.onResult(final.trim(), true);
    else if (interim) opts.onResult(interim.trim(), false);
  };

  recognition.onerror = (event: { error?: string }) => {
    opts.onError?.(event.error ?? 'unknown');
  };

  recognition.onend = () => {
    if (!stopped) opts.onEnd?.();
    stopped = false;
  };

  return {
    start: () => {
      try {
        recognition.start();
      } catch (e) {
        opts.onError?.(e instanceof Error ? e.message : 'start_failed');
      }
    },
    stop: () => {
      stopped = true;
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
      opts.onEnd?.();
    },
    abort: () => {
      stopped = true;
      try {
        recognition.abort();
      } catch {
        /* ignore */
      }
    },
  };
}

/* ─────────────────────────  Browser TTS (synthesis)  ───────────────────────── */

/**
 * Voice picker — preference order is JARVIS-FIRST:
 *   1. Apple "Daniel" (British male, the canonical Jarvis-adjacent voice)
 *   2. "Google UK English Male"
 *   3. Microsoft British male voices (George / Ryan / etc.)
 *   4. Any other en-GB voice
 *   5. Deep American males as a soft fallback (Alex, Microsoft David)
 *   6. Any English voice
 */
const VOICE_PREFERENCE: ReadonlyArray<{
  match: (v: SpeechSynthesisVoice) => boolean;
}> = [
  { match: (v) => v.name === 'Daniel' && v.lang.toLowerCase().startsWith('en') },
  { match: (v) => /google uk english male/i.test(v.name) },
  { match: (v) => /microsoft.+(george|ryan|liam|thomas)/i.test(v.name) },
  { match: (v) => v.lang.toLowerCase().startsWith('en-gb') },
  { match: (v) => v.name === 'Alex' && v.lang.toLowerCase().startsWith('en') },
  { match: (v) => /microsoft david/i.test(v.name) },
  { match: (v) => v.lang.toLowerCase().startsWith('en') },
];

let cachedVoices: SpeechSynthesisVoice[] | null = null;

export function getAvailableVoices(): SpeechSynthesisVoice[] {
  if (!isVoiceOutputSupported()) return [];
  const voices = window.speechSynthesis.getVoices();
  if (voices && voices.length > 0) {
    cachedVoices = voices;
    return voices;
  }
  return cachedVoices ?? [];
}

function primeVoices(): void {
  if (!isVoiceOutputSupported()) return;
  if (cachedVoices && cachedVoices.length > 0) return;
  const list = window.speechSynthesis.getVoices();
  if (list.length > 0) {
    cachedVoices = list;
    return;
  }
  const handler = () => {
    cachedVoices = window.speechSynthesis.getVoices();
    window.speechSynthesis.removeEventListener('voiceschanged', handler);
  };
  window.speechSynthesis.addEventListener('voiceschanged', handler);
}

function pickPreferredVoice(
  voices: SpeechSynthesisVoice[],
  desiredName?: string,
): SpeechSynthesisVoice | undefined {
  if (voices.length === 0) return undefined;
  if (desiredName) {
    const exact = voices.find((v) => v.name === desiredName);
    if (exact) return exact;
  }
  for (const pref of VOICE_PREFERENCE) {
    const hit = voices.find(pref.match);
    if (hit) return hit;
  }
  return voices[0];
}

/**
 * Chrome's SpeechSynthesis silently stops after ~15 seconds on long
 * utterances. Splitting on sentence boundaries and speaking each chunk
 * sequentially avoids that bug and gives a more natural cadence.
 */
function splitForSpeech(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  // Split on sentence-ending punctuation but keep the punctuation attached.
  const parts = trimmed.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [trimmed];
  // Merge short trailing fragments into the previous chunk so we don't
  // utter single-word artefacts.
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if (out.length > 0 && t.length < 12) {
      out[out.length - 1] += ' ' + t;
    } else {
      out.push(t);
    }
  }
  return out;
}

function speakOne(text: string, settings: VoiceSettings): Promise<void> {
  return new Promise((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    utterance.volume = settings.volume;

    const voices = getAvailableVoices();
    const chosen = pickPreferredVoice(voices, settings.voice);
    if (chosen) {
      utterance.voice = chosen;
      utterance.lang = chosen.lang;
    } else {
      utterance.lang = 'en-US';
    }

    utterance.onend = () => resolve();
    utterance.onerror = (e: SpeechSynthesisErrorEvent) => {
      if (e.error === 'interrupted' || e.error === 'canceled') resolve();
      else reject(new Error(`speak_error:${e.error ?? 'unknown'}`));
    };

    try {
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      reject(e instanceof Error ? e : new Error('speak_failed'));
    }
  });
}

async function speakBrowser(text: string, settings: VoiceSettings): Promise<void> {
  if (!isVoiceOutputSupported()) return;
  primeVoices();
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
  const chunks = splitForSpeech(text);
  for (const chunk of chunks) {
    // Each chunk is its own utterance so Chrome's 15s ceiling never bites.
    // eslint-disable-next-line no-await-in-loop
    await speakOne(chunk, settings);
  }
}

/* ─────────────────────────  ElevenLabs streaming TTS  ───────────────────────── */

let activeAudio: HTMLAudioElement | null = null;

async function speakElevenLabs(
  text: string,
  credentials: ChittiTtsCredentials,
): Promise<void> {
  if (!isBrowser()) return;

  // Stop any in-flight speech, browser or 11l.
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.src = '';
    activeAudio = null;
  }

  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, credentials }),
  });
  if (!res.ok || !res.body) {
    const err = await res.text().catch(() => 'tts_failed');
    throw new Error(`tts_http_${res.status}:${err.slice(0, 200)}`);
  }

  // Stream the audio bytes into a Blob URL. Could be upgraded to MediaSource
  // for true progressive playback later; this is plenty for sub-second TTS.
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);

  await new Promise<void>((resolve, reject) => {
    const audio = new Audio(url);
    activeAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (activeAudio === audio) activeAudio = null;
      resolve();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (activeAudio === audio) activeAudio = null;
      reject(new Error('audio_play_error'));
    };
    audio.play().catch((e) => {
      URL.revokeObjectURL(url);
      if (activeAudio === audio) activeAudio = null;
      reject(e instanceof Error ? e : new Error('audio_play_rejected'));
    });
  });
}

/**
 * Speak `text` using the best available path. Resolves on done, rejects on
 * a real error (interruption is treated as success). Pass ttsCredentials
 * to use ElevenLabs; omit them to use the browser's built-in synthesis.
 *
 * No-ops on the server / unsupported browsers.
 */
export async function speak(
  text: string,
  settings: VoiceSettings,
  ttsCredentials?: ChittiTtsCredentials | null,
): Promise<void> {
  if (!isBrowser()) return;
  const trimmed = text.trim();
  if (trimmed.length === 0) return;

  if (
    ttsCredentials &&
    ttsCredentials.provider === 'elevenlabs' &&
    ttsCredentials.apiKey &&
    ttsCredentials.apiKey.trim().length > 0
  ) {
    try {
      await speakElevenLabs(trimmed, ttsCredentials);
      return;
    } catch {
      // Soft-fallback to browser TTS so the assistant still vocalises.
      await speakBrowser(trimmed, settings);
      return;
    }
  }
  await speakBrowser(trimmed, settings);
}

export function cancelSpeech(): void {
  if (!isBrowser()) return;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.src = '';
    activeAudio = null;
  }
}
