/**
 * POST /api/asr
 *
 * Forwards a recorded audio blob to Groq's OpenAI-compatible Whisper
 * endpoint and returns the transcript. Two body shapes are accepted:
 *
 *   1. multipart/form-data    (preferred — no base64 overhead)
 *      - field `file`         : the audio Blob (webm/opus, mp4, wav, ...)
 *      - field `credentials`  : JSON-serialised ChittiAsrCredentials
 *
 *   2. application/json
 *      - { audioBase64: string, mimeType?: string, credentials }
 *
 * Auth: BYO Groq key from `credentials.apiKey`, falling back to
 * `process.env.GROQ_API_KEY`. Never persisted, never logged.
 *
 * Response: { text: string, durationMs: number }
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_MODEL = 'whisper-large-v3';
// 25MB matches Groq's documented file ceiling. Hard-limit so a stuck mic
// can't fire a multi-GB payload at the upstream and waste an LPU slot.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const CredentialsSchema = z.object({
  provider: z.literal('groq').optional(),
  apiKey: z.string().min(8).optional(),
  model: z.string().min(2).optional(),
  language: z.string().min(2).max(8).optional(),
});

const JsonBodySchema = z.object({
  audioBase64: z.string().min(8),
  mimeType: z.string().min(3).max(80).optional(),
  credentials: CredentialsSchema.optional(),
});

type ParsedCredentials = z.infer<typeof CredentialsSchema>;

interface ParsedInput {
  audio: Blob;
  filename: string;
  credentials: ParsedCredentials | undefined;
}

function jsonError(
  body: Record<string, unknown>,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Best-effort filename extension so Groq's parser can sniff the codec. */
function pickFilename(mimeType: string | undefined): string {
  if (!mimeType) return 'audio.webm';
  const m = mimeType.toLowerCase();
  if (m.includes('mp4') || m.includes('m4a')) return 'audio.mp4';
  if (m.includes('mpeg') || m.includes('mp3')) return 'audio.mp3';
  if (m.includes('wav')) return 'audio.wav';
  if (m.includes('ogg')) return 'audio.ogg';
  return 'audio.webm';
}

async function readMultipart(request: NextRequest): Promise<ParsedInput | Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError({ error: 'invalid_form_data' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof Blob)) {
    return jsonError({ error: 'missing_file' }, 400);
  }
  if (file.size === 0) {
    return jsonError({ error: 'empty_audio' }, 400);
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return jsonError(
      { error: 'audio_too_large', maxBytes: MAX_AUDIO_BYTES },
      413,
    );
  }

  let credentials: ParsedCredentials | undefined;
  const credsRaw = form.get('credentials');
  if (typeof credsRaw === 'string' && credsRaw.length > 0) {
    try {
      const parsed = CredentialsSchema.safeParse(JSON.parse(credsRaw));
      if (!parsed.success) {
        return jsonError(
          { error: 'bad_credentials', detail: parsed.error.message },
          400,
        );
      }
      credentials = parsed.data;
    } catch {
      return jsonError({ error: 'bad_credentials_json' }, 400);
    }
  }

  // Prefer the upload's own name if present; otherwise infer from MIME.
  const uploadedName =
    file instanceof File && file.name ? file.name : pickFilename(file.type);

  return { audio: file, filename: uploadedName, credentials };
}

async function readJson(request: NextRequest): Promise<ParsedInput | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError({ error: 'invalid_json' }, 400);
  }
  const parsed = JsonBodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      { error: 'bad_request', detail: parsed.error.message },
      400,
    );
  }
  const { audioBase64, mimeType, credentials } = parsed.data;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(audioBase64, 'base64');
  } catch {
    return jsonError({ error: 'bad_base64' }, 400);
  }
  if (bytes.byteLength === 0) {
    return jsonError({ error: 'empty_audio' }, 400);
  }
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    return jsonError(
      { error: 'audio_too_large', maxBytes: MAX_AUDIO_BYTES },
      413,
    );
  }
  const type = mimeType ?? 'audio/webm';
  // Copy into a fresh ArrayBuffer so the Blob sees a strict ArrayBuffer
  // (not ArrayBufferLike/SharedArrayBuffer). Necessary because Node's
  // Buffer types as Buffer<ArrayBufferLike> under strict TS and that
  // shape isn't assignable to BlobPart.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const blob = new Blob([ab], { type });
  return { audio: blob, filename: pickFilename(type), credentials };
}

export async function POST(request: NextRequest): Promise<Response> {
  const started = Date.now();

  const contentType = request.headers.get('content-type') ?? '';
  const input = contentType.includes('multipart/form-data')
    ? await readMultipart(request)
    : await readJson(request);
  if (input instanceof Response) return input;

  const apiKey =
    input.credentials?.apiKey?.trim() || process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    return jsonError(
      {
        error: 'no_credentials',
        message: 'Paste a Groq key in Chitti Settings → VOICE tab.',
      },
      401,
    );
  }

  const model =
    (input.credentials?.model && input.credentials.model.trim()) ||
    DEFAULT_MODEL;
  const language = input.credentials?.language?.trim();

  // Build an OpenAI-shaped multipart request for Groq's endpoint.
  const upstreamForm = new FormData();
  upstreamForm.set('file', input.audio, input.filename);
  upstreamForm.set('model', model);
  upstreamForm.set('response_format', 'json');
  if (language) upstreamForm.set('language', language);
  // Temperature 0 → deterministic transcription, no creative hallucination.
  upstreamForm.set('temperature', '0');

  let upstream: Response;
  try {
    upstream = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstreamForm,
      signal: request.signal,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'fetch_failed';
    if (e instanceof DOMException && e.name === 'AbortError') {
      return jsonError({ error: 'aborted' }, 499);
    }
    return jsonError(
      { error: 'upstream_unreachable', detail: message.slice(0, 200) },
      502,
    );
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return jsonError(
      {
        error: 'groq_failed',
        status: upstream.status,
        detail: detail.slice(0, 500),
      },
      upstream.status === 401 ? 401 : 502,
    );
  }

  // Groq returns { text: "..." } for response_format=json.
  let payload: { text?: unknown };
  try {
    payload = (await upstream.json()) as { text?: unknown };
  } catch {
    return jsonError({ error: 'invalid_upstream_response' }, 502);
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const durationMs = Date.now() - started;

  console.log(
    `[chitti] asr provider=groq model=${model} bytes=${input.audio.size} ms=${durationMs} ok=1`,
  );

  return new Response(JSON.stringify({ text, durationMs }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
