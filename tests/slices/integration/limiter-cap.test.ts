/**
 * Audit L1 regression guard: the internal run limiter must never let more
 * than `concurrency` agents execute at once, even under heavy queue churn.
 *
 * L1 (workflow.ts createLimiter) was a microtask window between a finishing
 * caller's `active--` and the queued waiter's own `active++` — a new caller
 * could observe a free slot that was already spoken for and briefly exceed
 * the cap. The fix hands the slot over (increments before resolving the
 * waiter) so the cap is closed at every suspension point.
 *
 * The window is a single microtask and createLimiter is module-private, so
 * this test cannot deterministically trigger it; it stresses the queue-shift
 * path (many agents, small concurrency, event-loop yields inside each agent)
 * and asserts the runner-visible cap never breaks, pinning the semaphore
 * contract from outside.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../../../src/workflow.js";

/** Minimal deferred — mirrors the inline helper in tests/workflow-runtime.test.ts. */
function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("limiter cap holds under sustained queue churn (L1 semaphore handoff)", async () => {
  const CONCURRENCY = 3;
  const AGENTS = 60;

  let active = 0;
  let maxActive = 0;
  const release = createDeferred<void>();

  const runner = {
    async run(prompt: string) {
      active++;
      maxActive = Math.max(maxActive, active);
      // Yield to the event loop so the queue-shift/waiter-wake microtask
      // interleavings (the L1 window) can actually occur.
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      return `ok:${prompt}`;
    },
  };

  const script = `export const meta = { name: 'limiter_cap', description: 'cap under churn' }
const xs = await parallel(Array.from({ length: ${AGENTS} }, (_, i) => () => agent(String(i), { label: String(i) })))
return xs`;

  const run = runWorkflow(script, { agent: runner, concurrency: CONCURRENCY, persistLogs: false });

  // Open the gate once the first wave is inside; the remaining agents queue
  // behind them and are handed slots as each finishes (the L1 handoff path).
  while (active < CONCURRENCY) await new Promise((resolve) => setTimeout(resolve, 0));
  release.resolve();

  const result = await run;
  assert.equal(result.agentCount, AGENTS);
  assert.equal(maxActive, CONCURRENCY, `runner-visible parallelism must never exceed the cap; saw ${maxActive}`);
});
