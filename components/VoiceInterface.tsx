'use client';

/**
 * VoiceInterface — circular mic button + visualizer + state badge.
 *
 * Two recognition paths, selected from saved settings on every click:
 *
 *   - Web Speech (default): `createRecognition()` streams interim text
 *     into the store while the user speaks, fires `onSend(text)` on the
 *     final result.
 *
 *   - Groq Whisper (opt-in): `createAsrRecorder()` captures the mic with
 *     MediaRecorder. We render a "REC" pulsing dot while recording. When
 *     the user clicks the mic again (or maxMs lapses) the captured Blob
 *     is shipped to `/api/asr` and the returned transcript is forwarded
 *     to `onSend`.
 */

import { motion } from 'framer-motion';
import { Mic, MicOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useChittiStore } from '@/lib/store';
import { loadSettings } from '@/lib/settings';
import {
  createAsrRecorder,
  isAsrSupported,
  type AsrRecorderHandle,
} from '@/lib/asr';
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
  // True when we're actively recording for Groq Whisper (vs. Web Speech).
  // Drives the "REC" pulsing dot and the PROCESSING badge while we await
  // the transcript round-trip.
  const [usingGroq, setUsingGroq] = useState(false);

  const recognitionRef = useRef<RecognitionHandle | null>(null);
  const asrRecorderRef = useRef<AsrRecorderHandle | null>(null);
  const levelTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // Either path is enough to enable the button. Groq works on any browser
    // with MediaRecorder + getUserMedia (covers Safari iOS where Web Speech
    // is missing); Web Speech is the no-key default for Chromium.
    setSupported(isVoiceInputSupported() || isAsrSupported());
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

  /* ─────────────  Web Speech path  ───────────── */

  const startBrowser = useCallback(() => {
    if (!isVoiceInputSupported()) {
      // Caller has already decided this isn't the Groq path; we can't help.
      setSupported(isAsrSupported());
      return;
    }
    if (recognitionRef.current) return;

    const handle = createRecognition({
      onResult: (text, isFinal) => {
        setInputText(text);
        if (isFinal && text.length > 0) {
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
      setSupported(isAsrSupported());
      return;
    }
    recognitionRef.current = handle;
    setListening(true);
    setState('listening');
    startLevelTicker();
    handle.start();
  }, [onSend, setInputText, setState, startLevelTicker, state, stopLevelTicker]);

  const stopBrowser = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
    stopLevelTicker();
    if (state === 'listening') setState('idle');
  }, [setState, state, stopLevelTicker]);

  /* ─────────────  Groq Whisper path  ───────────── */

  const startGroq = useCallback(async () => {
    if (asrRecorderRef.current) return;

    const settings = loadSettings();
    const credentials = settings.asr;

    const recorder = await createAsrRecorder({
      credentials,
      maxMs: 15_000,
      onTranscript: () => {
        // The actual hand-off to onSend happens in stopGroq where we await
        // the recorder's stop() promise — keeping the flow single-source.
      },
      onError: (err) => {
        // Recorder bailed out asynchronously (e.g. auto-stop fired with no
        // audio). Surface as a soft fault and reset UI.
        asrRecorderRef.current = null;
        setListening(false);
        setUsingGroq(false);
        stopLevelTicker();
        const message = err.message || '';
        if (message === 'asr_no_audio' || message === 'aborted') {
          if (state === 'listening' || state === 'thinking') setState('idle');
        } else {
          setState('error');
        }
      },
    });

    if (!recorder) {
      // No mic / MediaRecorder — fall back to Web Speech if available.
      setUsingGroq(false);
      if (isVoiceInputSupported()) {
        startBrowser();
      } else {
        setSupported(false);
        setState('error');
      }
      return;
    }

    asrRecorderRef.current = recorder;
    setUsingGroq(true);
    setListening(true);
    setState('listening');
    startLevelTicker();
    try {
      await recorder.start();
    } catch (e) {
      asrRecorderRef.current = null;
      setListening(false);
      setUsingGroq(false);
      stopLevelTicker();
      setState('error');
      // eslint-disable-next-line no-console
      console.error('[chitti] asr start failed', e);
    }
  }, [setState, startBrowser, startLevelTicker, state, stopLevelTicker]);

  const stopGroq = useCallback(async () => {
    const recorder = asrRecorderRef.current;
    if (!recorder) return;
    asrRecorderRef.current = null;
    setListening(false);
    stopLevelTicker();
    // Whisper round-trip — flip to PROCESSING while we wait.
    setState('thinking');
    try {
      const result = await recorder.stop();
      const text = result.text.trim();
      if (text.length > 0) {
        onSend(text);
        setInputText('');
      } else if (state === 'thinking') {
        setState('idle');
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[chitti] asr transcript failed', e);
      setState('error');
    } finally {
      setUsingGroq(false);
    }
  }, [onSend, setInputText, setState, state, stopLevelTicker]);

  /* ─────────────  Combined toggle  ───────────── */

  const pickGroq = useCallback(() => {
    const settings = loadSettings();
    return (
      settings.asr.provider === 'groq' &&
      typeof settings.asr.apiKey === 'string' &&
      settings.asr.apiKey.trim().length > 0 &&
      isAsrSupported()
    );
  }, []);

  const start = useCallback(() => {
    if (pickGroq()) {
      void startGroq();
    } else {
      startBrowser();
    }
  }, [pickGroq, startBrowser, startGroq]);

  const stop = useCallback(() => {
    if (asrRecorderRef.current) {
      void stopGroq();
    } else {
      stopBrowser();
    }
  }, [stopBrowser, stopGroq]);

  // Cleanup on unmount — bail out of either recognition path cleanly.
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      asrRecorderRef.current?.cancel();
      asrRecorderRef.current = null;
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

  // Wake-word integration — `<WakeWordListener />` dispatches a
  // `chitti:wake` event on the window when it detects the hot-word.
  // We mirror the mic-button click behaviour: start ASR if we're idle,
  // ignore the trigger if we're already busy (streaming, listening,
  // or speaking — don't interrupt the assistant mid-reply).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      if (!supported) return;
      if (isStreaming) return;
      if (listening) return;
      if (state === 'speaking') return;
      start();
    };
    window.addEventListener('chitti:wake', handler);
    return () => window.removeEventListener('chitti:wake', handler);
  }, [isStreaming, listening, start, state, supported]);

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
              ? usingGroq
                ? 'Stop recording (Whisper)'
                : 'Stop listening'
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

      {/* REC dot — only shown when we're actively recording for Whisper. */}
      {usingGroq && listening && (
        <span className="hidden md:inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.3em] text-signal-red">
          <motion.span
            className="inline-block w-2 h-2 rounded-full bg-signal-red"
            animate={{ opacity: [1, 0.25, 1] }}
            transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
            aria-hidden
          />
          REC
        </span>
      )}

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
