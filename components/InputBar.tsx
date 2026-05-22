'use client';

/**
 * InputBar — pinned-bottom text input + send/stop + embedded VoiceInterface.
 *
 * - Enter to send. Shift+Enter for newline.
 * - While streaming, the Send button morphs into Stop (calls onStop).
 * - The voice mic is on the right; speaking a final transcript also triggers onSend.
 */

import { Send, Square } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useChittiStore } from '@/lib/store';
import VoiceInterface from './VoiceInterface';

export interface InputBarProps {
  onSend: (text: string) => void;
  onStop: () => void;
  className?: string;
}

export function InputBar({ onSend, onStop, className }: InputBarProps) {
  const inputText = useChittiStore((s) => s.inputText);
  const setInputText = useChittiStore((s) => s.setInputText);
  const isStreaming = useChittiStore((s) => s.isStreaming);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize textarea up to a cap.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, 160);
    el.style.height = `${next}px`;
  }, [inputText]);

  const handleSend = useCallback(() => {
    const trimmed = inputText.trim();
    if (trimmed.length === 0) return;
    if (isStreaming) return;
    onSend(trimmed);
    setInputText('');
  }, [inputText, isStreaming, onSend, setInputText]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div
      className={cn(
        'glass-strong hud-corners p-3 flex items-end gap-3',
        className,
      )}
    >
      <div className="flex-1 min-w-0 relative">
        <div className="absolute left-3 top-3 font-mono text-[10px] tracking-[0.4em] text-chitti-400/70 pointer-events-none">
          {'>>'}
        </div>
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={
            isStreaming
              ? 'Chitti is responding…'
              : 'Speak or type your command…'
          }
          disabled={isStreaming}
          className={cn(
            'w-full resize-none bg-transparent outline-none',
            'pl-10 pr-3 pt-2.5 pb-2 min-h-[44px] max-h-40',
            'font-sans text-sm text-chitti-50 placeholder:text-chitti-400/60',
            'border-b border-chitti-700/60 focus:border-chitti-400/80 transition-colors',
            'disabled:opacity-60',
          )}
        />
      </div>

      <VoiceInterface onSend={onSend} />

      <button
        type="button"
        onClick={isStreaming ? onStop : handleSend}
        disabled={!isStreaming && inputText.trim().length === 0}
        title={isStreaming ? 'Stop' : 'Send'}
        className={cn(
          'flex items-center justify-center w-12 h-12 rounded-full transition-colors border',
          isStreaming
            ? 'border-signal-red/70 bg-signal-red/15 text-signal-red hover:bg-signal-red/25'
            : 'border-chitti-400/70 bg-chitti-500/15 text-chitti-100 hover:bg-chitti-500/30',
          !isStreaming &&
            inputText.trim().length === 0 &&
            'opacity-40 cursor-not-allowed hover:bg-chitti-500/15',
        )}
        style={{
          boxShadow: isStreaming
            ? '0 0 20px rgba(255, 56, 96, 0.45)'
            : '0 0 18px rgba(0, 184, 230, 0.45)',
        }}
      >
        {isStreaming ? (
          <Square className="w-5 h-5" strokeWidth={2} />
        ) : (
          <Send className="w-5 h-5" strokeWidth={1.8} />
        )}
      </button>
    </div>
  );
}

export default InputBar;
