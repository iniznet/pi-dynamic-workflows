import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  closeRunDurableStore,
  createRunDurableStore,
  DURABLE_STORE_SCHEMA_VERSION,
  DurableStore,
  deterministicRunClock,
  recordProvenance,
  runDurableStore,
} from "../src/durable-store.js";
import { runWorkflow } from "../src/workflow.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "durable-store-test-"));
}

function makeStore(dir: string, projectKey = "test-project", now?: (seq: number) => string): DurableStore {
  return new DurableStore({ dir, projectKey, now: now ?? ((seq: number) => `t-${seq}`) });
}

// ─── basics + persistence ────────────────────────────────────────────────────

test("DurableStore put/get/has/keys basics", async () => {
  const dir = tempDir();
  const store = makeStore(dir);
  assert.equal(store.has("x"), false);
  assert.equal(store.get("x"), undefined);
  await store.put("x", 42);
  assert.equal(store.has("x"), true);
  assert.equal(store.get("x"), 42);
  assert.deepEqual(store.keys(), ["x"]);
});

test("DurableStore persists across instances (cross-run memory)", async () => {
  const dir = tempDir();
  const a = makeStore(dir);
  await a.put("cross-run", { done: true });
  const b = makeStore(dir);
  assert.deepEqual(b.get("cross-run"), { done: true }, "a fresh instance sees the prior run's write");
});

test("DurableStore atomic write: valid versioned JSON, no orphan tmp", async () => {
  const dir = tempDir();
  const store = makeStore(dir);
  await store.put("k", "v");
  const file = join(dir, "test-project.json");
  const raw = JSON.parse(readFileSync(file, "utf-8")) as { version: number; entries: Record<string, unknown> };
  assert.equal(raw.version, DURABLE_STORE_SCHEMA_VERSION, "the schema version is stamped");
  assert.deepEqual(raw.entries, { k: "v" });
  assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp")), "no orphan tmp is left behind (atomic tmp+rename)");
});

test("DurableStore never downgrades a NEWER on-disk schema", async () => {
  const dir = tempDir();
  const file = join(dir, "test-project.json");
  writeFileSync(
    file,
    JSON.stringify({ version: DURABLE_STORE_SCHEMA_VERSION + 1, seq: 1, entries: { newer: true }, ledger: [] }),
  );
  const store = makeStore(dir);
  assert.equal(store.get("newer"), undefined, "a newer schema is unreadable by this writer");
  const written = await store.put("k", "v");
  assert.equal(written, undefined, "put resolves (no-op contract)");
  const raw = JSON.parse(readFileSync(file, "utf-8")) as { version: number };
  assert.equal(raw.version, DURABLE_STORE_SCHEMA_VERSION + 1, "the newer file is never downgrade-overwritten");
});

// ─── lock / concurrent writers ───────────────────────────────────────────────

test("DurableStore concurrent instances merge (mesh-lite, no clobber)", async () => {
  const dir = tempDir();
  const a = makeStore(dir);
  const b = makeStore(dir);
  await Promise.all([a.put("from-a", { who: "a" }), b.put("from-b", { who: "b" })]);
  const c = makeStore(dir);
  assert.deepEqual(c.get("from-a"), { who: "a" }, "a's write survives");
  assert.deepEqual(c.get("from-b"), { who: "b" }, "b's write survives");
});

// ─── idempotent replay ───────────────────────────────────────────────────────

test("DurableStore re-executed writes are idempotent (identical state)", async () => {
  const dir = tempDir();
  const runOnce = async (): Promise<string> => {
    const store = makeStore(dir);
    await store.put("task:1", { state: "done", by: "worker-a" });
    await store.put("task:2", { state: "done", by: "worker-b" });
    await store.record({ source: "agent", agent: "worker-a" });
    await store.record({ source: "agent", agent: "worker-b" });
    return readFileSync(join(dir, "test-project.json"), "utf-8");
  };
  const first = await runOnce();
  // A cached-prefix replay re-executes the same script statements against the
  // SAME persisted store — every write must be a byte-identical no-op.
  const replay = await runOnce();
  assert.equal(replay, first, "replay leaves the store file byte-identical");
});

