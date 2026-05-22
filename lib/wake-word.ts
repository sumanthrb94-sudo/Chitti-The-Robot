/**
 * Wake-word detection wrapper around Picovoice Porcupine Web.
 *
 * Loads the WASM blob lazily (dynamic import) so users who never enable
 * wake-word pay zero startup cost. The handle exposes start/stop semantics
 * suitable for a React effect lifecycle.
 *
 * Browser-only. SSR-safe — `createWakeWord` returns null when window is
 * undefined or the user denies microphone permission.
 *
 * Reference: https://picovoice.ai/docs/quick-start/porcupine-web/
 *   PorcupineWorker.create(accessKey, keywords, callback) → worker.
 *   WebVoiceProcessor.subscribe(worker) wires the mic stream in.
 */
'use client';

import type { ChittiWakeWordCredentials } from '@/types';

export interface WakeWordHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Whether the listener is currently armed. */
  isActive(): boolean;
}

export interface CreateWakeWordOptions {
  accessKey: string;
  keyword: ChittiWakeWordCredentials['keyword'];
  sensitivity: number;
  onWake: () => void;
  onError?: (err: Error) => void;
}

/**
 * Map a Chitti keyword string to Porcupine's BuiltInKeyword enum entry.
 * Returned at call time because the enum lives inside the dynamic
 * import — we can't reference it statically without forcing the WASM
 * blob into the initial bundle.
 */
function keywordToBuiltIn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  BuiltInKeyword: any,
  keyword: ChittiWakeWordCredentials['keyword'],
): unknown {
  switch (keyword) {
    case 'jarvis':
      return BuiltInKeyword.Jarvis;
    case 'alexa':
      return BuiltInKeyword.Alexa;
    case 'computer':
      return BuiltInKeyword.Computer;
    case 'hey siri':
      return BuiltInKeyword.HeySiri;
    case 'ok google':
      return BuiltInKeyword.OkayGoogle;
    case 'porcupine':
      return BuiltInKeyword.Porcupine;
    case 'bumblebee':
      return BuiltInKeyword.Bumblebee;
    case 'grasshopper':
      return BuiltInKeyword.Grasshopper;
    case 'terminator':
      return BuiltInKeyword.Terminator;
    case 'picovoice':
      return BuiltInKeyword.Picovoice;
    case 'blueberry':
      return BuiltInKeyword.Blueberry;
    case 'americano':
      return BuiltInKeyword.Americano;
    default:
      return BuiltInKeyword.Jarvis;
  }
}

/**
 * Clamp the user-supplied sensitivity into Porcupine's accepted [0, 1]
 * range. Default to 0.5 if the value is NaN / undefined.
 */
function clampSensitivity(s: number): number {
  if (!Number.isFinite(s)) return 0.5;
  if (s < 0) return 0;
  if (s > 1) return 1;
  return s;
}

/**
 * Create a wake-word listener. Returns null on any setup failure
 * (no browser, package missing, mic denied, etc.) — the caller should
 * inspect the `onError` callback for diagnostics.
 *
 * Caller is responsible for invoking `start()` after a user gesture
 * (browser autoplay policy) and `stop()` on unmount / settings change.
 */
export async function createWakeWord(
  opts: CreateWakeWordOptions,
): Promise<WakeWordHandle | null> {
  if (typeof window === 'undefined') return null;
  if (!opts.accessKey || opts.accessKey.trim().length === 0) {
    opts.onError?.(new Error('wake_word_no_access_key'));
    return null;
  }

  // Dynamic imports so the WASM bundle is fetched lazily.
  // Vendor packages — schemas may not be installed during typecheck;
  // we treat the modules as `any` and ignore eslint for that line.
  let PorcupineWorker: {
    create: (
      accessKey: string,
      keywords: Array<{ builtin: unknown; sensitivity: number; label?: string }>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callback: (detection: { label: string }) => void,
    ) => Promise<{
      release: () => Promise<void>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any;
    }>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let BuiltInKeyword: any;
  let WebVoiceProcessor: {
    instance: () => Promise<{
      subscribe: (worker: unknown) => Promise<void>;
      unsubscribe: (worker: unknown) => Promise<void>;
    }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const porcupineMod: any = await import(
      /* webpackChunkName: "porcupine" */ '@picovoice/porcupine-web'
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wvpMod: any = await import(
      /* webpackChunkName: "web-voice-processor" */ '@picovoice/web-voice-processor'
    );
    PorcupineWorker = porcupineMod.PorcupineWorker;
    BuiltInKeyword = porcupineMod.BuiltInKeyword;
    WebVoiceProcessor = wvpMod.WebVoiceProcessor;
    if (!PorcupineWorker || !BuiltInKeyword || !WebVoiceProcessor) {
      throw new Error('wake_word_module_shape_unexpected');
    }
  } catch (e) {
    opts.onError?.(
      e instanceof Error ? e : new Error('wake_word_import_failed'),
    );
    return null;
  }

  const builtin = keywordToBuiltIn(BuiltInKeyword, opts.keyword);
  const sensitivity = clampSensitivity(opts.sensitivity);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let worker: any = null;
  let active = false;

  try {
    worker = await PorcupineWorker.create(
      opts.accessKey.trim(),
      [{ builtin, sensitivity, label: String(opts.keyword) }],
      // Detection callback — Porcupine fires this every time the
      // keyword crosses the sensitivity threshold.
      () => {
        try {
          opts.onWake();
        } catch (err) {
          opts.onError?.(
            err instanceof Error ? err : new Error('wake_word_callback_threw'),
          );
        }
      },
    );
  } catch (e) {
    opts.onError?.(
      e instanceof Error ? e : new Error('wake_word_worker_create_failed'),
    );
    return null;
  }

  const start = async (): Promise<void> => {
    if (active) return;
    try {
      const wvp = await WebVoiceProcessor.instance();
      await wvp.subscribe(worker);
      active = true;
    } catch (e) {
      // Mic permission denied, busy, etc.
      opts.onError?.(
        e instanceof Error ? e : new Error('wake_word_subscribe_failed'),
      );
      active = false;
    }
  };

  const stop = async (): Promise<void> => {
    if (!active && !worker) return;
    try {
      const wvp = await WebVoiceProcessor.instance();
      await wvp.unsubscribe(worker);
    } catch {
      /* ignore — we still want to release the worker */
    }
    active = false;
    try {
      if (worker && typeof worker.release === 'function') {
        await worker.release();
      }
    } catch {
      /* ignore */
    }
    worker = null;
  };

  return {
    start,
    stop,
    isActive: () => active,
  };
}
