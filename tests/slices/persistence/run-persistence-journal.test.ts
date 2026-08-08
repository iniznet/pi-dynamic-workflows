import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  capJournalBudget,
  cleanupRun,
  createRunPersistence,
  DEFAULT_JOURNAL_BYTE_BUDGET,
  DEFAULT_JOURNAL_DELTA_CHECKPOINT_BYTES,
  JOURNAL_DELTA_SUFFIX,
  listActiveRuns,
  loadRunState,
  MAX_JOURNAL_ENTRIES,
  type PersistedRunState,
  type RunCheckpoint,
  redactText,
  resumeRun,
  saveCheckpoint,
  updateRunState,
  upsertJournalEntry,
} from "../../../src/run-persistence.js";
import { workflowProjectPaths } from "../../../src/workflow-paths.js";
import { withFakeHomeAsync } from "../../helpers/fake-home.js";
import { rmForce } from "../../helpers/rm-force.js";

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-rp-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      await rmForce(cwd, fakeHome);
    }
  };
}

function baseRunState(
  runId: string,
  updatedAt = "2024-01-01T00:00:00.000Z",
  status: PersistedRunState["status"] = "completed",
): PersistedRunState {
  return {
    runId,
    workflowName: "wf",
    script: "export const meta = { name: 'w', description: 'w' }",
    status,
    phases: [],
    agents: [],
    logs: [],
    startedAt: updatedAt,
    updatedAt,
  };
}

// ─── P0-4: saveCheckpoint must not pollute the resume journal ────────────────

test(
  "saveCheckpoint appends to checkpoints[] and leaves the resume journal untouched (no fake hash entry)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "p0-4-journal";
    const seededJournal = [
      { index: 0, runId, hash: "real-call-hash-1", result: { reply: "first" } },
      { index: 1, runId, hash: "real-call-hash-2", result: { reply: "second" } },
    ];
    rp.save({
      runId,
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      journal: seededJournal,
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const checkpoint: RunCheckpoint = {
      runId,
      taskId: "approve-plan",
      status: "completed",
      worktreePath: "/tmp/worktree",
      branch: "plan-approval",
      output: "approved",
      timestamp: "2024-01-01T00:05:00.000Z",
    };
    await saveCheckpoint(runId, checkpoint, cwd);

    const raw = rp.load(runId);
    assert.deepEqual(
      raw?.journal,
      seededJournal,
      "the resume journal must be unchanged — a checkpoint must never add an entry the resume path could replay as a cache hit",
    );
    assert.equal(raw?.journal?.length, 2, "no fake hash entry may be appended");
    assert.deepEqual(raw?.checkpoints, [checkpoint], "the checkpoint lands in checkpoints[]");

    // Round-trip through the exported reader.
    const state = await loadRunState(runId, cwd);
    assert.equal(state?.status, "active", "a paused run maps to checkpoint-state 'active'");
    assert.deepEqual(state?.checkpoints, [checkpoint], "checkpoint round-trips via loadRunState");
    assert.equal(state?.checkpoints[0].taskId, "approve-plan");
    assert.equal(state?.checkpoints[0].branch, "plan-approval");

    // listActiveRuns (paused run) reads from checkpoints[] too.
    const active = await listActiveRuns(cwd);
    assert.equal(active.length, 1);
    assert.deepEqual(active[0].checkpoints, [checkpoint]);
  }),
);

