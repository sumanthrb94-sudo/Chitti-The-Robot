'use client';

/**
 * WakeWordListener — mount-once, headless component that arms a Picovoice
 * Porcupine listener when the user has opted in via Settings.
 *
 * Lifecycle:
 *   - On mount, read settings. If wake-word is disabled or no accessKey, idle.
 *   - Otherwise, lazily create the wake-word handle (which lazy-loads the
 *     Porcupine WASM module).
 *   - Wait for the first user interaction (click / keydown / touch) — browser
 *     autoplay policies forbid microphone access before a gesture.
 *   - Pause when the tab is hidden, resume when visible again. This keeps the
 *     mic cold while the user is on another tab (privacy + battery).
 *   - On unmount, release the worker + unsubscribe from the voice processor.
 *
 * Renders a tiny green dot in the corner so the user has a visual confirmation
 * that the always-on mic is live. Kept intentionally minimal — the rest of
 * the UI is busy enough.
 */

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { loadSettings } from '@/lib/settings';
import { createWakeWord, type WakeWordHandle } from '@/lib/wake-word';
import type { ChittiWakeWordCredentials } from '@/types';

export interface WakeWordListenerProps {
  /** Fires when the wake-word is detected. Parent should kick off ASR. */
  onWake: () => void;
  /** Optional: poll interval (ms) for re-reading settings. Defaults to 2s. */
  settingsPollMs?: number;
  className?: string;
}

/**
 * Returns a stable signature for the credential subset that affects the
 * Porcupine worker's configuration. If this string changes, we must
 * tear down the current handle and create a new one.
 */
function credsSignature(c: ChittiWakeWordCredentials): string {
  return [
    c.enabled ? '1' : '0',
    (c.accessKey ?? '').trim(),
    c.keyword,
    String(c.sensitivity),
  ].join('|');
}

export default function WakeWordListener({
  onWake,
  settingsPollMs = 2000,
  className,
}: WakeWordListenerProps) {
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs so async setup/teardown never closes over stale state.
  const handleRef = useRef<WakeWordHandle | null>(null);
  const sigRef = useRef<string>('');
  const userGestureRef = useRef<boolean>(false);
  const onWakeRef = useRef<() => void>(onWake);

  // Keep onWake fresh without re-arming the worker every render.
  useEffect(() => {
    onWakeRef.current = onWake;
  }, [onWake]);

  // Track the first user interaction so Safari/iOS will let us open the mic.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (userGestureRef.current) return;
    const mark = () => {
      userGestureRef.current = true;
      window.removeEventListener('pointerdown', mark, true);
      window.removeEventListener('keydown', mark, true);
      window.removeEventListener('touchstart', mark, true);
    };
    window.addEventListener('pointerdown', mark, true);
    window.addEventListener('keydown', mark, true);
    window.addEventListener('touchstart', mark, true);
    return () => {
      window.removeEventListener('pointerdown', mark, true);
      window.removeEventListener('keydown', mark, true);
      window.removeEventListener('touchstart', mark, true);
    };
  }, []);

  // Main arming loop. Polls settings — there is no global store for them
  // yet, and we don't want to hard-couple to SettingsModal's local state.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let cancelled = false;

    const teardown = async (): Promise<void> => {
      const h = handleRef.current;
      handleRef.current = null;
      sigRef.current = '';
      if (h) {
        try {
          await h.stop();
        } catch {
          /* ignore */
        }
      }
      if (!cancelled) setActive(false);
    };

    const arm = async (creds: ChittiWakeWordCredentials): Promise<void> => {
      const sig = credsSignature(creds);
      if (sig === sigRef.current && handleRef.current) {
        // Already armed with these creds — make sure it's running.
        if (!handleRef.current.isActive() && userGestureRef.current) {
          try {
            await handleRef.current.start();
            if (!cancelled) setActive(handleRef.current.isActive());
          } catch {
            /* swallow — already surfaced via onError */
          }
        }
        return;
      }

      // Creds changed (or first run) — tear the old handle down.
      await teardown();

      if (!creds.enabled) return;
      if (!creds.accessKey || creds.accessKey.trim().length === 0) {
        setError('wake_word_no_access_key');
        return;
      }

      const handle = await createWakeWord({
        accessKey: creds.accessKey,
        keyword: creds.keyword,
        sensitivity: creds.sensitivity,
        onWake: () => {
          // Fire on the latest onWake, not the one captured at create time.
          try {
            onWakeRef.current?.();
          } catch {
            /* ignore */
          }
        },
        onError: (err) => {
          if (cancelled) return;
          setError(err.message);
        },
      });

      if (cancelled) {
        // Component unmounted while we were importing — clean up.
        if (handle) {
          try {
            await handle.stop();
          } catch {
            /* ignore */
          }
        }
        return;
      }

      if (!handle) return;

      handleRef.current = handle;
      sigRef.current = sig;
      setError(null);

      // Start only after the user has interacted at least once.
      if (userGestureRef.current && !document.hidden) {
        try {
          await handle.start();
          if (!cancelled) setActive(handle.isActive());
        } catch {
          /* onError already fired */
        }
      }
    };

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const { wakeWord } = loadSettings();
        await arm(wakeWord);
      } catch {
        /* defensive — settings load is paranoid already */
      }
    };

    // Initial run.
    void tick();
    const intervalId = window.setInterval(() => void tick(), settingsPollMs);

    // Wait-then-start: if the handle was created before the user clicked,
    // arm it as soon as they do.
    const startOnGesture = async () => {
      // Give the gesture handler above a microtask to flip the flag.
      await Promise.resolve();
      if (handleRef.current && !handleRef.current.isActive() && !document.hidden) {
        try {
          await handleRef.current.start();
          if (!cancelled) setActive(handleRef.current.isActive());
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener('pointerdown', startOnGesture, { once: true, capture: true });
    window.addEventListener('keydown', startOnGesture, { once: true, capture: true });
    window.addEventListener('touchstart', startOnGesture, { once: true, capture: true });

    // Pause when the tab is hidden, resume when it returns.
    const onVisibility = () => {
      const h = handleRef.current;
      if (!h) return;
      if (document.hidden) {
        void h.stop().catch(() => {
          /* ignore */
        });
        if (!cancelled) setActive(false);
      } else if (userGestureRef.current) {
        void h.start().then(() => {
          if (!cancelled) setActive(h.isActive());
        }).catch(() => {
          /* ignore */
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointerdown', startOnGesture, true);
      window.removeEventListener('keydown', startOnGesture, true);
      window.removeEventListener('touchstart', startOnGesture, true);
      void teardown();
    };
  }, [settingsPollMs]);

  // Visual indicator — a tiny dot in the lower-left corner. Green when
  // the wake word is armed; amber on error; hidden when disabled.
  if (!active && !error) return null;

  return (
    <div
      className={cn(
        'fixed bottom-3 left-3 z-50 pointer-events-none flex items-center gap-2 font-mono text-[9px] tracking-[0.3em] uppercase',
        className,
      )}
      aria-live="polite"
      role="status"
    >
      <span
        className={cn(
          'inline-block w-1.5 h-1.5 rounded-full',
          active ? 'bg-signal-green' : 'bg-signal-amber',
        )}
        style={{
          boxShadow: active
            ? '0 0 8px rgba(0, 229, 168, 0.65)'
            : '0 0 8px rgba(255, 176, 32, 0.65)',
        }}
      />
      <span className={active ? 'text-signal-green/70' : 'text-signal-amber/70'}>
        {active ? 'WAKE' : 'WAKE FAULT'}
      </span>
    </div>
  );
}
