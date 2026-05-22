'use client';

/**
 * ViewportHUD — purely decorative full-viewport overlay.
 *
 * Composition (back → front, all pointer-events: none, z-index 1 max):
 *   • Faint hexagonal background grid (CSS data-URI SVG).
 *   • Four corner brackets (≈32px each), cyan with glow, inset 12px.
 *   • Top accent strip — triangular ornament + diagonal slashes + version label.
 *   • Left/right rail markings — thin vertical lines with periodic ticks.
 *   • Single horizontal "scan bar" travelling top→bottom every ~8s.
 *
 * Renders ABOVE the page background but BELOW interactive content.
 */

import { cn } from '@/lib/utils';

interface CornerProps {
  position: 'tl' | 'tr' | 'bl' | 'br';
}

function Corner({ position }: CornerProps) {
  const map: Record<CornerProps['position'], string> = {
    tl: 'top-3 left-3 border-l-2 border-t-2',
    tr: 'top-3 right-3 border-r-2 border-t-2',
    bl: 'bottom-3 left-3 border-l-2 border-b-2',
    br: 'bottom-3 right-3 border-r-2 border-b-2',
  };
  // A small tick sits inside the bracket — adds the Iron-Man fillip.
  const tickMap: Record<CornerProps['position'], string> = {
    tl: 'top-[6px] left-[6px] w-[6px] h-[6px] border-l border-t',
    tr: 'top-[6px] right-[6px] w-[6px] h-[6px] border-r border-t',
    bl: 'bottom-[6px] left-[6px] w-[6px] h-[6px] border-l border-b',
    br: 'bottom-[6px] right-[6px] w-[6px] h-[6px] border-r border-b',
  };
  return (
    <div
      aria-hidden
      className={cn(
        'fixed w-8 h-8 border-chitti-400/70 pointer-events-none',
        map[position],
      )}
      style={{
        boxShadow:
          '0 0 14px rgba(77, 220, 255, 0.35), inset 0 0 6px rgba(77, 220, 255, 0.18)',
      }}
    >
      <span
        aria-hidden
        className={cn(
          'absolute border-chitti-300/60 pointer-events-none',
          tickMap[position],
        )}
      />
    </div>
  );
}

function EdgeRail({ side }: { side: 'left' | 'right' }) {
  // Periodic vertical tick rail. We render with a CSS background gradient so
  // it works regardless of viewport height without measuring.
  const sideClass = side === 'left' ? 'left-1' : 'right-1';
  return (
    <div
      aria-hidden
      className={cn(
        'fixed top-24 bottom-24 w-px pointer-events-none',
        sideClass,
      )}
      style={{
        background:
          'linear-gradient(180deg, transparent 0%, rgba(77, 220, 255, 0.18) 12%, rgba(77, 220, 255, 0.18) 88%, transparent 100%)',
      }}
    >
      {/* Tick marks */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'repeating-linear-gradient(180deg, rgba(77, 220, 255, 0.45) 0px, rgba(77, 220, 255, 0.45) 1px, transparent 1px, transparent 28px)',
          width: side === 'left' ? 6 : 6,
          left: side === 'left' ? 0 : -5,
        }}
      />
      {/* Mid-rail label */}
      <span
        className="absolute top-1/2 -translate-y-1/2 font-mono text-[8px] tracking-[0.4em] text-chitti-300/50"
        style={{
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          left: side === 'left' ? 6 : undefined,
          right: side === 'right' ? 6 : undefined,
          transform:
            side === 'left'
              ? 'translateY(-50%) rotate(180deg)'
              : 'translateY(-50%)',
        }}
      >
        {side === 'left' ? 'AZ-04 // RAIL' : 'EL-12 // SYNC'}
      </span>
    </div>
  );
}

function TopAccentStrip() {
  return (
    <div
      aria-hidden
      className="fixed top-1 left-1/2 -translate-x-1/2 pointer-events-none flex items-center gap-2 select-none"
    >
      {/* Left diagonal slash */}
      <span
        className="block w-10 h-px bg-chitti-400/40"
        style={{ transform: 'rotate(-12deg)' }}
      />
      {/* Triangular ornament */}
      <span className="font-display text-[9px] tracking-[0.4em] text-chitti-300/70 flex items-center gap-2">
        <span
          className="block w-0 h-0"
          style={{
            borderLeft: '4px solid transparent',
            borderRight: '4px solid transparent',
            borderBottom: '6px solid rgba(77, 220, 255, 0.6)',
            filter: 'drop-shadow(0 0 4px rgba(77, 220, 255, 0.6))',
          }}
        />
        CHITTI HUD
        <span className="text-chitti-500/60">//</span>
        <span className="tabular-nums">v0.1.0</span>
        <span className="text-chitti-500/60">//</span>
        <span className="text-signal-green/80">OPERATIONAL</span>
      </span>
      {/* Right diagonal slash */}
      <span
        className="block w-10 h-px bg-chitti-400/40"
        style={{ transform: 'rotate(12deg)' }}
      />
    </div>
  );
}

export function ViewportHUD() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[1] overflow-hidden"
    >
      {/* Hex grid backdrop — sits behind everything inside the overlay. */}
      <div
        className="hex-grid absolute inset-0 opacity-50"
        style={{
          maskImage:
            'radial-gradient(ellipse at center, black 20%, transparent 78%)',
          WebkitMaskImage:
            'radial-gradient(ellipse at center, black 20%, transparent 78%)',
        }}
      />

      {/* Travelling scan bar — pure CSS, ~8s. */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="scan-bar animate-scan-slow" />
      </div>

      <Corner position="tl" />
      <Corner position="tr" />
      <Corner position="bl" />
      <Corner position="br" />

      <EdgeRail side="left" />
      <EdgeRail side="right" />

      <TopAccentStrip />
    </div>
  );
}

export default ViewportHUD;
