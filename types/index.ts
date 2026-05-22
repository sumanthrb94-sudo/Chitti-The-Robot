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

/* ─────────────────────────  User-supplied credentials (BYO-key) ───────────────────────── */

/**
 * Browser-side settings stored in localStorage. Sent with each chat / tts
 * request so each user can bring their own LLM + TTS keys without anyone
 * else getting access to them.
 *
 * The server never persists these — it forwards them straight to the
 * upstream provider for the duration of one request.
 */
export type LlmProviderId = 'anthropic' | 'openai' | 'ollama' | 'auto';

export interface ChittiLlmCredentials {
  provider: LlmProviderId;
  /** API key for the chosen provider. Optional — server env vars are the fallback. */
  apiKey?: string;
  /** OpenAI-compatible base URL: Moonshot/Kimi, OpenRouter, Groq, DeepSeek, etc. */
  baseUrl?: string;
  /** Model identifier override. */
  model?: string;
}

export type TtsProviderId = 'browser' | 'elevenlabs';

export interface ChittiTtsCredentials {
  provider: TtsProviderId;
  /** ElevenLabs API key. Only used when provider === 'elevenlabs'. */
  apiKey?: string;
  /** ElevenLabs voice id (default: Rachel = 21m00Tcm4TlvDq8ikWAM). */
  voiceId?: string;
  /** ElevenLabs model id (default: eleven_turbo_v2_5). */
  modelId?: string;
}

export interface ChittiSettings {
  llm: ChittiLlmCredentials;
  tts: ChittiTtsCredentials;
  voice: VoiceSettings;
}
