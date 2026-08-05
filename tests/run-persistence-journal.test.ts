import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkflowAgent } from "../src/agent.js";
import { buildResumeJournal, journalEntryKey, keepsResumeJournal, upsertJournalEntry } from "../src/run-persistence.js";
import type { JournalEntry } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/**
 * P2-4 extraction tests: the journal-persistence helpers that moved OUT of
 * workflow-manager.ts INTO run-persistence.ts, and the runtime behavior of
 * the "lease ⟺ executing" invariant that the ManagedRun discriminated union
 * now types.
 */

function entry(index: number, runId: string | undefined, result: unknown): JournalEntry {
  return { index, runId, hash: `h-${runId ?? "root"}-${index}`, result };
}

// ─── journalEntryKey ──────────────────────────────────────────────────────────

test("journalEntryKey namespaces a call index by its frame runId", () => {
  assert.equal(journalEntryKey("run-1", 0), "run-1:0");
  assert.equal(journalEntryKey("run-1", 42), "run-1:42");
  assert.equal(journalEntryKey("run-1-nested1", 0), "run-1-nested1:0");
  assert.notEqual(journalEntryKey("run-1", 0), journalEntryKey("run-1-nested1", 0));
});

// ─── upsertJournalEntry ───────────────────────────────────────────────────────

test("upsertJournalEntry appends a new (runId, index) entry", () => {
  const journal = upsertJournalEntry([], entry(0, undefined, "a"));
  const journal2 = upsertJournalEntry(journal, entry(1, undefined, "b"));
  assert.deepEqual(
    journal2.map((e) => e.result),
    ["a", "b"],
  );
});

test("upsertJournalEntry replaces the previous entry for the same (runId, index)", () => {
  let journal = upsertJournalEntry([], entry(0, undefined, "stale"));
  journal = upsertJournalEntry(journal, entry(0, undefined, "fresh"));
  assert.equal(journal.length, 1, "same (runId, index) must dedupe to one entry");
  assert.equal(journal[0]?.result, "fresh", "the latest entry wins");
});

test("upsertJournalEntry keeps a parent and nested child's index-0 entries separate", () => {
  const parent = entry(0, "run-1", "parent-result");
  const child = entry(0, "run-1-nested1", "child-result");
  const journal = upsertJournalEntry(upsertJournalEntry([], parent), child);
  assert.equal(journal.length, 2, "index collision across frames must NOT dedupe");
  assert.deepEqual(new Set(journal.map((e) => e.result)), new Set(["parent-result", "child-result"]));
});

test("upsertJournalEntry does not mutate the input journal", () => {
  const input = [entry(0, undefined, "a")];
  upsertJournalEntry(input, entry(0, undefined, "b"));
  assert.equal(input.length, 1, "the caller's array is untouched (returns a new one)");
});

// ─── buildResumeJournal ───────────────────────────────────────────────────────

test("buildResumeJournal keys entries as '<frameRunId>:<index>'", () => {
  const map = buildResumeJournal("run-1", [entry(0, "run-1", "a"), entry(0, "run-1-nested1", "b")]);
  assert.equal(map.get("run-1:0")?.result, "a");
  assert.equal(map.get("run-1-nested1:0")?.result, "b");
});

test("buildResumeJournal maps legacy entries (no runId) to the run's own frame", () => {
  const legacy = entry(2, undefined, "legacy-result");
  const map = buildResumeJournal("run-1", [legacy]);
  assert.equal(map.get("run-1:2")?.result, "legacy-result", "legacy entries resume-hit for the top-level frame");
});

test("buildResumeJournal treats undefined journal as empty", () => {
  const map = buildResumeJournal("run-1", undefined);
  assert.equal(map.size, 0);
});

test("buildResumeJournal preserves entry identity (replay results by reference)", () => {
  const journalEntry = entry(1, "run-1", { deep: { value: 1 } });
  const map = buildResumeJournal("run-1", [journalEntry]);
  assert.equal(map.get("run-1:1"), journalEntry, "the replay map holds the same entry object");
});

// ─── keepsResumeJournal ───────────────────────────────────────────────────────

test("keepsResumeJournal: resumable statuses keep their journal; completed/aborted drop it", () => {
  assert.equal(keepsResumeJournal("running"), true);
  assert.equal(keepsResumeJournal("pending"), true);
  assert.equal(keepsResumeJournal("paused"), true);
  assert.equal(keepsResumeJournal("failed"), true);
  assert.equal(keepsResumeJournal("completed"), false);
  assert.equal(keepsResumeJournal("aborted"), false);
});

