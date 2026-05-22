/**
 * Streaming agentic loop for Chitti, backed by Anthropic's Messages API.
 *
 * Exposes `streamChittiResponse`, an async generator that yields a small
 * StreamEvent union the route handler can forward as Server-Sent Events.
 *
 * Implementation notes:
 *  - We translate our internal `ChatMessage[]` (which stores tool_use and
 *    tool_result as separate messages on the user/tool side) into Anthropic's
 *    expected content-block format.
 *  - We stream text deltas as they arrive.
 *  - When the model emits one or more tool_use blocks, we execute them in
 *    parallel via `executeTool`, append the results to the conversation, and
 *    loop. We cap at 5 tool-call iterations as a safety rail.
 *  - The final `done` event carries the assembled assistant ChatMessage with
 *    the last chart artifact (if any) attached for the UI.
 */

import Anthropic from '@anthropic-ai/sdk';

import { CHITTI_SYSTEM_PROMPT } from '@/lib/system-prompt';
import type { StreamEvent } from '@/lib/stream-event';
import { CHITTI_TOOLS, executeTool } from '@/lib/tools';
import { nowIso, uid } from '@/lib/utils';
import type {
  Artifact,
  ChatMessage,
  ToolCall,
  ToolName,
} from '@/types';

export type { StreamEvent } from '@/lib/stream-event';

/* ─────────────────────────  Internal Anthropic shapes  ─────────────────────────
 *
 * The SDK ships strict types, but we keep the surface area minimal here so we
 * don't tightly couple to a specific minor version. We cast at the boundary.
 */

type AnthropicTextBlock = { type: 'text'; text: string };
type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

const MAX_TOOL_ITERATIONS = 5;
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set<ToolName>([
  'query_database',
  'list_tables',
  'describe_table',
  'visualize_data',
  'web_search',
  'get_time',
]);

/* ─────────────────────────  Conversion helpers  ───────────────────────── */

/**
 * Convert our ChatMessage[] into Anthropic's request format.
 *
 * Rules:
 *  - 'system' / 'tool' roles in our schema are folded appropriately. The system
 *    prompt is passed as the top-level `system` field, not as a message, so we
 *    skip any 'system' role messages here.
 *  - An assistant message with `toolCalls` gets its tool_use blocks reconstructed.
 *  - A 'tool' role message becomes a user message containing a tool_result block.
 */
