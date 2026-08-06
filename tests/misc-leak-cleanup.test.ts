/**
 * Regression tests for the S4-misc-leaks slice (audit findings):
 *
 *  - provider-pool-wake-timers: wake/timeout timers created in acquire/queue
 *    paths are cleared on abort/shutdown (or unref'd) so a dead pool cannot
 *    keep the event loop alive.
 *  - lock-poll-loops: workflow-status lock polling paces itself (bounded wait
 *    with sleep between attempts), never busy-loops.
 *  - onhistory-compaction: compactAgentHistory output is size-capped — a huge
 *    transcript cannot grow per-event output without bound.
 *  - token-samples-map: the task-panel token-rate sample map stays bounded per
 *    run (rolling window + run-end cleanup).
 *  - process-listeners-reload: repeated extension-reload handoff cycles never
 *    stack staged runtimes or dispose fanouts.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { compactAgentHistory } from "../src/agent-history.js";
import {
  discardWorkflowRuntime,
  handoffWorkflowRuntime,
  takeWorkflowRuntime,
  WORKFLOW_EXTENSION_VERSION,
  type WorkflowReloadRuntime,
} from "../src/extension-reload.js";
import { ProviderPool, type ProviderPoolConfig, type ProviderPoolEntry } from "../src/gateway/provider-pool.js";
import { acquireFileLock, releaseFileLock } from "../src/workflow-status.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// ─── Provider-pool helpers (mirror tests/provider-pool.test.ts) ─────────────

type EntrySpec = Omit<ProviderPoolEntry, "provider" | "modelId"> & { provider: string; modelId: string };

function makeConfig(
  specs: EntrySpec[],
  overrides: Partial<Pick<ProviderPoolConfig, "whenSaturated" | "saturationWaitTimeoutMs">> = {},
): ProviderPoolConfig {
  const providers: Record<string, ProviderPoolEntry> = {};
  for (const spec of specs) {
    const { provider, modelId, ...entry } = spec;
    providers[provider] = { provider, modelId, ...entry };
  }
  return {
    enabled: true,
    whenSaturated: overrides.whenSaturated ?? "wait",
    saturationWaitTimeoutMs: overrides.saturationWaitTimeoutMs ?? 0,
    defaultTpmWindowMs: 60_000,
    // Every test in this file acquires the single logical model "m".
    models: { m: providers },
  };
}

function makeRegistry(specs: EntrySpec[]): ModelRegistry {
  const registered = new Set(specs.map((spec) => `${spec.provider}\u0000${spec.modelId}`));
  return {
    find: (provider: string, modelId: string) =>
      registered.has(`${provider}\u0000${modelId}`) ? ({ provider, modelId } as never) : undefined,
    hasConfiguredAuth: () => true,
  } as unknown as ModelRegistry;
}

function makePool(
  specs: EntrySpec[],
  overrides: Parameters<typeof makeConfig>[1] = {},
): { pool: ProviderPool; config: ProviderPoolConfig; registry: ModelRegistry } {
  const config = makeConfig(specs, overrides);
  const registry = makeRegistry(specs);
  return { pool: new ProviderPool(config, registry), config, registry };
}

// ─── Timer tracking ─────────────────────────────────────────────────────────

interface TrackedTimer {
  handle: object;
  cleared: boolean;
  unrefCalled: boolean;
  ms: number;
}

/**
 * Wrap global setTimeout/clearTimeout so tests can assert that pool timers are
 * cleared/unref'd. Real timers still fire (delays are long enough that they
 * never do during the test); t.after sweeps anything left armed.
 */
interface MockableTestContext {
  mock: { method(target: object, name: string, implementation: (...args: any[]) => any): unknown };
  after(fn: () => void): void;
}