test(
  "saveCheckpoint dedupes by taskId and keeps checkpoints in first-seen order",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "p0-4-dedupe";
    rp.save({
      runId,
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "running",
      phases: [],
      agents: [],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const mk = (taskId: string, timestamp: string): RunCheckpoint => ({
      runId,
      taskId,
      status: "active",
      timestamp,
    });
    await saveCheckpoint(runId, mk("t1", "2024-01-01T00:01:00.000Z"), cwd);
    await saveCheckpoint(runId, mk("t2", "2024-01-01T00:02:00.000Z"), cwd);
    // Re-saving t1 must update in place, not append a duplicate at the end.
    await saveCheckpoint(runId, mk("t1", "2024-01-01T00:03:00.000Z"), cwd);

    const state = await loadRunState(runId, cwd);
    assert.equal(state?.checkpoints.length, 2, "re-saving an existing taskId must not duplicate it");
    assert.deepEqual(
      state?.checkpoints.map((c) => c.taskId),
      ["t1", "t2"],
      "checkpoints keep their first-seen order after an in-place update",
    );
    assert.equal(
      state?.checkpoints[0].timestamp,
      "2024-01-01T00:03:00.000Z",
      "the updated checkpoint replaces the old one in place",
    );
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// CAS single-writer persistence (core-orchestration:f3 / i2)
// ═══════════════════════════════════════════════════════════════════════════

test(
  "updateRunState applies a mutation to the freshest snapshot and persists atomically (no leftover .tmp)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "cas-basic";
    rp.save({
      ...baseRunState(runId, "2024-01-01T00:00:00.000Z", "paused"),
      journal: [{ index: 0, runId, hash: "h0", result: "cached" }],
    });
    const final = await updateRunState(
      runId,
      (s) => {
        s.status = "running";
      },
      cwd,
    );
    assert.equal(final?.status, "running");
    const loaded = rp.load(runId);
    assert.equal(loaded?.status, "running");
    assert.deepEqual(
      loaded?.journal,
      [{ index: 0, runId, hash: "h0", result: "cached" }],
      "the mutation must not clobber the journal",
    );
    assert.equal(
      existsSync(join(workflowProjectPaths(cwd).runsDir, `${runId}.json.tmp`)),
      false,
      "the CAS write is atomic — no leftover .tmp",
    );
  }),
);

test(
  "updateRunState returns null for a missing run and creates no file",
  withTempCwd(async (cwd) => {
    const result = await updateRunState(
      "ghost",
      (s) => {
        s.status = "running";
      },
      cwd,
    );
    assert.equal(result, null);
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "ghost.json")), false);
  }),
);

test(
  "concurrent writers (journaling + checkpointing) never lose each other's data: a stale checkpoint save preserves the journal",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "cas-race-journal";
    rp.save({ ...baseRunState(runId, "2024-01-01T00:00:00.000Z", "running") });

    // Writer B (checkpoint saver) captures a stale snapshot BEFORE A journals.
    const staleB = rp.load(runId);
    assert.ok(staleB, "B's snapshot exists");
    assert.equal(staleB.journal?.length, undefined, "B's snapshot predates A's journal entry");
    const checkpoint: RunCheckpoint = {
      runId,
      taskId: "approve-plan",
      status: "completed",
      timestamp: "2024-01-01T00:02:00.000Z",
    };

    // Writer A (the manager) journals an entry — this is the freshest state.
    await updateRunState(
      runId,
      (s) => {
        s.journal = upsertJournalEntry(s.journal ?? [], { index: 0, runId, hash: "h-journaled", result: "journaled" });
      },
      cwd,
    );

    await saveCheckpoint(runId, checkpoint, cwd);

    // B now persists its stale snapshot: the CAS merge must re-read the
    // freshest file and keep A's journal entry instead of erasing it.
    rp.save({ ...staleB, checkpoints: [checkpoint] });

    const final = rp.load(runId);
    assert.equal(final?.journal?.[0]?.result, "journaled", "the journaling writer's entry survives B's stale save");
    assert.deepEqual(final?.checkpoints, [checkpoint], "B's checkpoint is present");
  }),
);

test(
  "concurrent writers never lose each other's data: a stale journaling save preserves the checkpoint",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "cas-race-checkpoint";
    rp.save({ ...baseRunState(runId, "2024-01-01T00:00:00.000Z", "running") });

    // Writer A (the manager) captures a stale snapshot BEFORE B's checkpoint.
    const staleA = rp.load(runId);
    assert.ok(staleA, "A's snapshot exists");
    assert.equal(staleA.checkpoints, undefined, "A's snapshot predates B's checkpoint");

    // Writer B saves a checkpoint first (fresh CAS read).
    const checkpoint: RunCheckpoint = {
      runId,
      taskId: "approve-plan",
      status: "completed",
      timestamp: "2024-01-01T00:01:00.000Z",
    };
    await saveCheckpoint(runId, checkpoint, cwd);

    // A journals an entry (fresh CAS read), then persists its stale snapshot.
    await updateRunState(
      runId,
      (s) => {
        s.journal = upsertJournalEntry(s.journal ?? [], { index: 0, runId, hash: "h-journaled", result: "journaled" });
      },
      cwd,
    );
    rp.save({ ...staleA, journal: [{ index: 0, runId, hash: "h-stale", result: "stale" }] });

    const final = rp.load(runId);
    assert.deepEqual(final?.checkpoints, [checkpoint], "the checkpoint writer's data survives A's stale save");
    assert.equal(final?.journal?.length, 1, "A's journal entry survives");
    assert.equal(final?.journal?.[0]?.result, "stale", "the journaling writer's own entry wins its key");
  }),
);

