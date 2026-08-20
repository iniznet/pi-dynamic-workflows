/**
 * V2-P03 edit transaction: pre-edit snapshot, gated commit, rollback, auto
 * test-scope, and the evidence commit cert. Covers the contract checkpoints:
 *  1. begin() snapshots dirty-at-begin + declared files (atomic manifest);
 *  2. begin → edit → commit happy path (machine tests pass + scope clean);
 *  3. rollback restores EXACTLY (snapshot copies, begin-tree blobs, deletions);
 *  4. a gate failure (failed test / scope violation) NEVER leaves partial state;
 *  5. auto test-scope derivation from impact-scope's emitted testScope;
 *  6. the commit cert is replay-idempotent in the durable-store ledger;
 *  7. per-run snapshot pruning at run sweep + non-git degradation.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeRunDurableStore, createRunDurableStore, DurableStore, runDurableStore } from "../../src/durable-store.js";
import {
  createEditTransaction,
  deriveTestGateTestsFromPartition,
  deriveTestGateTestsFromScope,
  pruneEditTransactionSnapshots,
  testScopeFromPartition,
} from "../../src/edit-transaction.js";
import type { ImpactPartition } from "../../src/impact-scope.js";

/** Create a throwaway git repo (autocrlf off — byte-exact content asserts). */
async function makeGitRepo(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), tag));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "core.autocrlf", "false");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/feature.ts"), "export const v = 1\n", "utf-8");
  await writeFile(join(dir, "keep.txt"), "keep\n", "utf-8");
  git("add", "-A");
  git("commit", "-q", "-m", "baseline");
  return dir;
}

function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), tag));
}

// ─── begin ────────────────────────────────────────────────────────────────────

test("edit-transaction begin: snapshots dirty-at-begin + declared files under an atomic manifest", async () => {
  const repo = await makeGitRepo("et-begin-");
  const baseDir = tempDir("et-begin-snap-");
  try {
    await writeFile(join(repo, "dirty.txt"), "dirty-v1\n", "utf-8");
    const txn = createEditTransaction({ cwd: repo, allowedPaths: ["src/feature.ts", "docs/out.md"], baseDir });
    assert.equal(txn.state, "new");
    const begun = await txn.begin();
    assert.equal(txn.state, "active");
    assert.equal(begun.transactionId, txn.transactionId);
    assert.ok(existsSync(join(begun.snapshotDir, "snapshot.json")), "manifest written atomically");
    assert.ok(!existsSync(join(begun.snapshotDir, "snapshot.json.tmp")), "no orphan tmp left behind");
    const files = begun.snapshot.files;
    assert.equal(files["dirty.txt"], Buffer.from("dirty-v1\n", "utf-8").toString("base64"), "dirty file copied");
    assert.equal(
      files["src/feature.ts"],
      Buffer.from("export const v = 1\n", "utf-8").toString("base64"),
      "declared clean tracked file copied",
    );
    assert.equal(files["docs/out.md"], undefined, "a declared file that does not exist yet is not copied");
    assert.equal(files["keep.txt"], undefined, "clean tracked files outside the declared scope are not copied");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  }
});

// ─── begin → edit → commit happy path ─────────────────────────────────────────

