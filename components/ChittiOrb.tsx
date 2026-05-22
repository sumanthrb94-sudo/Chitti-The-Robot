'use client';

/**
 * ChittiOrb — the centerpiece holographic orb.
 *
 * Composition (back → front):
 *   1. Outer glow ring (state-tinted box-shadow)
 *   2. Three concentric ring tracks with tick marks (rotating at different rates)
 *   3. Floating particles orbiting at varying radii
 *   4. Central core: gradient sphere that breathes / scales / strobes per state
 *   5. Speaking-state radiating waves
 *   6. Tabular telemetry text overlays ("CHITTI", "v0.1", live counter)
 *
 * Built with framer-motion + SVG. No canvas required.
 */

import { motion, type Transition } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import type { ChittiState } from '@/types';

export interface ChittiOrbProps {
  state: ChittiState;
  /** 0..1 mic input level; only consulted when state === 'listening' */
  audioLevel?: number;
  className?: string;
}

const SIZE = 360;
const CENTER = SIZE / 2;

interface PaletteEntry {
  core: string;
  coreEdge: string;
  ring: string;
  ringDim: string;
  glow: string;
  label: string;
}

const PALETTE: Record<ChittiState, PaletteEntry> = {
  idle: {
    core: '#4ddcff',
    coreEdge: '#9b6bff',
    ring: 'rgba(77, 220, 255, 0.85)',
    ringDim: 'rgba(77, 220, 255, 0.25)',
    glow: 'rgba(0, 184, 230, 0.55)',
    label: 'STANDBY',
  },
  listening: {
    core: '#00e5a8',
    coreEdge: '#4ddcff',
    ring: 'rgba(0, 229, 168, 0.9)',
    ringDim: 'rgba(0, 229, 168, 0.3)',
    glow: 'rgba(0, 229, 168, 0.6)',
    label: 'LISTENING',
  },
  thinking: {
    core: '#9b6bff',
    coreEdge: '#4ddcff',
    ring: 'rgba(155, 107, 255, 0.9)',
    ringDim: 'rgba(155, 107, 255, 0.3)',
    glow: 'rgba(155, 107, 255, 0.55)',
    label: 'PROCESSING',
  },
  speaking: {
    core: '#4ddcff',
    coreEdge: '#80e7ff',
    ring: 'rgba(128, 231, 255, 0.95)',
    ringDim: 'rgba(128, 231, 255, 0.32)',
    glow: 'rgba(77, 220, 255, 0.7)',
    label: 'TRANSMITTING',
  },
  error: {
    core: '#ff3860',
    coreEdge: '#ffb020',
    ring: 'rgba(255, 56, 96, 0.9)',
    ringDim: 'rgba(255, 56, 96, 0.3)',
    glow: 'rgba(255, 56, 96, 0.55)',
    label: 'FAULT',
  },
};

/** Generate evenly distributed tick marks around a circle. */
function buildTicks(
  count: number,
  radius: number,
  inner: number,
  highlightEvery = 0,
): Array<{ x1: number; y1: number; x2: number; y2: number; bright: boolean }> {
  const out: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    bright: boolean;
  }> = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    out.push({
      x1: CENTER + cos * inner,
      y1: CENTER + sin * inner,
      x2: CENTER + cos * radius,
      y2: CENTER + sin * radius,
      bright: highlightEvery > 0 ? i % highlightEvery === 0 : false,
    });
  }
  return out;
}

const RING_OUTER_TICKS = buildTicks(60, 170, 158, 5);
const RING_MID_TICKS = buildTicks(40, 138, 128, 4);
const RING_INNER_TICKS = buildTicks(24, 108, 100, 3);

const PARTICLE_COUNT = 7;

