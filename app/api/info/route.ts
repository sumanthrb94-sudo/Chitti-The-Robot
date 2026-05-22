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
    model: info.model,
    openSource: info.openSource,
    hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
    isVercel: process.env.VERCEL === '1',
    toolCount: 10,
  });
}
