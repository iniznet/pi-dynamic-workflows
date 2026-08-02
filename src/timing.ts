/**
 * Central safe-timer and timeout utilities shared by infra sites.
 *
 * Every infra timer site (poll loops, fetch deadlines, SSE heartbeats) used to
 * hand-roll its own setTimeout bookkeeping, which made leak classes easy to
 * miss: a re-armed poll timer that survives settle, a fetch deadline that never
 * aborts, an interval that pins the process open at shutdown. This module is
 * the single implementation of that bookkeeping:
 *
 *  - `safeSetTimeout`/`safeSetInterval` wrap node's timers in a `SafeTimer`
 *    exposing `unref()` (never hold the process open) and `clear()` (release
 *    the handle exactly once, no double-clear footguns).
 *  - `withTimeout` races a promise against a deadline and fires `onTimeout`
 *    BEFORE the timeout rejection wins the race, so callers can abort the
 *    underlying work (e.g. an in-flight fetch) instead of leaking it.
 */

export interface SafeTimer {
  /** The underlying node timer handle. */
  readonly id: NodeJS.Timeout;
  /** Opt out of keeping the event loop alive (idempotent). */
  unref(): SafeTimer;
  /** Opt back into keeping the event loop alive (idempotent). */
  ref(): SafeTimer;
  /** Release the handle exactly once; subsequent calls are no-ops. */
  clear(): void;
}

function wrapTimer(id: NodeJS.Timeout): SafeTimer {
  let cleared = false;
  return {
    id,
    unref() {
      if (!cleared) id.unref();
      return this;
    },
    ref() {
      if (!cleared) id.ref();
      return this;
    },
    clear() {
      if (cleared) return;
      cleared = true;
      clearTimeout(id);
    },
  };
}

/** Like `setTimeout`, but with explicit `unref()`/`clear()` via {@link SafeTimer}. */
export function safeSetTimeout(callback: () => void, ms: number): SafeTimer {
  return wrapTimer(setTimeout(callback, ms));
}

/** Like `setInterval`, but with explicit `unref()`/`clear()` via {@link SafeTimer}. */
export function safeSetInterval(callback: () => void, ms: number): SafeTimer {
  return wrapTimer(setInterval(callback, ms));
}

/**
 * Run `promise` with a timeout.
 *
 * `onTimeout` fires when the deadline hits, BEFORE the timeout rejection wins
 * the race — the caller uses it to abort the underlying work (e.g. an
 * in-flight fetch) so it releases its resources instead of streaming on in the
 * background. The losing promise still settles later; the caller must swallow
 * its rejection. The deadline timer is unref'd: a pending timeout must never,
 * by itself, hold the process (or a test runner) open.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number | null | undefined,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  if (ms === null || ms === undefined) return promise;

  let deadline: SafeTimer | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    deadline = safeSetTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Best-effort cleanup; never let it mask the timeout error.
      }
      reject(new Error(`Timed out after ${ms}ms: ${label}`));
    }, ms);
    deadline.unref();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    deadline?.clear();
  }
}