test(
  "a manager-style full snapshot save never erases disk checkpoints (save() carries them into the write)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "cas-checkpoints-survive";
    rp.save({ ...baseRunState(runId, "2024-01-01T00:00:00.000Z", "running") });

    const checkpoint: RunCheckpoint = {
      runId,
      taskId: "approve-plan",
      status: "completed",
      timestamp: "2024-01-01T00:01:00.000Z",
    };
    await saveCheckpoint(runId, checkpoint, cwd);

    // The manager's writeRunToDisk save object carries NO checkpoints field —
    // save() must merge the disk list instead of dropping it.
    rp.save({
      ...baseRunState(runId, "2024-01-01T00:02:00.000Z", "paused"),
      journal: [{ index: 0, runId, hash: "h0", result: "cached" }],
    });
    const final = rp.load(runId);
    assert.deepEqual(final?.checkpoints, [checkpoint], "manager persists keep the checkpoint");
    assert.equal(final?.journal?.[0]?.result, "cached");
  }),
);

test(
  "concurrent updateRunState appends all land (no lost updates under real fs)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "cas-stress";
    rp.save({ ...baseRunState(runId, "2024-01-01T00:00:00.000Z", "running") });

    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        updateRunState(
          runId,
          (s) => {
            s.journal = upsertJournalEntry(s.journal ?? [], { index: i, runId, hash: `h${i}`, result: `r${i}` });
          },
          cwd,
        ),
      ),
    );
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        saveCheckpoint(
          runId,
          { runId, taskId: `t${i}`, status: "completed", timestamp: `2024-01-01T00:0${i}:00.000Z` },
          cwd,
        ),
      ),
    );

    const final = rp.load(runId);
    assert.equal(final?.journal?.length, 25, "all 25 concurrent journal appends must land");
    assert.equal(final?.checkpoints?.length, 5, "all 5 checkpoints must land");
  }),
);

