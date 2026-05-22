/**
 * Standalone seed runner.
 *
 * Usage:  npx tsx scripts/seed.ts
 *
 * Idempotent — checks `_seed_meta` and bails if already populated.
 */

import { ensureSeeded, listTables } from '@/lib/db';

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log('[chitti seed] checking database…');
  ensureSeeded();
  const tables = await listTables();
  const elapsed = Date.now() - startedAt;

  console.log(`[chitti seed] done in ${elapsed}ms — ${tables.length} tables:`);
  for (const t of tables) {
    console.log(`  • ${t.name.padEnd(14)} ${t.rowCount.toString().padStart(5)} rows`);
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[chitti seed] error: ${msg}`);
  process.exit(1);
});
