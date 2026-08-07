import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage, WorkflowAgent } from "../../../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../../../src/errors.js";
import { saveCheckpoint } from "../../../src/run-persistence.js";
import { WorkflowManager } from "../../../src/workflow-manager.js";
import { withFakeHomeAsync } from "../../helpers/fake-home.js";

/** Agent runner that reports fixed usage so token accounting is exercised. */
function fakeAgent(usage: Partial<AgentUsage> = {}, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  } as unknown as Pick<WorkflowAgent, "run">;
}

/** Agent that stays running until a deferred resolve is called externally. */
function deferredAgent() {
  let deferredResolve: ((value: unknown) => void) | null = null;
  let deferredReject: ((err: Error) => void) | null = null;
  const promise = new Promise((resolve, reject) => {
    deferredResolve = resolve;
    deferredReject = reject;
  });
  return {
    resolve: (value: unknown = "done") => deferredResolve?.(value),
    reject: (err: Error) => deferredReject?.(err),
    runner: {
      async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
        return promise;
      },
    } as unknown as Pick<WorkflowAgent, "run">,
  };
}

function delayedAgent(delayMs: number, result: unknown = "slow") {
  return {
    async run(_prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      options?.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
      });
      return result;
    },
  } as unknown as Pick<WorkflowAgent, "run">;
}

const oneAgentScript = `export const meta = { name: 'tracked_demo', description: 'one agent' }
phase('Work')
const a = await agent('do it', { label: 'a' })
return { a }`;

/** Two sequential agents: 'a' finishes, then 'b' starts. */
const twoAgentScript = `export const meta = { name: 'two_agent_demo', description: 'two sequential agents' }
phase('Work')
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

/** Run each manager test with isolated cwd and HOME so workflow state is isolated. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-mgr-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

test(
  "cold-start stop: a second manager cannot stop a run while another manager owns the lease",
  withTempCwd(async (cwd) => {
    const ownerAgent = deferredAgent();
    const owner = new WorkflowManager({ cwd, agent: ownerAgent.runner });
    owner.on("error", () => {});
    const runId = "cold-start-stop-leased-1";
    owner.getPersistence().save({
      runId,
      workflowName: "leased_stop",
      script: oneAgentScript,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Owner resumes the run, so it's live in owner's this.runs and owner holds
    // the cross-process lease.
    assert.equal(await owner.resume(runId), true, "owner should acquire the lease and start");
    await new Promise((r) => setTimeout(r, 20));

    // A second manager doesn't have the run in memory, so stop() takes the
    // persisted fallback path — but the owner still holds the lease, so the
    // contender must not be able to mark it aborted on disk.
    const contender = new WorkflowManager({ cwd, agent: fakeAgent() });
    assert.equal(contender.stop(runId), false, "contender cannot steal the lease to stop the run");
    assert.equal(contender.getPersistence().load(runId)?.status, "running", "run is untouched by the contender");

    ownerAgent.resolve("done");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(owner.getRun(runId)?.status, "completed", "leased owner should still finish");
  }),
);

// ─── getRun tests ──────────────────────────────────────────────────────────────

test(
  "getRun returns ManagedRun with correct fields for active background run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    const run = manager.getRun(runId);
    assert.ok(run, "getRun should return the managed run");
    assert.equal(run?.runId, runId);
    assert.equal(run?.status, "running");
    assert.equal(run?.script, oneAgentScript);
    assert.ok(run?.controller instanceof AbortController, "should have an AbortController");
    assert.ok(run?.startedAt instanceof Date, "should have a startedAt date");
    assert.equal(run?.background, true, "should be marked as background");
    assert.ok(Array.isArray(run?.journal), "should have a journal array");

    // snapshot should be populated
    assert.equal(run?.snapshot.name, "tracked_demo");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "getRun returns ManagedRun with status 'aborted' after stop",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.stop(runId);
    const run = manager.getRun(runId);
    assert.equal(run?.status, "aborted");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "getRun returns undefined after deleteRun",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Stop first, then delete
    manager.stop(runId);
    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);

    const run = manager.getRun(runId);
    assert.equal(run, undefined, "deleted run should not be accessible");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── deleteRun tests ───────────────────────────────────────────────────────────

test(
  "deleteRun can delete a running run (removes from memory and persistence)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Delete while running — should succeed (removes from tracking)
    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);

    // Should not be in memory
    assert.equal(manager.getRun(runId), undefined);

    // Should not be in persistence
    const runs = manager.listRuns();
    assert.equal(
      runs.find((r) => r.runId === runId),
      undefined,
    );

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "deleteRun aborts a live run so its later (delayed) settle can't resurrect the deleted file (#A3)",
  withTempCwd(async (cwd) => {
    // delayedAgent always resolves after a fixed real delay, IGNORING the abort
    // signal entirely — so the stale execution's eventual settle is driven
    // purely by its own timer, independent of whether deleteRun()'s abort call
    // actually interrupts it. This isolates the identity-guard mechanism (the
    // resurrection must not happen) from the separate "did abort() fire" check.
    const manager = new WorkflowManager({ cwd, agent: delayedAgent(40) });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    promise.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 15)); // let the agent start

    const liveManaged = manager.getRun(runId);
    assert.ok(liveManaged, "the run should be tracked while running");
    assert.equal(liveManaged?.controller.signal.aborted, false, "not aborted yet, before delete");

    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);
    assert.equal(
      liveManaged?.controller.signal.aborted,
      true,
      "deleteRun must abort a live run's controller so it winds down instead of running forever in the background",
    );
    assert.equal(manager.getRun(runId), undefined);
    assert.equal(manager.getPersistence().load(runId), null, "deleted immediately");

    // Wait past the stale execution's delayed (40ms) resolution settling.
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(
      manager.getPersistence().load(runId),
      null,
      "the stale execution's later settle must not resurrect the deleted run's file",
    );
    assert.equal(manager.getRun(runId), undefined);
  }),
);

test(
  "resume immediately after pause is not clobbered by the stale paused execution's delayed settle (#A4)",
  withTempCwd(async (cwd) => {
    let secondAttempts = 0;
    const agent = {
      async run(prompt: string, options?: { signal?: AbortSignal; onUsage?: (u: AgentUsage) => void }) {
        if (prompt === "first") {
          options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
          return "first-result";
        }
        // "second"
        secondAttempts++;
        if (secondAttempts === 1) {
          // First attempt: hang until aborted, then reject only after an
          // artificial delay, so the stale settle races the resumed execution.
          return new Promise((_resolve, reject) => {
            const fire = () => setTimeout(() => reject(new Error("aborted (delayed)")), 40);
            if (options?.signal?.aborted) fire();
            else options?.signal?.addEventListener("abort", fire, { once: true });
          });
        }
        options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "second-result";
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(twoAgentScript);
    promise.catch(() => {});
    for (let i = 0; i < 200 && secondAttempts === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(secondAttempts, 1, "'second' should be in flight before pausing");

    assert.equal(manager.pause(runId), true);
    // Immediately resume — races the stale execution's still-pending (delayed) rejection.
    assert.equal(await manager.resume(runId), true);

    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const afterResume = manager.getPersistence().load(runId);
    assert.equal(afterResume?.status, "completed", "the resumed execution's outcome");

    // Wait past the stale first execution's delayed (40ms) rejection settling.
    await new Promise((resolve) => setTimeout(resolve, 80));

    const finalState = manager.getPersistence().load(runId);
    assert.equal(
      finalState?.status,
      "completed",
      "the stale execution's later settle must not clobber the resumed run's persisted state",
    );
  }),
);

test(
  "pause() -> immediate resume(): the stale (paused) execution's delayed agent rejection never emits a stray 'error' event (emitLive gate)",
  withTempCwd(async (cwd) => {
    // Same race as #A4 (pause() then immediately resume(), the OLD execution's
    // 'second' agent hangs until aborted and only rejects ~40ms later), but
    // this test targets emitLive()'s isCurrent() gate directly rather than
    // persisted status: executeRun()'s own catch tail (reached when the stale
    // execution's runWorkflow() promise finally rejects) unconditionally
    // computes `usageLimitPaused` and, when it's false and an "error" listener
    // is attached, calls `this.emitLive(managed, "error", ...)`. With the gate
    // intact, isCurrent(managed) is false by then (resume() already replaced
    // this.runs's entry for runId with a brand-new managed/controller), so
    // that emit is silently dropped. Removing the isCurrent() check inside
    // emitLive() (the exact mutation this test targets) would let that stale
    // "error" event reach every listener — including, in production, the task
    // panel's failure-delivery path — for a run that has already resumed (and,
    // as asserted below, completed successfully).
    let secondAttempts = 0;
    const agent = {
      async run(prompt: string, options?: { signal?: AbortSignal; onUsage?: (u: AgentUsage) => void }) {
        if (prompt === "first") {
          options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
          return "first-result";
        }
        secondAttempts++;
        if (secondAttempts === 1) {
          return new Promise((_resolve, reject) => {
            const fire = () => setTimeout(() => reject(new Error("stale agent rejected")), 40);
            if (options?.signal?.aborted) fire();
            else options?.signal?.addEventListener("abort", fire, { once: true });
          });
        }
        options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "second-result";
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent });
    const errorEvents: unknown[] = [];
    manager.on("error", (e) => errorEvents.push(e));

    const { runId, promise } = manager.startInBackground(twoAgentScript);
    promise.catch(() => {});
    for (let i = 0; i < 200 && secondAttempts === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(secondAttempts, 1, "'second' should be in flight before pausing");

    assert.equal(manager.pause(runId), true);
    assert.equal(await manager.resume(runId), true);

    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.getPersistence().load(runId)?.status, "completed", "the resumed execution completes");

    // Wait past the stale execution's delayed (40ms) rejection settling —
    // this is when its executeRun() catch tail runs and attempts the stray
    // emitLive("error", ...).
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(
      errorEvents.length,
      0,
      "the stale (paused, superseded) execution's delayed rejection must never reach an 'error' listener",
    );
  }),
);

test(
  "resume() superseding a run-fatal-aborted failed run never delivers a stray sibling agent's agentEnd event (#1)",
  withTempCwd(async (cwd) => {
    // Historical note: this test used to document a genuine gap — a run that
    // reached "failed" WITHOUT managed.controller ever aborting (a parallel()
    // fan-out where one sibling ('failer') throws a non-recoverable error
    // while another ('straggler') is still in flight: Promise.all rejects
    // immediately but does NOT cancel 'straggler'). That gap is now closed at
    // the ROOT — runWorkflow's own run-fatal handling (SharedRuntime.
    // runFatalController, see workflow.ts) fires the instant 'failer's error
    // escapes the top-level script, and every in-flight agent (including
    // 'straggler') links its abort controller to that signal. So 'straggler'
    // still runs to completion here (the fake agent below doesn't check its
    // signal, simulating a real subagent process that doesn't cooperate with
    // abort) — stragglerSettles below proves that — but once it resolves,
    // agentImpl's OWN throwIfAborted() now trips before onAgentEnd is ever
    // called, for BOTH the old (never-resumed) execution and the new
    // (resumed) one, since 'failer' fails identically on replay. So
    // onAgentEnd for "straggler" is never delivered at all — a strictly
    // stronger guarantee than the old isCurrent()-based suppression this test
    // originally probed (that guard remains in place as defense-in-depth for
    // OTHER supersede paths — pause()/stop()/deleteRun() — see the tests
    // below), it just never has to fire for THIS scenario anymore.
    // managed.controller.signal itself still never aborts here (asserted
    // below) — the two abort signals are deliberately independent (see
    // SharedRuntime.runFatalController's doc comment).
    let stragglerSettles = 0;
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
        if (prompt === "failer") {
          throw new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
        }
        // "straggler": a real delay, and deliberately ignores any abort
        // signal — simulating a real subagent process that doesn't
        // cooperate with cancellation.
        await new Promise((resolve) => setTimeout(resolve, 60));
        stragglerSettles++;
        options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "straggler-done";
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});
    const agentEndsByLabel = new Map<string, number>();
    manager.on("agentEnd", (e: { label: string }) => {
      agentEndsByLabel.set(e.label, (agentEndsByLabel.get(e.label) ?? 0) + 1);
    });

    const script = `export const meta = { name: 'stray_sibling_demo', description: 'stray sibling agent' }
