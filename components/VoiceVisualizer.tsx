'use client';

/**
 * VoiceVisualizer — a 24-bar horizontal equalizer.
 *
 * `active`     → bars animate with organic, per-bar randomness.
 * `level`      → 0..1 input intensity; scales the bars when active.
 * Inactive     → bars sit nearly flat with a subtle pulse so the panel still feels alive.
 */

import { motion } from 'framer-motion';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

export interface VoiceVisualizerProps {
  active: boolean;
  level?: number;
  className?: string;
  bars?: number;
}

export function VoiceVisualizer({
  active,
  level = 0,
  className,
  bars = 24,
}: VoiceVisualizerProps) {
  // Per-bar phase / weight so the wave looks organic, not symmetric.
  const seeds = useMemo(
    () =>
      Array.from({ length: bars }, (_, i) => ({
        // Sinusoid weight: taller in the middle, shorter at the edges.
        weight: 0.4 + 0.6 * Math.sin((i / (bars - 1)) * Math.PI),
        delay: (i * 0.04) % 1.2,
        // Bar-unique speed so they don't pulse in lockstep.
        duration: 0.55 + ((i * 31) % 7) * 0.07,
      })),
    [bars],
  );

  const baseHeight = 4;
  const maxHeight = 28;

  return (
    <div
      className={cn(
        'flex items-end gap-[3px] h-8 px-1',
        className,
      )}
      aria-hidden
    >
      {seeds.map((seed, i) => {
        const reactive = Math.max(0, Math.min(level, 1)) * seed.weight;
        const peak = active
          ? baseHeight + reactive * (maxHeight - baseHeight) + 4
          : baseHeight + 1;
        // animate target heights
        const heights = active
          ? [
              baseHeight + reactive * 6,
              peak,
              baseHeight + reactive * 10,
              peak * 0.7,
              baseHeight + reactive * 4,
            ]
          : [baseHeight, baseHeight + 1, baseHeight];

        return (
          <motion.div
            key={i}
            className="w-[3px] rounded-full bg-chitti-400"
            style={{
              boxShadow: active
                ? '0 0 6px rgba(26, 210, 255, 0.85)'
                : '0 0 3px rgba(26, 210, 255, 0.45)',
              opacity: active ? 0.95 : 0.45,
            }}
            animate={{ height: heights }}
            transition={{
              duration: seed.duration,
              repeat: Infinity,
              ease: 'easeInOut',
              delay: seed.delay,
            }}
          />
        );
      })}
    </div>
  );
}

export default VoiceVisualizer;
