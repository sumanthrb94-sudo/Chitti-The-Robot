/**
 * Streaming agentic loop for Chitti, backed by Ollama (open-source local LLM).
 *
 * Mirrors the StreamEvent contract of `lib/claude.ts` so callers can switch
 * providers via the router in `lib/llm.ts` without changes elsewhere.
 *
 * Recommended OSS models with tool calling:
 *   - llama3.1:8b    (Meta, fast, decent tool use)
 *   - qwen2.5:7b     (Alibaba, strong tool use + reasoning)
 *   - mistral-nemo   (Mistral, 12B, good multilingual)
 *
 * Set OLLAMA_BASE_URL (default http://127.0.0.1:11434) and OLLAMA_MODEL.
 */

import { Ollama, type ChatResponse, type Message, type Tool } from 'ollama';

import { CHITTI_SYSTEM_PROMPT } from '@/lib/system-prompt';
import { CHITTI_TOOLS, executeTool } from '@/lib/tools';
import { nowIso, uid } from '@/lib/utils';
import type { StreamEvent } from '@/lib/stream-event';
import type {
  Artifact,
  ChatMessage,
  ToolCall,
  ToolDefinition,
  ToolName,
} from '@/types';

export type { StreamEvent } from '@/lib/stream-event';

const MAX_TOOL_ITERATIONS = 5;

const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set<ToolName>([
  'query_database',
  'list_tables',
  'describe_table',
  'visualize_data',
  'web_search',
  'wikipedia_search',
  'get_weather',
  'get_crypto_price',
  'get_hackernews_top',
  'get_time',
]);

/* ─────────────────────────  Schema conversion  ───────────────────────── */

/**
 * Convert Anthropic-style tool defs into OpenAI/Ollama function-call format.
 * Same JSON Schema body, different envelope.
 */
function toOllamaTools(tools: ToolDefinition[]): Tool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as unknown as Tool['function']['parameters'],
    },
  }));
}

/**
 * Convert our ChatMessage[] into Ollama's request format.
 *  - System prompt is the leading 'system' message.
 *  - Assistant messages with toolCalls keep them inline.
 *  - 'tool' role messages become 'tool' messages keyed by tool_use_id.
 */
function toOllamaMessages(messages: ChatMessage[]): Message[] {
  const out: Message[] = [
    { role: 'system', content: CHITTI_SYSTEM_PROMPT },
  ];

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'tool') {
      if (!msg.toolUseId) continue;
      out.push({
        role: 'tool',
        content: msg.content,
        // ollama types use `tool_name` / no id; we attach via name for traceability
      } as Message);
      continue;
    }

    if (msg.role === 'assistant') {
      const m: Message = { role: 'assistant', content: msg.content ?? '' };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        (m as Message & { tool_calls: unknown[] }).tool_calls =
          msg.toolCalls.map((tc) => ({
            function: { name: tc.name, arguments: tc.input },
          }));
      }
      out.push(m);
      continue;
    }

    out.push({ role: 'user', content: msg.content });
  }

  return out;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return 'Unknown error';
  }
}

/* ─────────────────────────  Main entrypoint  ───────────────────────── */

