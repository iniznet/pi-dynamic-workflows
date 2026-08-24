import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkflowAgent } from "../src/agent.js";
import {
  buildResumeJournal,
  createRunPersistence,
  journalEntryKey,
  keepsResumeJournal,
  type PersistedRunState,
  redactText,
  upsertJournalEntry,
} from "../src/run-persistence.js";
import type { JournalEntry } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { rmForce } from "./helpers/rm-force.js";

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
      await rmForce(cwd, fakeHome);
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
    // Resolve any outstanding calls as they appear while polling for the
    // terminal state: the resumed execution's live agent-2 call index is not
    // fixed (the paused original had already spawned its own), so a single
    // fixed resolve loop can no-op if the call is created late under load, and
    // the settle path's wall time varies — a fixed sleep flaked under cap-2.
    // Repeated resolves are no-ops for settled/not-yet-created indexes.
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      for (let j = 1; j < 8; j++) da.resolve(j, "done");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

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

// ═══════════════════════════════════════════════════════════════════════════
// D-03 (slice runtime-opt) — single-pass redacting serializer
//
// serializeRedacted used to probe the serialized form for a '.' (a JWT hint)
// and, on ANY period in prose, fall into a parse + deep-walk + re-stringify
// round trip — i.e. nearly every write with real agent prose. It now applies
// redactText inline through JSON.stringify's replacer: one pass, byte-stable,
// idempotent, and prose with '.'/'@' is never touched.
// ═══════════════════════════════════════════════════════════════════════════

const D03_PROSE = "The quick brown fox. It jumped over @ the lazy dog's fence. No secrets here.";
const D03_SK_KEY = "sk-abcDEF1234567890";
const D03_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

function d03State(runId: string, status: PersistedRunState["status"] = "completed"): PersistedRunState {
  return {
    runId,
    workflowName: "wf",
    script: "export const meta = { name: 'w', description: 'w' }",
    status,
    phases: [],
    agents: [],
    logs: [],
    startedAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    journal: [
      { index: 0, runId, hash: "h", result: `env: OPENAI_API_KEY=${D03_SK_KEY}` },
      { index: 1, runId, hash: "h", result: D03_SK_KEY },
      { index: 2, runId, hash: "h", result: D03_JWT },
      { index: 3, runId, hash: "h", result: D03_PROSE },
    ],
  };
}

test("D-03: persisted secrets are redacted; prose with '.'/'@' is preserved byte-for-byte; re-saves are byte-identical", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-d03-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-d03-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const rp = createRunPersistence(cwd);
      const state = d03State("d03-golden");
      rp.save(state);
      const path = join(workflowProjectPaths(cwd).runsDir, "d03-golden.json");
      const first = readFileSync(path, "utf-8");

      // The sensitive payload must be scrubbed in the persisted bytes.
      assert.ok(first.includes("[REDACTED]"), "the persisted form must contain redaction markers");
      assert.ok(!first.includes(D03_SK_KEY), "the provider key must not appear in the persisted bytes");
      assert.ok(!first.includes(D03_JWT), "the JWT must not appear in the persisted bytes");
      assert.ok(!first.includes("OPENAI_API_KEY=sk-"), "the KEY=value assignment must not survive");
      assert.ok(
        first.includes(`"OPENAI_API_KEY=[REDACTED]"`) || first.includes(`OPENAI_API_KEY=[REDACTED]`),
        "the KEY=value pair is redacted in place (scanner rule)",
      );

      // Prose containing '.' and '@' must pass through untouched.
      assert.ok(
        first.includes(D03_PROSE),
        "prose with periods and @ must be persisted byte-for-byte (the old '.' probe misfired here)",
      );

      // Golden byte-stability: a second save of the same state yields the same
      // redacted payload bytes. The only permitted drift is the manager's
      // per-write `updatedAt` timestamp (casWrite stamps now() on every save),
      // so the comparison normalizes that single field — everything else,
      // including every redaction decision, must be byte-identical.
      rp.save(state);
      const second = readFileSync(path, "utf-8");
      const stripUpdatedAt = (raw: string) => raw.replace(/"updatedAt": "[^"]*"/, '"updatedAt": "<ts>"');
      assert.equal(
        stripUpdatedAt(second),
        stripUpdatedAt(first),
        "re-saving the same state must produce byte-identical persisted output (modulo the per-write updatedAt stamp)",
      );
    });
  } finally {
    await rmForce(cwd, fakeHome);
  }
});

test("D-03: redactText is idempotent and a no-op on prose with '.'/'@'", () => {
  assert.equal(redactText(D03_PROSE), D03_PROSE, "prose is never redacted");
  assert.equal(redactText(`OPENAI_API_KEY=${D03_SK_KEY}`), "OPENAI_API_KEY=[REDACTED]");
  // Idempotency — the 'before/after' byte-stability contract at the unit level.
  for (const sample of [D03_PROSE, D03_SK_KEY, D03_JWT, `OPENAI_API_KEY=${D03_SK_KEY}`]) {
    const once = redactText(sample);
    assert.equal(redactText(once), once, `redaction is idempotent for: ${sample}`);
  }
});
