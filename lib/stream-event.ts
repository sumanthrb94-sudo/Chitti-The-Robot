/**
 * Provider-agnostic streaming event union. Both the Anthropic backend
 * (`lib/claude.ts`) and the Ollama backend (`lib/ollama.ts`) yield these.
 */

import type { Artifact, ChatMessage, ToolCall } from '@/types';

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; tool: ToolCall }
  | {
      type: 'tool_result';
      toolUseId: string;
      result: unknown;
      artifact?: Artifact;
    }
  | { type: 'done'; finalMessage: ChatMessage }
  | { type: 'error'; error: string };