test("edit-transaction commit: machine tests pass + scope clean → committed + cert", async () => {
  const repo = await makeGitRepo("et-commit-");
  const baseDir = tempDir("et-commit-snap-");
  const storeDir = tempDir("et-commit-store-");
  try {
    const store = new DurableStore({ dir: storeDir, projectKey: "et-happy", now: (seq) => `t-${seq}` });
    const txn = createEditTransaction({
      cwd: repo,
      allowedPaths: ["src/feature.ts", "docs/out.md"],
      baseDir,
    });
    await txn.begin();
    await writeFile(join(repo, "src/feature.ts"), "export const v = 2\n", "utf-8");
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(repo, "docs/out.md"), "generated\n", "utf-8");

    const commit = await txn.commit({
      tests: [{ command: "check", assert: { exitCode: 0 } }],
      runStep: async () => ({ exitCode: 0, output: "ok" }),
      ledger: store,
    });
    assert.equal(commit.ok, true);
    assert.equal(commit.state, "committed");
    assert.equal(txn.state, "committed");
    assert.deepEqual(commit.violations, []);
    assert.equal(commit.testResults.length, 1);
    assert.equal(commit.testResults[0].passed, true);
    assert.ok(commit.ledgerEntry, "commit cert recorded");
    assert.equal(store.ledgerEntries().length, 1);
    assert.equal(store.ledgerEntries()[0].source, "edit-transaction");
    assert.equal(
      await readFileSync(join(repo, "src/feature.ts"), "utf-8"),
      "export const v = 2\n",
      "the edit survives a successful commit",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("edit-transaction commit: scope-only gate (no tests) commits a clean-scoped edit", async () => {
  const repo = await makeGitRepo("et-scope-");
  const baseDir = tempDir("et-scope-snap-");
  try {
    const txn = createEditTransaction({ cwd: repo, allowedPaths: ["src/feature.ts"], baseDir });
    await txn.begin();
    await writeFile(join(repo, "src/feature.ts"), "export const v = 3\n", "utf-8");
    const commit = await txn.commit();
    assert.equal(commit.ok, true, "no tests supplied → scope-only gate");
    assert.deepEqual(commit.testResults, []);
    assert.equal(txn.state, "committed");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  }
});

// ─── rollback restores exactly ────────────────────────────────────────────────

test("edit-transaction rollback: restores snapshot copies, begin-tree blobs, deletions; leaves allowed subtrees", async () => {
  const repo = await makeGitRepo("et-roll-");
  const baseDir = tempDir("et-roll-snap-");
  try {
    // dirty-at-begin untracked files (snapshot-copy restore).
    await writeFile(join(repo, "dirty.txt"), "dirty-v1\n", "utf-8");
    await writeFile(join(repo, "dirty-removed.txt"), "d2-v1\n", "utf-8");
    const txn = createEditTransaction({
      cwd: repo,
      // src/feature.ts (declared clean tracked), dirty.txt (declared dirty),
      // dist/ (declared allowed subtree). keep.txt is NOT declared — its
      // restore must come from the begin-tree blob.
      allowedPaths: ["src/feature.ts", "dirty.txt", "dist/"],
      baseDir,
    });
    await txn.begin();
    // Edits:
    await writeFile(join(repo, "src/feature.ts"), "export const v = 2\n", "utf-8"); // declared → copy restore
    await writeFile(join(repo, "dirty.txt"), "dirty-v2\n", "utf-8"); // declared dirty → copy restore
    await rm(join(repo, "dirty-removed.txt")); // dirty at begin, removed → copy restore
    await writeFile(join(repo, "keep.txt"), "mutated\n", "utf-8"); // undeclared clean tracked → blob restore
    await writeFile(join(repo, "sneaky.ts"), "x\n", "utf-8"); // out-of-scope new file → deleted
    await mkdir(join(repo, "dist"), { recursive: true });
    await writeFile(join(repo, "dist/bundle.js"), "bundled\n", "utf-8"); // allowed subtree → left alone

    const rollback = await txn.rollback();
    assert.equal(rollback.state, "rolled-back");
    assert.equal(rollback.clean, true, "every restore completed");
    assert.equal(txn.state, "rolled-back");
    assert.equal(
      readFileSync(join(repo, "src/feature.ts"), "utf-8"),
      "export const v = 1\n",
      "declared clean tracked file restored from its snapshot copy",
    );
    assert.equal(readFileSync(join(repo, "dirty.txt"), "utf-8"), "dirty-v1\n", "dirty file restored from its copy");
    assert.equal(
      readFileSync(join(repo, "dirty-removed.txt"), "utf-8"),
      "d2-v1\n",
      "a dirty file removed during the edit is restored",
    );
    assert.equal(
      readFileSync(join(repo, "keep.txt"), "utf-8"),
      "keep\n",
      "clean tracked file restored from the begin-tree blob",
    );
    assert.equal(existsSync(join(repo, "sneaky.ts")), false, "out-of-scope new file deleted");
    assert.equal(
      readFileSync(join(repo, "dist/bundle.js"), "utf-8"),
      "bundled\n",
      "allowed-subtree output left in place",
    );
    assert.ok(rollback.restored.includes("src/feature.ts"));
    assert.ok(rollback.restored.includes("dirty.txt"));
    assert.ok(rollback.restored.includes("dirty-removed.txt"));
    assert.ok(rollback.restored.includes("keep.txt"));
    assert.ok(rollback.deleted.includes("sneaky.ts"));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  }
});

// ─── gate failure never leaves partial state ──────────────────────────────────

test("edit-transaction commit: a failed machine test auto-rolls back (never partial state)", async () => {
  const repo = await makeGitRepo("et-failtest-");
  const baseDir = tempDir("et-failtest-snap-");
  try {
    const txn = createEditTransaction({ cwd: repo, allowedPaths: ["src/feature.ts"], baseDir });
    await txn.begin();
    // The edit stays scope-clean — the machine test itself fails the gate.
    await writeFile(join(repo, "src/feature.ts"), "export const v = 2\n", "utf-8");
    const commit = await txn.commit({
      tests: [{ command: "check", assert: { exitCode: 0 } }],
      runStep: async () => ({ exitCode: 1, output: "boom" }),
    });
    assert.equal(commit.ok, false);
    assert.equal(commit.state, "rolled-back");
    assert.equal(txn.state, "rolled-back");
    assert.equal(commit.testResults.length, 1);
    assert.equal(commit.testResults[0].passed, false);
    assert.match(commit.reason ?? "", /machine postcondition\(s\) failed/);
    assert.equal(
      readFileSync(join(repo, "src/feature.ts"), "utf-8"),
      "export const v = 1\n",
      "the pre-edit state is fully restored after a failed gate",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("edit-transaction commit: a scope violation auto-rolls back (scope clean is a hard gate)", async () => {
  const repo = await makeGitRepo("et-viol-");
  const baseDir = tempDir("et-viol-snap-");
  try {
    const txn = createEditTransaction({ cwd: repo, allowedPaths: ["src/feature.ts"], baseDir });
    await txn.begin();
    await writeFile(join(repo, "src/feature.ts"), "export const v = 2\n", "utf-8");
    await writeFile(join(repo, "unexpected.txt"), "x\n", "utf-8");
    const commit = await txn.commit();
    assert.equal(commit.ok, false, "no tests supplied, but the scope violation still fails the gate");
    assert.deepEqual(commit.violations, ["added: unexpected.txt"]);
    assert.match(commit.reason ?? "", /workspace scope violations/);
    assert.equal(txn.state, "rolled-back");
    assert.equal(existsSync(join(repo, "unexpected.txt")), false);
    assert.equal(readFileSync(join(repo, "src/feature.ts"), "utf-8"), "export const v = 1\n");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  }
});

// ─── auto test-scope derivation ───────────────────────────────────────────────

const SAMPLE_PARTITION: ImpactPartition = {
  slices: [
    {
      name: "slice-a",
      focus: "entry wiring",
      scopedFiles: ["src/a.ts"],
      testScope: ["tests/a.test.ts", "tests/a.test.ts", "tests/dup.test.ts"],
    },
    {
      name: "slice-b",
      focus: "validation",
      scopedFiles: [],
      testScope: ["  tests/b.test.ts  ", "tests/dup.test.ts"],
    },
  ],
};

test("edit-transaction auto test-scope: partition testScope flattens deduped + deterministic", () => {
  assert.deepEqual(testScopeFromPartition(SAMPLE_PARTITION), [
    "tests/a.test.ts",
    "tests/dup.test.ts",
    "tests/b.test.ts",
  ]);
  assert.deepEqual(testScopeFromPartition({ slices: [] }), []);
});

test("edit-transaction auto test-scope: testScope derives testGate commands (default + custom)", () => {
  const defaults = deriveTestGateTestsFromScope(["tests/a.test.ts"]);
  assert.deepEqual(defaults, [{ command: "node --import tsx --test tests/a.test.ts", assert: { exitCode: 0 } }]);
  const custom = deriveTestGateTestsFromScope(["tests/a.test.ts"], (file) => `node --test ${file}`);
  assert.deepEqual(custom, [{ command: "node --test tests/a.test.ts", assert: { exitCode: 0 } }]);
  assert.deepEqual(deriveTestGateTestsFromScope([]), []);
  const fromPartition = deriveTestGateTestsFromPartition(SAMPLE_PARTITION, (file) => `run ${file}`);
  assert.deepEqual(
    fromPartition.map((t) => t.command),
    ["run tests/a.test.ts", "run tests/dup.test.ts", "run tests/b.test.ts"],
  );
});

// ─── commit cert replay-idempotence ───────────────────────────────────────────

test("edit-transaction commit cert: content-derived id makes the ledger record replay-idempotent", async () => {
  const repo = await makeGitRepo("et-cert-");
  const baseDir = tempDir("et-cert-snap-");
  const storeDir = tempDir("et-cert-store-");
  try {
    const store = new DurableStore({ dir: storeDir, projectKey: "et-cert", now: (seq) => `t-${seq}` });
    const txn = createEditTransaction({ cwd: repo, allowedPaths: ["src/feature.ts"], baseDir });
    await txn.begin();
    await writeFile(join(repo, "src/feature.ts"), "export const v = 2\n", "utf-8");
    const commit = await txn.commit({ ledger: store });
    assert.equal(commit.ok, true);
    assert.ok(commit.ledgerEntry);
    assert.equal(store.ledgerEntries().length, 1);
    const cert = commit.ledgerEntry;
    assert.ok(cert, "commit cert present");
    assert.equal(typeof cert.id, "string");
    // A replay re-records the SAME cert: deduped by the content-derived id.
    await store.record(cert);
    await store.record(cert);
    assert.equal(store.ledgerEntries().length, 1, "identical certs never re-append");
    assert.equal(store.ledgerEntries()[0].id, cert.id);
    // The cert payload is deterministic — no wall-clock timestamps anywhere.
    assert.deepEqual(
      Object.keys(store.ledgerEntries()[0].detail ?? {}).sort(),
      ["scope", "tests", "transactionId", "treeHash"].sort(),
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("edit-transaction commit cert: runId routes the cert into the run's registered store", async () => {
  const repo = await makeGitRepo("et-runid-");
  const baseDir = tempDir("et-runid-snap-");
  const storeDir = tempDir("et-runid-store-");
  try {
    createRunDurableStore({ runId: "et-run-2", projectKey: "et-runid", dir: storeDir, now: (seq) => `t-${seq}` });
    const txn = createEditTransaction({ cwd: repo, runId: "et-run-2", allowedPaths: ["src/feature.ts"], baseDir });
    assert.equal(txn.transactionId, "et-run-2", "run-bound transactions default to the deterministic runId");
    await txn.begin();
    await writeFile(join(repo, "src/feature.ts"), "export const v = 2\n", "utf-8");
    const commit = await txn.commit();
    assert.equal(commit.ok, true);
    assert.ok(commit.ledgerEntry, "runId alone is a ledger target via recordProvenance");
    const sink = runDurableStore("et-run-2");
    assert.equal(sink?.ledgerEntries().length, 1);
    assert.equal(sink?.ledgerEntries()[0].source, "edit-transaction");
  } finally {
    closeRunDurableStore("et-run-2");
    await rm(repo, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  }
});

// ─── pruning + non-git degradation ────────────────────────────────────────────

test("edit-transaction run sweep: pruneEditTransactionSnapshots removes the runId namespace (idempotent)", async () => {
  const repo = await makeGitRepo("et-prune-");
  const baseDir = tempDir("et-prune-snap-");
  try {
    const txn = createEditTransaction({ cwd: repo, runId: "et-run-3", allowedPaths: [], baseDir });
    await txn.begin();
    assert.ok(existsSync(join(baseDir, "et-run-3")), "snapshot dir created under the runId namespace");
    const removed = await pruneEditTransactionSnapshots("et-run-3", { baseDir });
    assert.deepEqual(removed, [join(baseDir, "et-run-3")]);
    assert.equal(existsSync(join(baseDir, "et-run-3")), false);
    assert.deepEqual(await pruneEditTransactionSnapshots("et-run-3", { baseDir }), [], "idempotent no-op");
    assert.deepEqual(await pruneEditTransactionSnapshots(undefined, { baseDir }), [], "no runId → no-op");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("edit-transaction non-git workspace: scope gate trivially clean; declared files restore from copies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "et-nogit-"));
  const baseDir = tempDir("et-nogit-snap-");
  try {
    await writeFile(join(dir, "notes.md"), "v1\n", "utf-8");
    const txn = createEditTransaction({ cwd: dir, allowedPaths: ["notes.md"], baseDir });
    await txn.begin();
    await writeFile(join(dir, "notes.md"), "v2\n", "utf-8");
    const commit = await txn.commit();
    assert.equal(commit.ok, true, "no git → empty diff → scope clean");
    assert.equal(commit.diff.treeHashChanged, false);

    const txn2 = createEditTransaction({ cwd: dir, allowedPaths: ["notes.md"], baseDir });
    await txn2.begin();
    await writeFile(join(dir, "notes.md"), "v3\n", "utf-8");
    const rollback = await txn2.rollback();
    assert.equal(rollback.clean, true);
    assert.ok(rollback.restored.includes("notes.md"));
    assert.equal(
      readFileSync(join(dir, "notes.md"), "utf-8"),
      "v2\n",
      "rollback restores the transaction's own begin state (the post-commit v2, not the pre-repo v1)",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  }
});

// ─── lifecycle guards ─────────────────────────────────────────────────────────

test("edit-transaction lifecycle guards fail loud on misuse", async () => {
  const repo = await makeGitRepo("et-guards-");
  const baseDir = tempDir("et-guards-snap-");
  try {
    const txn = createEditTransaction({ cwd: repo, allowedPaths: ["src/feature.ts"], baseDir });
    await assert.rejects(txn.commit(), /active transaction/, "commit before begin fails loud");
    await assert.rejects(txn.rollback(), /active transaction/, "rollback before begin fails loud");
    await txn.begin();
    await assert.rejects(txn.begin(), /already called/, "double begin fails loud");
    await writeFile(join(repo, "src/feature.ts"), "export const v = 2\n", "utf-8");
    await assert.rejects(
      txn.commit({ tests: [{ command: "x", assert: { exitCode: 0 } }] }),
      /runStep is required/,
      "tests without a runStep fail loud",
    );
    await txn.rollback();
    await assert.rejects(txn.commit(), /active transaction/, "commit after rollback fails loud");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  }
});