function trackTimers(t: MockableTestContext): { created: TrackedTimer[]; wakeTimers: () => TrackedTimer[] } {
  const created: TrackedTimer[] = [];
  const handleToReal = new Map<object, NodeJS.Timeout>();
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  const realClearTimeout = globalThis.clearTimeout.bind(globalThis);

  t.mock.method(globalThis, "setTimeout", (fn: () => void, ms?: number): NodeJS.Timeout => {
    const real = realSetTimeout(fn, ms);
    const rec: TrackedTimer = { handle: {}, cleared: false, unrefCalled: false, ms: ms ?? 0 };
    const wrapper = {
      unref() {
        rec.unrefCalled = true;
        real.unref();
        return wrapper;
      },
      ref() {
        real.ref();
        return wrapper;
      },
    };
    rec.handle = wrapper;
    created.push(rec);
    handleToReal.set(wrapper, real);
    return wrapper as unknown as NodeJS.Timeout;
  });
  t.mock.method(globalThis, "clearTimeout", (handle: unknown) => {
    const rec = created.find((entry) => entry.handle === handle);
    if (rec) rec.cleared = true;
    const real = handleToReal.get(handle as object);
    if (real) realClearTimeout(real);
    else realClearTimeout(handle as NodeJS.Timeout);
  });

  t.after(() => {
    for (const rec of created) {
      const real = handleToReal.get(rec.handle);
      if (real) realClearTimeout(real);
    }
  });

  return { created, wakeTimers: () => created.filter((entry) => entry.ms > 0) };
}

// ─── provider-pool-wake-timers ──────────────────────────────────────────────

test("provider pool: aborting the last queued waiter clears the model's wake timer", async (t) => {
  const timers = trackTimers(t);
  const { pool } = makePool([{ provider: "a", modelId: "a", concurrency: 1, weight: 1, cooldownMs: 60_000 }], {
    whenSaturated: "wait",
  });

  const first = await pool.acquire("m");
  assert.equal(first?.provider, "a");

  // Cooldown blocks fresh acquires → the queued acquire arms a wake timer at
  // the cooldown's expiry (the only setTimeout a wait-mode pool should hold).
  pool.recordLimitEvent("a");
  const controller = new AbortController();
  const pending = pool.acquire("m", { signal: controller.signal });
  const wake = timers.wakeTimers();
  assert.equal(wake.length, 1, "queuing behind a cooldown arms exactly one wake timer");

  controller.abort();
  await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");

  assert.equal(pool.snapshot().waiting, 0, "aborted waiter leaves the FIFO queue");
  assert.equal(
    wake[0]?.cleared,
    true,
    "wake timer must be cleared when the queue empties (a dead pool keeps no timers)",
  );
  pool.release(first as NonNullable<typeof first>);
});

test("provider pool: aborting one waiter keeps the wake timer while others remain queued", async (t) => {
  const timers = trackTimers(t);
  const { pool } = makePool([{ provider: "a", modelId: "a", concurrency: 1, weight: 1, cooldownMs: 60_000 }], {
    whenSaturated: "wait",
  });

  const first = await pool.acquire("m");
  pool.recordLimitEvent("a");
  const c1 = new AbortController();
  const c2 = new AbortController();
  const pending1 = pool.acquire("m", { signal: c1.signal });
  const pending2 = pool.acquire("m", { signal: c2.signal });
  const wake = timers.wakeTimers();
  assert.equal(wake.length, 1, "one wake timer covers the whole model queue");

  c1.abort();
  await assert.rejects(pending1, (error: unknown) => (error as Error).name === "AbortError");
  assert.equal(wake[0]?.cleared, false, "the wake timer must survive while a waiter is still queued");

  c2.abort();
  await assert.rejects(pending2, (error: unknown) => (error as Error).name === "AbortError");
  assert.equal(wake[0]?.cleared, true, "the wake timer clears only once the queue fully empties");
  pool.release(first as NonNullable<typeof first>);
});

test("provider pool: shutdown settles every queued waiter, clears wake timers, and refuses new acquires", async (t) => {
  const timers = trackTimers(t);
  const { pool } = makePool([{ provider: "a", modelId: "a", concurrency: 1, weight: 1, cooldownMs: 60_000 }], {
    whenSaturated: "wait",
  });

  const first = await pool.acquire("m");
  pool.recordLimitEvent("a");
  const pending1 = pool.acquire("m");
  const pending2 = pool.acquire("m");
  const wake = timers.wakeTimers();
  assert.equal(wake.length, 1);

  pool.shutdown();

  await assert.rejects(pending1, (error: unknown) => (error as Error).name === "AbortError");
  await assert.rejects(pending2, (error: unknown) => (error as Error).name === "AbortError");
  assert.equal(wake[0]?.cleared, true, "shutdown clears every armed wake timer");
  assert.equal(pool.snapshot().waiting, 0, "shutdown empties the FIFO queues");

  await assert.rejects(pool.acquire("m"), (error: unknown) => (error as Error).name === "AbortError");
  pool.release(first as NonNullable<typeof first>); // still a safe no-op-or-release after shutdown
});

