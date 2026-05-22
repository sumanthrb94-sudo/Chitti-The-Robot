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
import { Database, Mic, MicOff, Settings, Sparkles, Wrench } from 'lucide-react';
import { cn, nowIso, uid } from '@/lib/utils';
import { useChittiStore } from '@/lib/store';
import { streamChat, type StreamEvent } from '@/lib/chat-client';
import { getTtsRequestCredentials } from '@/lib/settings';
import { cancelSpeech, isVoiceOutputSupported, speak } from '@/lib/voice';
import ChittiOrb from './ChittiOrb';
import ConversationPanel from './ConversationPanel';
import InputBar from './InputBar';
import SettingsModal from './SettingsModal';
import SystemStatus from './SystemStatus';
import ViewportHUD from './ViewportHUD';
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [llmInfo, setLlmInfo] = useState<{
    provider: 'anthropic' | 'ollama' | 'openai';
    brand: string;
    model: string;
    openSource: boolean;
    hasAnthropicKey: boolean;
    hasOpenAIKey: boolean;
    openaiBaseUrl: string | null;
    isVercel: boolean;
    toolCount: number;
  } | null>(null);

  useEffect(() => {
    setTtsSupported(isVoiceOutputSupported());
  }, []);

  // Discover which LLM provider the server resolved to. Shown in the MODEL
  // chip and used to decide whether to warn the user about misconfiguration
  // (e.g. ollama fallback on Vercel because ANTHROPIC_API_KEY isn't set).
  useEffect(() => {
    let alive = true;
    fetch('/api/info', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((info) => {
        if (alive) setLlmInfo(info);
      })
      .catch(() => {
        /* non-fatal — chip will fall back to a placeholder */
      });
    return () => {
      alive = false;
    };
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

        // Speak if voice is on. Pass the user's TTS credentials so we
        // route through ElevenLabs when configured, else browser TTS.
        const currentState = useChittiStore.getState().state;
        if (currentState !== 'error') {
          if (voiceEnabled && finalText.trim().length > 0 && ttsSupported) {
            setState('speaking');
            try {
              await speak(finalText, voiceSettings, getTtsRequestCredentials());
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

  const toolCount = llmInfo?.toolCount ?? 5;

  // Format the MODEL chip value from the live provider info. Falls back to
  // a placeholder while /api/info is in flight.
  const modelChipValue = useMemo(() => {
    if (!llmInfo) return 'DETECTING…';
    if (llmInfo.provider === 'anthropic') {
      // "claude-sonnet-4-6" → "SONNET 4.6"
      const m = llmInfo.model.match(/^claude-([a-z]+)-(\d+)-(\d+)/i);
      if (m) return `${m[1].toUpperCase()} ${m[2]}.${m[3]}`;
      return llmInfo.model.toUpperCase();
    }
    if (llmInfo.provider === 'openai') {
      // Kimi flavours:
      //   "kimi-latest"          → "KIMI LATEST"
      //   "kimi-coding"          → "KIMI CODING"
      //   "kimi-k2-0905-preview" → "KIMI K2"
      if (llmInfo.brand === 'kimi') {
        const m = llmInfo.model.match(/^kimi-(k\d+)/i);
        if (m) return `KIMI ${m[1].toUpperCase()}`;
        const tail = llmInfo.model.replace(/^kimi-/i, '');
        return `KIMI ${tail.toUpperCase()}`;
      }
      // Other brands → BRAND + short model
      const shortModel = llmInfo.model.split('/').pop() ?? llmInfo.model;
      return `${llmInfo.brand.toUpperCase()} ${shortModel.split('-')[0]?.toUpperCase() ?? ''}`.trim();
    }
    // ollama: "llama3.1:8b" → "LLAMA3.1"
    const base = llmInfo.model.split(':')[0]?.toUpperCase() ?? 'OLLAMA';
    return base;
  }, [llmInfo]);

  // Warn tone when the resolved provider can't actually reach an LLM —
  // e.g. on Vercel, fell back to Ollama (unreachable from a serverless fn).
  const modelChipTone: 'ok' | 'warn' = useMemo(() => {
    if (!llmInfo) return 'ok';
    if (llmInfo.provider === 'ollama' && llmInfo.isVercel) return 'warn';
    return 'ok';
  }, [llmInfo]);

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
        value: modelChipValue,
        tone: modelChipTone,
        // Tap the chip → open Settings on the Brain tab. Faster discovery.
        onClick: () => setSettingsOpen(true),
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
    [voiceEnabled, setVoiceEnabled, modelChipValue, modelChipTone, toolCount],
  );

  // Compute a responsive orb size — smaller on phones, default on desktop.
  // (Computed once on mount via window.innerWidth; we keep it simple and
  // avoid a resize listener since the orb gracefully accepts a CSS size.)
  // The orb itself maintains aspect ratio inside its 360 viewBox.
  return (
    <div className="relative z-0 min-h-screen w-full flex flex-col">
      {/* Decorative HUD overlay — must be the FIRST child so corner brackets
          + edge rails sit behind everything else. pointer-events: none. */}
      <ViewportHUD />

      {/* Top HUD strip + gear icon for Settings */}
      <header className="px-4 pt-4 pb-2 relative z-10 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <SystemStatus />
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          title="Settings (API keys & voice)"
          aria-label="Open settings"
          className="flex items-center justify-center w-10 h-10 rounded-full border border-chitti-500/60 bg-chitti-900/40 text-chitti-200 hover:bg-chitti-800/60 hover:text-chitti-100 transition-colors"
          style={{ boxShadow: '0 0 14px rgba(0, 184, 230, 0.25)' }}
        >
          <Settings className="w-4 h-4" strokeWidth={1.8} />
        </button>
      </header>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* Main grid.
          Order on mobile: conversation FIRST (order-1), orb compact (order-2).
          On lg+: orb section on the left, conversation on the right.
          We use flex-col-reverse on the inner conversation/orb wrapper at mobile
          and the natural row direction on desktop. */}
      <main className="flex-1 flex flex-col lg:flex-row gap-4 px-4 pb-4 min-h-0 relative z-10">
        {/* LEFT — orb + legend + telemetry stream (desktop only).
            On mobile this section is ORDER-2 so the conversation panel
            appears above it. */}
        <section
          className={cn(
            'order-2 lg:order-1',
            'lg:w-1/3 flex flex-col items-center gap-4 lg:gap-6 lg:py-6 py-2',
          )}
        >
          {/* Orb wrapper — scales down on small screens, keeps aspect ratio.
              Mobile: 240px. sm-md: 300px. lg+: 360px. */}
          <div className="relative">
            <div className="sm:hidden">
              <ChittiOrb state={state} size={240} />
            </div>
            <div className="hidden sm:block lg:hidden">
              <ChittiOrb state={state} size={300} />
            </div>
            <div className="hidden lg:block">
              <ChittiOrb state={state} size={360} />
            </div>
          </div>

          {/* Legend chips — unchanged definition, restyled wrapper. */}
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

          {/* Session counter — desktop only */}
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

        {/* RIGHT — transcript + input. Mobile order-1 so it appears first. */}
        <section
          className={cn(
            'order-1 lg:order-2',
            'flex-1 flex flex-col min-h-0 gap-3',
          )}
        >
          <div className="glass hud-corners flex-1 flex flex-col min-h-0 overflow-hidden">
            <ConversationPanel className="flex-1" />
          </div>
          <InputBar onSend={handleSend} onStop={handleStop} />
        </section>
      </main>
    </div>
  );
}