const xs = await parallel([
  () => agent('failer', { label: 'failer' }),
  () => agent('straggler', { label: 'straggler' }),
])
return xs`;

    const { runId, promise } = manager.startInBackground(script);
    promise.catch(() => {});
    for (let i = 0; i < 200 && manager.getRun(runId)?.status !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.getRun(runId)?.status, "failed", "the run must fail (via 'failer')");
    assert.equal(
      manager.getRun(runId)?.controller.signal.aborted,
      false,
      "managed.controller (options.signal) itself is never aborted by a run-fatal error — only the internal runFatalController is",
    );
    const oldManaged = manager.getRun(runId);

    // Resume: builds a brand-new managed/controller for this runId. The OLD
    // execution's 'straggler' call is still in flight (its run-fatal abort
    // only discards its RESULT once it settles — it doesn't forcibly kill a
    // signal-ignoring runner mid-call), entirely unaffected by resume().
    assert.equal(await manager.resume(runId), true);
    assert.notEqual(manager.getRun(runId), oldManaged, "resume() must have replaced the managed run object");

    // Wait past BOTH the old and the new execution's 'straggler' (each ~60ms
    // from its own start) so both have settled.
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(stragglerSettles, 2, "both the old (stale) and new (current) straggler calls actually ran");
    assert.equal(
      agentEndsByLabel.get("straggler"),
      undefined,
      "run-fatal abort suppresses BOTH stragglers' agentEnd before the manager ever sees them",
    );
  }),
);

test(
  "writeRunToDisk's isCurrent guard is unreachable defense-in-depth: run-fatal abort now stops a stale straggler from ever journaling (#2)",
  withTempCwd(async (cwd) => {
    // HISTORY: this test used to drive a stale schedulePersist() deferred
    // timer (the one path into writeRunToDisk() that skips persistRun()'s own
    // isCurrent guard) by having a superseded-but-never-aborted execution's
    // straggler settle and journal AFTER resume() replaced it. That trigger
    // required a run to reach "failed" WITHOUT managed.controller ever
    // aborting AND its straggler's onAgentJournal still firing after the
    // fact — exactly the gap item 1 (run-fatal abort, see
    // SharedRuntime.runFatalController in workflow.ts) closes: ANY error that
    // fails a top-level run now seals that SAME execution's shared runtime
    // before its own catch returns, so a sibling straggler within THAT
    // execution — like 'straggler' below — trips throwIfAborted() the moment
    // it resolves and NEVER reaches onAgentJournal (see the flow proven
    // below). Since onAgentJournal is schedulePersist()'s only call site,
    // there is no longer a way to construct a genuinely stale (superseded,
    // un-aborted) execution whose straggler still journals afterward — every
    // status transition that would make a run resumable (paused OR failed)
    // is now, structurally, always preceded by at least one abort signal
    // (managed.controller for pause()/stop(), or shared.runFatalController
    // for a run-fatal escape) tripping for that same execution first.
    //
    // The isCurrent() check inside writeRunToDisk() (independent of, and
    // additional to, persistRun()'s own early-return) is KEPT as
    // defense-in-depth — it costs nothing, and protects against a future
    // change that reopens a stale-journal path without anyone re-deriving
    // this whole chain of reasoning. This test now asserts the structural
    // closure directly (the straggler's result never reaches the journal at
    // all) instead of asserting a disk-write side effect that no longer has
    // a way to occur — a test that only proved "nothing happened" for a path
    // that can no longer be exercised would silently stop meaning anything.
    const agent = {
      async run(prompt: string) {
        if (prompt === "failer") {
          throw new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
        }
        // "straggler": settles well after 'failer' has already failed the run.
        await new Promise((resolve) => setTimeout(resolve, 30));
        return "straggler-stale";
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});
    const journaledResults: unknown[] = [];
    manager.on("agentEnd", (e: { label: string; result: unknown }) => {
      if (e.label === "straggler") journaledResults.push(e.result);
    });

    const script = `export const meta = { name: 'stray_timer_demo', description: 'stray schedulePersist timer' }
const xs = await parallel([
  () => agent('failer', { label: 'failer' }),
  () => agent('straggler', { label: 'straggler' }),
])
return xs`;

    const { runId, promise } = manager.startInBackground(script);
    promise.catch(() => {});
    for (let i = 0; i < 200 && manager.getRun(runId)?.status !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.getRun(runId)?.status, "failed");
    assert.equal(manager.getRun(runId)?.controller.signal.aborted, false, "managed.controller itself is never aborted");

    // Wait well past the OLD straggler's 30ms settle. Its result must NEVER
    // reach an agentEnd event — throwIfAborted() (tripped by run-fatal abort,
    // sealed the instant 'failer' escaped) discards it before onAgentJournal
    // (and therefore schedulePersist) is ever called.
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      journaledResults.includes("straggler-stale"),
      false,
      "the old (never-aborted-by-controller) execution's straggler must never journal — run-fatal abort discards it first",
    );

    const persisted = manager.getPersistence().load(runId);
    const journal = persisted?.journal ?? [];
    assert.ok(
      !journal.some((entry) => entry.result === "straggler-stale"),
      "the persisted journal must never contain the stale straggler's result either — schedulePersist() is only ever " +
        "called from onAgentJournal, so if the journal never sees it, no stray timer was ever scheduled for it",
    );
    // (resume()'s own correctness — including a genuinely resumed execution's
    // writes landing normally — is covered by #A3/#A4 and the other resume
    // tests above; this test's whole point is the pre-resume structural
    // closure proven above, not resume() itself.)
  }),
);

test(
  "concurrent agents sharing a label get correctly attributed onAgentEnd results (never swapped)",
  withTempCwd(async (cwd) => {
    // Two agents in the same parallel() fan-out share a label ('x') — a
    // routine pattern (parallel()'s own default label is phase-scoped, not
    // per-call-unique, and authors often reuse a label across a fan-out). 'A'
    // (started first) finishes quickly; 'B' (started second) finishes much
    // later. Before keying snapshot lookups on the agent CALL's unique id
    // (see WorkflowRunOptions.onAgentEnd's `id` field in workflow.ts), the
    // manager resolved an onAgentEnd event by reverse-scanning
    // managed.snapshot.agents for the last-pushed entry with a matching label
    // AND status "running" — which, for two concurrently-running same-label
    // agents, picks whichever entry the scan happens to land on rather than
    // the one THIS event actually belongs to. Here that would misattribute
    // A's (fast) result onto B's snapshot slot (B is the last-pushed
    // still-"running" entry when A's event fires), and later attribute B's
    // (slow) result onto A's slot — a full swap.
    const agent = {
      async run(prompt: string) {
        if (prompt === "A") {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return "result-A";
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
        return "result-B";
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'shared_label_demo', description: 'same-label concurrency' }
const xs = await parallel([
  () => agent('A', { label: 'x' }),
  () => agent('B', { label: 'x' }),
])
return xs`;

    const { runId, promise } = manager.startInBackground(script);
    promise.catch(() => {});

    // Wait past A's ~5ms completion but well before B's ~150ms one.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const midSnapshot = manager.getSnapshot(runId);
    assert.ok(midSnapshot, "run must still be live at this point");
    if (!midSnapshot) throw new Error("unreachable");
    const [firstAgent, secondAgent] = midSnapshot.agents;
    assert.equal(firstAgent.label, "x");
    assert.equal(secondAgent.label, "x");
    assert.equal(firstAgent.status, "done", "the first-started agent (A) has already finished");
    assert.equal(firstAgent.resultPreview, "result-A", "A's own result must land on A's own snapshot entry");
    assert.equal(secondAgent.status, "running", "the second-started agent (B) is still genuinely in flight");

    // Wait past B's completion too, then verify final attribution is still correct.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const finalSnapshot = manager.getSnapshot(runId);
    assert.equal(finalSnapshot?.agents[0].resultPreview, "result-A", "A's slot must still hold A's result");
    assert.equal(finalSnapshot?.agents[1].resultPreview, "result-B", "B's slot must hold B's own result, not A's");
  }),
);

