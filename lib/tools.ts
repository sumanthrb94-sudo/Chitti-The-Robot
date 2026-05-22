/**
 * Chitti tool schemas + server-side executor.
 *
 * Tool schemas follow Anthropic's tool-use format:
 *   { name, description, input_schema: { type: 'object', properties, required } }
 *
 * `executeTool` is the dispatcher used by the agentic loop in `lib/claude.ts`.
 * It calls into `@/lib/db` for data tools and returns artifacts for visualizations.
 */

import {
  getCryptoPrice,
  getHackerNewsTop,
  getWeather,
  webSearch,
  wikipediaSearch,
} from '@/lib/connectors';
import { describeTable, listTables, runQuery } from '@/lib/db';
import type {
  Artifact,
  ChartData,
  ChartType,
  ToolDefinition,
  ToolName,
} from '@/types';

/* ─────────────────────────  Schemas  ───────────────────────── */

export const CHITTI_TOOLS: ToolDefinition[] = [
  {
    name: 'list_tables',
    description:
      'List every table in the local SQLite database, with column metadata and row counts. Use this when the user asks an ambiguous data question and you do not yet know what data exists.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'describe_table',
    description:
      'Return the schema (columns, types, nullability, primary keys) and row count for a single table. Call this before crafting SQL against an unfamiliar table.',
    input_schema: {
      type: 'object',
      properties: {
        table_name: {
          type: 'string',
          description: 'Exact name of the table to describe.',
        },
      },
      required: ['table_name'],
    },
  },
  {
    name: 'query_database',
    description:
      'Execute a single read-only SQL SELECT against the local SQLite database and return the rows. Mutating statements (INSERT, UPDATE, DELETE, DROP, etc.) will be rejected by the runtime.',
    input_schema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'A single SQL SELECT statement.',
        },
        reason: {
          type: 'string',
          description:
            'One-sentence explanation of what this query is meant to answer. Helps with logging and debugging.',
        },
      },
      required: ['sql', 'reason'],
    },
  },
  {
    name: 'visualize_data',
    description:
      'Render a chart artifact for the UI. Use after a query when the data tells a clear visual story (trend, ranking, distribution). Pass the rows you want plotted along with the keys to chart.',
    input_schema: {
      type: 'object',
      properties: {
        chart_type: {
          type: 'string',
          enum: ['bar', 'line', 'area', 'pie'],
          description:
            'Chart kind. Use bar for category comparisons, line or area for trends over time, pie for small share-of-total breakdowns.',
        },
        title: {
          type: 'string',
          description: 'Short human-readable title for the chart.',
        },
        x_key: {
          type: 'string',
          description: 'Field name in each row used as the x-axis / category.',
        },
        y_keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more field names in each row to plot on the y-axis.',
        },
        rows: {
          type: 'array',
          description:
            'The data rows to plot. Each row is an object whose keys include x_key and every entry in y_keys.',
          items: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
      required: ['chart_type', 'title', 'x_key', 'y_keys', 'rows'],
    },
  },
  {
    name: 'get_time',
    description:
      'Return the current date and time. Optionally accepts an IANA timezone (e.g. "America/Los_Angeles", "Asia/Kolkata"). Defaults to the host timezone.',
    input_schema: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description:
            'IANA timezone identifier. Omit to use the server\'s local timezone.',
        },
      },
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web via DuckDuckGo\'s Instant Answer API (no API key required). Best for factual lookups — returns an abstract paragraph and related links. Falls back gracefully when no instant answer is available.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query in natural language.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'wikipedia_search',
    description:
      'Fetch the Wikipedia summary for a topic. More reliable than web_search for well-known concepts (people, places, science, history). Returns title, extract paragraph, and article URL.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Topic, name, or concept to look up (e.g. "Iron Man", "SQLite", "Tony Stark").',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_weather',
    description:
      'Current weather for any city in the world via Open-Meteo (no API key required). Returns temperature in °C, apparent temperature, humidity, wind speed in km/h, and a human-readable condition.',
    input_schema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City or place name (e.g. "Bangalore", "San Francisco", "Tokyo").',
        },
      },
      required: ['location'],
    },
  },
  {
    name: 'get_crypto_price',
    description:
      'Current price for a cryptocurrency via CoinGecko (no API key required). Returns price, 24h change %, and market cap. Common shorthands accepted (btc, eth, sol, doge, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Coin symbol or name (e.g. "btc", "bitcoin", "eth", "solana").',
        },
        vs_currency: {
          type: 'string',
          description: 'Quote currency code. Defaults to "usd".',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_hackernews_top',
    description:
      'Fetch the top stories from Hacker News right now. Use when asked what is trending in tech / startups. Returns title, URL, score, comment count for each story.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'How many stories to return (1-15). Defaults to 5.',
        },
      },
    },
  },
];

/* ─────────────────────────  Executor  ───────────────────────── */

export type ToolExecutionResult =
  | { ok: true; result: unknown; artifact?: Artifact }
  | { ok: false; error: string };

const CHART_TYPES: readonly ChartType[] = ['bar', 'line', 'area', 'pie'];

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return 'Unknown error';
  }
}

