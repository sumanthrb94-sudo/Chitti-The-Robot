/**
 * POST /api/tts
 *
 * Body: { text: string; credentials?: { apiKey?: string; voiceId?: string; modelId?: string } }
 *
 * Forwards the text to ElevenLabs and streams the MP3 audio back to the
 * browser. The user's API key arrives in the request body — we never
 * persist it; it's used for this single upstream call and forgotten.
 *
 * Env-var fallback (legacy single-tenant): ELEVENLABS_API_KEY,
 * ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID — used when the request omits
 * credentials.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const BodySchema = z.object({
  text: z.string().min(1).max(5000),
  credentials: z
    .object({
      provider: z.literal('elevenlabs').optional(),
      apiKey: z.string().min(8).optional(),
      voiceId: z.string().min(4).optional(),
      modelId: z.string().min(2).optional(),
    })
    .optional(),
});

const DEFAULT_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9'; // Daniel — British male
const DEFAULT_MODEL_ID = 'eleven_turbo_v2_5';

export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'bad_request', detail: parsed.error.message }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const apiKey = parsed.data.credentials?.apiKey ?? process.env.ELEVENLABS_API_KEY;
  const voiceId =
    parsed.data.credentials?.voiceId ??
    process.env.ELEVENLABS_VOICE_ID ??
    DEFAULT_VOICE_ID;
  const modelId =
    parsed.data.credentials?.modelId ??
    process.env.ELEVENLABS_MODEL_ID ??
    DEFAULT_MODEL_ID;

  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: 'no_credentials',
        message:
          'No ElevenLabs API key. Paste one into Chitti settings or set ELEVENLABS_API_KEY on the server.',
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Stream endpoint emits MP3 chunks as they're generated.
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?optimize_streaming_latency=2&output_format=mp3_44100_128`;

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: parsed.data.text,
      model_id: modelId,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.15,
        use_speaker_boost: true,
      },
    }),
    signal: request.signal,
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return new Response(
      JSON.stringify({
        error: 'elevenlabs_failed',
        status: upstream.status,
        detail: detail.slice(0, 500),
      }),
      {
        status: upstream.status === 401 ? 401 : 502,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  // Pipe the MP3 stream straight through to the browser.
  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