test(
  "deleteRun deletes persisted journal entries",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId } = manager.startInBackground(oneAgentScript);
    // Wait for completion
    await new Promise((r) => setTimeout(r, 30));

    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);

    // Verify persistence file is gone by checking listRuns
    const runs = manager.listRuns();
    assert.equal(runs.length, 0, "no persisted runs should remain after delete");
  }),
);

// ─── startInBackground tests ───────────────────────────────────────────────────

test(
  "startInBackground with args propagates args to workflow script",
  withTempCwd(async (cwd) => {
    // Script that uses args
    const argsScript = `export const meta = { name: 'args_demo', description: 'args test' }
const a = await agent('do it', { label: 'a' })
return { args, a }`;

    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ total: 50 }) });
    const { promise } = manager.startInBackground(argsScript, { mode: "test", value: 42 });
    const result = await promise;
    assert.ok(result, "should complete successfully");
  }),
);

test(
  "startInBackground runId is unique per call",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const r1 = manager.startInBackground(oneAgentScript);
    const r2 = manager.startInBackground(oneAgentScript);
    assert.notEqual(r1.runId, r2.runId, "runIds should be unique");

    // Wait for both to complete
    await Promise.allSettled([r1.promise, r2.promise]);
  }),
);

test(
  "startInBackground snapshot is initially populated with workflow name",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    const snap = manager.getSnapshot(runId);
    assert.equal(snap?.name, "tracked_demo");
    assert.equal(snap?.description, "one agent");
    assert.ok(Array.isArray(snap?.phases), "snap.phases should be an array");
    assert.ok(Array.isArray(snap?.logs), "snap.logs should be an array");
    await promise.catch(() => {});
  }),
);

// ─── Multiple runs lifecycle tests ─────────────────────────────────────────────

test(
  "multiple background runs are independently managed",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const r1 = manager.startInBackground(oneAgentScript);
    const r2 = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 30));

    // Both should be running
    assert.equal(manager.getRun(r1.runId)?.status, "running");
    assert.equal(manager.getRun(r2.runId)?.status, "running");

    // Stop one independently
    manager.stop(r1.runId);
    assert.equal(manager.getRun(r1.runId)?.status, "aborted");
    assert.equal(manager.getRun(r2.runId)?.status, "running", "other run should still be running");

    // listRuns should show both
    const runs = manager.listRuns();
    assert.equal(runs.length, 2, "both runs should be listed");

    da.resolve("done");
    await Promise.allSettled([r1.promise, r2.promise]);
  }),
);

test(
  "listRuns reflects status changes after pause and stop",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause
    manager.pause(runId);
    let persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "paused", "listRuns should show paused status");

    // Stop
    manager.stop(runId);
    persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "listRuns should show aborted status after stop");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Event tests ───────────────────────────────────────────────────────────────

test(
  "listRuns reflects running status immediately after resume",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((resolve) => setTimeout(resolve, 20));
    manager.pause(runId);

    const resumed = await manager.resume(runId);
    const persisted = manager.listRuns().find((run) => run.runId === runId);

    assert.equal(resumed, true);
    assert.equal(persisted?.status, "running", "listRuns should show running status after resume");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "manager emits 'resumed' event on resume",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let resumedEvent: { runId: string } | null = null;
    manager.on("resumed", (ev: { runId: string }) => {
      resumedEvent = ev;
    });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.pause(runId);
    await manager.resume(runId);

    const resumed = resumedEvent as { runId: string } | null;
    assert.ok(resumed, "resumed event should fire");
    assert.equal(resumed.runId, runId);

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "manager does NOT emit 'error' for an intentional externalSignal abort (f1 gate)",
  withTempCwd(async (cwd) => {
    const ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });

    let capturedError: { runId: string; error: WorkflowError } | null = null;
    manager.on("error", (ev: { runId: string; error: WorkflowError }) => {
      capturedError = ev;
    });

    const runPromise = manager.runSync(oneAgentScript, undefined, {
      externalSignal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    da.resolve("done");

    try {
      await runPromise;
    } catch {
      /* expected */
    }

    // externalSignal aborts managed.controller (see executeRun's wiring), so the
    // intent-gated 'error' branch must skip the emit — a deliberate user abort
    // (Esc during a blocking tool call) is not a run failure.
    assert.equal(capturedError, null, "intentional external abort must NOT emit 'error'");
    assert.equal(manager.listRuns()[0]?.status, "aborted");
  }),
);

test(
  "manager emits 'error' event for a genuine run failure (f1 gate preserves real failures)",
  withTempCwd(async (cwd) => {
    // Each agent reports 100 tokens against a default budget of 50: the second
    // agent throws TOKEN_BUDGET_EXHAUSTED — a genuine, non-recoverable run
    // failure that must still emit 'error' even with the intent gate.
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ total: 100 }), defaultTokenBudget: 50 });

    let capturedError: { runId: string; error: WorkflowError } | null = null;
    manager.on("error", (ev: { runId: string; error: WorkflowError }) => {
      capturedError = ev;
    });

    await assert.rejects(manager.runSync(twoAgentScript));

    const failureEvent = capturedError as { runId: string; error: WorkflowError } | null;
    assert.ok(failureEvent, "a genuine run failure must emit 'error'");
    assert.ok(failureEvent.error instanceof WorkflowError, "error should be instance of WorkflowError");
    assert.equal(failureEvent.error.code, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED);
    assert.equal(manager.listRuns()[0]?.status, "failed");
  }),
);

