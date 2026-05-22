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

/**
 * BYO long-term memory credentials. Chitti remembers facts across sessions
 * by upserting vector embeddings of each exchange into a user-supplied
 * vector database (Upstash Vector). Same trust model as LLM/TTS keys —
 * the server forwards them per-request, never persists.
 */
export interface ChittiMemoryCredentials {
  vectorUrl?: string;
  vectorToken?: string;
  embeddingApiKey?: string;
  /** Stable per-user namespace so memories don't bleed between users. */
  userId?: string;
  /** Whether memory features are enabled at all. */
  enabled: boolean;
}

/**
 * BYO speech-recognition credentials. `'browser'` uses the built-in Web
 * Speech API (free, but Chrome-only and quality varies). `'groq'` posts
 * the recorded audio to Groq's OpenAI-compatible Whisper endpoint for
 * sub-200ms whisper-large-v3 transcription. Same trust model — the
 * server forwards keys per-request and never persists them.
 */
export type AsrProviderId = 'browser' | 'groq';

export interface ChittiAsrCredentials {
  provider: AsrProviderId;
  /** Groq API key — required when provider === 'groq'. */
  apiKey?: string;
  /** Model id, defaults to 'whisper-large-v3'. */
  model?: string;
  /** ISO-639-1 language code; omit for auto-detect. */
  language?: string;
}

/**
 * Wake-word detection (Picovoice Porcupine Web). When enabled and an
 * accessKey is configured, Chitti listens passively for a hot-word
 * ("Jarvis" by default) and trips the same code path as tapping the
 * mic button. The accessKey is a free-tier credential from
 * console.picovoice.ai — same BYO trust model as the LLM/TTS keys.
 */
export interface ChittiWakeWordCredentials {
  enabled: boolean;
  accessKey?: string;
  /** Default 'jarvis' — comes from Porcupine's built-in keyword list. */
  keyword:
    | 'jarvis'
    | 'alexa'
    | 'computer'
    | 'hey siri'
    | 'ok google'
    | 'porcupine'
    | 'bumblebee'
    | 'grasshopper'
    | 'terminator'
    | 'picovoice'
    | 'blueberry'
    | 'americano';
  /** 0..1 — Porcupine sensitivity. Higher = more triggers (incl. false positives). */
  sensitivity: number;
}

export interface ChittiSettings {
  llm: ChittiLlmCredentials;
  tts: ChittiTtsCredentials;
  voice: VoiceSettings;
  memory: ChittiMemoryCredentials;
  asr: ChittiAsrCredentials;
  wakeWord: ChittiWakeWordCredentials;
}
