/**
 * Shared types for Chitti.
 * Contracts between agent modules (brain, voice, data, UI).
 */

/* ─────────────────────────  Conversation  ───────────────────────── */

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  /** ISO timestamp */
  createdAt: string;
  /** When assistant invoked tools, raw blocks live here */
  toolCalls?: ToolCall[];
  /** When this message is a tool result, the tool_use_id it answers */
  toolUseId?: string;
  /** Optional UI hint: rich payload (chart, table) the UI should render */
  artifact?: Artifact;
}

export interface ToolCall {
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
}

/* ─────────────────────────  Tools  ───────────────────────── */

export type ToolName =
  | 'query_database'
  | 'list_tables'
  | 'describe_table'
  | 'visualize_data'
  | 'web_search'
  | 'wikipedia_search'
  | 'get_weather'
  | 'get_crypto_price'
  | 'get_hackernews_top'
  | 'get_time';

export interface ToolDefinition {
  name: ToolName;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/* ─────────────────────────  DB / Analysis  ───────────────────────── */

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  sql: string;
  durationMs: number;
}

export interface TableSchema {
  name: string;
  columns: Array<{
    name: string;
    type: string;
    notNull: boolean;
    primaryKey: boolean;
  }>;
  rowCount: number;
}

/* ─────────────────────────  Artifacts (rich UI payloads) ───────────────────────── */

export type Artifact =
  | { kind: 'table'; data: QueryResult }
  | { kind: 'chart'; chartType: ChartType; data: ChartData; title?: string }
  | { kind: 'metric'; label: string; value: string | number; delta?: number }
  | { kind: 'markdown'; text: string };

export type ChartType = 'bar' | 'line' | 'area' | 'pie';

export interface ChartData {
  /** Field name (column) used for the x axis / category */
  xKey: string;
  /** Field names plotted on y axis */
  yKeys: string[];
  rows: Array<Record<string, string | number>>;
}

/* ─────────────────────────  Voice state  ───────────────────────── */

export type ChittiState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export interface VoiceSettings {
  enabled: boolean;
  autoListen: boolean;
  voice?: string;
  rate: number;
  pitch: number;
  volume: number;
}
