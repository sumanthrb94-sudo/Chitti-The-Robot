'use client';

/**
 * ConversationPanel — scrolling transcript of the chitti / user exchange.
 *
 * - Auto-scrolls to bottom on new messages or content updates.
 * - User messages right-aligned with a chitti-tinted bubble.
 * - Assistant messages left-aligned with .glass + .hud-corners.
 * - Blinking cursor on the streaming-in-progress assistant bubble.
 * - Lazy-imports Team C's DataDashboard; falls back to a JSON <pre> if missing.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { ComponentType, lazy, Suspense, useEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useChittiStore } from '@/lib/store';
import type { Artifact, ChatMessage } from '@/types';

interface DashboardProps {
  artifact: Artifact;
}

/* ─────────────── lazy DataDashboard with fallback ─────────────── */

const DataDashboard = lazy<ComponentType<DashboardProps>>(async () => {
  try {
    const mod = await import('@/components/DataDashboard');
    const Comp = (mod.default ?? mod.DataDashboard) as
      | ComponentType<DashboardProps>
      | undefined;
    if (Comp) return { default: Comp };
    throw new Error('DataDashboard export missing');
  } catch {
    const Fallback: ComponentType<DashboardProps> = ({ artifact }) => (
      <pre className="text-xs text-chitti-200/80 overflow-auto p-3 rounded border border-chitti-700/50 bg-chitti-900/50 max-h-64">
        {JSON.stringify(artifact, null, 2)}
      </pre>
    );
    Fallback.displayName = 'DataDashboardFallback';
    return { default: Fallback };
  }
});

/* ─────────────── helpers ─────────────── */

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--:--';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return '--:--';
  }
}

/* ─────────────── bubble ─────────────── */

interface BubbleProps {
  message: ChatMessage;
  showCursor: boolean;
}

function MessageBubble({ message, showCursor }: BubbleProps) {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  // Skip tool / system messages from the visible transcript.
  if (!isUser && !isAssistant) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.28, ease: 'easeOut' }}
      className={cn(
        'flex flex-col gap-1',
        isUser ? 'items-end' : 'items-start',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2 font-mono text-[10px] tracking-[0.25em] uppercase',
          isUser ? 'text-chitti-300/70' : 'text-chitti-200/80',
        )}
      >
        {isUser ? (
          <>
            <span className="tabular-nums">{formatTime(message.createdAt)}</span>
            <span>YOU</span>
          </>
        ) : (
          <>
            <span className="text-glow">CHITTI</span>
            <span className="tabular-nums">{formatTime(message.createdAt)}</span>
          </>
        )}
      </div>

      <div
        className={cn(
          'max-w-[85%] px-4 py-3 rounded-lg leading-relaxed text-sm',
          isUser
            ? 'glass bg-chitti-700/25 border-chitti-500/30 text-chitti-50 rounded-br-sm'
            : 'glass hud-corners text-chitti-50 rounded-bl-sm',
        )}
      >
        {message.content.length === 0 && showCursor ? (
          <span className="inline-flex items-center gap-1 text-chitti-300/80">
            <span className="font-mono text-xs tracking-widest">THINKING</span>
            <span className="inline-block w-2 h-4 bg-chitti-400 animate-pulse ml-1" />
          </span>
        ) : (
          <span className="whitespace-pre-wrap">
            {message.content}
            {showCursor && (
              <span
                aria-hidden
                className="inline-block w-2 h-4 align-text-bottom bg-chitti-400 ml-1 animate-pulse"
              />
            )}
          </span>
        )}
      </div>

      {message.artifact && (
        <div className="w-full max-w-[85%] mt-1">
          <Suspense
            fallback={
              <div className="text-xs text-chitti-300/60 font-mono tracking-widest p-2">
                LOADING ARTIFACT…
              </div>
            }
          >
            <DataDashboard artifact={message.artifact} />
          </Suspense>
        </div>
      )}
    </motion.div>
  );
}

/* ─────────────── panel ─────────────── */

export interface ConversationPanelProps {
  className?: string;
}

export function ConversationPanel({ className }: ConversationPanelProps) {
  const messages = useChittiStore((s) => s.messages);
  const isStreaming = useChittiStore((s) => s.isStreaming);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll on new content.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, isStreaming]);

  const visibleMessages = useMemo(
    () => messages.filter((m) => m.role === 'user' || m.role === 'assistant'),
    [messages],
  );

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].id;
    }
    return null;
  }, [messages]);

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex-1 overflow-y-auto px-4 py-6 space-y-5',
        className,
      )}
    >
      {visibleMessages.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center text-center gap-3 text-chitti-300/60">
          <div className="font-display text-xs tracking-[0.6em]">CHANNEL OPEN</div>
          <div className="text-sm max-w-xs">
            Speak or type. Ask me about the data, the time, or anything else.
          </div>
        </div>
      ) : (
        <AnimatePresence initial={false}>
          {visibleMessages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              showCursor={
                isStreaming &&
                m.role === 'assistant' &&
                m.id === lastAssistantId
              }
            />
          ))}
        </AnimatePresence>
      )}
    </div>
  );
}

export default ConversationPanel;
