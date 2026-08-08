/**
 * SLICE A — manager-plumbing per-agent live stats.
 *
 * Verifies the manager/data side of the per-agent live-stats feature:
 *  1. a settled sibling's tokenUsage lands on the snapshot while another agent
 *     still runs, and the run-wide aggregate is never double-counted (A2 — the
 *     journal path never accumulates);
 *  2. retry spend folds exactly once into the run aggregate (M26) while the
 *     per-agent figure stays final-attempt only;
 *  3. lastActiveAtMs moves on journal/history events but NOT on run-wide events
 *     (onTokenUsage), and sibling events never stamp each other;
 *  4. the idle threshold constant + pure helpers behave at boundary values;
 *  5. resume: replayed (cache-hit) agents restore their ORIGINAL figures and
 *     timestamps (never 0 / never resume-time "now" — L4), and lastActiveAtMs
 *     is never persisted yet recomputes from events;
 *  6. persistRun strips the ephemeral ms fields from the primary while the ISO
 *     startedAt/endedAt strings remain;
 *  7. journal compaction interning keeps usage-bearing journals lossless
 *     (verifyJournalCompaction byte-identity with the new tokens/tokenUsage
 *     fields — the lockstep requirement).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage, WorkflowAgent } from "../../../src/agent.js";
import { agentElapsedMs, agentIdleMs, DEFAULT_IDLE_AGENT_MS } from "../../../src/display.js";
import { compactJournal, reconstructJournal, verifyJournalCompaction } from "../../../src/journal-compaction.js";
import type { JournalEntry } from "../../../src/workflow.js";
import { WorkflowManager } from "../../../src/workflow-manager.js";
import { withFakeHomeAsync } from "../../helpers/fake-home.js";
import { rmForce } from "../../helpers/rm-force.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Unref'd sleep — racing a settle against it never blocks process exit. */
const sleepUnref = (ms: number) =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

/** Run each test with isolated cwd + HOME so workflow state is isolated. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-livestats-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-livestats-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      await rmForce(cwd, fakeHome);
    }
  };
}

/**
 * Agent runner with PER-CALL deferred promises (each run() hangs until its own
 * resolve). `usageFor(idx)` fires the runner's onUsage (the mock analog of
 * agent.ts's once-per-call onUsage) right before resolving, so the settled
 * call's usage is in scope at the journal/onAgentEnd emit.
 */
function perCallDeferredAgent(usageFor?: (idx: number) => AgentUsage | undefined) {
  const resolves: Array<(value: unknown) => void> = [];
  let callIdx = 0;
  return {
    resolve: (idx: number, value: unknown = "done") => resolves[idx]?.(value),
    resolveAll: (value: unknown = "done") => {
      for (let i = 0; i < resolves.length; i++) resolves[i]?.(value);
    },
    runner: {
      async run(_prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
        const idx = callIdx++;
        const onUsage = options?.onUsage;
        return new Promise((resolve) => {
          resolves[idx] = (value: unknown) => {
            const usage = usageFor?.(idx);
            if (usage && onUsage) onUsage(usage);
            resolve(value);
          };
        });
      },
    } as unknown as Pick<WorkflowAgent, "run">,
  };
}

const twoParallel = `export const meta = { name: 'live_stats', description: 'parallel live stats' }
const [a, b] = await parallel([() => agent('a', { label: 'a' }), () => agent('b', { label: 'b' })])
return { a, b }`;

// ═══════════════════════════════════════════════════════════════════════════
// 1 — settled sibling's figure lands on the snapshot while another runs
// ═══════════════════════════════════════════════════════════════════════════