function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'tool') {
      if (!msg.toolUseId) continue;
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.toolUseId,
            content: msg.content,
          },
        ],
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (msg.content && msg.content.length > 0) {
        blocks.push({ type: 'text', text: msg.content });
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input,
          });
        }
      }
      if (blocks.length === 0) {
        // Anthropic requires at least one content block. Skip empty assistant turns.
        continue;
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    // user
    if (msg.content && msg.content.length > 0) {
      out.push({ role: 'user', content: msg.content });
    }
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

export async function* streamChittiResponse({
  messages,
  signal,
}: {
  messages: ChatMessage[];
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent, void, unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    yield {
      type: 'error',
      error: 'ANTHROPIC_API_KEY is not set on the server.',
    };
    return;
  }

  const client = new Anthropic({ apiKey });
  const model = process.env.CHITTI_MODEL ?? 'claude-sonnet-4-6';

  // Running Anthropic-format conversation we mutate across iterations.
  const convo: AnthropicMessage[] = toAnthropicMessages(messages);

  // Accumulated text + tool calls across all iterations for the final message.
  let assembledText = '';
  const allToolCalls: ToolCall[] = [];
  let lastChartArtifact: Artifact | undefined;

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      if (signal?.aborted) {
        yield { type: 'error', error: 'Request aborted.' };
        return;
      }

      // Per-iteration accumulators.
      let iterText = '';
      const toolUseAccumulators = new Map<
        number,
        {
          id: string;
          name: string;
          rawInput: string;
        }
      >();
      let stopReason: string | null = null;

      const stream = client.messages.stream(
        {
          model,
          max_tokens: 2048,
          system: CHITTI_SYSTEM_PROMPT,
          tools: CHITTI_TOOLS as unknown as Anthropic.Tool[],
          messages: convo as unknown as Anthropic.MessageParam[],
        },
        signal ? { signal } : undefined,
      );

      for await (const event of stream) {
        if (signal?.aborted) {
          yield { type: 'error', error: 'Request aborted.' };
          return;
        }

        // Anthropic stream events: 'message_start', 'content_block_start',
        // 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'.
        const ev = event as unknown as {
          type: string;
          index?: number;
          content_block?: {
            type: string;
            id?: string;
            name?: string;
            text?: string;
            input?: Record<string, unknown>;
          };
          delta?: {
            type?: string;
            text?: string;
            partial_json?: string;
            stop_reason?: string;
          };
        };

        switch (ev.type) {
          case 'content_block_start': {
            const block = ev.content_block;
            if (block?.type === 'tool_use' && typeof ev.index === 'number') {
              toolUseAccumulators.set(ev.index, {
                id: block.id ?? '',
                name: block.name ?? '',
                rawInput: '',
              });
            }
            break;
          }
          case 'content_block_delta': {
            if (ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
              iterText += ev.delta.text;
              assembledText += ev.delta.text;
              yield { type: 'text', delta: ev.delta.text };
            } else if (
              ev.delta?.type === 'input_json_delta' &&
              typeof ev.delta.partial_json === 'string' &&
              typeof ev.index === 'number'
            ) {
              const acc = toolUseAccumulators.get(ev.index);
              if (acc) acc.rawInput += ev.delta.partial_json;
            }
            break;
          }
          case 'message_delta': {
            if (typeof ev.delta?.stop_reason === 'string') {
              stopReason = ev.delta.stop_reason;
            }
            break;
          }
          default:
            break;
        }
      }

      // Finalize tool calls from this iteration.
      const finishedToolCalls: ToolCall[] = [];
      const assistantBlocksForConvo: AnthropicContentBlock[] = [];
      if (iterText.length > 0) {
        assistantBlocksForConvo.push({ type: 'text', text: iterText });
      }

      const sortedIndexes = Array.from(toolUseAccumulators.keys()).sort(
        (a, b) => a - b,
      );
      // We track the original (possibly invalid) tool name from the model so
      // that the conversation we send back to Anthropic preserves it, even when
      // we surface the call as an error.
      const finishedRaw: Array<{ call: ToolCall; rawName: string }> = [];
      for (const idx of sortedIndexes) {
        const acc = toolUseAccumulators.get(idx);
        if (!acc) continue;
        let parsedInput: Record<string, unknown> = {};
        if (acc.rawInput.length > 0) {
          try {
            parsedInput = JSON.parse(acc.rawInput) as Record<string, unknown>;
          } catch {
            parsedInput = {};
          }
        }
        // We preserve the raw model-provided name on the ToolCall; the executor
        // re-validates it against the ToolName union and returns an error if
        // it isn't recognised, which Anthropic will then see in the tool_result.
        const call: ToolCall = {
          id: acc.id || uid('tool'),
          name: acc.name as ToolName,
          input: parsedInput,
        };
        finishedRaw.push({ call, rawName: acc.name });
        finishedToolCalls.push(call);
        assistantBlocksForConvo.push({
          type: 'tool_use',
          id: call.id,
          name: acc.name,
          input: parsedInput,
        });
      }

      // Emit tool_use events for the UI / log.
      for (const call of finishedToolCalls) {
        allToolCalls.push(call);
        yield { type: 'tool_use', tool: call };
      }

      // If no tool calls, we're done.
      if (finishedToolCalls.length === 0) {
        break;
      }

      // Push assistant turn into convo before tool_result user turn.
      if (assistantBlocksForConvo.length > 0) {
        convo.push({ role: 'assistant', content: assistantBlocksForConvo });
      }

      // Execute all tool calls concurrently.
      const executions = await Promise.all(
        finishedRaw.map(async ({ call, rawName }) => {
          if (!KNOWN_TOOL_NAMES.has(rawName)) {
            return {
              call,
              outcome: {
                ok: false as const,
                error: `Unknown tool: ${rawName}`,
              },
            };
          }
          const outcome = await executeTool(call.name, call.input);
          return { call, outcome };
        }),
      );

      // Build a single user message containing all tool_result blocks (Anthropic
      // requires tool_result blocks to be in a user message and to follow the
      // assistant's tool_use turn directly).
      const toolResultBlocks: AnthropicContentBlock[] = [];
      for (const { call, outcome } of executions) {
        if (outcome.ok) {
          if (
            outcome.artifact &&
            outcome.artifact.kind === 'chart'
          ) {
            lastChartArtifact = outcome.artifact;
          }
          const payload = stringifyToolResult(outcome.result);
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: payload,
          });
          yield {
            type: 'tool_result',
            toolUseId: call.id,
            result: outcome.result,
            artifact: outcome.artifact,
          };
        } else {
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: `Error: ${outcome.error}`,
            is_error: true,
          });
          yield {
            type: 'tool_result',
            toolUseId: call.id,
            result: { error: outcome.error },
          };
        }
      }
      convo.push({ role: 'user', content: toolResultBlocks });

      if (stopReason === 'end_turn' || stopReason === 'max_tokens') {
        // Some providers may flag stop early; the next iteration is still safe.
        // We continue so the model can react to tool_result. Only break if the
        // model produced no tool calls (handled above).
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
    yield { type: 'error', error: errMessage(e) };
  }
}