test("DurableStore putMany lands one atomic commit for a batch (settle-path coalescing)", async () => {
  const dir = tempDir();
  const store = makeStore(dir);
  // Multiple keys in one commit: a single seq bump per changed key, single file.
  await store.putMany([
    ["phaseBudgets:r:a", 400],
    ["outputBudget:r", { limit: 1000, spent: 0 }],
    ["steerRevisions:r", [{ revision: { phases: [{ title: "b", budget: 200 }] }, callIndex: 3 }]],
    ["spendLedger:r", { runId: "r", total: 42 }],
  ]);
  assert.equal(store.get("phaseBudgets:r:a"), 400);
  assert.deepEqual(store.get("outputBudget:r"), { limit: 1000, spent: 0 });
  assert.deepEqual(store.get("steerRevisions:r"), [
    { revision: { phases: [{ title: "b", budget: 200 }] }, callIndex: 3 },
  ]);
  assert.deepEqual(store.get("spendLedger:r"), { runId: "r", total: 42 });
  const file = JSON.parse(readFileSync(join(dir, "test-project.json"), "utf-8")) as { seq: number };
  assert.equal(file.seq, 4, "each changed key bumps seq exactly once, in ONE commit");
  assert.ok(
    !readdirSync(dir).some((f) => f.endsWith(".tmp")),
    "the batch write is atomic (tmp+rename) — no orphan tmp",
  );
  // A fresh instance sees the batch (single on-disk commit persisted all keys).
  const fresh = makeStore(dir);
  assert.equal(fresh.get("phaseBudgets:r:a"), 400);
  assert.deepEqual(fresh.get("spendLedger:r"), { runId: "r", total: 42 });
});

test("DurableStore putMany is replay-idempotent (per-key deep-equal no-ops)", async () => {
  const dir = tempDir();
  const store = makeStore(dir);
  await store.put("phaseBudgets:r:a", 400);
  await store.putMany([
    ["phaseBudgets:r:a", 400], // unchanged — no-op
    ["outputBudget:r", { limit: 1000, spent: 5 }], // changed
  ]);
  assert.equal(store.get("phaseBudgets:r:a"), 400);
  assert.deepEqual(store.get("outputBudget:r"), { limit: 1000, spent: 5 });
  const file = JSON.parse(readFileSync(join(dir, "test-project.json"), "utf-8")) as { seq: number };
  assert.equal(file.seq, 2, "an all-unchanged re-executed batch is a no-op; only the changed key bumps seq");
});

test("DurableStore putMany with no entries is a no-op", async () => {
  const dir = tempDir();
  const store = makeStore(dir);
  await store.putMany([]);
  assert.ok(!readdirSync(dir).some((f) => f.endsWith(".json")), "an empty batch never touches the disk");
});

test("DurableStore putOnce dedupes by id (a re-executed increment lands once)", async () => {
  const dir = tempDir();
  const store = makeStore(dir);
  assert.equal(await store.putOnce("count:run-1", "count", 1), true, "first write lands");
  assert.equal(await store.putOnce("count:run-1", "count", 1), false, "same id is a no-op");
  assert.equal(store.get("count"), 1);
  const fresh = makeStore(dir);
  assert.equal(await fresh.putOnce("count:run-1", "count", 1), false, "replay with the same id is a no-op");
  assert.equal(fresh.get("count"), 1, "no double increment");
});

test("DurableStore compareAndSwap is replay-safe", async () => {
  const dir = tempDir();
  const store = makeStore(dir);
  assert.equal(await store.compareAndSwap("board:t1", undefined, "claimed-by-a"), true, "first claim wins");
  // Re-execution (replay): the persisted value no longer matches `undefined`.
  assert.equal(await store.compareAndSwap("board:t1", undefined, "claimed-by-a"), false, "re-claim is a no-op");
  assert.equal(store.get("board:t1"), "claimed-by-a");
  // A mismatched expected value never writes.
  assert.equal(await store.compareAndSwap("board:t1", "someone-else", "claimed-by-b"), false);
  assert.equal(store.get("board:t1"), "claimed-by-a");
});

// ─── provenance ledger ───────────────────────────────────────────────────────

test("DurableStore record appends to the ledger with deterministic timestamps", async () => {
  const dir = tempDir();
  const store = makeStore(dir);
  await store.record({ source: "agent", agent: "worker-a", phase: "build" });
  await store.record({ source: "agent", agent: "worker-b" });
  const ledger = store.ledgerEntries();
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0]?.source, "agent");
  assert.equal(ledger[0]?.agent, "worker-a");
  assert.equal(ledger[0]?.phase, "build");
  assert.equal(ledger[0]?.timestamp, "t-1", "timestamp stamped from the injected clock + seq");
  assert.equal(ledger[1]?.timestamp, "t-2");
  assert.ok(ledger[0]?.id, "an id is auto-derived for dedupe");
});

test("DurableStore record dedupes by content identity (replay never re-appends)", async () => {
  const dir = tempDir();
  const store = makeStore(dir);
  assert.equal(await store.record({ source: "agent", agent: "worker-a" }), true);
  assert.equal(await store.record({ source: "agent", agent: "worker-a" }), false, "identical record is skipped");
  assert.equal(store.ledgerEntries().length, 1);
  // Same source/agent but a different phase is a DISTINCT record.
  assert.equal(await store.record({ source: "agent", agent: "worker-a", phase: "review" }), true);
  assert.equal(store.ledgerEntries().length, 2);
});