test(
  "cleanupRun and resumeRun go through CAS: neither clobbers concurrent journal/checkpoint data",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "cas-lifecycle";
    rp.save({
      ...baseRunState(runId, "2024-01-01T00:00:00.000Z", "paused"),
      journal: [{ index: 0, runId, hash: "h0", result: "cached" }],
    });
    const checkpoint: RunCheckpoint = {
      runId,
      taskId: "approve",
      status: "completed",
      timestamp: "2024-01-01T00:01:00.000Z",
    };
    await saveCheckpoint(runId, checkpoint, cwd);

    const resumed = await resumeRun(runId, cwd);
    assert.equal(resumed.status, "active");
    assert.deepEqual((await loadRunState(runId, cwd))?.checkpoints, [checkpoint]);
    assert.deepEqual(rp.load(runId)?.journal, [{ index: 0, runId, hash: "h0", result: "cached" }]);

    await cleanupRun(runId, cwd);
    const finished = rp.load(runId);
    assert.equal(finished?.status, "completed");
    assert.ok(finished?.completedAt, "cleanup stamps completedAt");
    assert.deepEqual(finished?.checkpoints, [checkpoint], "cleanup keeps the checkpoint");
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// Secret redaction (provider keys never reach disk)
// ═══════════════════════════════════════════════════════════════════════════

test("redactText masks provider keys, env-var assignments, bearer tokens, JWTs and PEM blocks", () => {
  assert.equal(redactText("sk-abcDEF1234567890"), "[REDACTED]");
  assert.equal(redactText("OPENAI_API_KEY=sk-abcDEF1234567890"), "OPENAI_API_KEY=[REDACTED]");
  assert.equal(redactText('"OPENAI_API_KEY": "sk-abcDEF1234567890"'), '"OPENAI_API_KEY=[REDACTED]"');
  assert.equal(redactText("Authorization: Bearer abcdefghijklmnop1234567890"), "Authorization: Bearer [REDACTED]");
  assert.equal(
    redactText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"),
    "[REDACTED]",
  );
  assert.equal(redactText("-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"), "[REDACTED]");
  assert.equal(redactText("ghp_abcdefghijklmnopqrstuvwxyz1234567890"), "[REDACTED]");
  assert.equal(redactText("AIzaSyA1234567890abcdefghijklmnopqrstuvwxyz"), "[REDACTED]");
  assert.equal(redactText("AKIAIOSFODNN7EXAMPLE"), "[REDACTED]");
  // Benign content is untouched.
  assert.equal(redactText("the quick brown fox"), "the quick brown fox");
  assert.equal(redactText('{"hash":"a1b2c3d4","result":"ok"}'), '{"hash":"a1b2c3d4","result":"ok"}');
  assert.equal(redactText("2024-01-01T00:00:00.000Z"), "2024-01-01T00:00:00.000Z");
});

test("redactText semantics: keyword-suffix identifiers match the original regex rule exactly", () => {
  // Parity guards for the linear scanner replacing the old KEY=value regex
  // (cpu-leak audit: the regex form backtracked O(n²) on long runs).
  assert.equal(redactText("XKEY=abc"), "XKEY=abc", "1-char prefix: the original regex did not match");
  assert.equal(redactText("AKEY=abc"), "AKEY=abc", "1-char prefix before KEY: no match (original semantics)");
  assert.equal(redactText("API_KEY=abc"), "API_KEY=[REDACTED]");
  assert.equal(redactText("MYTOKEN=abc"), "MYTOKEN=[REDACTED]");
  assert.equal(redactText("secret=abc"), "secret=abc", "lowercase keyword: case-sensitive like the original");
  assert.equal(redactText("API_KEY2=abc"), "API_KEY2=abc", "no word boundary after KEY: no match (original semantics)");
  assert.equal(redactText("KEY="), "KEY=", "empty value: no match (original semantics)");
  assert.equal(redactText("KEY value"), "KEY value", "missing separator: no match");
  assert.equal(redactText("openai_key=abc"), "openai_key=abc", "no keyword suffix: untouched");
  assert.equal(redactText("KEY:value"), "KEY:value", "0-char prefix before KEY: no match (original semantics)");
  assert.equal(redactText("FOO_KEY:value"), "FOO_KEY=[REDACTED]", "colon separator");
  assert.equal(redactText('FOO_KEY = "a,b"'), 'FOO_KEY=[REDACTED],b"', "value stops at comma like the original");
  assert.equal(redactText("A_B_C_D_SECRET=xyz"), "A_B_C_D_SECRET=[REDACTED]");
  // JWT parity: 3+ segments of >=20 [A-Za-z0-9_-] redact; short segments don't.
  const seg = (n: number) => "a".repeat(n);
  assert.equal(redactText(`${seg(25)}.${seg(30)}.${seg(35)}`), "[REDACTED]");
  assert.equal(redactText(`${seg(10)}.${seg(30)}.${seg(35)}`), `${seg(10)}.${seg(30)}.${seg(35)}`);
  assert.equal(redactText(`${seg(25)}.${seg(30)}`), `${seg(25)}.${seg(30)}`, "two segments: no match");
  // A KEY=value pair whose value is a JWT redacts the value, not the assignment.
  assert.equal(redactText(`TOKEN=${seg(25)}.${seg(30)}.${seg(35)}`), "TOKEN=[REDACTED]");
});

test("redactText is linear on long homogeneous runs (ReDoS regression)", () => {
  // The old KEY=value / JWT regexes backtracked O(n²) on a long run of word
  // chars — a 36.8MB journal of 3800-char results hung the event loop for
  // minutes (the cpu-leak audit's "secret-regex scan" made catastrophic). The
  // scanner must finish well under a second on the same shape.
  const blob = "x".repeat(3800);
  const started = performance.now();
  for (let i = 0; i < 200; i++) {
    redactText(i % 13 === 0 ? `${blob} SECRET_KEY=abc` : blob);
  }
  const elapsedMs = performance.now() - started;
  assert.ok(
    elapsedMs < 2000,
    `200 scans of 3800-char runs took ${elapsedMs.toFixed(0)}ms — a linear scanner must stay under 2s (was minutes)`,
  );
});

test(
  "a provider API key in agent output never lands in the persisted journal or compacted state",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "secret-leak";
    const key = "sk-abcDEFghijklmnopqrstuvwxyz1234567890";

    // Save 1: plain-journal form (the manager's default write).
    const journalState: PersistedRunState = {
      ...baseRunState(runId, "2024-01-01T00:00:00.000Z", "paused"),
      journal: [{ index: 0, runId, hash: "h0", result: { text: `use ${key} for the API` } }],
      logs: [`OPENAI_API_KEY=${key}`],
      agents: [{ id: 1, label: "a", prompt: "p", status: "done", result: { key } }],
    };
    rp.save(journalState);

    const rawJournal = readFileSync(join(workflowProjectPaths(cwd).runsDir, `${runId}.json`), "utf-8");
    assert.ok(!rawJournal.includes(key), "the raw key must never be written to disk");
    assert.ok(!rawJournal.includes("sk-abcDEFghijklmnopqrstuvwxyz"), "the key prefix must not leak either");
    assert.ok(rawJournal.includes("use [REDACTED] for the API"), "the redacted form IS what lands on disk");

    const loadedJournal = rp.load(runId);
    assert.ok(!JSON.stringify(loadedJournal).includes(key), "the key is scrubbed from every loaded surface");
    assert.equal((loadedJournal?.journal?.[0]?.result as { text?: string })?.text, "use [REDACTED] for the API");
    assert.equal(loadedJournal?.logs?.[0], "OPENAI_API_KEY=[REDACTED]");
    assert.equal((loadedJournal?.agents[0]?.result as { key?: string })?.key, "[REDACTED]");
    // The in-memory state passed to save() is NOT mutated — only the
    // persisted form is scrubbed.
    assert.ok(
      JSON.stringify(journalState).includes(key),
      "the in-memory state keeps its value until the persistence boundary",
    );

    // Save 2: compacted-summary form (the manager's opt-in compaction write).
    const compactedState: PersistedRunState = {
      ...baseRunState(runId, "2024-01-01T00:02:00.000Z", "paused"),
      journalCompacted: {
        kind: "compact",
        version: 1,
        hashes: ["h0"],
        opTraces: [],
        results: [{ key }],
        models: [],
        storeDeltas: [],
        records: [{ fold: "resolved", index: 0, runId, hashRef: 0, resultRef: 0 }],
      },
    };
    rp.save(compactedState);

    const rawCompacted = readFileSync(join(workflowProjectPaths(cwd).runsDir, `${runId}.json`), "utf-8");
    assert.ok(!rawCompacted.includes(key), "the key never lands in the compacted state either");
    const loadedCompacted = rp.load(runId);
    assert.equal((loadedCompacted?.journalCompacted?.results[0] as { key?: string })?.key, "[REDACTED]");
    assert.equal(loadedCompacted?.journalCompacted?.records.length, 1);
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// Journal size / stringify budget
// ═══════════════════════════════════════════════════════════════════════════

test("upsertJournalEntry caps growth at MAX_JOURNAL_ENTRIES keeping the newest entries", () => {
  const base = Array.from({ length: MAX_JOURNAL_ENTRIES }, (_, i) => ({
    index: i,
    runId: "r",
    hash: `h${i}`,
    result: i,
  }));
  const next = upsertJournalEntry(base, { index: MAX_JOURNAL_ENTRIES, runId: "r", hash: "new", result: "new" });
  assert.equal(next.length, MAX_JOURNAL_ENTRIES, "the journal never grows past the cap");
  assert.equal(next[0]?.index, 1, "the oldest entry is evicted");
  assert.equal(next[next.length - 1]?.index, MAX_JOURNAL_ENTRIES, "the newest entry is kept");
});

test("capJournalBudget drops the oldest entries first when over the byte budget", () => {
  const journal = Array.from({ length: 100 }, (_, i) => ({
    index: i,
    runId: "r",
    hash: `h${i}`,
    result: `result-${i}-${"x".repeat(100)}`,
  }));
  const capped = capJournalBudget(journal, 2000);
  assert.ok(capped.length < journal.length, "the journal was trimmed");
  assert.ok(JSON.stringify(capped).length <= 2000, "the capped journal fits the budget");
  assert.equal(capped[0]?.index, journal.length - capped.length, "the OLDEST entries were dropped, newest kept");
  assert.equal(capJournalBudget(journal, DEFAULT_JOURNAL_BYTE_BUDGET), journal, "under budget → unchanged (no copy)");
});

test(
  "persisting a 20k-entry journal stays within a generous wall-clock bound",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const journal = Array.from({ length: 20_000 }, (_, i) => ({
      index: i,
      runId: "big",
      hash: `h${i}`,
      result: { i },
    }));
    const started = Date.now();
    rp.save({ ...baseRunState("big-run", "2024-01-01T00:00:00.000Z", "paused"), journal });
    const saveMs = Date.now() - started;
    const loaded = rp.load("big-run");
    assert.equal(loaded?.journal?.length, 20_000, "the full journal round-trips");
    assert.ok(saveMs < 5000, `saving 20k entries took ${saveMs}ms — expected well under the generous 5s bound`);
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// E4 — append-only journal delta (fast path) + periodic full checkpoint
// ═══════════════════════════════════════════════════════════════════════════

function journaledRun(
  runId: string,
  journal: Array<{ index: number; runId?: string; hash: string; result: unknown }>,
): PersistedRunState {
  return { ...baseRunState(runId, "2024-01-01T00:00:00.000Z", "running"), journal };
}

const deltaPath = (cwd: string, runId: string) =>
  join(workflowProjectPaths(cwd).runsDir, `${runId}.json${JOURNAL_DELTA_SUFFIX}`);

test(
  "fastPath save appends ONLY the journal delta to the .jdelta sidecar (no primary rewrite, no .bak)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "e4-fast-1";
    // Boundary write first: primary gets the folded journal (and its .bak).
    rp.save(journaledRun(runId, [{ index: 0, runId, hash: "h0", result: "a" }]));
    const runsDir = workflowProjectPaths(cwd).runsDir;
    assert.ok(existsSync(join(runsDir, `${runId}.json`)), "boundary write creates the primary");
    assert.ok(existsSync(join(runsDir, `${runId}.json.bak`)), "boundary write keeps the .bak");
    const primaryBefore = readFileSync(join(runsDir, `${runId}.json`), "utf-8");

    // Fast path: only entry index 1 is new — it must land in the sidecar.
    rp.save(
      journaledRun(runId, [
        { index: 0, runId, hash: "h0", result: "a" },
        { index: 1, runId, hash: "h1", result: "b" },
      ]),
      { fastPath: true },
    );
    assert.equal(existsSync(deltaPath(cwd, runId)), true, ".jdelta sidecar exists");
    const sidecar = JSON.parse(readFileSync(deltaPath(cwd, runId), "utf-8")) as Array<{ index: number }>;
    assert.deepEqual(
      sidecar.map((e) => e.index),
      [1],
      "only the NEW entry is appended — the folded entry is not re-written",
    );
    assert.equal(
      readFileSync(join(runsDir, `${runId}.json`), "utf-8"),
      primaryBefore,
      "the primary is NOT rewritten on the fast path",
    );
    assert.equal(existsSync(join(runsDir, `${runId}.json.bak`)), true, ".bak untouched (no new write)");

    // load() merges: primary journal + sidecar deltas = the full journal.
    const loaded = rp.load(runId);
    assert.deepEqual(
      loaded?.journal?.map((e) => e.result),
      ["a", "b"],
      "load() replays the sidecar deltas on top of the folded journal",
    );
  }),
);

test(
  "fastPath replacement (same key re-journaled in place) is delta'd and wins on load",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "e4-fast-replace";
    rp.save(journaledRun(runId, [{ index: 0, runId, hash: "h0", result: "stale" }]));
    // Same (runId, index) key with a NEW result object — the fast path must
    // carry the replacement through the sidecar.
    rp.save(journaledRun(runId, [{ index: 0, runId, hash: "h0", result: "fresh" }]), { fastPath: true });
    const sidecar = JSON.parse(readFileSync(deltaPath(cwd, runId), "utf-8")) as Array<{ index: number }>;
    assert.equal(sidecar.length, 1, "the replacement is appended to the sidecar");
    const loaded = rp.load(runId);
    assert.equal(loaded?.journal?.length, 1, "no duplicate key after the merge");
    assert.equal(loaded?.journal?.[0]?.result, "fresh", "the replaced entry wins on load");
  }),
);

