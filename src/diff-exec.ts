/**
 * Shared exec profile for the diff-source fetch (GAP-3).
 *
 * Two entry points resolve a `git …` / `gh pr diff …` command into a diff in
 * the extension process: the /code-review slash command
 * (src/builtin-commands.ts) and the `workflow` tool's `name` path
 * (src/builtin-workflows.ts prepareArgs → fetchDiffFromSource). Both must
 * execute the source command with the identical buffer cap, deadline, and kill
 * signal so the two paths stay byte-identical — this module is the single
 * home for those constants (they were previously duplicated under a
 * "mirror exactly" comment).
 */

/**
 * Cap on the diff-source exec's stdout+stderr buffer. Node's default (1 MB)
 * throws on anything but a small diff — `gh pr diff` on a sizeable PR routinely
 * exceeds it. 64 MB comfortably covers any realistic diff while still bounding
 * worst-case memory; the prompt-side cap (code-review.ts's MAX_DIFF_CHARS) is
 * what actually protects the review from a huge diff, not this buffer.
 */
export const DIFF_EXEC_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Hard deadline for the diff-source exec (M12). A hung `gh` (network stall) or
 * a wedged git process must never block the code-review path — and with it the
 * session — indefinitely; the previous exec had no timeout at all.
 */
export const DIFF_EXEC_TIMEOUT_MS = 60_000;

/**
 * SIGKILL is uncatchable by the child: a wedged network call dies for real
 * instead of getting a chance to ignore the signal.
 */
export const DIFF_EXEC_KILL_SIGNAL = "SIGKILL" as const;