test("deterministicRunClock is stable and monotonic (never wall-clock)", () => {
  const clock = deterministicRunClock("run-x");
  const a = clock(0);
  const b = clock(0);
  const c = clock(1);
  assert.equal(a, b, "the same seq always produces the same timestamp");
  assert.ok(c > a, "higher seq stamps later");
  assert.equal(a, "2023-11-14T22:13:20.000Z", "the fixed constant epoch base is reproducible");
});

// ─── run-scoped registry / recordProvenance ─────────────────────────────────

test("createRunDurableStore registers the run's sink; recordProvenance routes to it", async () => {
  const dir = tempDir();
  const store = createRunDurableStore({ runId: "run-1", projectKey: "p", dir, now: (s) => `t-${s}` });
  assert.equal(runDurableStore("run-1"), store, "the registry resolves the run's store");
  // Idempotent per runId: a second bind returns the same instance.
  assert.equal(createRunDurableStore({ runId: "run-1", projectKey: "p", dir }), store);
  await recordProvenance("run-1", { source: "worktree", file: "/tmp/wt", agent: "pi/wf/branch" });
  assert.equal(store.ledgerEntries().length, 1);
  assert.equal(store.ledgerEntries()[0]?.file, "/tmp/wt");
  closeRunDurableStore("run-1");
  assert.equal(runDurableStore("run-1"), undefined, "close unregisters the sink");
});

test("recordProvenance is a no-op without a runId or a registered store", async () => {
  await recordProvenance(undefined, { source: "agent" });
  await recordProvenance("no-such-run", { source: "agent" });
});

// ─── vm integration: the durableStore global ─────────────────────────────────

function capturingRunner() {
  const calls: Array<{ label?: string; model?: string }> = [];
  return {
    calls,
    runner: {
      async run(_prompt: string, options: Record<string, unknown>) {
        calls.push({
          label: options.label as string | undefined,
          model: options.model as string | undefined,
        });
        return "ok";
      },
    },
  };
}

test("durableStore vm global: script writes survive the run and replay is idempotent", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const script = `export const meta = { name: "durable", description: "durable store" }
await durableStore.put("task:1", { state: "done", by: "worker-a" })
await agent("do the thing", { label: "worker-a" })
await durableStore.record({ source: "script", agent: "worker-a", phase: "build" })
return "finished"`;

    const first = capturingRunner();
    const result1 = await runWorkflow(script, { agent: first.runner, cwd, persistLogs: false, runId: "run-1" });
    assert.equal(result1.result, "finished");
    assert.equal(first.calls.length, 1);

    // The store file lives under the (fake) agent dir, project-keyed by cwd.
    const agentDir = join(process.env.HOME ?? "", ".pi", "agent");
    const files = readdirSync(join(agentDir, "durable-store")).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".bak"),
    );
    assert.equal(files.length, 1, "one per-project store file");
    const file = join(agentDir, "durable-store", files[0] ?? "");
    const raw = JSON.parse(readFileSync(file, "utf-8")) as {
      version: number;
      entries: Record<string, unknown>;
      ledger: Array<{ source: string; agent: string }>;
    };
    assert.equal(raw.version, DURABLE_STORE_SCHEMA_VERSION);
    assert.deepEqual(raw.entries["task:1"], { state: "done", by: "worker-a" });
    assert.ok(
      raw.ledger.some((e) => e.source === "script" && e.agent === "worker-a"),
      "the script's record() lands in the provenance ledger",
    );

    // Simulate a cached-prefix replay: re-execute the same script against the
    // same store file — writes are idempotent, so the file stays identical.
    const before = readFileSync(file, "utf-8");
    const second = capturingRunner();
    await runWorkflow(script, { agent: second.runner, cwd, persistLogs: false, runId: "run-1" });
    const after = readFileSync(file, "utf-8");
    assert.equal(after, before, "replay leaves the durable store byte-identical");
  }));

test("durableStore CAS task board works across runs (mesh-lite)", async () => {
  const dir = tempDir();
  const projectKey = "task-board";
  const claimRun = async (who: string): Promise<boolean> => {
    const store = makeStore(dir, projectKey);
    return store.compareAndSwap("board:t1", undefined, { claimedBy: who });
  };
  assert.equal(await claimRun("run-a"), true);
  assert.equal(await claimRun("run-b"), false, "a later run cannot re-claim the task");
  const fresh = makeStore(dir, projectKey);
  assert.deepEqual(fresh.get("board:t1"), { claimedBy: "run-a" });
});
