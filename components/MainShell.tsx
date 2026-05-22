'use client';

/**
 * MainShell — top-level page composition + streaming orchestrator.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────────────┐
 *   │  SystemStatus (top bar, spans full width)             │
 *   ├──────────────────┬─────────────────────────────────────┤
 *   │  ChittiOrb        │  ConversationPanel                  │
 *   │  StatusLegend     │                                     │
 *   │                   │  InputBar                           │
 *   └────────────────────────────────────────────────────────┘
 *
 * Streaming flow when the user sends a message:
 *   1. Append user message to store.
 *   2. Append empty assistant message → state='thinking', isStreaming=true.
 *   3. streamChat() → on 'text' deltas append to last assistant content;
 *      on 'tool_result' attach artifact; on 'done' overlay finalMessage;
 *      on 'error' set state='error'.
 *   4. After done: if voice enabled, speak() → state='speaking' → 'idle'.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Database, Mic, MicOff, Sparkles, Wrench } from 'lucide-react';
import { cn, nowIso, uid } from '@/lib/utils';
import { useChittiStore } from '@/lib/store';
import { streamChat, type StreamEvent } from '@/lib/chat-client';
import { cancelSpeech, isVoiceOutputSupported, speak } from '@/lib/voice';
import ChittiOrb from './ChittiOrb';
import ConversationPanel from './ConversationPanel';
import InputBar from './InputBar';
import SystemStatus from './SystemStatus';
import type { Artifact, ChatMessage } from '@/types';

interface LegendChipProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'off';
  onClick?: () => void;
}

function LegendChip({ icon, label, value, tone = 'ok', onClick }: LegendChipProps) {
  const toneClass =
    tone === 'ok'
      ? 'text-signal-green border-signal-green/40'
      : tone === 'warn'
        ? 'text-signal-amber border-signal-amber/40'
        : 'text-chitti-400/60 border-chitti-700/60';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'glass hud-corners flex items-center gap-2 px-3 py-2 text-left transition-colors',
        onClick ? 'hover:bg-chitti-800/40 cursor-pointer' : 'cursor-default',
      )}
    >
      <span className={cn('flex-none', toneClass)}>{icon}</span>
      <span className="flex flex-col leading-tight">
        <span className="font-mono text-[9px] tracking-[0.3em] text-chitti-300/70">
          {label}
        </span>
        <span
          className={cn(
            'font-display tracking-[0.18em] text-[11px]',
            toneClass,
          )}
        >
          {value}
        </span>
      </span>
    </button>
  );
}

export default function MainShell() {
  const messages = useChittiStore((s) => s.messages);
  const state = useChittiStore((s) => s.state);
  const voiceEnabled = useChittiStore((s) => s.voiceEnabled);
  const voiceSettings = useChittiStore((s) => s.voiceSettings);
  const isStreaming = useChittiStore((s) => s.isStreaming);
  const addMessage = useChittiStore((s) => s.addMessage);
  const updateLastAssistantMessage = useChittiStore(
    (s) => s.updateLastAssistantMessage,
  );
  const setState = useChittiStore((s) => s.setState);
  const setIsStreaming = useChittiStore((s) => s.setIsStreaming);
  const setVoiceEnabled = useChittiStore((s) => s.setVoiceEnabled);

  const abortRef = useRef<AbortController | null>(null);
  const [ttsSupported, setTtsSupported] = useState(true);

  useEffect(() => {
    setTtsSupported(isVoiceOutputSupported());
  }, []);

  /** Send a message + drive the streaming life-cycle. */
  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      if (isStreaming) return;

      const userMsg: ChatMessage = {
        id: uid('msg'),
        role: 'user',
        content: trimmed,
        createdAt: nowIso(),
      };
      const assistantMsg: ChatMessage = {
        id: uid('msg'),
        role: 'assistant',
        content: '',
        createdAt: nowIso(),
      };

      addMessage(userMsg);
      addMessage(assistantMsg);

      // Snapshot the message history we send to the server.
      const historyForServer: ChatMessage[] = [...messages, userMsg];

      setState('thinking');
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      let pendingArtifact: Artifact | undefined;
      let finalText = '';

      const onEvent = (event: StreamEvent) => {
        switch (event.type) {
          case 'text': {
            updateLastAssistantMessage((m) => ({
              ...m,
              content: m.content + event.delta,
            }));
            break;
          }
          case 'tool_use': {
            // Surface that a tool is firing — keep state as thinking.
            setState('thinking');
            break;
          }
          case 'tool_result': {
            if (event.artifact) pendingArtifact = event.artifact;
            break;
          }
          case 'done': {
            const final = event.finalMessage;
            finalText = final.content ?? '';
            updateLastAssistantMessage((m) => ({
              ...m,
              content: final.content ?? m.content,
              artifact: final.artifact ?? pendingArtifact ?? m.artifact,
              toolCalls: final.toolCalls ?? m.toolCalls,
            }));
            break;
          }
          case 'error': {
            updateLastAssistantMessage((m) => ({
              ...m,
              content:
                m.content.length > 0
                  ? m.content
                  : `[error] ${event.error}`,
            }));
            setState('error');
            break;
          }
        }
      };

      try {
        await streamChat({
          messages: historyForServer,
          onEvent,
          signal: controller.signal,
        });

        // If we got here without an explicit done event but text was streamed,
        // make sure the visible message reflects what we accumulated.
        if (!finalText) {
          const latest = useChittiStore.getState().messages;
          const lastAsst = [...latest]
            .reverse()
            .find((m) => m.role === 'assistant');
          if (lastAsst?.artifact === undefined && pendingArtifact) {
            updateLastAssistantMessage((m) => ({
              ...m,
              artifact: m.artifact ?? pendingArtifact,
            }));
          }
          finalText = lastAsst?.content ?? '';
        }

        // Speak if voice is on.
        const currentState = useChittiStore.getState().state;
        if (currentState !== 'error') {
          if (voiceEnabled && finalText.trim().length > 0 && ttsSupported) {
            setState('speaking');
            try {
              await speak(finalText, voiceSettings);
            } catch {
              /* speech errors are non-fatal */
            }
            setState('idle');
          } else {
            setState('idle');
          }
        }
      } catch (e) {
        // Aborts are silent.
        if (e instanceof DOMException && e.name === 'AbortError') {
          setState('idle');
        } else {
          setState('error');
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [
      addMessage,
      isStreaming,
      messages,
      setIsStreaming,
      setState,
      ttsSupported,
      updateLastAssistantMessage,
      voiceEnabled,
      voiceSettings,
    ],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    cancelSpeech();
    setIsStreaming(false);
    setState('idle');
  }, [setIsStreaming, setState]);

  // Clean up any in-flight stream / TTS on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      cancelSpeech();
    };
  }, []);

  const toolCount = 5; // list_tables, describe_table, query_database, visualize_data, get_time

  const legend = useMemo(
    () => [
      {
        icon: voiceEnabled ? (
          <Mic className="w-4 h-4" strokeWidth={1.8} />
        ) : (
          <MicOff className="w-4 h-4" strokeWidth={1.8} />
        ),
        label: 'VOICE',
        value: voiceEnabled ? 'ON' : 'OFF',
        tone: (voiceEnabled ? 'ok' : 'off') as 'ok' | 'off',
        onClick: () => setVoiceEnabled(!voiceEnabled),
      },
      {
        icon: <Sparkles className="w-4 h-4" strokeWidth={1.8} />,
        label: 'MODEL',
        value: 'CLAUDE 4.6',
        tone: 'ok' as const,
      },
      {
        icon: <Database className="w-4 h-4" strokeWidth={1.8} />,
        label: 'DB',
        value: 'CONNECTED',
        tone: 'ok' as const,
      },
      {
        icon: <Wrench className="w-4 h-4" strokeWidth={1.8} />,
        label: 'TOOLS',
        value: String(toolCount),
        tone: 'ok' as const,
      },
    ],
    [voiceEnabled, setVoiceEnabled],
  );

  return (
    <div className="relative min-h-screen w-full flex flex-col">
      {/* Top HUD strip */}
      <header className="px-4 pt-4 pb-2">
        <SystemStatus />
      </header>

      {/* Main grid */}
      <main className="flex-1 flex flex-col lg:flex-row gap-4 px-4 pb-4 min-h-0">
        {/* LEFT — orb + legend */}
        <section className="lg:w-1/3 flex flex-col items-center gap-6 py-6">
          <div className="relative">
            <ChittiOrb state={state} />
          </div>

          <div className="grid grid-cols-2 gap-3 w-full max-w-xs">
            {legend.map((chip) => (
              <LegendChip
                key={chip.label}
                icon={chip.icon}
                label={chip.label}
                value={chip.value}
                tone={chip.tone}
                onClick={chip.onClick}
              />
            ))}
          </div>

          <div className="hidden lg:block w-full max-w-xs">
            <div className="glass hud-corners px-3 py-2 font-mono text-[10px] tracking-[0.25em] text-chitti-300/70 uppercase">
              <div className="flex items-center justify-between">
                <span>SESSION</span>
                <span className="tabular-nums text-chitti-200">
                  {messages.length.toString().padStart(3, '0')} MSG
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* RIGHT — transcript + input */}
        <section className="flex-1 flex flex-col min-h-0 gap-3">
          <div className="glass hud-corners flex-1 flex flex-col min-h-0 overflow-hidden">
            <ConversationPanel className="flex-1" />
          </div>
          <InputBar onSend={handleSend} onStop={handleStop} />
        </section>
      </main>
    </div>
  );
}