test(
  "pause() and stop() do not emit 'error' (intentional aborts, not failures)",
  withTempCwd(async (cwd) => {
    // The subagent's in-flight run() rejects when the run's abort signal fires
    // — the cooperative-abort path a real session follows on pause/stop. This
    // rejection reaches executeRun's catch tail, which must NOT emit 'error'
    // for a deliberate user action (core-orchestration:f1).
    const abortRejectingAgent = {
      async run(_prompt: string, options?: { signal?: AbortSignal }) {
        return new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    };

    for (const action of ["pause", "stop"] as const) {
      let sawAbort = false;
      const agentWithFlag = {
        async run(prompt: string, options?: { signal?: AbortSignal }) {
          // Set the in-flight flag when the subagent session is actually created.
          sawAbort = true;
          return abortRejectingAgent.run(prompt, options);
        },
      } as unknown as Pick<WorkflowAgent, "run">;
      const manager = new WorkflowManager({ cwd, agent: agentWithFlag });
      let errorEvents = 0;
      manager.on("error", () => {
        errorEvents++;
      });
      const { runId, promise } = manager.startInBackground(oneAgentScript);
      // Wait until the agent is genuinely in flight (run() invoked).
      for (let i = 0; i < 200 && !sawAbort; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (action === "pause") assert.equal(manager.pause(runId), true);
      else assert.equal(manager.stop(runId), true);
      // Let the abort propagate through the agent rejection into the catch tail.
      await promise.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(errorEvents, 0, `${action}() must not emit 'error'`);
      assert.equal(manager.getRun(runId)?.status, action === "pause" ? "paused" : "aborted");
    }
  }),
);

test(
  "deleteRun() does not emit 'error' for the run it intentionally aborts",
  withTempCwd(async (cwd) => {
    let sawAbort = false;
    const abortRejectingAgent = {
      async run(_prompt: string, options?: { signal?: AbortSignal }) {
        // In-flight marker: the subagent session is live the moment run() runs.
        sawAbort = true;
        return new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent: abortRejectingAgent });
    let errorEvents = 0;
    manager.on("error", () => {
      errorEvents++;
    });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    for (let i = 0; i < 200 && !sawAbort; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(manager.deleteRun(runId), true);
    await promise.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(errorEvents, 0, "deleteRun() must not emit 'error'");
  }),
);

test(
  "checkpoints persist through writeRunToDisk and seed resume() (f3 manager side)",
  withTempCwd(async (cwd) => {
    // 'first' resolves, 'second' hangs — so the run can be paused after the
    // first agent journals.
    const agent = {
      async run(prompt: string) {
        if (prompt === "first") return "a-done";
        return new Promise(() => {});
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent });
    const { runId, promise } = manager.startInBackground(twoAgentScript);
    promise.catch(() => {}); // pause aborts the in-flight execution — expected
    // Wait until the second agent is in flight, then pause.
    for (let i = 0; i < 200 && (manager.getRun(runId)?.snapshot?.agents?.length ?? 0) < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(manager.pause(runId), true);

    // A checkpoint written through the persistence layer (the CAS side lives
    // in the persistence slice; the manager must not erase it on its next
    // write — see writeRunToDisk's save object).
    await saveCheckpoint(
      runId,
      {
        runId,
        taskId: "task-1",
        status: "active",
        output: "stage 1 complete",
        timestamp: new Date().toISOString(),
      },
      cwd,
    );

    // A manager persist lands AFTER the saveCheckpoint (e.g. the final pause
    // persist, or resume's initial persist) — with ManagedRunBase.checkpoints
    // carried through, the checkpoint survives.
    const persisted = manager.getPersistence().load(runId);
    assert.equal(persisted?.checkpoints?.length, 1, "manager persist must keep the CAS-written checkpoint");
    assert.equal(persisted?.checkpoints?.[0]?.taskId, "task-1");

    // Resume: the new ManagedRun seeds its in-memory checkpoints from the
    // persisted array (persisted.checkpoints ?? []), so a later manager persist
    // keeps carrying them.
    assert.equal(await manager.resume(runId), true);
    assert.deepEqual(manager.getRun(runId)?.checkpoints, persisted?.checkpoints);
    const resumedPersisted = manager.getPersistence().load(runId);
    assert.equal(resumedPersisted?.checkpoints?.length, 1, "resume's initial persist keeps the checkpoint");
  }),
);

test(
  "resume(runId, opts) passes ExecOptions through (onProgress fires for the resumed execution)",
  withTempCwd(async (cwd) => {
    // First run: 'first' resolves, 'second' hangs — pause mid-'second'.
    let hangSecond = true;
    const agent = {
      async run(prompt: string) {
        if (prompt === "second" && hangSecond) return new Promise(() => {});
        return `done:${prompt}`;
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent });
    const { runId, promise } = manager.startInBackground(twoAgentScript);
    promise.catch(() => {});
    for (let i = 0; i < 200 && (manager.getRun(runId)?.snapshot?.agents?.length ?? 0) < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(manager.pause(runId), true);

    // Resume with an ExecOptions passthrough: onProgress must fire for the
    // resumed execution (core-orchestration:i4) while the headless scheduler
    // path (no opts) stays unchanged.
    hangSecond = false;
    let progressCalls = 0;
    const resumed = await manager.resume(runId, {
      onProgress: () => {
        progressCalls++;
      },
    });
    assert.equal(resumed, true);
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(progressCalls > 0, "onProgress must fire during the resumed execution");
    assert.equal(manager.getPersistence().load(runId)?.status, "completed");
  }),
);

test(
  "resume stays headless when opts carries no confirm; threaded confirm is honored (i4)",
  withTempCwd(async (cwd) => {
    // A checkpoint() script: a headless resume (no confirm threaded in) applies
    // the declared default / replays the journaled reply instead of blocking.
    const script = `export const meta = { name: 'ckpt_headless', description: 'checkpoint headless' }
const ok = await checkpoint('proceed?', { kind: 'confirm', default: true })
const a = await agent('work', { label: 'a' })
return { ok, a }`;
    let hang = true;
    const agent = {
      async run(prompt: string) {
        if (hang && prompt === "work") return new Promise(() => {});
        return `done:${prompt}`;
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent });
    const { runId, promise } = manager.startInBackground(script);
    promise.catch(() => {});
    for (let i = 0; i < 200 && (manager.getRun(runId)?.snapshot?.agents?.length ?? 0) < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(manager.pause(runId), true);
    hang = false;

    // Headless scheduler path: resume() with no opts must not hang on the
    // checkpoint (it replays the journaled reply).
    assert.equal(await manager.resume(runId), true);
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(manager.getPersistence().load(runId)?.status, "completed");

    // Same script run fresh with a confirm threaded via ExecOptions: the
    // callback is used (proves the opts passthrough surface is the same
    // ExecOptions runSync/startInBackground already accept).
    const manager2 = new WorkflowManager({ cwd, agent });
    let confirmCalls = 0;
    await manager2.runSync(script, undefined, {
      confirm: async () => {
        confirmCalls++;
        return true;
      },
    });
    assert.ok(confirmCalls > 0, "confirm from ExecOptions is honored");
  }),
);

test(
  "journal upsert is O(1): a resume re-run replaces its seeded (runId, index) entry in place",
  withTempCwd(async (cwd) => {
    const hangSecond = true;
    const agent = {
      async run(prompt: string) {
        if (prompt === "second" && hangSecond) return new Promise(() => {});
        return `done:${prompt}`;
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent });
    const { runId, promise } = manager.startInBackground(twoAgentScript);
    promise.catch(() => {});
    for (let i = 0; i < 200 && (manager.getRun(runId)?.snapshot?.agents?.length ?? 0) < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(manager.pause(runId), true);
    // The first run journaled exactly one entry: 'first' (call index 0).
    assert.equal(manager.getPersistence().load(runId)?.journal?.length, 1);

    // Resume with an EDITED script (call 0's prompt changes -> cache miss ->
    // re-runs live and journals a FRESH (runId, 0) entry). 'second' STILL
    // hangs, so the resumed run's in-memory journal — the side-index's own
    // bookkeeping (core-orchestration:i3) — is observable mid-run.
    const edited = twoAgentScript.replace("'first'", "'first-edited'");
    assert.equal(await manager.resume(runId, { script: edited }), true);
    // Wait until the resumed run has re-journaled call 0 and reached the
    // hanging 'second' (agents rebuilt from scratch: length 1 -> 2).
    for (let i = 0; i < 200 && (manager.getRun(runId)?.snapshot?.agents?.length ?? 0) < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const liveJournal = manager.getRun(runId)?.journal;
    assert.equal(liveJournal?.length, 1, "the fresh (runId, 0) entry replaced the seeded one in place — no duplicate");
    assert.equal(liveJournal?.[0]?.result, "done:first-edited", "latest-wins: the resumed call's result is journaled");

    // Cleanup: stop the resumed run (its 'second' hangs forever).
    assert.equal(manager.stop(runId), true);
  }),
);

test(
  "settle watchdog releases a stopped run whose execution never settles (i5)",
  withTempCwd(async (cwd) => {
    // The subagent NEVER settles — it ignores the abort signal entirely, so the
    // execution promise would otherwise pin the run in `runs` forever.
    const neverSettlingAgent = {
      async run(_prompt: string, _options?: { signal?: AbortSignal }) {
        return new Promise(() => {});
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent: neverSettlingAgent, settleWatchdogMs: 80 });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    promise.catch(() => {}); // the hung execution never settles — swallow
    for (let i = 0; i < 200 && (manager.getRun(runId)?.snapshot?.agents?.length ?? 0) < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(manager.stop(runId), true);
    assert.ok(manager.getRun(runId), "the stopped run is still in memory until the watchdog fires");

    // After settleWatchdogMs the watchdog force-releases the run from the
    // in-memory registry (disk state remains authoritative and listable).
    for (let i = 0; i < 100 && manager.getRun(runId) !== undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(manager.getRun(runId), undefined, "watchdog must release the never-settling run");
    assert.equal(manager.listRuns()[0]?.status, "aborted", "disk state stays authoritative");
  }),
);

test(
  "settle watchdog never releases a run that settles on its own (disarmed on settle)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner, settleWatchdogMs: 60 });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.pause(runId), true);
    // The cooperative abort DOES settle (agent resolves, throwIfAborted fires).
    da.resolve("done");
    await promise.catch(() => {});

    // Give the watchdog ample time to have fired had it not been disarmed.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const managed = manager.getRun(runId);
    assert.ok(managed, "a settled run must not be force-released");
    assert.equal(managed.status, "paused");
  }),
);

// ─── State transition tests ─────────────────────────────────────────────────

test(
  "state transition: running -> pause -> running (pause then resume cycle)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // running -> pause -> running
    assert.equal(manager.getRun(runId)?.status, "running", "should start as running");
    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused", "should be paused after pause");

    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    assert.equal(manager.getRun(runId)?.status, "running", "should be running after resume");

    // Complete the resumed run
    da.resolve("resumed-done");
    await origPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(manager.getRun(runId)?.status, "completed", "should complete after resume finishes");
  }),
);

test(
  "state transition: running -> stop (direct stop while running)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.getRun(runId)?.status, "running");
    assert.equal(manager.stop(runId), true);
    assert.equal(manager.getRun(runId)?.status, "aborted");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "state transition: running -> pause -> stop (pause then stop)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    assert.equal(manager.stop(runId), true);
    assert.equal(manager.getRun(runId)?.status, "aborted");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "state transition: running -> stop -> resume (stop then try resume -> false)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.stop(runId), true);
    assert.equal(manager.getRun(runId)?.status, "aborted");

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "cannot resume a stopped/aborted run");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "state transition: completed -> resume (completed run cannot be resumed -> false)",
  withTempCwd(async (cwd) => {
    const agentObj = fakeAgent();
    const runMock = test.mock.method(agentObj, "run");
    const manager = new WorkflowManager({ cwd, agent: agentObj });
    const { promise } = manager.startInBackground(oneAgentScript);
    await promise;

    const runs = manager.listRuns();
    const runId = runs[0]?.runId;
    assert.ok(runId);
    assert.equal(runs[0].status, "completed");
    assert.equal(runMock.mock.callCount(), 1, "agent.run should have been called once");

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "cannot resume a completed run");
  }),
);

test(
  "state transition: running -> pause -> pause (double pause -> false)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    assert.equal(manager.pause(runId), false, "second pause should return false");
    assert.equal(manager.getRun(runId)?.status, "paused", "status should remain paused");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Concurrency / race tests ──────────────────────────────────────────────────

test(
  "double resume on a persisted paused run returns false on second call",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause while running so we can resume
    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    // First resume should succeed
    const firstResume = await manager.resume(runId);
    assert.equal(firstResume, true, "first resume should succeed");

    // The resumed run is now running; second resume should return false
    const secondResume = await manager.resume(runId);
    assert.equal(secondResume, false, "second resume should return false when the resumed run is already running");

    da.resolve("done");
    await origPromise.catch(() => {});
  }),
);

test(
  "concurrent pause and stop produces deterministic aborted state",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Call pause and stop without awaiting — synchronous in the event loop
    const _pauseResult = manager.pause(runId);
    const _stopResult = manager.stop(runId);

    // Final state must always be "aborted" because:
    //   pause transitions "running" → "paused"
    //   stop transitions "running" or "paused" → "aborted", never back to "paused"
    // Ordering 1: pause then stop → paused then aborted
    // Ordering 2: stop then pause → aborted, pause returns false
    // In every ordering: final status is "aborted".
    assert.equal(manager.getRun(runId)?.status, "aborted", "final status must be aborted regardless of ordering");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "agent error during resume sets run to failed status",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause while the deferred agent is in-flight
    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Mock the agent runner to throw a non-recoverable WorkflowError on resume.
    // Regular Error/agent rejections get wrapped as recoverable (agent returns
    // null, workflow continues). A non-recoverable WorkflowError propagates up
    // to executeRun's catch block and sets status to "failed".
    test.mock.method(da.runner, "run", async (_prompt: string) => {
      throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
    });

    try {
      // Resume — executeRun calls runWorkflow which calls the mocked runner
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true, "resume should schedule the run");

      // Wait for the background executed run to process the agent error
      await new Promise((r) => setTimeout(r, 100));

      const finalRun = manager.getRun(runId);
      assert.equal(finalRun?.status, "failed", "resumed run should transition to failed when agent errors");
      assert.ok(finalRun?.error instanceof WorkflowError, "error should be a WorkflowError");
      assert.equal(
        (finalRun?.error as WorkflowError).code,
        WorkflowErrorCode.AGENT_EXECUTION_ERROR,
        "error code should be AGENT_EXECUTION_ERROR",
      );
    } finally {
      // Resolve the original deferred promise so the first executeRun settles
      da.runner.run = (async (_prompt: string) => "done") as unknown as typeof da.runner.run;
      da.resolve("done");
      await origPromise.catch(() => {});
    }
  }),
);

