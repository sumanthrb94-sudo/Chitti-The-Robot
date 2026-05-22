'use client';

/**
 * VoiceInterface — circular mic button + visualizer + state badge.
 *
 * Behaviour:
 *   - Click mic → start SpeechRecognition. Interim transcripts populate the
 *     store's `inputText`. On final transcript we fire `onSend(text)` and clear.
 *   - Click again while listening → stop.
 *   - Auto-stops on recognition `onend`.
 *   - If Web Speech is unsupported, button is disabled with a tooltip.
 */

import { motion } from 'framer-motion';
import { Mic, MicOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useChittiStore } from '@/lib/store';
import {
  createRecognition,
  isVoiceInputSupported,
  type RecognitionHandle,
} from '@/lib/voice';
import VoiceVisualizer from './VoiceVisualizer';
import type { ChittiState } from '@/types';

export interface VoiceInterfaceProps {
  onSend: (text: string) => void;
  className?: string;
}

const STATE_LABEL: Record<ChittiState, string> = {
  idle: 'STANDBY',
  listening: 'LISTENING',
  thinking: 'PROCESSING',
  speaking: 'SPEAKING',
  error: 'FAULT',
};

const STATE_COLOR: Record<ChittiState, string> = {
  idle: 'text-chitti-300 border-chitti-700',
  listening: 'text-signal-green border-signal-green/60',
  thinking: 'text-signal-violet border-signal-violet/60',
  speaking: 'text-chitti-200 border-chitti-400/60',
  error: 'text-signal-red border-signal-red/60',
};

export function VoiceInterface({ onSend, className }: VoiceInterfaceProps) {
  const state = useChittiStore((s) => s.state);
  const setState = useChittiStore((s) => s.setState);
  const setInputText = useChittiStore((s) => s.setInputText);
  const isStreaming = useChittiStore((s) => s.isStreaming);

  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);

  const recognitionRef = useRef<RecognitionHandle | null>(null);
  const levelTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setSupported(isVoiceInputSupported());
  }, []);

  /** Cosmetic audio level — Web Speech doesn't expose raw mic data. */
  const startLevelTicker = useCallback(() => {
    if (levelTimerRef.current !== null) return;
    levelTimerRef.current = window.setInterval(() => {
      // pseudo-random walk so the visualizer feels alive
      setAudioLevel((prev) => {
        const target = 0.3 + Math.random() * 0.65;
        return prev + (target - prev) * 0.4;
      });
    }, 90);
  }, []);

  const stopLevelTicker = useCallback(() => {
    if (levelTimerRef.current !== null) {
      window.clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    setAudioLevel(0);
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
    stopLevelTicker();
    // Only revert state if we're the ones holding 'listening'
    if (state === 'listening') setState('idle');
  }, [setState, state, stopLevelTicker]);

  const start = useCallback(() => {
    if (!isVoiceInputSupported()) {
      setSupported(false);
      return;
    }
    if (recognitionRef.current) return;

    const handle = createRecognition({
      onResult: (text, isFinal) => {
        setInputText(text);
        if (isFinal && text.length > 0) {
          // Hand it to the parent and tear down recognition.
          onSend(text);
          setInputText('');
          recognitionRef.current?.stop();
          recognitionRef.current = null;
          setListening(false);
          stopLevelTicker();
        }
      },
      onEnd: () => {
        recognitionRef.current = null;
        setListening(false);
        stopLevelTicker();
        if (state === 'listening') setState('idle');
      },
      onError: (err) => {
        recognitionRef.current = null;
        setListening(false);
        stopLevelTicker();
        // Treat "no-speech" / "aborted" as benign cancels, not faults.
        if (err === 'no-speech' || err === 'aborted') {
          if (state === 'listening') setState('idle');
        } else {
          setState('error');
        }
      },
    });

    if (!handle) {
      setSupported(false);
      return;
    }
    recognitionRef.current = handle;
    setListening(true);
    setState('listening');
    startLevelTicker();
    handle.start();
  }, [onSend, setInputText, setState, startLevelTicker, state, stopLevelTicker]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      if (levelTimerRef.current !== null) {
        window.clearInterval(levelTimerRef.current);
      }
    };
  }, []);

  const toggle = useCallback(() => {
    if (!supported) return;
    if (isStreaming) return;
    if (listening) stop();
    else start();
  }, [isStreaming, listening, start, stop, supported]);

  const disabled = !supported || isStreaming;

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <motion.button
        type="button"
        onClick={toggle}
        disabled={disabled}
        whileTap={{ scale: 0.92 }}
        whileHover={disabled ? undefined : { scale: 1.04 }}
        title={
          !supported
            ? 'Voice input unsupported in this browser'
            : listening
              ? 'Stop listening'
              : 'Start listening'
        }
        className={cn(
          'relative flex items-center justify-center w-12 h-12 rounded-full border transition-colors',
          'font-display tracking-wider',
          listening
            ? 'border-signal-green/80 bg-signal-green/15 text-signal-green'
            : 'border-chitti-500/60 bg-chitti-900/40 text-chitti-200 hover:bg-chitti-800/60',
          disabled && 'opacity-40 cursor-not-allowed hover:bg-chitti-900/40',
        )}
        style={{
          boxShadow: listening
            ? '0 0 24px rgba(0, 229, 168, 0.55)'
            : '0 0 14px rgba(0, 184, 230, 0.35)',
        }}
      >
        {listening ? (
          <MicOff className="w-5 h-5" strokeWidth={1.8} />
        ) : (
          <Mic className="w-5 h-5" strokeWidth={1.8} />
        )}
        {listening && (
          <motion.span
            className="absolute inset-0 rounded-full border border-signal-green/60"
            initial={{ opacity: 0.7, scale: 1 }}
            animate={{ opacity: 0, scale: 1.7 }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
      </motion.button>

      <VoiceVisualizer
        active={listening}
        level={audioLevel}
        className="hidden md:block w-36"
      />

      <span
        className={cn(
          'hidden md:inline-flex items-center font-mono text-[10px] tracking-[0.3em] px-2 py-1 rounded border',
          STATE_COLOR[state],
        )}
      >
        {STATE_LABEL[state]}
      </span>
    </div>
  );
}

export default VoiceInterface;
