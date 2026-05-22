'use client';

/**
 * SystemStatus — thin HUD bar pinned across the top of the layout.
 *
 * Shows:
 *   - "CHITTI ONLINE" with a pulsing green dot.
 *   - The live ChittiState ("LISTENING…", "PROCESSING…", …).
 *   - Fake telemetry: CPU%, MEM, NET state — ticks every second.
 */

import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useChittiStore } from '@/lib/store';
import type { ChittiState } from '@/types';

const STATE_LABEL: Record<ChittiState, string> = {
  idle: 'STANDBY',
  listening: 'LISTENING…',
  thinking: 'PROCESSING…',
  speaking: 'TRANSMITTING…',
  error: 'FAULT',
};

const STATE_COLOR: Record<ChittiState, string> = {
  idle: 'text-chitti-200',
  listening: 'text-signal-green',
  thinking: 'text-signal-violet',
  speaking: 'text-chitti-100',
  error: 'text-signal-red',
};

export interface SystemStatusProps {
  className?: string;
}

interface Telemetry {
  cpu: number;
  memGb: number;
  net: 'OK' | 'BUSY';
}

export function SystemStatus({ className }: SystemStatusProps) {
  const state = useChittiStore((s) => s.state);

  const [telemetry, setTelemetry] = useState<Telemetry>({
    cpu: 34,
    memGb: 1.2,
    net: 'OK',
  });

  const [clock, setClock] = useState<string>('');

  useEffect(() => {
    const tick = () => {
      setTelemetry((prev) => ({
        cpu: Math.max(
          12,
          Math.min(96, Math.round(prev.cpu + (Math.random() - 0.5) * 14)),
        ),
        memGb: Math.max(
          0.8,
          Math.min(7.4, +(prev.memGb + (Math.random() - 0.5) * 0.18).toFixed(1)),
        ),
        net: Math.random() > 0.92 ? 'BUSY' : 'OK',
      }));
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      setClock(`${hh}:${mm}:${ss}`);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      className={cn(
        'glass-strong hud-corners w-full px-4 py-2 flex items-center gap-4 font-mono text-[11px] tracking-[0.25em] uppercase tabular-nums',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <motion.span
          aria-hidden
          className="block w-2 h-2 rounded-full bg-signal-green"
          style={{ boxShadow: '0 0 10px rgba(0, 229, 168, 0.85)' }}
          animate={{ opacity: [1, 0.35, 1] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
        />
        <span className="font-display tracking-[0.4em] text-chitti-100 text-glow">
          CHITTI ONLINE
        </span>
      </div>

      <span
        className={cn('font-display tracking-[0.4em]', STATE_COLOR[state])}
      >
        {STATE_LABEL[state]}
      </span>

      <div className="flex-1" />

      <div className="hidden sm:flex items-center gap-4 text-chitti-300/85">
        <span>CPU {String(telemetry.cpu).padStart(2, '0')}%</span>
        <span>MEM {telemetry.memGb.toFixed(1)}GB</span>
        <span
          className={
            telemetry.net === 'OK' ? 'text-signal-green' : 'text-signal-amber'
          }
        >
          NET {telemetry.net === 'OK' ? '◉' : '◍'} {telemetry.net}
        </span>
        <span className="text-chitti-200/90">{clock}</span>
      </div>
    </div>
  );
}

export default SystemStatus;
