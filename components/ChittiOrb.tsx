'use client';

/**
 * ChittiOrb — minimal holographic core.
 *
 * Composition (back → front):
 *   1. Soft outer halo glow (state-tinted).
 *   2. Two thin concentric rings, slowly counter-rotating.
 *   3. Central gradient sphere with a single specular highlight.
 *   4. Speaking-state radiating waves (subtle).
 *
 * Public API: { state, audioLevel?, className?, size? }, default export.
 */

import { motion } from 'framer-motion';
import { useMemo } from 'react';

import { cn } from '@/lib/utils';
import type { ChittiState } from '@/types';

export interface ChittiOrbProps {
  state: ChittiState;
  /** 0..1 mic input level; only consulted when state === 'listening' */
  audioLevel?: number;
  className?: string;
  /** Render size in CSS pixels (square). Default 280. */
  size?: number;
}

interface Palette {
  core: string;
  edge: string;
  ring: string;
  halo: string;
}

const PALETTE: Record<ChittiState, Palette> = {
  idle: {
    core: '#80e7ff',
    edge: '#4ddcff',
    ring: 'rgba(77, 220, 255, 0.45)',
    halo: 'rgba(0, 184, 230, 0.42)',
  },
  listening: {
    core: '#00e5a8',
    edge: '#4ddcff',
    ring: 'rgba(0, 229, 168, 0.55)',
    halo: 'rgba(0, 229, 168, 0.45)',
  },
  thinking: {
    core: '#b18bff',
    edge: '#4ddcff',
    ring: 'rgba(155, 107, 255, 0.5)',
    halo: 'rgba(155, 107, 255, 0.4)',
  },
  speaking: {
    core: '#80e7ff',
    edge: '#9b6bff',
    ring: 'rgba(77, 220, 255, 0.6)',
    halo: 'rgba(77, 220, 255, 0.5)',
  },
  error: {
    core: '#ff7a8c',
    edge: '#ff3860',
    ring: 'rgba(255, 56, 96, 0.5)',
    halo: 'rgba(255, 56, 96, 0.45)',
  },
};

export function ChittiOrb({
  state,
  audioLevel = 0,
  className,
  size = 280,
}: ChittiOrbProps) {
  const palette = PALETTE[state];

  // Single scale factor that breathes (idle) / reacts to mic (listening) /
  // pulses (thinking) / radiates (speaking).
  const coreAnimation = useMemo(() => {
    switch (state) {
      case 'listening': {
        const target = 1 + 0.06 * Math.min(1, Math.max(0, audioLevel));
        return {
          scale: [1, target, 1],
          transition: { duration: 0.6, repeat: Infinity, ease: 'easeInOut' as const },
        };
      }
      case 'thinking':
        return {
          scale: [1, 1.04, 1],
          opacity: [0.95, 1, 0.95],
          transition: { duration: 1.1, repeat: Infinity, ease: 'easeInOut' as const },
        };
      case 'speaking':
        return {
          scale: [1, 1.025, 1],
          transition: { duration: 0.5, repeat: Infinity, ease: 'easeInOut' as const },
        };
      case 'error':
        return {
          scale: [1, 1.02, 1],
          opacity: [1, 0.7, 1],
          transition: { duration: 0.18, repeat: Infinity, ease: 'easeInOut' as const },
        };
      case 'idle':
      default:
        return {
          scale: [1, 1.03, 1],
          transition: { duration: 4, repeat: Infinity, ease: 'easeInOut' as const },
        };
    }
  }, [state, audioLevel]);

  // Ring rotation speeds tune slightly with state.
  const outerDur = state === 'thinking' ? 9 : state === 'listening' ? 14 : 24;
  const innerDur = state === 'thinking' ? 6 : state === 'listening' ? 10 : 18;

  return (
    <div
      className={cn('relative grid place-items-center select-none', className)}
      style={{ width: size, height: size }}
      aria-label={`Chitti orb, state: ${state}`}
    >
      {/* Halo glow — large soft radial behind the sphere */}
      <div
        aria-hidden
        className="absolute inset-0 rounded-full"
        style={{
          background: `radial-gradient(circle at 50% 50%, ${palette.halo} 0%, transparent 65%)`,
          filter: 'blur(8px)',
        }}
      />

      {/* Outer ring */}
      <motion.div
        aria-hidden
        className="absolute rounded-full"
        style={{
          width: size * 0.92,
          height: size * 0.92,
          border: `1px solid ${palette.ring}`,
          boxShadow: `0 0 18px ${palette.ring}`,
        }}
        animate={{ rotate: 360 }}
        transition={{ duration: outerDur, repeat: Infinity, ease: 'linear' }}
      >
        {/* Single accent tick at 12 o'clock */}
        <div
          className="absolute left-1/2 -translate-x-1/2 -top-[3px] w-[6px] h-[6px] rounded-full"
          style={{
            background: palette.edge,
            boxShadow: `0 0 8px ${palette.edge}`,
          }}
        />
      </motion.div>

      {/* Inner ring (counter-rotating) */}
      <motion.div
        aria-hidden
        className="absolute rounded-full"
        style={{
          width: size * 0.68,
          height: size * 0.68,
          border: `1px solid ${palette.ring}`,
          opacity: 0.55,
        }}
        animate={{ rotate: -360 }}
        transition={{ duration: innerDur, repeat: Infinity, ease: 'linear' }}
      >
        {/* Two faint ticks at 3 and 9 o'clock */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -left-[2px] w-[4px] h-[4px] rounded-full"
          style={{ background: palette.edge, opacity: 0.7 }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 -right-[2px] w-[4px] h-[4px] rounded-full"
          style={{ background: palette.edge, opacity: 0.7 }}
        />
      </motion.div>

      {/* Speaking-state radiating waves */}
      {state === 'speaking' && (
        <>
          {[0, 0.6, 1.2].map((delay) => (
            <motion.div
              key={delay}
              aria-hidden
              className="absolute rounded-full"
              style={{
                width: size * 0.5,
                height: size * 0.5,
                border: `1px solid ${palette.edge}`,
              }}
              initial={{ scale: 1, opacity: 0.45 }}
              animate={{ scale: 1.8, opacity: 0 }}
              transition={{
                duration: 1.8,
                delay,
                repeat: Infinity,
                ease: 'easeOut',
              }}
            />
          ))}
        </>
      )}

      {/* Core sphere — gradient with specular highlight */}
      <motion.div
        aria-hidden
        className="relative rounded-full"
        style={{
          width: size * 0.42,
          height: size * 0.42,
          background: `
            radial-gradient(circle at 36% 32%, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.18) 14%, transparent 30%),
            radial-gradient(circle at 50% 50%, ${palette.core} 0%, ${palette.edge} 55%, rgba(0,0,0,0) 90%)
          `,
          boxShadow: `0 0 50px ${palette.halo}, inset 0 0 28px rgba(0, 0, 0, 0.35)`,
        }}
        animate={coreAnimation}
      />
    </div>
  );
}

export default ChittiOrb;
