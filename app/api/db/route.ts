/**
 * /api/db — schema inspection and read-only SQL execution.
 *
 *   GET  /api/db?op=tables                 -> { tables: TableSchema[] }
 *   GET  /api/db?op=describe&name=users    -> { schema: TableSchema }
 *   POST /api/db { op: 'query', sql: '…' } -> { result: QueryResult }
 *
 * Every request calls `seedIfNeeded()` first so the demo dataset is always
 * available on a fresh checkout.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { describeTable, listTables, runQuery } from '@/lib/db';
import { seedIfNeeded } from '@/lib/seed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TablesOpSchema = z.object({ op: z.literal('tables') });
const DescribeOpSchema = z.object({
  op: z.literal('describe'),
  name: z.string().min(1).max(128),
});
const QueryOpSchema = z.object({
  op: z.literal('query'),
  sql: z.string().min(1).max(8000),
});

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'Unknown error';
}

/* ─────────────────────────  GET  ───────────────────────── */

export async function GET(req: Request) {
  try {
    await seedIfNeeded();

    const url = new URL(req.url);
    const op = url.searchParams.get('op') ?? 'tables';

    if (op === 'tables') {
      const parsed = TablesOpSchema.safeParse({ op });
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'Invalid op' },
          { status: 400 },
        );
      }
      const tables = await listTables();
      return NextResponse.json({ tables });
    }

    if (op === 'describe') {
      const name = url.searchParams.get('name') ?? '';
      const parsed = DescribeOpSchema.safeParse({ op, name });
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'describe requires ?name=<table>' },
          { status: 400 },
        );
      }
      const schema = await describeTable(parsed.data.name);
      return NextResponse.json({ schema });
    }

    return NextResponse.json(
      { error: `Unknown GET op "${op}". Use tables or describe.` },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: errorMessage(e) },
      { status: 400 },
    );
  }
}

/* ─────────────────────────  POST  ───────────────────────── */

export async function POST(req: Request) {
  try {
    await seedIfNeeded();

    const raw = (await req.json().catch(() => null)) as unknown;
    if (!raw || typeof raw !== 'object') {
      return NextResponse.json(
        { error: 'Body must be JSON object' },
        { status: 400 },
      );
    }

    const body = raw as Record<string, unknown>;
    const op = body.op;

    if (op === 'tables') {
      const tables = await listTables();
      return NextResponse.json({ tables });
    }

    if (op === 'describe') {
      const parsed = DescribeOpSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'describe requires { op:"describe", name:string }' },
          { status: 400 },
        );
      }
      const schema = await describeTable(parsed.data.name);
      return NextResponse.json({ schema });
    }

    if (op === 'query') {
      const parsed = QueryOpSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'query requires { op:"query", sql:string }' },
          { status: 400 },
        );
      }
      const result = await runQuery(parsed.data.sql);
      return NextResponse.json({ result });
    }

    return NextResponse.json(
      { error: `Unknown POST op "${String(op)}". Use tables, describe, or query.` },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: errorMessage(e) },
      { status: 400 },
    );
  }
}