test(
  "two concurrent background runs are both tracked immediately in listRuns",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const r1 = manager.startInBackground(oneAgentScript);
    const r2 = manager.startInBackground(oneAgentScript);

    // Both runs should be immediately visible in listRuns
    const runs = manager.listRuns();
    assert.equal(runs.length, 2, "both runs should appear in listRuns immediately after startInBackground");

    // Both should be in running status
    assert.equal(manager.getRun(r1.runId)?.status, "running");
    assert.equal(manager.getRun(r2.runId)?.status, "running");

    // Run IDs must be unique
    assert.notEqual(r1.runId, r2.runId);

    da.resolve("done");
    await Promise.allSettled([r1.promise, r2.promise]);
  }),
);

// ─── Failed state transition tests ─────────────────────────────────────────────

test(
  "pause returns false for failed run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause the running run so we can resume with a failing agent
    assert.equal(manager.pause(runId), true, "pause should succeed");
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Mock agent to throw a non-recoverable WorkflowError, making the run fail
    test.mock.method(da.runner, "run", async (_prompt: string) => {
      throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
    });

    try {
      // Resume — the run will fail because the mocked agent throws
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true, "resume should schedule the run");
      await new Promise((r) => setTimeout(r, 100));

      // Verify the run is now in failed state
      const failedRun = manager.getRun(runId);
      assert.equal(failedRun?.status, "failed", "run should be in failed state");
      assert.ok(failedRun?.error instanceof WorkflowError, "error should be a WorkflowError");

      // pause() should return false for a failed run (requires status === "running")
      const paused = manager.pause(runId);
      assert.equal(paused, false, "pause should return false for failed run");
      assert.equal(manager.getRun(runId)?.status, "failed", "status should remain failed after rejected pause");
    } finally {
      da.runner.run = (async (_prompt: string) => "done") as unknown as typeof da.runner.run;
      da.resolve("done");
      await origPromise.catch(() => {});
    }
  }),
);

test(
  "stop returns false for failed run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause the running run so we can resume with a failing agent
    assert.equal(manager.pause(runId), true, "pause should succeed");
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Mock agent to throw a non-recoverable WorkflowError
    test.mock.method(da.runner, "run", async (_prompt: string) => {
      throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
    });

    try {
      // Resume — the run will fail
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true, "resume should schedule the run");
      await new Promise((r) => setTimeout(r, 100));

      // Verify the run is now in failed state
      const failedRun = manager.getRun(runId);
      assert.equal(failedRun?.status, "failed", "run should be in failed state");
      assert.ok(failedRun?.error instanceof WorkflowError, "error should be a WorkflowError");

      // stop() should return false for a failed run (requires "running" or "paused")
      const stopped = manager.stop(runId);
      assert.equal(stopped, false, "stop should return false for failed run");
      assert.equal(manager.getRun(runId)?.status, "failed", "status should remain failed after rejected stop");
    } finally {
      da.runner.run = (async (_prompt: string) => "done") as unknown as typeof da.runner.run;
      da.resolve("done");
      await origPromise.catch(() => {});
    }
  }),
);

test(
  "resume restarts a failed run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause the running run
    assert.equal(manager.pause(runId), true, "pause should succeed");
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Mock agent to throw a non-recoverable WorkflowError
    test.mock.method(da.runner, "run", async (_prompt: string) => {
      throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
    });

    try {
      // Resume — the run will fail
      await manager.resume(runId);
      await new Promise((r) => setTimeout(r, 100));

      // Verify the run is now in failed state
      const failedRun = manager.getRun(runId);
      assert.equal(failedRun?.status, "failed", "run should be in failed state");
      assert.ok(failedRun?.error instanceof WorkflowError, "error should be a WorkflowError");
    } finally {
      // Restore the runner so the resumed run's agent call succeeds
      da.runner.run = (async (_prompt: string) => "done") as unknown as typeof da.runner.run;
      da.resolve("done");
      await origPromise.catch(() => {});
    }

    // Resume the failed run — resume() allows failed status
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true, "resume should return true for a failed run");
    assert.equal(manager.getRun(runId)?.status, "running", "resumed failed run should transition to running");

    // Wait for the resumed run to complete successfully
    await new Promise((r) => setTimeout(r, 100));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed failed run should complete successfully after restore");
  }),
);

// ─── parallel() concurrency tests ───────────────────────────────────────────

test(
  "parallel executes all items",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const script = `export const meta = { name: 'parallel_count', description: 'count parallel agents' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n)))
return results`;
    const result = await manager.runSync(script);
    assert.equal(result.agentCount, 3, "parallel should execute all 3 agents");
    assert.ok(Array.isArray(result.result), "result should be an array");
    assert.equal(result.result.length, 3);
  }),
);

test(
  "parallel returns results in order",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          return prompt;
        },
      } as unknown as Pick<WorkflowAgent, "run">,
    });
    const script = `export const meta = { name: 'parallel_order', description: 'check parallel order' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n)))
return results`;
    const result = await manager.runSync(script);
    assert.equal(result.agentCount, 3, "3 agents should have run");
    assert.deepEqual(result.result, ["task 1", "task 2", "task 3"], "parallel should return results in input order");
  }),
);

test(
  "parallel with empty array returns empty",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const script = `export const meta = { name: 'parallel_empty', description: 'empty parallel' }
const results = await parallel([])
return results`;
    const result = await manager.runSync(script);
    assert.ok(Array.isArray(result.result), "result should be an array");
    assert.equal(result.result.length, 0, "empty parallel should return empty array");
    assert.equal(result.agentCount, 0, "no agents should run with empty parallel");
  }),
);