export function ChittiOrb({ state, audioLevel = 0, className }: ChittiOrbProps) {
  const palette = PALETTE[state];

  /** Telemetry counter ticking up — pure cosmetic. */
  const [telemetry, setTelemetry] = useState(20471);
  useEffect(() => {
    const id = window.setInterval(() => {
      setTelemetry((n) => n + Math.floor(1 + Math.random() * 7));
    }, 280);
    return () => window.clearInterval(id);
  }, []);

  // Speed multipliers per state.
  const speeds = useMemo(() => {
    switch (state) {
      case 'listening':
        return { outer: 8, mid: 6, inner: 4 };
      case 'thinking':
        return { outer: 4, mid: 3, inner: 2 };
      case 'speaking':
        return { outer: 10, mid: 7, inner: 5 };
      case 'error':
        return { outer: 20, mid: 16, inner: 12 };
      default:
        return { outer: 18, mid: 14, inner: 22 };
    }
  }, [state]);

  // Core scale reactive to audio level when listening, otherwise driven by state.
  const coreScale = useMemo(() => {
    if (state === 'listening') {
      return 1 + Math.min(audioLevel, 1) * 0.35;
    }
    return 1;
  }, [state, audioLevel]);

  // Particles — memo so motion components don't reshuffle.
  const particles = useMemo(
    () =>
      Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
        id: i,
        radius: 92 + (i % 4) * 22,
        size: 2 + (i % 3),
        duration: 7 + (i % 5) * 1.6,
        delay: (i * 0.42) % 3,
        reverse: i % 2 === 0,
      })),
    [],
  );

  // Speaking-state radiating waves.
  const speakingWaves = [0, 1, 2];

  return (
    <div
      className={cn(
        'relative flex items-center justify-center select-none',
        className,
      )}
      style={{ width: SIZE, height: SIZE }}
    >
      {/* Outer glow halo */}
      <div
        aria-hidden
        className="absolute inset-0 rounded-full pointer-events-none transition-[box-shadow] duration-700"
        style={{
          boxShadow: `0 0 80px 10px ${palette.glow}, inset 0 0 60px ${palette.ringDim}`,
        }}
      />

      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="absolute inset-0"
        aria-hidden
      >
        <defs>
          <radialGradient id="orb-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
            <stop offset="35%" stopColor={palette.core} stopOpacity="0.9" />
            <stop offset="75%" stopColor={palette.coreEdge} stopOpacity="0.55" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="orb-inner-glass" cx="50%" cy="42%" r="42%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.6" />
            <stop offset="60%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <filter id="orb-blur" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="1.2" />
          </filter>
        </defs>

        {/* Outer ring */}
        <motion.g
          style={{ transformOrigin: `${CENTER}px ${CENTER}px` }}
          animate={{ rotate: 360 }}
          transition={{
            duration: speeds.outer,
            ease: 'linear',
            repeat: Infinity,
          }}
        >
          <circle
            cx={CENTER}
            cy={CENTER}
            r={170}
            fill="none"
            stroke={palette.ringDim}
            strokeWidth={1}
          />
          {RING_OUTER_TICKS.map((t, i) => (
            <line
              key={`o${i}`}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={t.bright ? palette.ring : palette.ringDim}
              strokeWidth={t.bright ? 1.6 : 1}
              strokeLinecap="round"
            />
          ))}
        </motion.g>

        {/* Mid ring — counter-rotating */}
        <motion.g
          style={{ transformOrigin: `${CENTER}px ${CENTER}px` }}
          animate={{ rotate: -360 }}
          transition={{
            duration: speeds.mid,
            ease: 'linear',
            repeat: Infinity,
          }}
        >
          <circle
            cx={CENTER}
            cy={CENTER}
            r={138}
            fill="none"
            stroke={palette.ringDim}
            strokeWidth={1}
            strokeDasharray="2 6"
          />
          {RING_MID_TICKS.map((t, i) => (
            <line
              key={`m${i}`}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={t.bright ? palette.ring : palette.ringDim}
              strokeWidth={t.bright ? 1.4 : 0.8}
              strokeLinecap="round"
            />
          ))}
        </motion.g>

        {/* Inner ring */}
        <motion.g
          style={{ transformOrigin: `${CENTER}px ${CENTER}px` }}
          animate={{ rotate: 360 }}
          transition={{
            duration: speeds.inner,
            ease: 'linear',
            repeat: Infinity,
          }}
        >
          <circle
            cx={CENTER}
            cy={CENTER}
            r={108}
            fill="none"
            stroke={palette.ringDim}
            strokeWidth={1}
          />
          {RING_INNER_TICKS.map((t, i) => (
            <line
              key={`i${i}`}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={t.bright ? palette.ring : palette.ringDim}
              strokeWidth={t.bright ? 1.3 : 0.8}
              strokeLinecap="round"
            />
          ))}
        </motion.g>

        {/* PROCESSING arc for thinking state */}
        {state === 'thinking' && (
          <motion.g style={{ transformOrigin: `${CENTER}px ${CENTER}px` }}>
            <motion.circle
              cx={CENTER}
              cy={CENTER}
              r={150}
              fill="none"
              stroke={palette.ring}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray="900"
              strokeDashoffset={900}
              animate={{ strokeDashoffset: [900, 0, 900], rotate: 360 }}
              transition={{
                duration: 2.2,
                repeat: Infinity,
                ease: 'easeInOut',
              }}
              style={{ transformOrigin: `${CENTER}px ${CENTER}px` }}
              filter="url(#orb-blur)"
            />
          </motion.g>
        )}

        {/* Speaking radiating waves */}
        {state === 'speaking' &&
          speakingWaves.map((i) => (
            <motion.circle
              key={`wave${i}`}
              cx={CENTER}
              cy={CENTER}
              r={70}
              fill="none"
              stroke={palette.core}
              strokeWidth={2}
              animate={{
                r: [70, 165],
                opacity: [0.65, 0],
                strokeWidth: [2, 0.3],
              }}
              transition={
                {
                  duration: 1.8,
                  repeat: Infinity,
                  ease: 'easeOut',
                  delay: i * 0.6,
                } satisfies Transition
              }
            />
          ))}

        {/* Central core */}
        <motion.g
          style={{ transformOrigin: `${CENTER}px ${CENTER}px` }}
          animate={
            state === 'thinking'
              ? { scale: [1, 1.08, 0.96, 1.04, 1], opacity: [0.95, 1, 0.85, 1, 0.95] }
              : state === 'error'
                ? { scale: [1, 1.1, 0.95, 1], opacity: [1, 0.6, 1, 0.8, 1] }
                : { scale: coreScale }
          }
          transition={
            state === 'thinking'
              ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }
              : state === 'error'
                ? { duration: 0.4, repeat: Infinity, ease: 'easeInOut' }
                : { type: 'spring', stiffness: 180, damping: 18 }
          }
        >
          <circle
            cx={CENTER}
            cy={CENTER}
            r={78}
            fill="url(#orb-core)"
            className={state === 'idle' ? 'animate-orb-breathe' : undefined}
            style={{ transformOrigin: `${CENTER}px ${CENTER}px` }}
          />
          {/* glass highlight */}
          <ellipse
            cx={CENTER - 14}
            cy={CENTER - 22}
            rx={36}
            ry={20}
            fill="url(#orb-inner-glass)"
            opacity={0.7}
          />
          {/* equator line */}
          <line
            x1={CENTER - 70}
            y1={CENTER}
            x2={CENTER + 70}
            y2={CENTER}
            stroke={palette.ring}
            strokeWidth={0.6}
            opacity={0.5}
          />
          {/* meridian */}
          <line
            x1={CENTER}
            y1={CENTER - 70}
            x2={CENTER}
            y2={CENTER + 70}
            stroke={palette.ring}
            strokeWidth={0.4}
            opacity={0.35}
          />
        </motion.g>
      </svg>

      {/* Orbiting particles — DOM dots so each has its own animation */}
      {particles.map((p) => (
        <motion.div
          key={p.id}
          aria-hidden
          className="absolute left-1/2 top-1/2 origin-center"
          style={{
            width: 0,
            height: 0,
          }}
          animate={{ rotate: p.reverse ? -360 : 360 }}
          transition={{
            duration: p.duration,
            repeat: Infinity,
            ease: 'linear',
            delay: p.delay,
          }}
        >
          <div
            className="rounded-full"
            style={{
              width: p.size * 2,
              height: p.size * 2,
              background: palette.core,
              boxShadow: `0 0 10px ${palette.core}`,
              transform: `translate(${p.radius - p.size}px, -${p.size}px)`,
            }}
          />
        </motion.div>
      ))}

      {/* Text overlays — Orbitron, tabular nums */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-3 left-1/2 -translate-x-1/2 font-display text-[10px] tracking-[0.5em] text-chitti-200/80 text-glow">
          CHITTI
        </div>
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 font-mono text-[10px] tracking-[0.3em] text-chitti-300/70 tabular-nums">
          v0.1 · {palette.label}
        </div>
        <div className="absolute top-1/2 -translate-y-1/2 left-2 font-mono text-[9px] tracking-widest text-chitti-300/60 tabular-nums">
          {String(telemetry).padStart(7, '0')}
        </div>
        <div
          className="absolute top-1/2 -translate-y-1/2 right-2 font-mono text-[9px] tracking-widest text-chitti-300/60 tabular-nums"
          style={{ writingMode: 'vertical-rl' }}
        >
          SYS·{Math.floor(telemetry / 100) % 1000}
        </div>
      </div>
    </div>
  );
}

export default ChittiOrb;