export async function* streamOllamaResponse({
  messages,
  signal,
  baseUrl: baseUrlOverride,
  model: modelOverride,
}: {
  messages: ChatMessage[];
  signal?: AbortSignal;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): AsyncGenerator<StreamEvent, void, unknown> {
  const host =
    baseUrlOverride || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const model = modelOverride || process.env.OLLAMA_MODEL || 'llama3.1:8b';

  const client = new Ollama({ host });
  const tools = toOllamaTools(CHITTI_TOOLS);
  const convo = toOllamaMessages(messages);

  let assembledText = '';
  const allToolCalls: ToolCall[] = [];
  let lastChartArtifact: Artifact | undefined;

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      if (signal?.aborted) {
        yield { type: 'error', error: 'Request aborted.' };
        return;
      }

      let iterText = '';
      const iterToolCalls: ToolCall[] = [];

      const stream = await client.chat({
        model,
        messages: convo,
        tools,
        stream: true,
        options: {
          temperature: 0.6,
        },
      });

      for await (const chunk of stream as AsyncIterable<ChatResponse>) {
        if (signal?.aborted) {
          // The Ollama client doesn't expose an AbortSignal hook on chat();
          // stop draining the stream — the underlying fetch will be GC'd.
          yield { type: 'error', error: 'Request aborted.' };
          return;
        }

        const msg = chunk.message;
        if (msg?.content && msg.content.length > 0) {
          iterText += msg.content;
          assembledText += msg.content;
          yield { type: 'text', delta: msg.content };
        }

        // Tool calls in Ollama streaming arrive on the final chunk
        // (done=true) as msg.tool_calls. Some servers also emit them mid-stream.
        const rawCalls = (msg as unknown as {
          tool_calls?: Array<{
            function: { name: string; arguments: Record<string, unknown> };
          }>;
        })?.tool_calls;

        if (Array.isArray(rawCalls)) {
          for (const tc of rawCalls) {
            const call: ToolCall = {
              id: uid('tool'),
              name: tc.function.name as ToolName,
              input: tc.function.arguments ?? {},
            };
            iterToolCalls.push(call);
          }
        }
      }

      // No tool calls -> we're done with the agent loop.
      if (iterToolCalls.length === 0) {
        break;
      }

      // Emit tool_use events for the UI.
      for (const call of iterToolCalls) {
        allToolCalls.push(call);
        yield { type: 'tool_use', tool: call };
      }

      // Push the assistant turn (text + tool_calls) into the convo.
      convo.push({
        role: 'assistant',
        content: iterText,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tool_calls: iterToolCalls.map((c) => ({
          function: { name: c.name, arguments: c.input },
        })),
      } as unknown as Message);

      // Execute all tool calls concurrently.
      const executions = await Promise.all(
        iterToolCalls.map(async (call) => {
          if (!KNOWN_TOOL_NAMES.has(call.name)) {
            return {
              call,
              outcome: {
                ok: false as const,
                error: `Unknown tool: ${call.name}`,
              },
            };
          }
          const outcome = await executeTool(call.name, call.input);
          return { call, outcome };
        }),
      );

      // Append a 'tool' message per result.
      for (const { call, outcome } of executions) {
        if (outcome.ok) {
          if (outcome.artifact && outcome.artifact.kind === 'chart') {
            lastChartArtifact = outcome.artifact;
          }
          const payload = stringifyToolResult(outcome.result);
          convo.push({
            role: 'tool',
            content: payload,
          } as Message);
          yield {
            type: 'tool_result',
            toolUseId: call.id,
            result: outcome.result,
            artifact: outcome.artifact,
          };
        } else {
          convo.push({
            role: 'tool',
            content: `Error: ${outcome.error}`,
          } as Message);
          yield {
            type: 'tool_result',
            toolUseId: call.id,
            result: { error: outcome.error },
          };
        }
      }
    }

    const finalMessage: ChatMessage = {
      id: uid('msg'),
      role: 'assistant',
      content: assembledText,
      createdAt: nowIso(),
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      artifact: lastChartArtifact,
    };
    yield { type: 'done', finalMessage };
  } catch (e) {
    const onVercel = process.env.VERCEL === '1';
    const hint = onVercel
      ? `No LLM configured. On Vercel, the easiest fix is to add ANTHROPIC_API_KEY to your project's environment variables and redeploy. Alternatively, point OLLAMA_BASE_URL at a publicly reachable Ollama server.`
      : `Is ollama running at ${host}? Try \`ollama serve\` and \`ollama pull ${model}\`.`;
    yield {
      type: 'error',
      error: `${errMessage(e)} — ${hint}`,
    };
  }
}