test(
  "persistAgentSessions plumbs through the manager into runWorkflow options",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent(), persistAgentSessions: true });
    // The manager forwards the flag on every runWorkflow call; the flag is
    // captured at construction and defaults to false when omitted.
    assert.equal((manager as unknown as { persistAgentSessions: boolean }).persistAgentSessions, true);

    const defaulted = new WorkflowManager({ cwd, agent: fakeAgent() });
    assert.equal((defaulted as unknown as { persistAgentSessions: boolean }).persistAgentSessions, false);

    // The run still completes normally with the flag set (injected agent
    // runner, so no real session is created here).
    const result = await manager.runSync(oneAgentScript);
    assert.equal(result.agentCount, 1);
  }),
);

test(
  "agents receive an identifiable sessionName (workflow:<runId> <label>) for persisted sessions",
  withTempCwd(async (cwd) => {
    const seen: Array<{ label?: string; sessionName?: string }> = [];
    const manager = new WorkflowManager({
      cwd,
      persistAgentSessions: true,
      agent: {
        async run(_prompt: string, options?: { label?: string; sessionName?: string }) {
          seen.push({ label: options?.label, sessionName: options?.sessionName });
          return "ok";
        },
      } as unknown as Pick<WorkflowAgent, "run">,
    });
    const result = await manager.runSync(oneAgentScript);
    assert.equal(result.agentCount, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].label, "a");
    // runWorkflow now uses the managed run's persisted id (slug + generateRunId)
    // so result.runId / session names line up with listRuns()/resume().
    assert.match(seen[0].sessionName ?? "", /^workflow:tracked-demo-[a-z0-9-]+ a$/);
  }),
);

// ─── Edited-script resume (cached-prefix reuse / model iteration) ───────────────
// resume(runId, { script }) lets the orchestrating model re-run with an EDITED
// script: the unchanged agent() prefix replays from the journal (cache hit), and
// the first edited/new call — plus everything after — re-runs live. resume(runId)
// with NO opts stays backward-compatible (uses the persisted script) so #78's
// auto-resume (UsageLimitScheduler calls resume(runId)) is unaffected.

const editResumeScriptV1 = `export const meta = { name: 'edit_resume', description: 'two agents' }
const a = await agent('FIRST', { label: 'first' })
const b = await agent('SECOND-ORIGINAL', { label: 'second' })
return { a, b }`;

/** Runner that records prompts and pauses (usage limit) on the original 2nd prompt. */
function editResumeRunner() {
  const seen: string[] = [];
  const state = { failOriginalSecond: true };
  return {
    seen,
    state,
    runner: {
      async run(prompt: string) {
        seen.push(prompt);
        if (prompt.includes("SECOND-ORIGINAL") && state.failOriginalSecond) {
          throw new WorkflowError("usage limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
            recoverable: false,
            resetHint: "Resets soon",
          });
        }
        return `ran:${prompt}`;
      },
    } as unknown as Pick<WorkflowAgent, "run">,
  };
}

test(
  "resume with an edited script replays the unchanged prefix and re-runs only the edited call",
  withTempCwd(async (cwd) => {
    const { seen, runner } = editResumeRunner();
    const manager = new WorkflowManager({ cwd, agent: runner });
    manager.on("paused", () => {});
    manager.on("error", () => {});

    // First run: agent 1 completes + journals, agent 2 hits a usage limit -> paused.
    const { runId, promise } = manager.startInBackground(editResumeScriptV1);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused", "run pauses on the usage limit");
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.ok((persisted?.journal?.length ?? 0) >= 1, "agent 1 should be journaled");

    // Resume with an EDITED script: agent 1 unchanged, agent 2's prompt changed.
    const editResumeScriptV2 = `export const meta = { name: 'edit_resume', description: 'two agents' }
const a = await agent('FIRST', { label: 'first' })
const b = await agent('SECOND-EDITED', { label: 'second' })
return { a, b }`;

    const seenBeforeResume = seen.length;
    const resumed = await manager.resume(runId, { script: editResumeScriptV2 });
    assert.equal(resumed, true, "resume with edited script should succeed");
    await new Promise((r) => setTimeout(r, 80));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed run completes");
    assert.equal(
      (finalRun?.result?.result as { a?: unknown } | undefined)?.a,
      "ran:FIRST",
      "agent 1 replays its cached journal result",
    );
    assert.equal(
      (finalRun?.result?.result as { b?: unknown } | undefined)?.b,
      "ran:SECOND-EDITED",
      "edited agent 2 re-runs live",
    );

    // Cache proof: during the resume, the runner was NOT called for the unchanged
    // agent 1, and WAS called for the edited agent 2.
    const promptsDuringResume = seen.slice(seenBeforeResume);
    assert.ok(!promptsDuringResume.includes("FIRST"), "unchanged agent 1 replayed from journal, not re-run");
    assert.ok(promptsDuringResume.includes("SECOND-EDITED"), "edited agent 2 ran live");

    // The edited script is persisted, so a later resume sees it.
    const persistedAfter = manager.listRuns().find((r) => r.runId === runId);
    assert.match(persistedAfter?.script ?? "", /SECOND-EDITED/, "edited script is persisted");
  }),
);

test(
  "resume(runId) with no opts uses the persisted script (auto-resume backward-compat)",
  withTempCwd(async (cwd) => {
    const { seen, state, runner } = editResumeRunner();
    const manager = new WorkflowManager({ cwd, agent: runner });
    manager.on("paused", () => {});
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(editResumeScriptV1);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Let the original second prompt succeed on the second attempt, then resume
    // with NO opts — exactly how UsageLimitScheduler calls it.
    state.failOriginalSecond = false;
    const seenBeforeResume = seen.length;
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    await new Promise((r) => setTimeout(r, 80));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed");
    assert.equal(
      (finalRun?.result?.result as { a?: unknown } | undefined)?.a,
      "ran:FIRST",
      "agent 1 still replays from journal",
    );
    assert.equal(
      (finalRun?.result?.result as { b?: unknown } | undefined)?.b,
      "ran:SECOND-ORIGINAL",
      "persisted (unedited) script runs agent 2",
    );

    const promptsDuringResume = seen.slice(seenBeforeResume);
    assert.ok(!promptsDuringResume.includes("FIRST"), "agent 1 replayed from journal");
    assert.ok(promptsDuringResume.includes("SECOND-ORIGINAL"), "persisted script's original agent 2 re-ran");
  }),
);

/** Runner that records prompts and pauses (usage limit) on a third, later call. */
function nestedPauseResumeRunner() {
  const seen: string[] = [];
  const state = { failThird: true };
  return {
    seen,
    state,
    runner: {
      async run(prompt: string) {
        seen.push(prompt);
        if (prompt === "third-call" && state.failThird) {
          throw new WorkflowError("usage limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
            recoverable: false,
            resetHint: "Resets soon",
          });
        }
        return `ran:${prompt}`;
      },
    } as unknown as Pick<WorkflowAgent, "run">,
  };
}

test(
  "manager resume: both a nested child's AND the parent's own index-0 journal entries cache-hit, not re-run live (M6)",
  withTempCwd(async (cwd) => {
    // Regression coverage for the manager-level journal dedup keying. The
    // nested child's agent('inner-call') and the parent's own
    // agent('outer-call') both land at callIndex 0 in their respective
    // frames and BOTH journal successfully during the SAME live execution —
    // this is exactly the shape that collides if managed.journal's dedup
    // filter matched on `index` alone (not `(index, runId)`): whichever of
    // the two journals SECOND would evict the other from managed.journal,
    // so the persisted journal silently ends up with only one of the two
    // entries. A third call then fails (usage limit) to force a pause with
    // that (possibly corrupted) journal on disk, and resume must show BOTH
    // completed calls cache-hitting — not just whichever survived a buggy
    // dedup.
    const { seen, state, runner } = nestedPauseResumeRunner();
    const manager = new WorkflowManager({ cwd, agent: runner });
    manager.on("paused", () => {});
    manager.on("error", () => {});

    const script = `export const meta = { name: 'nested_pause_resume', description: 'nested resume' }
const inner = await workflow(\`
  export const meta = { name: 'nested_pause_resume_inner', description: 'inner' }
  const x = await agent('inner-call', { label: 'inner' })
  return x
\`, {})
const outer = await agent('outer-call', { label: 'outer' })
const third = await agent('third-call', { label: 'third' })
return { inner, outer, third }`;

    // First run: the nested child's index-0 call AND the parent's own
    // index-0 call both complete and journal; the parent's third call hits
    // a usage limit -> run pauses.
    const { runId, promise } = manager.startInBackground(script);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused", "run pauses on the third call's usage limit");
    assert.equal(seen.filter((p) => p === "inner-call").length, 1, "the nested child's agent ran once before pause");
    assert.equal(seen.filter((p) => p === "outer-call").length, 1, "the parent's own agent ran once before pause");

    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(
      persisted?.journal?.length,
      2,
      "BOTH the child's and the parent's completed index-0 calls must be journaled — neither may have evicted the other",
    );

    // Resume: let the third call succeed this time.
    state.failThird = false;
    const seenBeforeResume = seen.length;
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    await new Promise((r) => setTimeout(r, 80));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed run completes");
    assert.equal((finalRun?.result?.result as { inner?: unknown } | undefined)?.inner, "ran:inner-call");
    assert.equal((finalRun?.result?.result as { outer?: unknown } | undefined)?.outer, "ran:outer-call");
    assert.equal((finalRun?.result?.result as { third?: unknown } | undefined)?.third, "ran:third-call");

    const promptsDuringResume = seen.slice(seenBeforeResume);
    assert.ok(
      !promptsDuringResume.includes("inner-call"),
      "the nested child's journaled call must cache-hit on resume, not re-run live",
    );
    assert.ok(
      !promptsDuringResume.includes("outer-call"),
      "the parent's own journaled call must cache-hit on resume, not re-run live",
    );
    assert.ok(promptsDuringResume.includes("third-call"), "the parent's previously-failed third call re-runs live");
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// `runs` map eviction (run-level analog of the subagent memory-retention
// mitigation): terminal runs' in-memory ManagedRun (agents array, journal,
// snapshot) must not accumulate forever, but the navigator/resume must keep
// working against persisted state once a run's in-memory copy is gone.
// ═══════════════════════════════════════════════════════════════════════════

test(
  "completed runs beyond maxTerminalRunsInMemory are evicted from the in-memory map, but stay listable via listRuns()",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent(), maxTerminalRunsInMemory: 2 });
    const runIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await manager.runSync(oneAgentScript);
      assert.ok(result.runId);
      runIds.push(result.runId as string);
    }

    // Only the 2 most recent terminal runs still have a live ManagedRun.
    assert.equal(manager.getRun(runIds[0]), undefined, "oldest completed run's in-memory state is evicted");
    assert.equal(manager.getRun(runIds[1]), undefined, "2nd oldest completed run's in-memory state is evicted");
    assert.ok(manager.getRun(runIds[2]), "3rd run (within the cap) is still in memory");
    assert.ok(manager.getRun(runIds[3]), "most recent run is still in memory");

    // But every run is still reachable via listRuns() (backed by persistence)
    // — eviction from the in-memory map must never mean "the run vanished".
    const listed = manager
      .listRuns()
      .map((r) => r.runId)
      .sort();
    assert.deepEqual(listed, [...runIds].sort(), "all runs remain listable after eviction");
    for (const id of runIds) {
      const persisted = manager.listRuns().find((r) => r.runId === id);
      assert.equal(persisted?.status, "completed");
      assert.equal(persisted?.agents[0]?.status, "done", "persisted agent detail survives eviction too");
    }
  }),
);

