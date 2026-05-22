'use client';

/**
 * Whisper-grade ASR client. Records a short utterance from the user's
 * microphone via MediaRecorder, then ships the resulting Blob to
 * `/api/asr` which forwards it to Groq's hosted Whisper LPU.
 *
 * Returns null when the browser can't supply a mic / MediaRecorder so the
 * caller can fall back to the Web Speech API path in `lib/voice.ts`.
 *
 * iOS Safari only emits `audio/mp4` from MediaRecorder, so we feature-
 * detect and pick the first supported MIME from a small preference list.
 *
 * Server-safe — every browser API touch is guarded.
 */

import type { ChittiAsrCredentials } from '@/types';

/* ─────────────────────────  Public surface  ───────────────────────── */

export interface AsrTranscript {
  text: string;
  durationMs: number;
}

export interface AsrRecorderHandle {
  /** Begin capturing mic audio. Resolves once recording is live. */
  start(): Promise<void>;
  /** Stop capturing and resolve with the Groq transcript. */
  stop(): Promise<AsrTranscript>;
  /** Discard the buffered audio and release the mic without uploading. */
  cancel(): void;
}

export interface CreateAsrRecorderOptions {
  credentials: ChittiAsrCredentials;
  /** Called when a final transcript arrives. */
  onTranscript: (text: string) => void;
  /** Called on any non-cancel failure (network, mic perms, upstream). */
  onError?: (err: Error) => void;
  /** Cap recording duration to this many ms (default 15000). */
  maxMs?: number;
}

/* ─────────────────────────  Capability checks  ───────────────────────── */

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/**
 * MediaRecorder MIME preference. Opus-in-WebM is small and well-supported
 * in Chrome / Firefox / Edge; mp4 is the iOS Safari fallback. The bare
 * 'audio/webm' and 'audio/mp4' entries cover devices that don't advertise
 * the codec suffix.
 */
const MIME_CANDIDATES: ReadonlyArray<string> = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

function pickSupportedMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const candidate of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // Some shims throw on unknown codecs — keep probing.
    }
  }
  // Empty string lets MediaRecorder fall back to its default container.
  // We still return it so the recorder runs on quirky devices.
  return '';
}

export function isAsrSupported(): boolean {
  if (!isBrowser()) return false;
  if (typeof MediaRecorder === 'undefined') return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  return true;
}

/* ─────────────────────────  Upload  ───────────────────────── */

async function uploadForTranscription(
  blob: Blob,
  credentials: ChittiAsrCredentials,
): Promise<AsrTranscript> {
  // Strip out anything but the BYO-key envelope so we never leak unrelated
  // settings into the request body.
  const credsEnvelope: ChittiAsrCredentials = {
    provider: credentials.provider,
    apiKey: credentials.apiKey,
    model: credentials.model,
    language: credentials.language,
  };

  const form = new FormData();
  form.set('file', blob, 'utterance');
  form.set('credentials', JSON.stringify(credsEnvelope));

  const res = await fetch('/api/asr', {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      detail = body.message || body.error || '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(
      `asr_http_${res.status}${detail ? `:${detail.slice(0, 200)}` : ''}`,
    );
  }

  const payload = (await res.json()) as { text?: unknown; durationMs?: unknown };
  const text = typeof payload.text === 'string' ? payload.text : '';
  const durationMs =
    typeof payload.durationMs === 'number' ? payload.durationMs : 0;
  return { text, durationMs };
}

/* ─────────────────────────  Recorder factory  ───────────────────────── */

export async function createAsrRecorder(
  opts: CreateAsrRecorderOptions,
): Promise<AsrRecorderHandle | null> {
  if (!isAsrSupported()) return null;

  const maxMs = Math.max(1_000, opts.maxMs ?? 15_000);
  const mime = pickSupportedMime();
  if (mime === null) return null;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    opts.onError?.(e instanceof Error ? e : new Error('mic_permission_denied'));
    return null;
  }

  // Some browsers reject the `mimeType` option entirely if it's empty — only
  // pass it when we have a real candidate.
  let recorder: MediaRecorder;
  try {
    recorder = mime
      ? new MediaRecorder(stream, { mimeType: mime })
      : new MediaRecorder(stream);
  } catch (e) {
    releaseStream(stream);
    opts.onError?.(
      e instanceof Error ? e : new Error('media_recorder_unavailable'),
    );
    return null;
  }

  const chunks: Blob[] = [];
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let stopResolve: ((value: AsrTranscript) => void) | null = null;
  let stopReject: ((reason: Error) => void) | null = null;
  let cancelled = false;
  let started = false;
  let stopped = false;

  const clearTimer = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  recorder.onerror = (event: Event) => {
    clearTimer();
    releaseStream(stream);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (event as any).error;
    const err =
      raw instanceof Error
        ? raw
        : new Error(typeof raw === 'string' ? raw : 'media_recorder_error');
    if (stopReject) {
      const reject = stopReject;
      stopResolve = null;
      stopReject = null;
      reject(err);
    } else {
      opts.onError?.(err);
    }
  };

  recorder.onstop = () => {
    clearTimer();
    releaseStream(stream);

    if (cancelled) {
      stopResolve = null;
      stopReject = null;
      return;
    }

    const blobType = mime || chunks[0]?.type || 'audio/webm';
    const blob = new Blob(chunks, { type: blobType });

    const resolve = stopResolve;
    const reject = stopReject;
    stopResolve = null;
    stopReject = null;

    if (blob.size === 0) {
      const err = new Error('asr_no_audio');
      if (reject) reject(err);
      else opts.onError?.(err);
      return;
    }

    uploadForTranscription(blob, opts.credentials)
      .then((result) => {
        opts.onTranscript(result.text);
        resolve?.(result);
      })
      .catch((e) => {
        const err = e instanceof Error ? e : new Error('asr_upload_failed');
        if (reject) reject(err);
        else opts.onError?.(err);
      });
  };

  return {
    async start() {
      if (started) return;
      started = true;
      try {
        recorder.start();
      } catch (e) {
        releaseStream(stream);
        throw e instanceof Error ? e : new Error('recorder_start_failed');
      }
      // Auto-stop after maxMs so a forgotten recording can't pin the mic
      // indefinitely. The stop() promise (if any) still resolves normally.
      timeoutId = setTimeout(() => {
        if (recorder.state === 'recording') {
          try {
            recorder.stop();
          } catch {
            /* ignore */
          }
        }
      }, maxMs);
    },

    stop() {
      return new Promise<AsrTranscript>((resolve, reject) => {
        if (stopped) {
          reject(new Error('already_stopped'));
          return;
        }
        stopped = true;
        stopResolve = resolve;
        stopReject = reject;
        clearTimer();

        if (recorder.state === 'recording') {
          try {
            recorder.stop();
          } catch (e) {
            releaseStream(stream);
            stopResolve = null;
            stopReject = null;
            reject(e instanceof Error ? e : new Error('recorder_stop_failed'));
          }
        } else if (recorder.state === 'inactive') {
          // Recorder already fired onstop (e.g. auto-stop just landed).
          // onstop will pick up the pending stopResolve/stopReject.
        }
      });
    },

    cancel() {
      cancelled = true;
      clearTimer();
      if (recorder.state === 'recording') {
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
      releaseStream(stream);
      stopResolve = null;
      stopReject = null;
    },
  };
}

/* ─────────────────────────  Helpers  ───────────────────────── */

function releaseStream(stream: MediaStream): void {
  try {
    stream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}