test("provider pool: wake timers are unref'd so an abandoned pool cannot pin the event loop", async (t) => {
  const timers = trackTimers(t);
  const { pool } = makePool([{ provider: "a", modelId: "a", concurrency: 1, weight: 1, cooldownMs: 60_000 }], {
    whenSaturated: "wait",
  });

  const first = await pool.acquire("m");
  pool.recordLimitEvent("a");
  const pending = pool.acquire("m");
  const wake = timers.wakeTimers();
  assert.equal(wake.length, 1);
  assert.equal(wake[0]?.unrefCalled, true, "wake timers are advisory and must never hold the loop open");

  pool.shutdown(); // settle the waiter so no 60s timer stays armed
  await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
  pool.release(first as NonNullable<typeof first>);
});

test("provider pool: a waiter's saturation timeout timer is cleared when the waiter settles", async (t) => {
  const timers = trackTimers(t);
  const { pool } = makePool([{ provider: "a", modelId: "a", concurrency: 1, weight: 1, cooldownMs: 60_000 }], {
    whenSaturated: "wait",
    saturationWaitTimeoutMs: 30_000,
  });

  const first = await pool.acquire("m");
  pool.recordLimitEvent("a");
  const controller = new AbortController();
  const pending = pool.acquire("m", { signal: controller.signal });

  // Two timers now: the wake timer (cooldown 60s) and the waiter's own
  // saturation budget (30s) — the budget handle must be distinguishable. The
  // wake timer's delay is 60s MINUS the sub-ms elapsed between the cooldown
  // stamp and the timer arm, so match it as any delay beyond the 30s budget.
  const timeoutTimer = timers.created.find((entry) => entry.ms === 30_000);
  const wakeTimer = timers.created.find((entry) => entry.ms > 30_000);
  assert.ok(timeoutTimer, "saturation budget timer armed");
  assert.ok(wakeTimer, "wake timer armed");

  controller.abort();
  await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
  assert.equal(timeoutTimer.cleared, true, "settling a waiter clears its saturation budget timer");
  assert.equal(wakeTimer.cleared, true, "and the queue-emptied wake timer goes with it");
  pool.release(first as NonNullable<typeof first>);
});

test("provider pool: a pool-level abort signal tears the pool down deterministically", async (t) => {
  const timers = trackTimers(t);
  const { config, registry } = makePool(
    [{ provider: "a", modelId: "a", concurrency: 1, weight: 1, cooldownMs: 60_000 }],
    { whenSaturated: "wait" },
  );
  const poolSignal = new AbortController();
  const pool = new ProviderPool(config, registry, { signal: poolSignal.signal });

  const first = await pool.acquire("m");
  pool.recordLimitEvent("a");
  const pending = pool.acquire("m");
  const wake = timers.wakeTimers();
  assert.equal(wake.length, 1);

  poolSignal.abort();
  await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
  assert.equal(wake[0]?.cleared, true, "pool-level abort clears the wake timer");
  assert.equal(pool.snapshot().waiting, 0);
  pool.release(first as NonNullable<typeof first>);
});

// ─── lock-poll-loops ────────────────────────────────────────────────────────

/** Run `fn` inside a temp cwd with a temp fake home (mirror workflow-status.test.ts). */
function withStatusEnv(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), "misc-leak-lock-"));
    const home = await mkdtemp(join(tmpdir(), "misc-leak-lock-home-"));
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await withFakeHomeAsync(home, () => fn(dir));
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  };
}