test(
  "eviction never removes a running or paused run's in-memory entry, however many terminal runs pile up around it (separate managers, no queue pressure)",
  withTempCwd(async (cwd) => {
    const held = deferredAgent();
    // A dedicated manager for the long-running run so its agent (never
    // resolving until we say so) doesn't block the terminal runs below.
    const runningManager = new WorkflowManager({ cwd, agent: held.runner, maxTerminalRunsInMemory: 1 });
    const { runId: runningId, promise: runningPromise } = runningManager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(runningManager.getRun(runningId)?.status, "running");

    // Pause a second run so it sits in memory as "paused".
    const pausedManager = new WorkflowManager({ cwd, agent: held.runner, maxTerminalRunsInMemory: 1 });
    const { runId: pausedId } = pausedManager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(pausedManager.pause(pausedId), true);
    assert.equal(pausedManager.getRun(pausedId)?.status, "paused");

    // Now complete several terminal runs on a manager with a tiny cap and
    // confirm neither the running nor the paused run's manager evicted them
    // (they're on other manager instances, but exercises the same in-process
    // eviction path with a maximally aggressive cap of 1).
    const busyManager = new WorkflowManager({ cwd, agent: fakeAgent(), maxTerminalRunsInMemory: 1 });
    for (let i = 0; i < 3; i++) {
      await busyManager.runSync(oneAgentScript);
    }

    assert.equal(runningManager.getRun(runningId)?.status, "running", "the running run's entry survives eviction");
    assert.equal(pausedManager.getRun(pausedId)?.status, "paused", "the paused run's entry survives eviction");

    held.resolve();
    await runningPromise.catch(() => {});
  }),
);

test(
  "recordTerminalRun's status re-validation guard: a resumed (live, running) run survives an overflow triggered by its OWN stale queue entry",
  withTempCwd(async (cwd) => {
    // Repro for the guard's necessity (single manager, real queue pressure —
    // unlike the cross-manager test above, which has no queue interaction at
    // all and is structurally unable to catch this class of bug):
    //
    //  1. Run A fails (non-recoverable) -> terminalRunQueue = [A].
    //  2. A is resumed -> a FRESH, live ManagedRun replaces the map entry for
    //     "A" (status "running"), but the STALE "A" queue entry from step 1
    //     is still sitting at the front of terminalRunQueue.
    //  3. Run B terminates -> recordTerminalRun("B") pushes the queue over
    //     maxTerminalRunsInMemory (1), so it shifts the front — the STALE "A"
    //     entry — and must decide whether to evict.
    //
    // Without the guard (evict unconditionally on shift), the LIVE, still-
    // running resumed run A is deleted from `runs` — its eventual settle
    // then fails isCurrent(), silently skipping the final persist AND lease
    // release (run stuck "running" on disk forever, lease leaked). With the
    // guard, recordTerminalRun() re-reads the CURRENT entry for "A" at
    // eviction time, sees status "running" (not terminal), and skips it.
    let aAttempts = 0;
    let resolveHang: ((v: unknown) => void) | undefined;
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
        if (prompt === "A1") {
          aAttempts++;
          if (aAttempts === 1) {
            throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
              recoverable: false,
            });
          }
          // Second attempt (post-resume): hang so A stays "running" in
          // memory while B's overflow fires — exactly the window the bug
          // needs to matter.
          return new Promise((resolve) => {
            resolveHang = resolve;
          });
        }
        options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "ok";
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent, maxTerminalRunsInMemory: 1 });
    manager.on("error", () => {});

    const scriptA = `export const meta = { name: 'run_a', description: 'a' }
const a = await agent('A1', { label: 'a' })
return { a }`;
    const scriptB = `export const meta = { name: 'run_b', description: 'b' }
const b = await agent('B1', { label: 'b' })
return { b }`;

    // 1. A fails -> enqueued (terminal), still evictable in principle.
    const { runId: runAId, promise: aPromise } = manager.startInBackground(scriptA);
    await aPromise.catch(() => {});
    assert.equal(manager.getRun(runAId)?.status, "failed");

    // 2. Resume A: a fresh, live ManagedRun replaces the map entry; the old
    // queue entry for "A" is now stale (still at the front of the queue).
    const resumed = await manager.resume(runAId);
    assert.equal(resumed, true);
    assert.equal(manager.getRun(runAId)?.status, "running", "resumed run A is live and running (hung on attempt 2)");

    // 3. B terminates -> overflows the cap (1), shifting the stale "A" entry.
    const { promise: bPromise } = manager.startInBackground(scriptB);
    await bPromise.catch(() => {});

    // The guard must have refused to evict the LIVE, running resumed A.
    assert.ok(manager.getRun(runAId), "the guard must protect the live resumed run A from its own stale queue entry");
    assert.equal(manager.getRun(runAId)?.status, "running");

    // Clean up the hung agent so nothing keeps the process alive, and prove
    // the surviving entry settles normally afterward.
    resolveHang?.("done");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(manager.getRun(runAId)?.status, "completed", "the protected entry still settles correctly");
  }),
);

test(
  "paused-exclusion in executeRun's catch tail: a usage-limit pause must never create eviction pressure on an unrelated, genuinely-terminal run",
  withTempCwd(async (cwd) => {
    // A separate repro from the one above: here the mutation under test is
    // the catch tail's `if (IN_MEMORY_TERMINAL_STATUSES.has(managed.status))`
    // gate around recordTerminalRun() — NOT the guard inside recordTerminalRun
    // itself. Reached via the usage-limit branch (not manual pause()), which
    // is a distinct code path through executeRun's catch tail.
    //
    // Sequence with maxTerminalRunsInMemory 1:
    //  1. T completes -> terminalRunQueue = [T], within the cap.
    //  2. P pauses on a usage limit. If the catch tail's paused-exclusion gate
    //     were removed, this would ALSO call recordTerminalRun("P"), pushing
    //     the queue to [T, P] — over the cap — and evicting the FRONT entry,
    //     T, purely because P paused (T is genuinely terminal so the
    //     recordTerminalRun-internal guard would not save it). With the gate,
    //     a paused settle never enqueues at all, so T is never touched.
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
        if (prompt === "P1") {
          throw new WorkflowError(
            "Codex usage limit reached (plus plan). Resets in ~3h.",
            WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
            { recoverable: false, resetHint: "Resets in ~3h" },
          );
        }
        options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "ok";
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent, maxTerminalRunsInMemory: 1 });
    manager.on("error", () => {});
    manager.on("paused", () => {});

    const scriptT = `export const meta = { name: 'run_t', description: 't' }
const t = await agent('T1', { label: 't' })
return { t }`;
    const scriptP = `export const meta = { name: 'run_p', description: 'p' }
const p = await agent('P1', { label: 'p' })
return { p }`;

    const t = await manager.runSync(scriptT);
    const tId = t.runId as string;
    assert.equal(manager.getRun(tId)?.status, "completed");

    const { runId: pId, promise: pPromise } = manager.startInBackground(scriptP);
    await pPromise.catch(() => {});
    assert.equal(manager.getRun(pId)?.status, "paused");

    assert.ok(manager.getRun(tId), "T must survive — a paused settle must never count against the terminal-run cap");
  }),
);

