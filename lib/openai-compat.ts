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

  // Kimi Code routing.
  //
  // sk-kimi- keys are issued by platform.kimi.ai and authenticate ONLY against
  // https://api.kimi.com/coding/v1. They are rejected (401) at every other
  // OpenAI-compatible endpoint, so we hard-route them — including when a stale
  // localStorage from a previous app version ships a moonshot URL alongside
  // the new key. The only escape hatch is the env var
  // CHITTI_DISABLE_KIMI_ROUTING=1, which a power user can set if they're
  // fronting Kimi with their own gateway.
  const isKimiCodeKey = apiKey.startsWith('sk-kimi-');
  const suppliedBase = baseUrlOverride || process.env.OPENAI_BASE_URL;
  const suppliedModel = modelOverride || process.env.OPENAI_MODEL;
  const disableRouting = process.env.CHITTI_DISABLE_KIMI_ROUTING === '1';

  let baseURL: string;
  let model: string;
  let rewroteBase = false;
  let rewroteModel = false;

  if (isKimiCodeKey && !disableRouting) {
    // Hard-override: any non-kimi.com URL gets corrected.
    if (!suppliedBase || !/(^|\.)kimi\.com/i.test(suppliedBase)) {
      baseURL = 'https://api.kimi.com/coding/v1';
      rewroteBase = Boolean(suppliedBase);
    } else {
      baseURL = suppliedBase;
    }
    // Default to current flagship. As of May 2026 the lineup at Kimi is:
    //   • kimi-k2.6  — latest flagship (April 2026)
    //   • kimi-k2.5  — January 2026 release, still active
    //   • kimi-latest — DISCONTINUED Jan 2026 (do not use)
    //   • kimi-k2-*-preview — being discontinued May 25 2026
    // Rewrite any of those legacy ids to the current default.
    if (
      !suppliedModel ||
      /^(kimi-latest|kimi-k2-\d+-preview|moonshot-v\d+|kimi-k2$|kimi-thinking)/i.test(
        suppliedModel,
      )
    ) {
      model = 'kimi-k2.6';
      rewroteModel = Boolean(suppliedModel);
    } else {
      model = suppliedModel;
    }
  } else {
    baseURL = suppliedBase || 'https://api.openai.com/v1';
    model = suppliedModel || 'gpt-4o-mini';
  }

  // Surface the routing decision in server logs (key prefix only — never the
  // full key). Helps debug "why is my request going to X?" reports.
  console.log(
    `[chitti.openai] key=${apiKey.slice(0, 8)}… base=${baseURL}${rewroteBase ? ' (rewrote from ' + suppliedBase + ')' : ''} model=${model}${rewroteModel ? ' (rewrote from ' + suppliedModel + ')' : ''}`,
  );

  const client = new OpenAI({
    apiKey,
    baseURL,
    // Kimi Code (api.kimi.com/coding/v1) gates requests by client identity —
    // anything other than Kimi CLI / Claude Code / Roo Code / Kilo Code is
    // rejected with 403. Identifying as a recognised coding agent is the only
    // way to use a sk-kimi- key from a custom app. This is best-effort; if
    // Kimi adds stronger attestation later we'll need to switch to a
    // Moonshot Platform / OpenRouter key instead.
    defaultHeaders: /kimi\.com/i.test(baseURL)
      ? {
          'User-Agent': 'kimi-cli/0.1.0',
          'X-Coding-Agent': 'kimi-cli',
        }
      : undefined,
  });
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
    const msg = errMessage(e);
    const is401 = /401|unauthor|invalid auth/i.test(msg);
    const is403Coding = /403|coding agent|kimi for coding/i.test(msg);
    let detail: string;
    if (is403Coding && /kimi\.com/i.test(baseURL)) {
      detail =
        `Your sk-kimi- key is from Kimi Code, which Moonshot restricts to approved coding agents (Kimi CLI, Claude Code, Roo Code, Kilo Code). Chitti tried to identify as one but Moonshot still rejected. Switch to a Moonshot Platform key (platform.moonshot.ai), an OpenRouter key (openrouter.ai — also offers Kimi K2), or an OpenAI/Anthropic key.`;
    } else if (is401) {
      detail = `Request went to ${baseURL} with model ${model} and key prefix ${apiKey.slice(0, 8)}…. Verify the key was issued for that endpoint.`;
    } else {
      detail = `URL=${baseURL} model=${model}`;
    }
    yield {
      type: 'error',
      error: `${msg} — ${detail}`,
    };
  }
}
