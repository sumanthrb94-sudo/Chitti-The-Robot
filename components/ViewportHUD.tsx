'use client';

/**
 * ViewportHUD — minimal decorative overlay.
 *
 * Just four corner brackets — that's all. Anything else (scan bars,
 * hex grids, edge rails, version labels) competes with the orb and
 * the conversation for attention. Less is more.
 *
 * pointer-events: none everywhere, z-[1] so it sits above the page
 * background but below interactive content.
 */

import { cn } from '@/lib/utils';

interface CornerProps {
  position: 'tl' | 'tr' | 'bl' | 'br';
}

function Corner({ position }: CornerProps) {
  const map: Record<CornerProps['position'], string> = {
    tl: 'top-3 left-3 border-l border-t',
    tr: 'top-3 right-3 border-r border-t',
    bl: 'bottom-3 left-3 border-l border-b',
    br: 'bottom-3 right-3 border-r border-b',
  };
  return (
    <div
      aria-hidden
      className={cn(
        'fixed w-6 h-6 border-chitti-400/40 pointer-events-none',
        map[position],
      )}
    />
  );
}

export function ViewportHUD() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[1] overflow-hidden"
    >
      <Corner position="tl" />
      <Corner position="tr" />
      <Corner position="bl" />
      <Corner position="br" />
    </div>
  );
}

export default ViewportHUD;