// ─── lease ⟺ executing invariant (runtime view of the typed union) ───────────

const oneAgentScript = `export const meta = { name: 'invariant_demo', description: 'lease invariant' }
const a = await agent('do it', { label: 'a' })
return { a }`;

/** Agent runner with PER-CALL deferred promises (each run() hangs until its own resolve). */
function perCallDeferredAgent() {
  const resolves: Array<(value: unknown) => void> = [];
  let callIdx = 0;
  return {
    resolve: (idx: number, value: unknown = "done") => resolves[idx]?.(value),
    runner: {
      async run() {
        const idx = callIdx++;
        return new Promise((resolve) => {
          resolves[idx] = resolve;
        });
      },
    } as unknown as Pick<WorkflowAgent, "run">,
  };
}

/** Run each manager test with isolated cwd and HOME so workflow state is isolated. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-lease-"));
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
  "while a run is executing it holds its lease; every resting status has none (the typed invariant, observed live)",
  withTempCwd(async (cwd) => {
    const da = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Executing: the run is leased (status "running" ⟺ lease held).
    const executing = manager.getRun(runId);
    assert.equal(executing?.status, "running");
    assert.ok(executing && "lease" in executing && executing.lease, "executing run must hold its lease");
    // The lease is the real cross-process token on disk — a second manager
    // cannot acquire it while the first is executing.
    const pers = manager.getPersistence();
    assert.equal(pers.acquireRunLease(runId), null, "the live lease must block a second acquirer");

    // Pause: idle — lease released, and the lock file is free again.
    manager.pause(runId);
    const paused = manager.getRun(runId);
    assert.equal(paused?.status, "paused");
    assert.ok(paused && !("lease" in paused && paused.lease !== undefined), "idle run must not hold its lease");
    const reacquired = pers.acquireRunLease(runId);
    assert.ok(reacquired, "paused (idle) run's lease is released — reacquirable");
    if (reacquired) pers.releaseRunLease(reacquired);

    da.resolve(0);
    await promise.catch(() => {});
  }),
);

test(
  "completed runs release their lease: the persisted state is terminal and the lock is free",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          return "ok";
        },
      } as unknown as Pick<WorkflowAgent, "run">,
    });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise;
    assert.equal(manager.getRun(runId)?.status, "completed");
    const run = manager.getRun(runId);
    assert.ok(run && !("lease" in run && run.lease !== undefined), "completed run must not hold its lease");
    const lease = manager.getPersistence().acquireRunLease(runId);
    assert.ok(lease, "completed run's lease is released — another process may take over the runId");
    if (lease) manager.getPersistence().releaseRunLease(lease);
  }),
);

test(
  "the manager's journal dedup and resume replay route through the extracted helpers",
  withTempCwd(async (cwd) => {
    // A two-agent script: agent 1 completes (journaled via upsertJournalEntry),
    // the run pauses, then resume() replays the journal (built via
    // buildResumeJournal) and runs agent 2 live.
    const da = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const twoAgentScript = `export const meta = { name: 'replay_demo', description: 'two agents' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;
    const { runId, promise: origPromise } = manager.startInBackground(twoAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    da.resolve(0, "first-result");
    await new Promise((r) => setTimeout(r, 30));

    const paused = manager.pause(runId);
    assert.equal(paused, true);
    const persisted = manager.getPersistence().load(runId);
    assert.ok((persisted?.journal?.length ?? 0) >= 1, "agent 1's result must be journaled (upsert helper)");

    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    // The resumed execution replays agent 1 from the journal and starts agent 2
    // live. (The paused original execution had already spawned its own agent-2
    // call, so the live call's index is not fixed — resolve any outstanding
    // calls; no-ops for indexes that were never created.)
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 1; i < 6; i++) da.resolve(i, "done");
    await new Promise((r) => setTimeout(r, 50));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed");
    assert.equal(
      (finalRun?.result as { result?: { a?: string; b?: string } })?.result?.a,
      "first-result",
      "agent 1 replayed from the resume journal",
    );
    assert.equal(
      (finalRun?.result as { result?: { a?: string; b?: string } })?.result?.b,
      "done",
      "agent 2 ran live after resume",
    );
    await origPromise.catch(() => {});
  }),
);
