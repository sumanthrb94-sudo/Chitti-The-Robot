/**
 * Browser-only Web Speech wrappers.
 * All functions are safe to import on the server — they no-op or return null
 * when window / SpeechRecognition / speechSynthesis are missing.
 */

import type { VoiceSettings } from '@/types';

/* ─────────────────────────  Capability checks  ───────────────────────── */

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function getSpeechRecognitionCtor():
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | (new () => any)
  | null {
  if (!isBrowser()) return null;
  // SpeechRecognition lives on window in Firefox / webkitSpeechRecognition in Chromium.
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

/**
 * Build a Web Speech recognition handle.
 * Returns null on the server or in browsers without SpeechRecognition.
 */
export function createRecognition(
  opts: CreateRecognitionOptions,
): RecognitionHandle | null {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) return null;

  // The Web Speech types aren't in lib.dom.d.ts in older TS targets;
  // we treat this as any. Marked clearly per the brief's constraint.
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
        // start() throws if already started — surface as error
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

/* ─────────────────────────  Synthesis (text → speech)  ───────────────────────── */

const VOICE_NAME_PRIORITY: ReadonlyArray<string> = [
  'Google',
  'Samantha',
  'Daniel',
  'Microsoft',
];

let cachedVoices: SpeechSynthesisVoice[] | null = null;

/**
 * Return available voices. Handles the async `voiceschanged` event:
 * the first call after page load often returns an empty list.
 */
export function getAvailableVoices(): SpeechSynthesisVoice[] {
  if (!isVoiceOutputSupported()) return [];
  const voices = window.speechSynthesis.getVoices();
  if (voices && voices.length > 0) {
    cachedVoices = voices;
    return voices;
  }
  return cachedVoices ?? [];
}

/** One-time wiring so cachedVoices is hot when speak() runs. */
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
  for (const needle of VOICE_NAME_PRIORITY) {
    const hit = voices.find(
      (v) => v.lang.toLowerCase().startsWith('en') && v.name.includes(needle),
    );
    if (hit) return hit;
  }
  const anyEnglish = voices.find((v) => v.lang.toLowerCase().startsWith('en'));
  return anyEnglish ?? voices[0];
}

/**
 * Speak `text` using `speechSynthesis`. Resolves on 'end', rejects on 'error'.
 * No-ops (resolves immediately) on the server or in unsupported browsers.
 */
export function speak(text: string, settings: VoiceSettings): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isVoiceOutputSupported()) {
      resolve();
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      resolve();
      return;
    }
    primeVoices();

    // Cancel anything currently speaking so we don't queue endlessly.
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }

    const utterance = new SpeechSynthesisUtterance(trimmed);
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
      // Some browsers fire "interrupted" when we cancel; treat as success.
      if (e.error === 'interrupted' || e.error === 'canceled') {
        resolve();
      } else {
        reject(new Error(`speak_error:${e.error ?? 'unknown'}`));
      }
    };

    try {
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      reject(e instanceof Error ? e : new Error('speak_failed'));
    }
  });
}

/** Cancel any in-flight speech synthesis. Safe on server. */
export function cancelSpeech(): void {
  if (!isVoiceOutputSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}
