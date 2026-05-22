/**
 * Streaming agentic loop for Chitti via any OpenAI-compatible endpoint.
 *
 * One provider, many backends — all the OpenAI Chat Completions API
 * dialect speakers:
 *   - Moonshot / Kimi      → OPENAI_BASE_URL=https://api.moonshot.ai/v1
 *   - OpenAI               → OPENAI_BASE_URL=https://api.openai.com/v1  (default)
 *   - OpenRouter           → OPENAI_BASE_URL=https://openrouter.ai/api/v1
 *   - Together AI          → OPENAI_BASE_URL=https://api.together.xyz/v1
 *   - Groq                 → OPENAI_BASE_URL=https://api.groq.com/openai/v1
 *   - DeepSeek             → OPENAI_BASE_URL=https://api.deepseek.com/v1
 *   - vLLM / LM Studio     → OPENAI_BASE_URL=http://your-server/v1
 *
 * Env:
 *   - OPENAI_API_KEY   (required)
 *   - OPENAI_BASE_URL  (optional; defaults to OpenAI)
 *   - OPENAI_MODEL     (optional; default 'gpt-4o-mini')
 *
 * Mirrors the StreamEvent contract from lib/stream-event.ts so the chat
 * route doesn't need to know which provider it's talking to.
 */

import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

import { CHITTI_SYSTEM_PROMPT } from '@/lib/system-prompt';
import type { StreamEvent } from '@/lib/stream-event';
import { CHITTI_TOOLS, executeTool } from '@/lib/tools';
import { nowIso, uid } from '@/lib/utils';
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

function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

/**
 * Convert our ChatMessage[] into OpenAI's chat-completions format.
 *  - First message is the system prompt.
 *  - Assistant messages may carry tool_calls; we re-emit them in OpenAI shape.
 *  - 'tool' role messages reference the tool_call_id they answer.
 */
function toOpenAIMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [
    { role: 'system', content: CHITTI_SYSTEM_PROMPT },
  ];

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'tool') {
      if (!msg.toolUseId) continue;
      out.push({
        role: 'tool',
        tool_call_id: msg.toolUseId,
        content: msg.content,
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const m: ChatCompletionMessageParam = {
        role: 'assistant',
        content: msg.content ?? '',
      };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        (m as ChatCompletionMessageParam & {
          tool_calls: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        }).tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input ?? {}),
          },
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

export async function* streamOpenAIResponse({
  messages,
  signal,
  apiKey: apiKeyOverride,
  baseUrl: baseUrlOverride,
  model: modelOverride,
}: {
  messages: ChatMessage[];
  signal?: AbortSignal;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): AsyncGenerator<StreamEvent, void, unknown> {
  const apiKey = apiKeyOverride || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    yield {
      type: 'error',
      error:
        'No API key. Paste your Kimi/OpenAI/OpenRouter key in Chitti Settings, or set OPENAI_API_KEY on the server.',
    };
    return;
  }

  // Auto-route Kimi Code keys (sk-kimi-…) to the kimi.com endpoint when the
  // user hasn't overridden the base URL. Those keys are rejected by
  // api.moonshot.ai with a 401, so this saves a confused support round-trip.
  const isKimiCodeKey = apiKey.startsWith('sk-kimi-');
  const baseURL =
    baseUrlOverride ||
    process.env.OPENAI_BASE_URL ||
    (isKimiCodeKey ? 'https://api.kimi.com/coding/v1' : 'https://api.openai.com/v1');
  const model =
    modelOverride ||
    process.env.OPENAI_MODEL ||
    (isKimiCodeKey ? 'kimi-latest' : 'gpt-4o-mini');

  const client = new OpenAI({ apiKey, baseURL });
  const tools = toOpenAITools(CHITTI_TOOLS);
  const convo = toOpenAIMessages(messages);

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
      // Tool call accumulators keyed by their streamed index, since OpenAI
      // streams the arguments as JSON deltas across many chunks.
      const toolAcc = new Map<
        number,
        { id: string; name: string; rawArgs: string }
      >();

      const stream = await client.chat.completions.create(
        {
          model,
          messages: convo,
          tools,
          stream: true,
          temperature: 0.6,
        },
        signal ? { signal } : undefined,
      );

      for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
        if (signal?.aborted) {
          yield { type: 'error', error: 'Request aborted.' };
          return;
        }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          iterText += delta.content;
          assembledText += delta.content;
          yield { type: 'text', delta: delta.content };
        }

        const toolDeltas = delta.tool_calls;
        if (Array.isArray(toolDeltas)) {
          for (const td of toolDeltas) {
            const idx = td.index ?? 0;
            const existing = toolAcc.get(idx) ?? {
              id: '',
              name: '',
              rawArgs: '',
            };
            if (typeof td.id === 'string' && td.id.length > 0) {
              existing.id = td.id;
            }
            if (td.function?.name) {
              existing.name = td.function.name;
            }
            if (typeof td.function?.arguments === 'string') {
              existing.rawArgs += td.function.arguments;
            }
            toolAcc.set(idx, existing);
          }
        }
      }

      // No tool calls accumulated → conversation turn is complete.
      if (toolAcc.size === 0) {
        break;
      }

      // Finalize tool calls.
      const finishedCalls: ToolCall[] = [];
      const sorted = Array.from(toolAcc.entries()).sort(([a], [b]) => a - b);
      for (const [, acc] of sorted) {
        let parsedInput: Record<string, unknown> = {};
        if (acc.rawArgs.length > 0) {
          try {
            parsedInput = JSON.parse(acc.rawArgs) as Record<string, unknown>;
          } catch {
            parsedInput = {};
          }
        }
        const call: ToolCall = {
          id: acc.id || uid('tool'),
          name: acc.name as ToolName,
          input: parsedInput,
        };
        finishedCalls.push(call);
      }

      // Surface to the UI / event log.
      for (const call of finishedCalls) {
        allToolCalls.push(call);
        yield { type: 'tool_use', tool: call };
      }

      // Push the assistant turn (text + tool_calls) into the convo.
      convo.push({
        role: 'assistant',
        content: iterText,
        tool_calls: finishedCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: {
            name: c.name,
            arguments: JSON.stringify(c.input ?? {}),
          },
        })),
      } as ChatCompletionMessageParam);

      // Execute all tool calls concurrently.
      const executions = await Promise.all(
        finishedCalls.map(async (call) => {
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
            tool_call_id: call.id,
            content: payload,
          });
          yield {
            type: 'tool_result',
            toolUseId: call.id,
            result: outcome.result,
            artifact: outcome.artifact,
          };
        } else {
          convo.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `Error: ${outcome.error}`,
          });
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
    yield {
      type: 'error',
      error: `${errMessage(e)} — check OPENAI_API_KEY / OPENAI_BASE_URL (currently ${baseURL}) / OPENAI_MODEL.`,
    };
  }
}