export async function executeTool(
  name: ToolName,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    switch (name) {
      case 'list_tables': {
        const tables = await listTables();
        return { ok: true, result: { tables } };
      }

      case 'describe_table': {
        const tableName = input?.table_name;
        if (typeof tableName !== 'string' || tableName.length === 0) {
          return { ok: false, error: 'table_name (string) is required' };
        }
        const schema = await describeTable(tableName);
        return { ok: true, result: schema };
      }

      case 'query_database': {
        const sql = input?.sql;
        if (typeof sql !== 'string' || sql.trim().length === 0) {
          return { ok: false, error: 'sql (string) is required' };
        }
        const reason = typeof input?.reason === 'string' ? input.reason : '';
        const queryResult = await runQuery(sql);
        const artifact: Artifact = { kind: 'table', data: queryResult };
        return {
          ok: true,
          result: {
            reason,
            sql: queryResult.sql,
            columns: queryResult.columns,
            rows: queryResult.rows,
            rowCount: queryResult.rowCount,
            durationMs: queryResult.durationMs,
          },
          artifact,
        };
      }

      case 'visualize_data': {
        const chartType = input?.chart_type;
        const title = input?.title;
        const xKey = input?.x_key;
        const yKeys = input?.y_keys;
        const rows = input?.rows;

        if (
          typeof chartType !== 'string' ||
          !CHART_TYPES.includes(chartType as ChartType)
        ) {
          return {
            ok: false,
            error: 'chart_type must be one of: bar, line, area, pie',
          };
        }
        if (typeof xKey !== 'string' || xKey.length === 0) {
          return { ok: false, error: 'x_key (string) is required' };
        }
        if (
          !Array.isArray(yKeys) ||
          yKeys.length === 0 ||
          !yKeys.every((k) => typeof k === 'string' && k.length > 0)
        ) {
          return {
            ok: false,
            error: 'y_keys must be a non-empty array of strings',
          };
        }
        if (!Array.isArray(rows) || rows.length === 0) {
          return { ok: false, error: 'rows must be a non-empty array' };
        }

        const chartData: ChartData = {
          xKey,
          yKeys: yKeys as string[],
          rows: rows as Array<Record<string, string | number>>,
        };
        const artifact: Artifact = {
          kind: 'chart',
          chartType: chartType as ChartType,
          data: chartData,
          title: typeof title === 'string' ? title : undefined,
        };
        return {
          ok: true,
          result: {
            rendered: true,
            chart_type: chartType,
            title: typeof title === 'string' ? title : null,
            row_count: rows.length,
          },
          artifact,
        };
      }

      case 'get_time': {
        const tz = input?.timezone;
        const now = new Date();
        const iso = now.toISOString();
        if (typeof tz === 'string' && tz.length > 0) {
          try {
            const formatter = new Intl.DateTimeFormat('en-US', {
              timeZone: tz,
              dateStyle: 'full',
              timeStyle: 'long',
            });
            return {
              ok: true,
              result: {
                iso,
                timezone: tz,
                formatted: formatter.format(now),
              },
            };
          } catch (e) {
            return {
              ok: false,
              error: `Invalid timezone "${tz}": ${errMessage(e)}`,
            };
          }
        }
        return {
          ok: true,
          result: {
            iso,
            timezone:
              Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
            formatted: now.toString(),
          },
        };
      }

      case 'web_search': {
        const q = input?.query;
        if (typeof q !== 'string' || q.trim().length === 0) {
          return { ok: false, error: 'query (string) is required' };
        }
        const result = await webSearch(q.trim());
        return { ok: true, result };
      }

      case 'wikipedia_search': {
        const q = input?.query;
        if (typeof q !== 'string' || q.trim().length === 0) {
          return { ok: false, error: 'query (string) is required' };
        }
        const result = await wikipediaSearch(q.trim());
        return { ok: true, result };
      }

      case 'get_weather': {
        const loc = input?.location;
        if (typeof loc !== 'string' || loc.trim().length === 0) {
          return { ok: false, error: 'location (string) is required' };
        }
        const result = await getWeather(loc.trim());
        return { ok: true, result };
      }

      case 'get_crypto_price': {
        const sym = input?.symbol;
        if (typeof sym !== 'string' || sym.trim().length === 0) {
          return { ok: false, error: 'symbol (string) is required' };
        }
        const vs = typeof input?.vs_currency === 'string' ? input.vs_currency : 'usd';
        const result = await getCryptoPrice(sym.trim(), vs);
        return { ok: true, result };
      }

      case 'get_hackernews_top': {
        const limitRaw = input?.limit;
        const limit =
          typeof limitRaw === 'number' && Number.isFinite(limitRaw)
            ? Math.max(1, Math.min(15, Math.floor(limitRaw)))
            : 5;
        const stories = await getHackerNewsTop(limit);
        return { ok: true, result: { stories, count: stories.length } };
      }

      default: {
        const _exhaustive: never = name;
        return {
          ok: false,
          error: `Unknown tool: ${String(_exhaustive)}`,
        };
      }
    }
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}