test(
  "lock polling sleeps between attempts instead of busy-looping",
  withStatusEnv(async () => {
    // A live holder that never releases: the polling waiter must pace itself
    // at pollIntervalMs, and the waitMs budget must bound the total time.
    assert.equal(await acquireFileLock("src/a.ts", "run-1", "task-1", 5000), true);
    const start = Date.now();
    const acquired = await acquireFileLock("src/a.ts", "run-2", "task-2", 5000, {
      waitMs: 300,
      pollIntervalMs: 50,
    });
    assert.equal(acquired, false, "bounded wait fails once the budget is exhausted");
    const elapsed = Date.now() - start;
    // ~6 polls × 50ms ≈ 300ms; a busy-wait would return in ~0ms.
    assert.ok(elapsed >= 240, `poll loop must actually sleep between attempts (elapsed ${elapsed}ms)`);
    assert.ok(elapsed < 3000, `wait budget must bound the total poll time (elapsed ${elapsed}ms)`);
    assert.equal(await releaseFileLock("src/a.ts", "run-1"), true);
  }),
);

// ─── onhistory-compaction ───────────────────────────────────────────────────

test("history compaction caps a huge transcript instead of growing output with input", () => {
  const messages: unknown[] = [];
  for (let i = 0; i < 5_000; i++) {
    messages.push({ role: "user", content: `prompt ${i} ${"x".repeat(500)}` });
    messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${i} ${"y".repeat(500)}` }] });
  }
  const history = compactAgentHistory(messages, { maxEntries: 40, maxTextChars: 2000, maxTotalChars: 20_000 });
  assert.ok(history.length <= 40, `entries must be capped, got ${history.length}`);
  const total = history.reduce((sum, entry) => sum + entry.text.length + (entry.diff?.length ?? 0), 0);
  assert.ok(total <= 20_000, `total chars must be capped, got ${total}`);
  assert.equal(history[0]?.role, "user", "the newest 40 entries are kept, oldest first");
  const last = history[history.length - 1];
  assert.ok(last?.text.includes("answer 4999"), "the very last transcript message survives the fit");
});

// ─── token-samples-map ──────────────────────────────────────────────────────

test("tokenSamples stays bounded to the rolling window and clears on run end", async () => {
  const { sampleTokens, tokensPerSecond, clearTokenSamples } = await import("../src/task-panel.js");
  const runId = "misc-leak-run";
  clearTokenSamples(runId);

  // Five samples inside the window, then a gap, then two fresh samples.
  for (let i = 0; i < 5; i++) sampleTokens(runId, 100 + i * 100, 1_000 + i * 1_000);
  sampleTokens(runId, 900, 20_000);
  sampleTokens(runId, 1_000, 25_000);

  // The 10s window keeps only the two recent samples: 100 tokens over 5s.
  assert.equal(tokensPerSecond(runId), 20, "old samples must age out of the window");
  clearTokenSamples(runId);
  assert.equal(tokensPerSecond(runId), 0, "run-end cleanup forgets the samples");
});

// ─── process-listeners-reload (extension-reload layer) ─────────────────────

test("repeated reload handoff cycles never stack staged runtimes or dispose fanouts", () => {
  const cwd = `/tmp/misc-reload-${process.pid}`;
  const disposes: string[] = [];
  const makeRuntime = (cycle: number): WorkflowReloadRuntime => ({
    cwd,
    extensionVersion: WORKFLOW_EXTENSION_VERSION,
    manager: { listRuns: () => [], pause: () => false } as unknown as WorkflowReloadRuntime["manager"],
    effort: { level: "high" },
    dispose: () => {
      disposes.push(`cycle-${cycle}`);
    },
  });

  discardWorkflowRuntime(cwd); // clean slate
  for (let cycle = 1; cycle <= 5; cycle++) {
    handoffWorkflowRuntime(makeRuntime(cycle), 10);
    assert.equal(takeWorkflowRuntime(cwd)?.cwd, cwd, `cycle ${cycle} claims its own staged runtime`);
    assert.equal(takeWorkflowRuntime(cwd), undefined, `cycle ${cycle} leaves nothing staged behind`);
  }
  assert.equal(disposes.length, 5, "exactly one dispose fanout per generation — none stacked");
});