test(
  "a settled sibling's tokenUsage lands on the snapshot while another agent still runs (run aggregate never double-counted)",
  withTempCwd(async (cwd) => {
    const usageA: AgentUsage = { input: 300, output: 200, cacheRead: 100, cacheWrite: 50, total: 650, cost: 0.01 };
    const da = perCallDeferredAgent((idx) => (idx === 0 ? usageA : undefined));
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(twoParallel);
    try {
      const deadline = Date.now() + 5000;
      while ((manager.getRun(runId)?.snapshot.agents.length ?? 0) < 2) {
        if (Date.now() > deadline) assert.fail("the run never reached both agents");
        await sleep(10);
      }
      const snap = () => manager.getRun(runId)?.snapshot;
      assert.equal(typeof snap()?.agents[0]?.startedAtMs, "number", "onAgentStart stamps startedAtMs");
      assert.equal(typeof snap()?.agents[0]?.lastActiveAtMs, "number", "onAgentStart stamps lastActiveAtMs");

      da.resolve(0, "a-done");
      const endDeadline = Date.now() + 5000;
      while (snap()?.agents[0]?.status !== "done") {
        if (Date.now() > endDeadline) assert.fail("agent 0 never settled");
        await sleep(10);
      }
      const agents = snap()?.agents ?? [];
      assert.equal(agents[0]?.status, "done");
      assert.equal(agents[1]?.status, "running", "sibling still runs");
      assert.deepEqual(agents[0]?.tokenUsage, usageA, "settled sibling's breakdown is live on the snapshot");
      assert.equal(agents[0]?.tokens, 650, "canonical scalar (component sum) also lands");
      assert.equal(agents[1]?.tokens, undefined, "running agent has no fabricated figure");
      assert.equal(typeof agents[0]?.endedAtMs, "number", "terminal agent gets endedAtMs");
      assert.equal(agents[1]?.endedAtMs, undefined, "running agent has no endedAtMs");

      // Run-wide aggregate: settled exactly once via onAgentEnd's accumulate
      // (the journal path never accumulates — A2), so no double-count.
      const usage = snap()?.tokenUsage;
      assert.ok(usage, "run aggregate seeded");
      assert.equal(usage?.input, 300);
      assert.equal(usage?.output, 200);
      assert.equal(usage?.cacheRead, 100);
      assert.equal(usage?.cacheWrite, 50);
      assert.equal(usage?.total, 650, "M26: total === components; never double-counted");
    } finally {
      da.resolveAll();
      await promise.catch(() => {});
    }
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 2 — retry spend folds once into the aggregate; per-agent stays final-attempt
// ═══════════════════════════════════════════════════════════════════════════

test(
  "retry spend folds exactly once into the run aggregate; the per-agent figure stays final-attempt",
  withTempCwd(async (cwd) => {
    let aAttempts = 0;
    let resolveA2: ((v: unknown) => void) | undefined;
    let resolveB: ((v: unknown) => void) | undefined;
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }): Promise<any> {
        if (prompt === "a") {
          aAttempts++;
          if (aAttempts === 1) {
            options?.onUsage?.({ input: 40, output: 0, cacheRead: 0, cacheWrite: 0, total: 40, cost: 0 });
            return ""; // empty output -> recoverable -> retried
          }
          options?.onUsage?.({ input: 10, output: 5, cacheRead: 5, cacheWrite: 0, total: 20, cost: 0.05 });
          return new Promise((resolve) => {
            resolveA2 = resolve;
          });
        }
        options?.onUsage?.({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: 0 });
        return new Promise((resolve) => {
          resolveB = resolve;
        });
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});
    const script = `export const meta = { name: 'retry_stats', description: 'retry live stats' }
const a = await agent('a', { label: 'a' })
const b = await agent('b', { label: 'b' })
return { a, b }`;
    const { runId, promise } = manager.startInBackground(script, undefined, { agentRetries: 1, retryBackoffMs: 0 });
    try {
      const deadline = Date.now() + 5000;
      while (aAttempts < 2) {
        if (Date.now() > deadline) assert.fail("the retry never happened");
        await sleep(10);
      }
      // Mid-retry: the failed attempt's spend is in the run aggregate, NOT on
      // the per-agent row (final attempt only), and the heartbeat was stamped.
      let snap = manager.getRun(runId)?.snapshot;
      assert.equal(snap?.agents[0]?.status, "running");
      assert.equal(snap?.agents[0]?.tokens, undefined, "per-agent figure stays final-attempt (retry excluded)");
      assert.equal(snap?.agents[0]?.tokenUsage, undefined, "per-agent breakdown untouched by retry spend");
      assert.equal(typeof snap?.agents[0]?.lastActiveAtMs, "number", "onRetrySpend stamps the heartbeat");
      assert.equal(snap?.tokenUsage?.total, 40, "retried attempt folds into the run aggregate exactly once");

      resolveA2?.("a-result");
      const doneDeadline = Date.now() + 5000;
      while (manager.getRun(runId)?.snapshot.agents[0]?.status !== "done") {
        if (Date.now() > doneDeadline) assert.fail("the final attempt never settled");
        await sleep(10);
      }
      snap = manager.getRun(runId)?.snapshot;
      assert.deepEqual(
        snap?.agents[0]?.tokenUsage,
        { input: 10, output: 5, cacheRead: 5, cacheWrite: 0, total: 20, cost: 0.05 },
        "per-agent figure is the FINAL attempt only",
      );
      // 'b' hasn't settled yet: aggregate is a's retry + final (b's fold is
      // still pending in the hanging run()).
      assert.equal(snap?.tokenUsage?.input, 50, "40 (retried) + 10 (final)");
      assert.equal(snap?.tokenUsage?.output, 5);
      assert.equal(snap?.tokenUsage?.cacheRead, 5);
      assert.equal(snap?.tokenUsage?.cacheWrite, 0);
      assert.equal(snap?.tokenUsage?.total, 60, "M26 holds mid-run");
    } finally {
      resolveB?.("b-done");
      resolveA2?.("a-done");
      // Race-bound the settle: a failing assertion before both deferreds exist
      // must never hang the parallel suite (the run settles on its own in the
      // success path well inside this window). Unref'd so the guard timer never
      // blocks process exit on the (normal) early-settle path.
      await Promise.race([promise.catch(() => {}), sleepUnref(10_000)]);
    }
    // Post-completion persisted aggregate (mirrors token-invariant.test.ts):
    // retry + final + b, total === components.
    const persisted = manager.getPersistence().load(runId);
    const usage = persisted?.tokenUsage;
    assert.ok(usage, "token breakdown is persisted");
    assert.equal(usage?.input, 51, "40 (retried) + 10 (final) + 1 (b)");
    assert.equal(usage?.output, 5);
    assert.equal(usage?.cacheRead, 5);
    assert.equal(usage?.cacheWrite, 0);
    assert.equal(usage?.total, 61, "M26: total === components after the run");
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 3 — lastActiveAtMs: journal/history stamp; run-wide events never do
// ═══════════════════════════════════════════════════════════════════════════

test(
  "lastActiveAtMs moves on journal/history but not on run-wide events; sibling events never stamp each other",
  withTempCwd(async (cwd) => {
    let historyFired = 0;
    let resolveA: ((v: unknown) => void) | undefined;
    let resolveB: ((v: unknown) => void) | undefined;
    const usageA: AgentUsage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20, cost: 0 };
    const agent = {
      async run(
        prompt: string,
        options?: { onUsage?: (u: AgentUsage) => void; onHistory?: (history: unknown[]) => void },
      ): Promise<any> {
        if (prompt === "b") {
          // A live-history event ~50ms after the call starts (the F21 cadence
          // analog in agent.ts) — the test polls for the observable stamp.
          setTimeout(() => {
            historyFired++;
            options?.onHistory?.([{ role: "user", content: "step" }]);
          }, 50);
          return new Promise((resolve) => {
            resolveB = resolve;
          });
        }
        options?.onUsage?.(usageA);
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(twoParallel);
    try {
      const deadline = Date.now() + 5000;
      while ((manager.getRun(runId)?.snapshot.agents.length ?? 0) < 2) {
        if (Date.now() > deadline) assert.fail("the run never reached both agents");
        await sleep(10);
      }
      const agents = () => manager.getRun(runId)?.snapshot.agents ?? [];
      const t0a = agents()[0]?.lastActiveAtMs;
      const t0b = agents()[1]?.lastActiveAtMs;
      assert.equal(typeof t0a, "number", "agent 0 start-stamped");
      assert.equal(typeof t0b, "number", "agent 1 start-stamped");

      // onHistory re-stamps the owning agent with a LATER time.
      const histDeadline = Date.now() + 5000;
      while (historyFired === 0 || (agents()[1]?.lastActiveAtMs ?? 0) <= (t0b ?? 0)) {
        if (Date.now() > histDeadline) assert.fail("the history event never moved agent 1's heartbeat");
        await sleep(10);
      }
      const L_b = agents()[1]?.lastActiveAtMs;

      // Settling agent 0 stamps IT via the journal/onAgentEnd burst…
      resolveA?.("a-done");
      const doneDeadline = Date.now() + 5000;
      while (agents()[0]?.status !== "done") {
        if (Date.now() > doneDeadline) assert.fail("agent 0 never settled");
        await sleep(10);
      }
      assert.ok((agents()[0]?.lastActiveAtMs ?? 0) > (t0a ?? 0), "journal/end events re-stamp the settled agent");
      // …but NEVER its still-running sibling (agent 0's events are isolated).
      assert.equal(agents()[1]?.lastActiveAtMs, L_b, "sibling events never stamp each other");

      // Completing the script fires onTokenUsage (run-wide, once at script
      // end) — it must NOT re-stamp any agent's heartbeat.
      resolveB?.("b-done");
      const bDeadline = Date.now() + 5000;
      while (agents()[1]?.status !== "done") {
        if (Date.now() > bDeadline) assert.fail("agent 1 never settled");
        await sleep(10);
      }
      const L_b_done = agents()[1]?.lastActiveAtMs;
      await promise;
      assert.equal(agents()[1]?.lastActiveAtMs, L_b_done, "onTokenUsage never stamps a per-agent heartbeat");
    } finally {
      resolveA?.("a-done");
      resolveB?.("b-done");
      await promise.catch(() => {});
    }
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 4 — idle threshold constant + pure helpers
// ═══════════════════════════════════════════════════════════════════════════

test("DEFAULT_IDLE_AGENT_MS threshold + agentIdleMs boundary semantics", () => {
  const NOW = 1_000_000;
  assert.equal(DEFAULT_IDLE_AGENT_MS, 30_000);
  // Exactly at the threshold: the idle segment SHOWS (>= threshold predicate).
  assert.equal(agentIdleMs({ lastActiveAtMs: NOW - 30_000 }, NOW), 30_000);
  assert.ok((agentIdleMs({ lastActiveAtMs: NOW - 30_000 }, NOW) ?? 0) >= DEFAULT_IDLE_AGENT_MS);
  // Just under the threshold: hidden.
  assert.equal(agentIdleMs({ lastActiveAtMs: NOW - 29_999 }, NOW), 29_999);
  assert.ok((agentIdleMs({ lastActiveAtMs: NOW - 29_999 }, NOW) ?? 0) < DEFAULT_IDLE_AGENT_MS);
  // Clock skew clamps to zero; absent field degrades to undefined.
  assert.equal(agentIdleMs({ lastActiveAtMs: NOW + 5_000 }, NOW), 0);
  assert.equal(agentIdleMs({}, NOW), undefined);
  assert.equal(agentIdleMs({ lastActiveAtMs: NaN }, NOW), undefined);
});

test("agentElapsedMs derives per-agent elapsed from startedAtMs", () => {
  const NOW = 1_000_000;
  assert.equal(agentElapsedMs({ startedAtMs: NOW - 192_000 }, NOW), 192_000);
  assert.equal(agentElapsedMs({ startedAtMs: NOW - 30_000 }, NOW), 30_000);
  assert.equal(agentElapsedMs({ startedAtMs: NOW + 100 }, NOW), 0, "clock skew clamps to zero");
  assert.equal(agentElapsedMs({}, NOW), undefined, "absent startedAtMs renders no elapsed");
  assert.equal(agentElapsedMs({ startedAtMs: NaN }, NOW), undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — resume: seeded restore (L4) + recomputed heartbeats, nothing persisted
// ═══════════════════════════════════════════════════════════════════════════

test(
  "resume: replayed agents restore ORIGINAL figures + timestamps (never 0 / never now); lastActiveAtMs never persisted",
  withTempCwd(async (cwd) => {
    const usageA: AgentUsage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, total: 30, cost: 0.001 };
    let bCalls = 0;
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }): Promise<any> {
        options?.onUsage?.({ ...usageA });
        if (prompt === "b") {
          bCalls++;
          if (bCalls === 1) return new Promise(() => {}); // first 'b' hangs until paused
          return "b-result"; // post-resume 'b' completes
        }
        return `${prompt}-result`;
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});
    const script = `export const meta = { name: 'resume_stats', description: 'resume live stats' }
const a = await agent('a', { label: 'a' })
const b = await agent('b', { label: 'b' })
return { a, b }`;
    const { runId, promise } = manager.startInBackground(script);
    promise.catch(() => {});
    try {
      for (let i = 0; i < 200 && bCalls === 0; i++) await sleep(10);
      assert.equal(bCalls, 1, "first 'b' is in flight before pausing");
      for (let i = 0; i < 200 && !(manager.getRun(runId)?.journal.length ?? 0); i++) await sleep(10);
      assert.ok((manager.getRun(runId)?.journal.length ?? 0) > 0, "'a' completed in memory before pausing");
      const liveA = manager.getRun(runId)?.snapshot.agents.find((ag) => ag.label === "a");
      assert.ok(liveA?.startedAtMs, "live 'a' carries startedAtMs");
      assert.ok(liveA?.endedAtMs, "live 'a' carries endedAtMs");
      assert.equal(typeof liveA?.lastActiveAtMs, "number");
      assert.deepEqual(liveA?.tokenUsage, usageA);

      assert.equal(manager.pause(runId), true);
      await sleep(30);
      const before = manager.getPersistence().load(runId);
      const beforeA = before?.agents.find((ag) => ag.label === "a");
      assert.ok(beforeA, "'a' persisted at the pause boundary");
      const originalStartedAt = beforeA?.startedAt;
      const originalEndedAt = beforeA?.endedAt;
      assert.ok(originalStartedAt, "'a' has a real persisted startedAt");
      assert.ok(originalEndedAt, "'a' has a real persisted endedAt");
      // EPHEMERAL live fields never reach disk (persistRun strips them); the
      // ISO timestamps and the token figures persist exactly as before.
      assert.equal("lastActiveAtMs" in beforeA, false, "lastActiveAtMs never persisted");
      assert.equal("startedAtMs" in beforeA, false, "startedAtMs never persisted");
      assert.equal("endedAtMs" in beforeA, false, "endedAtMs never persisted");
      assert.deepEqual(beforeA?.tokenUsage, usageA, "tokens/tokenUsage persist as before");

      // Resume: 'a' replays from the journal (cache hit), 'b' runs live.
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true);
      for (let i = 0; i < 300 && manager.getRun(runId)?.status === "running"; i++) await sleep(10);
      assert.equal(manager.getRun(runId)?.status, "completed");

      const snapA = manager.getRun(runId)?.snapshot.agents.find((ag) => ag.label === "a");
      assert.equal(snapA?.status, "done");
      assert.deepEqual(
        snapA?.tokenUsage,
        usageA,
        "seeded restore: ORIGINAL usage, never zeroed by the tokens:0 replay",
      );
      assert.equal(snapA?.tokens, 30, "seeded restore: ORIGINAL scalar");
      assert.equal(snapA?.startedAtMs, Date.parse(originalStartedAt as string), "seeded startedAtMs (L4)");
      assert.equal(snapA?.endedAtMs, Date.parse(originalEndedAt as string), "seeded endedAtMs (L4)");
      assert.equal(
        snapA?.lastActiveAtMs,
        Date.parse(originalEndedAt as string),
        "seeded last-active = completion moment — never a resume-time 'now'",
      );

      // The live re-run 'b' re-stamps its heartbeat from real events.
      const liveB = manager.getRun(runId)?.snapshot.agents.find((ag) => ag.label === "b");
      assert.equal(liveB?.status, "done");
      assert.equal(typeof liveB?.lastActiveAtMs, "number", "live agent's heartbeat recomputes from events");

      const after = manager.getPersistence().load(runId);
      const replayedA = after?.agents.find((ag) => ag.label === "a");
      assert.ok(replayedA, "replayed 'a' is persisted again");
      assert.equal(replayedA?.startedAt, originalStartedAt, "L4: replayed agent keeps ORIGINAL startedAt");
      assert.equal(replayedA?.endedAt, originalEndedAt, "L4: replayed agent keeps ORIGINAL endedAt");
      assert.equal("lastActiveAtMs" in replayedA, false, "still never persisted after resume");
    } finally {
      // The first execution's 'b' mock promise is intentionally unresolvable
      // (seeded-timestamps pattern) — its executeRun promise never settles, so
      // never await it here (the run itself is asserted "completed" above).
      promise.catch(() => {});
    }
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 6 — persistRun strips the ephemeral ms fields from the primary
// ═══════════════════════════════════════════════════════════════════════════

test(
  "persistRun strips the ephemeral ms fields from the primary; ISO startedAt/endedAt remain",
  withTempCwd(async (cwd) => {
    const da = perCallDeferredAgent((idx) =>
      idx === 0 ? { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0 } : undefined,
    );
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const script = `export const meta = { name: 'strip_stats', description: 'ephemeral strip' }
const a = await agent('a', { label: 'a' })
const b = await agent('b', { label: 'b' })
return { a, b }`;
    const { runId, promise } = manager.startInBackground(script);
    try {
      const deadline = Date.now() + 5000;
      while ((manager.getRun(runId)?.snapshot.agents.length ?? 0) < 1) {
        if (Date.now() > deadline) assert.fail("the run never reached the first agent");
        await sleep(10);
      }
      da.resolve(0, "a-done");
      const doneDeadline = Date.now() + 5000;
      while (manager.getRun(runId)?.snapshot.agents[0]?.status !== "done") {
        if (Date.now() > doneDeadline) assert.fail("'a' never settled");
        await sleep(10);
      }
      assert.equal(manager.pause(runId), true);
      const loaded = manager.getPersistence().load(runId);
      const persistedA = loaded?.agents.find((ag) => ag.label === "a");
      assert.ok(persistedA, "'a' persisted at the pause boundary");
      assert.ok(persistedA.startedAt, "ISO startedAt remains");
      assert.ok(persistedA.endedAt, "ISO endedAt remains");
      assert.equal("lastActiveAtMs" in persistedA, false, "lastActiveAtMs stripped");
      assert.equal("startedAtMs" in persistedA, false, "startedAtMs stripped");
      assert.equal("endedAtMs" in persistedA, false, "endedAtMs stripped");
      assert.equal(persistedA.tokens, 15, "tokens persist as before");
    } finally {
      da.resolveAll();
      await promise.catch(() => {});
    }
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 7 — compaction interning keeps usage-bearing journals lossless
// ═══════════════════════════════════════════════════════════════════════════

test("journal compaction interning: usage-bearing entries round-trip byte-identically (verifyJournalCompaction)", () => {
  const sharedUsage: AgentUsage = { input: 300, output: 200, cacheRead: 100, cacheWrite: 50, total: 650, cost: 0.01 };
  const journal: JournalEntry[] = [
    {
      index: 0,
      runId: "r",
      hash: "h0",
      result: "x",
      tokens: 650,
      tokenUsage: sharedUsage,
      model: "m",
      storeDelta: { k: 1 },
      storeCommitSeq: 1,
      operations: [{ line: 1, op: "read", outcome: "ok" }],
    },
    { index: 1, runId: "r", hash: "h1", result: "y", tokens: 650, tokenUsage: sharedUsage },
    // Estimate-only entry (no usage reported): no tokens/tokenUsage keys.
    { index: 2, runId: "r", hash: "h2", result: "z" },
  ];
  const summary = compactJournal(journal);
  assert.deepEqual(verifyJournalCompaction(summary, journal), { ok: true }, "the QA gate accepts the summary");
  const reconstructed = reconstructJournal(summary);
  assert.equal(JSON.stringify(reconstructed), JSON.stringify(journal), "byte-identical round-trip");
  assert.equal(reconstructed[0]?.tokens, 650);
  assert.deepEqual(reconstructed[0]?.tokenUsage, sharedUsage);
  assert.deepEqual(reconstructed[1]?.tokenUsage, sharedUsage, "twins share the interned usage slot");
  assert.equal(reconstructed[2]?.tokens, undefined, "estimate-only entry keeps no tokens key");
  // Canonical emit order (workflow.ts success path) is preserved so the
  // persisted bytes match the in-memory journal exactly.
  assert.deepEqual(Object.keys(reconstructed[0]), [
    "index",
    "runId",
    "hash",
    "result",
    "tokens",
    "tokenUsage",
    "model",
    "storeDelta",
    "storeCommitSeq",
    "operations",
  ]);
  assert.equal(summary.tokens?.length, 1, "identical scalars share one interned slot");
  assert.equal(summary.usages?.length, 1, "identical breakdowns share one interned slot");
});
