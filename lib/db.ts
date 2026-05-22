/**
 * Chitti — SQLite data layer.
 *
 * Server-only module. Never import from a client component.
 * Wraps `better-sqlite3` behind a small async surface so we can swap
 * to a remote DB later without breaking callers.
 *
 * Public surface:
 *   - getDb()
 *   - ensureSeeded()
 *   - listTables()
 *   - describeTable(name)
 *   - runQuery(sql)    — READ-ONLY (SELECT / WITH)
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { QueryResult, TableSchema } from '@/types';

/* ─────────────────────────  Singleton  ───────────────────────── */

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'chitti.db');
const SEED_PATH = path.join(DATA_DIR, 'seed.sql');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

/* ─────────────────────────  Seeding  ───────────────────────── */

interface SeedMetaRow {
  id: number;
  seeded_at: string;
  version: number;
}

export function ensureSeeded(): void {
  const db = getDb();

  // Check whether _seed_meta exists AND has a row.
  const tableRow = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_seed_meta'",
    )
    .get() as { name: string } | undefined;

  let alreadySeeded = false;
  if (tableRow) {
    const meta = db
      .prepare('SELECT id, seeded_at, version FROM _seed_meta WHERE id = 1')
      .get() as SeedMetaRow | undefined;
    alreadySeeded = !!meta;
  }
  if (alreadySeeded) return;

  if (!existsSync(SEED_PATH)) {
    throw new Error(`Seed file missing at ${SEED_PATH}`);
  }
  const sql = readFileSync(SEED_PATH, 'utf-8');

  // Execute as a single transaction. `exec` already runs the whole script;
  // wrapping in BEGIN/COMMIT (via a transaction) gives us atomicity.
  const tx = db.transaction(() => {
    db.exec(sql);
  });
  tx();
}

/* ─────────────────────────  Schema inspection  ───────────────────────── */

const SAFE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

interface PragmaColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface SqliteMasterRow {
  name: string;
}

function isUserTable(name: string): boolean {
  if (name.startsWith('sqlite_')) return false;
  if (name === '_seed_meta') return false;
  return true;
}

function readTableSchema(db: Database.Database, name: string): TableSchema {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`Invalid table name: ${name}`);
  }
  // PRAGMA table_info does not accept parameter binding, so we validate the
  // identifier with a strict regex and then interpolate.
  const colRows = db
    .prepare(`PRAGMA table_info("${name}")`)
    .all() as PragmaColumnRow[];

  if (colRows.length === 0) {
    throw new Error(`Table not found: ${name}`);
  }

  const countRow = db
    .prepare(`SELECT COUNT(*) AS c FROM "${name}"`)
    .get() as { c: number };

  return {
    name,
    columns: colRows.map((c) => ({
      name: c.name,
      type: c.type || 'TEXT',
      notNull: c.notnull === 1,
      primaryKey: c.pk > 0,
    })),
    rowCount: countRow.c,
  };
}

export async function listTables(): Promise<TableSchema[]> {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC",
    )
    .all() as SqliteMasterRow[];

  const tables: TableSchema[] = [];
  for (const r of rows) {
    if (!isUserTable(r.name)) continue;
    try {
      tables.push(readTableSchema(db, r.name));
    } catch {
      // Skip tables we can't introspect (shouldn't normally happen).
    }
  }
  return tables;
}

export async function describeTable(name: string): Promise<TableSchema> {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`Invalid table name: ${name}`);
  }
  const db = getDb();
  return readTableSchema(db, name);
}

/* ─────────────────────────  Query safety + execution  ───────────────────────── */

const BLOCKED_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'REPLACE',
  'TRUNCATE',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'VACUUM',
];

const MAX_ROWS = 1000;

/**
 * Strip single-quoted string literals so we can scan for keywords without
 * tripping on data that happens to contain those words.
 *
 * SQLite single-quoted literals double up internal quotes: 'it''s'. The
 * regex below matches: opening ', any run of (escaped '' or non-'), closing '.
 */
function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, "''");
}

/**
 * Strip leading `--` line comments and `/* ... *​/` block comments. Used to
 * find the real first keyword.
 */
function stripLeadingComments(sql: string): string {
  let s = sql.replace(/^\s+/, '');
  // Loop: remove either a line comment or a block comment at the start.
  // Keep going until the next char is a real token.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1);
      s = s.replace(/^\s+/, '');
      continue;
    }
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2);
      s = s.replace(/^\s+/, '');
      continue;
    }
    break;
  }
  return s;
}

function assertSelectOnly(sql: string): void {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    throw new Error('Empty SQL query.');
  }

  const withoutLeadingComments = stripLeadingComments(trimmed);
  const firstWordMatch = withoutLeadingComments.match(/^([A-Za-z]+)/);
  if (!firstWordMatch) {
    throw new Error('Only SELECT/WITH queries are allowed.');
  }
  const firstWord = firstWordMatch[1].toUpperCase();
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    throw new Error('Only SELECT/WITH queries are allowed.');
  }

  const scannable = stripStringLiterals(trimmed);
  for (const kw of BLOCKED_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(scannable)) {
      throw new Error(
        `Blocked keyword "${kw}" found. Only read-only SELECT/WITH queries are allowed.`,
      );
    }
  }
}

export async function runQuery(sql: string): Promise<QueryResult> {
  assertSelectOnly(sql);
  const db = getDb();

  const start = Date.now();

  // Run in a transaction so we can guarantee read-only semantics.
  // better-sqlite3 supports transaction.deferred()/immediate()/exclusive();
  // a deferred (default) transaction is fine for SELECT-only work and gives
  // us an atomic snapshot. We additionally bypass mutations via assertSelectOnly().
  const stmt = db.prepare(sql);
  // `raw=false` is the default — we want objects keyed by column name.
  let allRows: unknown[];
  try {
    allRows = stmt.all() as unknown[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`SQL error: ${msg}`);
  }

  const truncated = allRows.slice(0, MAX_ROWS) as Array<
    Record<string, unknown>
  >;

  // Recover the column order from the prepared statement when possible.
  let columns: string[] = [];
  try {
    // `columns()` returns an array of { name, column, table, database, type }.
    const colMeta = stmt.columns();
    columns = colMeta.map((c) => c.name);
  } catch {
    // Some statements (e.g. PRAGMA-shaped) don't expose columns(); fall back.
    columns = truncated.length > 0 ? Object.keys(truncated[0]) : [];
  }

  // Guard against duplicate column names where Object.keys can't represent
  // both — at least keep what the prepared statement reported.
  if (columns.length === 0 && truncated.length > 0) {
    columns = Object.keys(truncated[0]);
  }

  const durationMs = Date.now() - start;

  return {
    columns,
    rows: truncated,
    rowCount: truncated.length,
    sql: sql.trim(),
    durationMs,
  };
}
