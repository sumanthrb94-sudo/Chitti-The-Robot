/**
 * GET /api/info
 *
 * Lightweight read-only endpoint the UI hits on mount to discover which LLM
 * provider the server actually resolved to, plus a couple of environment
 * signals it uses to format helpful warnings.
 */

import { NextResponse } from 'next/server';

import { providerInfo } from '@/lib/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  const info = providerInfo();
  return NextResponse.json({
    provider: info.provider,
    brand: info.brand,
    model: info.model,
    openSource: info.openSource,
    hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasElevenLabsKey: Boolean(process.env.ELEVENLABS_API_KEY),
    openaiBaseUrl: process.env.OPENAI_BASE_URL || null,
    isVercel: process.env.VERCEL === '1',
    // Tools: list_tables, describe_table, query_database, visualize_data,
    // get_time, web_search, wikipedia_search, get_weather, get_crypto_price,
    // get_hackernews_top.
    toolCount: 10,
  });
}