test(
  "resume() succeeds for a run whose in-memory ManagedRun was already evicted (reads persisted state, not the map)",
  withTempCwd(async (cwd) => {
    // A non-recoverable WorkflowError propagates all the way up (unlike a
    // plain agent error, which workflow.ts swallows per-agent and the run
    // still completes) — this settles the run to "failed" (evictable and,
    // per WorkflowManager.resume()'s status guard, still resumable).
    const failingAgent = {
      async run() {
        throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
      },
    };
    const manager = new WorkflowManager({ cwd, agent: failingAgent, maxTerminalRunsInMemory: 1 });
    manager.on("error", () => {});

    const first = await manager.runSync(oneAgentScript).catch((e) => e);
    void first;
    const evictedRunId = manager.listRuns()[0]?.runId as string;

    // Push it out of the in-memory cap with more failing runs.
    for (let i = 0; i < 2; i++) {
      await manager.runSync(oneAgentScript).catch(() => {});
    }
    assert.equal(manager.getRun(evictedRunId), undefined, "the run's in-memory entry has been evicted");

    // Fix the agent so the resumed attempt succeeds, then resume the evicted run.
    const succeedingAgent = fakeAgent();
    const manager2 = new WorkflowManager({ cwd, agent: succeedingAgent, maxTerminalRunsInMemory: 1 });
    const resumed = await manager2.resume(evictedRunId);
    assert.equal(resumed, true, "resume works purely from persisted state even though the in-memory copy is gone");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(manager2.listRuns().find((r) => r.runId === evictedRunId)?.status, "completed");
  }),
);

test(
  "stop() on an already-paused run marks it eviction-eligible (its own executeRun tail already settled at pause time, so no future tail ever will)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner, maxTerminalRunsInMemory: 1 });
    manager.on("error", () => {});

    const { runId: pausedId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(manager.pause(pausedId), true);
    assert.equal(manager.getRun(pausedId)?.status, "paused");

    // Let pause()'s abort-triggered executeRun() tail fully settle BEFORE
    // stopping — the realistic case the fix targets. By now the run's only
    // executeRun() promise has already resolved once (as "paused", which is
    // deliberately NOT enqueued for eviction — see IN_MEMORY_TERMINAL_STATUSES),
    // so nothing will ever call recordTerminalRun() for it again except
    // stop() itself.
    da.resolve("done");
    await promise.catch(() => {});
    assert.equal(manager.getRun(pausedId)?.status, "paused", "still paused; the already-settled tail didn't change it");

    assert.equal(manager.stop(pausedId), true);
    assert.equal(manager.getRun(pausedId)?.status, "aborted");

    // One more terminal run overflows the cap (1): the stopped run must be
    // the one evicted — proving stop() itself recorded it terminal-eligible
    // (without that, it would sit in `runs` forever: no pending tail left to
    // ever call recordTerminalRun() for it).
    const other = await manager.runSync(oneAgentScript);
    assert.ok(other.runId, "a completed run carries its runId");
    assert.ok(manager.getRun(other.runId), "the newest terminal run is in memory");
    assert.equal(
      manager.getRun(pausedId),
      undefined,
      "stop() must have recorded the already-settled paused run as terminal-eligible, so it's evicted here",
    );
  }),
);

/** Agent whose first invocation for a given label throws a recoverable error
 * (retries exhausted -> null), then succeeds on every later call. */
function failOnceForLabel(label: string, message = "boom: recoverable failure") {
  let failed = false;
  return {
    async run(_prompt: string, options?: { label?: string; onUsage?: (u: AgentUsage) => void }) {
      options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      if (options?.label === label && !failed) {
        failed = true;
        throw new Error(message);
      }
      return "ok";
    },
  } as unknown as Pick<WorkflowAgent, "run">;
}

const parallelAbsorbScript = `export const meta = { name: 'parallel_absorb', description: 'one parallel item fails' }
phase('Fan')
const r = await parallel([() => agent('a', { label: 'a' }), () => agent('b', { label: 'b' })])
return { r }`;

test(
  "failOnExhaustedAgent (default lenient): a failing agent completes with a visible failedAgents entry",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: failOnceForLabel("a") });
    const result = await manager.runSync(oneAgentScript, undefined, { failOnExhaustedAgent: false });
    assert.equal(result.agentCount, 1);
    assert.equal((result.result as { a: unknown }).a, null, "the exhausted agent returns null to the script");
    assert.equal(result.failedAgents?.length, 1, "the failed agent is reported on the result");
    assert.equal(result.failedAgents?.[0].label, "a");
    assert.equal(manager.listRuns()[0].status, "completed", "lenient runs still complete");
  }),
);

test(
  "failOnExhaustedAgent (strict): a failing agent settles the run FAILED and a resume re-runs only the failed call",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: failOnceForLabel("a") });
    const { runId, promise } = manager.startInBackground(oneAgentScript, undefined, {
      failOnExhaustedAgent: true,
    });
    await assert.rejects(promise, (err: unknown) => {
      assert.equal((err as { code?: string }).code, WorkflowErrorCode.AGENT_EXHAUSTED);
      assert.equal((err as { recoverable?: boolean }).recoverable, false);
      assert.match((err as Error).message, /agent\(s\) exhausted retries/);
      return true;
    });
    const settled = manager.getPersistence().load(runId);
    assert.equal(settled?.status, "failed", "strict failure settles failed (journal preserved, resumable)");

    // Resume the SAME script: the failed call re-runs live (failOnceForLabel
    // already consumed its one failure) and the run completes.
    assert.equal(await manager.resume(runId, { script: oneAgentScript }), true);
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const resumed = manager.getPersistence().load(runId);
    assert.equal(resumed?.status, "completed", "resume after AGENT_EXHAUSTED completes");
    assert.equal(resumed?.agents[0]?.result, "ok", "the previously failed agent produced a real result");
  }),
);

test(
  "failOnExhaustedAgent (strict) is frozen at run start: a resume cannot downgrade it",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: failOnceForLabel("a") });
    const { runId, promise } = manager.startInBackground(oneAgentScript, undefined, {
      failOnExhaustedAgent: true,
    });
    await assert.rejects(promise, (err: unknown) => {
      assert.equal((err as { code?: string }).code, WorkflowErrorCode.AGENT_EXHAUSTED);
      return true;
    });
    // Resume with an explicit downgrade attempt — the frozen start-time value
    // must win, so the run stays strict and still fails (failOnceForLabel has
    // consumed its failure though, so this run actually succeeds... assert the
    // FLAG is carried instead by checking the persisted value).
    const persisted = manager.getPersistence().load(runId);
    assert.equal(persisted?.failOnExhaustedAgent, true, "the flag is persisted with the run");
    assert.equal(await manager.resume(runId, { script: oneAgentScript, failOnExhaustedAgent: false }), true);
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(manager.getPersistence().load(runId)?.failOnExhaustedAgent, true);
  }),
);

test(
  "failOnExhaustedAgent (strict): a parallel()-absorbed failure fails the run instead of a silent null item",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: failOnceForLabel("b") });
    const { runId, promise } = manager.startInBackground(parallelAbsorbScript, undefined, {
      failOnExhaustedAgent: true,
    });
    await assert.rejects(promise, (err: unknown) => {
      assert.equal((err as { code?: string }).code, WorkflowErrorCode.AGENT_EXHAUSTED);
      assert.match((err as Error).message, /b \(AGENT_EXECUTION_ERROR\)/);
      return true;
    });
    assert.equal(manager.getPersistence().load(runId)?.status, "failed");
  }),
);

test(
  "provider 503: an agent outage checkpoints the run as PAUSED (provider_overloaded), not failed",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(_prompt: string, options?: { label?: string; onUsage?: (u: AgentUsage) => void }) {
          options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
          throw new Error("503 status code (no body)");
        },
      },
    });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript, undefined, {
      agentRetries: 2,
      retryBackoffMs: 0,
    });
    await assert.rejects(promise, (err: unknown) => {
      assert.equal((err as { code?: string }).code, WorkflowErrorCode.PROVIDER_OVERLOADED);
      assert.equal((err as { recoverable?: boolean }).recoverable, false);
      return true;
    });
    const settled = manager.getPersistence().load(runId);
    assert.equal(settled?.status, "paused", "an outage checkpoints the run (resumable) instead of failing it");
    assert.equal(settled?.pauseReason, "provider_overloaded");
  }),
);

test(
  "provider 500: an exhausted transient outage surfaces PROVIDER_UNAVAILABLE in the failure text",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(_prompt: string, options?: { label?: string; onUsage?: (u: AgentUsage) => void }) {
          options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
          throw new Error("500 status code (no body)");
        },
      },
    });
    const result = await manager.runSync(oneAgentScript, undefined, { agentRetries: 0, retryBackoffMs: 0 });
    assert.equal(result.agentCount, 1);
    assert.equal((result.result as { a: unknown }).a, null, "the exhausted agent returns null to the script");
    assert.equal(result.failedAgents?.length, 1);
    assert.equal(result.failedAgents?.[0].errorCode, WorkflowErrorCode.PROVIDER_UNAVAILABLE);
    assert.match(result.failedAgents?.[0].error ?? "", /500 status code \(no body\)/);
  }),
);
