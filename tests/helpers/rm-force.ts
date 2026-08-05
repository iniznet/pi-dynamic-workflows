import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Options that make temp-fixture removal resilient on Windows.
 *
 * rmSync({ force: true }) only masks ENOENT — an EBUSY/EPERM from a still-open
 * OS handle (e.g. a fire-and-forget `git -C` child from the manager's
 * opportunistic worktree prune) still throws, failing a test AFTER its body
 * already passed.
 */
const RM_FORCE_OPTS = { recursive: true, force: true, maxRetries: 10, retryDelay: 250 } as const;

/** Outer-loop attempts beyond rmSync's own retries. */
const RM_FORCE_OUTER_ATTEMPTS = 15;

/** Errors rmSync retries are documented to cover; anything else is final. */
const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);

/**
 * Recursively remove one or more temp fixture paths, retrying on Windows
 * EBUSY/EPERM. Safe to call in finally blocks; missing paths are ignored.
 *
 * Two layers: maxRetries/retryDelay are passed to rmSync itself (the remedy
 * F38 prescribes), and a bounded outer loop re-enters rmSync with a linear
 * backoff because node's internal rmSync retry was observed to let EPERM
 * escape immediately on Windows while a manual retry a second later succeeds
 * (the git child exits and releases the directory handle).
 */
export async function rmForce(...paths: string[]): Promise<void> {
  for (const path of paths) {
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(path, RM_FORCE_OPTS);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (!RETRYABLE_CODES.has(code) || attempt >= RM_FORCE_OUTER_ATTEMPTS) throw error;
        await sleep(RM_FORCE_OPTS.retryDelay * (attempt + 1));
      }
    }
  }
}