test(
  "a boundary save folds the sidecar into the primary and clears the .jdelta + writes .bak",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "e4-fold";
    rp.save(journaledRun(runId, [{ index: 0, runId, hash: "h0", result: "a" }]));
    rp.save(
      journaledRun(runId, [
        { index: 0, runId, hash: "h0", result: "a" },
        { index: 1, runId, hash: "h1", result: "b" },
      ]),
      { fastPath: true },
    );
    assert.ok(existsSync(deltaPath(cwd, runId)), "sidecar exists before the fold");

    rp.save({ ...journaledRun(runId, []), status: "paused" });
    const loaded = rp.load(runId);
    assert.deepEqual(
      loaded?.journal?.map((e) => e.result),
      ["a", "b"],
      "the boundary write folds the sidecar deltas into the primary journal",
    );
    assert.equal(existsSync(deltaPath(cwd, runId)), false, ".jdelta cleared after the fold");
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, `${runId}.json.bak`)), true, ".bak written");
  }),
);

test(
  "a fastPath write that would exceed the checkpoint threshold folds into a full checkpoint instead",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd, undefined, { journalDeltaCheckpointBytes: 64 });
    const runId = "e4-checkpoint";
    rp.save(journaledRun(runId, []));
    // One entry already blows past a 64-byte threshold → the fast path folds.
    rp.save(journaledRun(runId, [{ index: 0, runId, hash: "h0", result: "big-result" }]), { fastPath: true });
    const runsDir = workflowProjectPaths(cwd).runsDir;
    const primary = JSON.parse(readFileSync(join(runsDir, `${runId}.json`), "utf-8")) as {
      journal?: Array<{ index: number }>;
    };
    assert.deepEqual(
      primary.journal?.map((e) => e.index),
      [0],
      "the full journal is folded into the primary (periodic checkpoint)",
    );
    assert.equal(existsSync(deltaPath(cwd, runId)), false, "no sidecar remains after the fold");
    assert.equal(existsSync(join(runsDir, `${runId}.json.bak`)), true, "a checkpoint is a resumable write (.bak kept)");
    assert.equal(rp.load(runId)?.journal?.length, 1, "load() sees the folded journal");
  }),
);

test(
  "delete removes the .jdelta sidecar too",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "e4-delete";
    rp.save(journaledRun(runId, [{ index: 0, runId, hash: "h0", result: "a" }]));
    rp.save(
      journaledRun(runId, [
        { index: 0, runId, hash: "h0", result: "a" },
        { index: 1, runId, hash: "h1", result: "b" },
      ]),
      { fastPath: true },
    );
    assert.ok(existsSync(deltaPath(cwd, runId)), "sidecar exists before delete");
    assert.equal(rp.delete(runId), true);
    assert.equal(existsSync(deltaPath(cwd, runId)), false, ".jdelta cleaned up by delete");
  }),
);

test(
  "a resumed cold instance still merges deltas: a fresh persistence sees primary + sidecar",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "e4-cold";
    rp.save(journaledRun(runId, [{ index: 0, runId, hash: "h0", result: "a" }]));
    rp.save(
      journaledRun(runId, [
        { index: 0, runId, hash: "h0", result: "a" },
        { index: 1, runId, hash: "h1", result: "b" },
      ]),
      { fastPath: true },
    );
    // A brand-new instance (crash-restart) has no in-memory folded map — its
    // load() must still reconstruct the full journal from disk.
    const fresh = createRunPersistence(cwd);
    const loaded = fresh.load(runId);
    assert.deepEqual(
      loaded?.journal?.map((e) => e.result),
      ["a", "b"],
      "a cold instance merges the sidecar deltas into the folded journal",
    );
    assert.equal(DEFAULT_JOURNAL_DELTA_CHECKPOINT_BYTES > 0, true, "the checkpoint threshold constant is positive");
  }),
);
