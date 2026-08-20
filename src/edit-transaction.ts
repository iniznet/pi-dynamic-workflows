/**
 * V2-P03 — edit transaction: pre-edit snapshot, gated commit, rollback.
 *
 * A mutation transaction for gated code-dev edits: `begin` snapshots the
 * pre-edit workspace state (N01 fingerprint + exact file copies under
 * getAgentDir()), the caller runs its edit agents, then `commit` runs a
 * MACHINE gate — testGate-style postconditions + the N01 scope-clean
 * assertion; on gate failure the workspace is ROLLED BACK to the exact
 * pre-edit state (never left partially edited) and the rollback diff is
 * reported.
 *
 * Foundation: the N01 fingerprint machinery (captureWorkspaceFingerprint /
 * diffWorkspaceFingerprints / workspaceScopeViolations in workflow-manager.ts)
 * — the same read-only git capture the phase machine uses, so the transaction
 * never stages/commits/resets while measuring. Rollback is a deliberate
 * restore: dirty-at-begin files are written back from their captured copies,
 * clean tracked files are restored from the captured begin-tree blob
 * (`git restore --source=<begin tree>`, byte-exact, no commit/stash), and
 * files created during the edit are removed.
 *
 * Auto test-scope: impact-scope (P08) emits `testScope` per partition slice
 * with zero consumers — deriveTestGateTestsFromScope / testScopeFromPartition
 * consume it into testGate test commands so the commit gate self-scopes to
 * the tests that cover the edit.
 *
 * Evidence commit cert: a successful commit records one ProvenanceEntry into
 * the run's durable-store ledger with a content-derived stable id — the SAME
 * cert re-recorded (replay / a re-run commit) dedupes and never re-appends.
 *
 * Determinism: the snapshot manifest, the commit-cert payload, and every
 * machine verdict are pure functions of workspace/script inputs — no
 * wall-clock timestamps or RNG in anything that could join a replay identity.
 * Crash safety follows the durable-store pattern: the manifest is written
 * atomically (tmp + rename).
 */

import { rmdirSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type DurableStore, type ProvenanceEntry, provenanceContentId, recordProvenance } from "./durable-store.js";
import {
  ensureDir,
  type PersistenceFsLayer,
  resolvePersistenceFs,
  writeJsonAtomicWithBackup,
} from "./fs-persistence.js";
import type { ImpactPartition } from "./impact-scope.js";
import {
  capTestGateOutput,
  machineValidateTest,
  type TestGateStepResult,
  type TestGateTest,
  type TestGateTool,
  validateTestGateTests,
} from "./test-gate.js";
import {
  captureWorkspaceFingerprint,
  diffWorkspaceFingerprints,
  parseGitStatusLine,
  type WorkspaceFingerprint,
  type WorkspaceScopeDiff,
  workspaceScopeAllowedPaths,
  workspaceScopeViolations,
} from "./workflow-manager.js";
import { workflowProjectKey } from "./workflow-paths.js";
import { gitExec } from "./worktree.js";

/** Subdirectory under getAgentDir() where edit-transaction snapshots live. */
export const EDIT_TRANSACTION_SUBDIR = "edit-transactions";

/** Phase label passed to the N01 fingerprint capture (host-side, outside a phase machine). */
export const EDIT_TRANSACTION_FINGERPRINT_PHASE = 0 as const;

/** Cap on files copied into one snapshot manifest (beyond → begin fails loud). */
export const EDIT_TRANSACTION_MAX_SNAPSHOT_FILES = 2_000;

/** Cap on bytes per snapshotted file (beyond → begin fails loud, no partial state). */
export const EDIT_TRANSACTION_MAX_SNAPSHOT_FILE_BYTES = 32 * 1024 * 1024;

/**
 * Default testScope → command derivation: the repo-consistent node:test
 * invocation with the tsx loader (the same documented fallback
 * scripts/run-tests.mjs uses). Deterministic; hosts with another runner pass
 * a custom `commandFor`.
 */
export const DEFAULT_TEST_SCOPE_COMMAND = (file: string): string => `node --import tsx --test ${file}`;

/** The fs surface the transaction needs (PersistenceFsLayer + recursive rmdir). */
export type EditTransactionFs = PersistenceFsLayer & { rmdirSync: typeof rmdirSync };

/** One pre-edit snapshot manifest (atomic JSON under getAgentDir()). */
export interface EditTransactionSnapshot {
  transactionId: string;
  /** Namespace key (runId when run-bound, else the cwd project key). */
  namespace: string;
  cwd: string;
  /** Repo root resolved at begin (rollback's git-restore anchor); null outside a repo. */
  repoRoot: string | null;
  /** The begin N01 fingerprint (read-only capture — the rollback baseline). */
  before: WorkspaceFingerprint;
  /** The declared N01 allowed paths snapshot (commit's scope-clean assertion default). */
  allowedPaths: readonly string[];
  /** base64 file copies: cwd-relative "/"-separated path → content. */
  files: Record<string, string>;
}

/** Transaction lifecycle states. */
export type EditTransactionState = "new" | "active" | "committed" | "rolled-back";

/** Options for {@link createEditTransaction}. */
export interface EditTransactionOptions {
  /** The workspace the edit happens in (repo root or a subdir). */
  cwd: string;
  /** Declared N01 allowed paths (workspaceScopeAllowedPaths adds the ".pi/" default). */
  allowedPaths?: readonly string[];
  /** Stable transaction id (default: derived from the namespace + a per-process counter). */
  transactionId?: string;
  /** Run identity: snapshot dir is namespaced under `<runId>` and the commit cert routes via recordProvenance. */
  runId?: string;
  /** Override the snapshot base dir (defaults to getAgentDir()/edit-transactions). */
  baseDir?: string;
  /** Test seam for the fs layer. */
  fs?: Partial<PersistenceFsLayer>;
}

/** Result of a successful begin(). */
export interface EditTransactionBeginResult {
  transactionId: string;
  snapshotDir: string;
  snapshot: EditTransactionSnapshot;
  /** Files copied into the manifest (cwd-relative paths). */
  snapshottedFiles: string[];
}

/** Options for one {@link EditTransaction.commit} call. */
export interface EditTransactionCommitOptions {
  /** testGate-style postconditions (auto-derivable via deriveTestGateTestsFromScope). */
  tests?: TestGateTest[];
  tool?: TestGateTool;
  /**
   * Executes one machine test and returns the captured `{ exitCode?, output }`.
   * REQUIRED when tests are supplied — the transaction is host-side and command
   * execution is the caller's channel (e.g. a testGate subagent step or a
   * direct exec). Absent + no tests = a scope-only gate.
   */
  runStep?: (test: TestGateTest, tool: TestGateTool) => Promise<unknown>;
  /** N01 allowed paths for the scope-clean assertion (default: the declared scope). */
  allowedPaths?: readonly string[];
  /**
   * Provenance ledger target: a DurableStore instance (its record() is used) or
   * a runId (recordProvenance routes to the run's registered sink). The commit
   * cert is recorded only when a target is present — never silently dropped.
   */
  ledger?: DurableStore;
  runId?: string;
}

/** Result of a commit (ok=false implies an automatic full rollback). */
export interface EditTransactionCommitResult {
  ok: boolean;
  state: "committed" | "rolled-back";
  diff: WorkspaceScopeDiff;
  /** N01 scope violations that failed the gate (empty on success). */
  violations: string[];
  /** Per-test machine verdicts (empty when no tests were supplied). */
  testResults: TestGateStepResult[];
  /** The recorded commit cert (present only when a ledger target was supplied). */
  ledgerEntry?: ProvenanceEntry;
  /** Gate failure detail (the rollback reason). */
  reason?: string;
}

/** Result of a rollback (restores exactly, failures never silent). */
export interface EditTransactionRollbackResult {
  state: "rolled-back";
  diff: WorkspaceScopeDiff;
  /** Paths restored from snapshot copies or begin-tree blobs. */
  restored: string[];
  /** Paths that appeared during the edit and were removed. */
  deleted: string[];
  /** Restore failures (reported — a failed restore still surfaces, never silent). */
  failures: Array<{ path: string; error: string }>;
  /** True when every restore completed without failure. */
  clean: boolean;
}

/** The transaction surface returned by {@link createEditTransaction}. */
export interface EditTransaction {
  readonly transactionId: string;
  readonly state: EditTransactionState;
  /** The captured manifest (after begin, null before). */
  readonly snapshot: EditTransactionSnapshot | null;
  begin(): Promise<EditTransactionBeginResult>;
  commit(options?: EditTransactionCommitOptions): Promise<EditTransactionCommitResult>;
  rollback(): Promise<EditTransactionRollbackResult>;
  /** Current machine scope diff vs the begin baseline (read-only). */
  scopeDiff(): Promise<WorkspaceScopeDiff>;
}

let transactionSeq = 0;

/**
 * Create an edit transaction over `cwd`. The transaction is host-side state
 * (never part of any agent() resume identity) and scratch (pruned at run
 * sweep via {@link pruneEditTransactionSnapshots}).
 */
export function createEditTransaction(options: EditTransactionOptions): EditTransaction {
  const cwd = resolve(options.cwd);
  // rmdirSync is NOT part of the shared PersistenceFsLayer surface (recursive
  // deletion is this module's own need) — layer the real one on top so the
  // run-sweep cleanup works on the default layer too.
  const fs = { ...resolvePersistenceFs(options.fs), rmdirSync } as EditTransactionFs;
  const runId = options.runId;
  const namespace = runId ?? workflowProjectKey(cwd);
  const baseDir = resolve(options.baseDir ?? join(getAgentDir(), EDIT_TRANSACTION_SUBDIR));
  // Run-bound transactions default to the runId as their id — deterministic
  // across replays (a resumed/re-driven transaction with the same runId
  // produces the SAME commit-cert content identity, so the ledger dedupes).
  // Callers running multiple transactions in one run pass an explicit id.
  const transactionId = options.transactionId ?? (runId !== undefined ? runId : `${namespace}-${++transactionSeq}`);
  const snapshotDir = join(baseDir, namespace, transactionId);
  const manifestPath = join(snapshotDir, "snapshot.json");
  const declaredAllowed = options.allowedPaths ?? [];

  let state: EditTransactionState = "new";
  let snapshot: EditTransactionSnapshot | null = null;

  /** Whether a git-status path refers to the transaction's own scratch dir. */
  const isSnapshotPath = (rel: string): boolean => {
    const baseRel = relative(cwd, baseDir).split(sep).join("/");
    if (baseRel === ".." || baseRel.startsWith("../")) return false; // scratch dir outside the workspace
    return rel === baseRel || rel.startsWith(`${baseRel}/`);
  };

  /** The declared allowed SUBTREE prefixes (e.g. ".pi/", "dist/") — runtime/output dirs. */
  const allowedSubtreePrefixes = (allowed: readonly string[]): string[] =>
    workspaceScopeAllowedPaths(allowed)
      .filter((entry) => entry.endsWith("/"))
      .map((entry) => entry.slice(0, -1));

  const dropSnapshotPaths = (diff: WorkspaceScopeDiff): WorkspaceScopeDiff => ({
    added: diff.added.filter((path) => !isSnapshotPath(path)),
    removed: diff.removed.filter((path) => !isSnapshotPath(path)),
    modified: diff.modified.filter((path) => !isSnapshotPath(path)),
    treeHashChanged: diff.treeHashChanged,
  });

  const isWithinCwd = (target: string): boolean => {
    const rel = relative(cwd, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };

  const begin = async (): Promise<EditTransactionBeginResult> => {
    if (state !== "new") {
      throw new Error(`edit-transaction ${transactionId}: begin() already called (state=${state})`);
    }
    const before = await captureWorkspaceFingerprint(cwd, EDIT_TRANSACTION_FINGERPRINT_PHASE);
    const repoRoot = await resolveRepoRoot(cwd);
    const files: Record<string, string> = {};
    const baseRel = relative(cwd, baseDir).split(sep).join("/");
    // Exclude only when the scratch dir is INSIDE the workspace (git paths can
    // never reference it otherwise) — a base dir outside cwd excludes nothing.
    const exclude = (rel: string): boolean => {
      if (baseRel === ".." || baseRel.startsWith("../")) return false;
      return rel === baseRel || rel.startsWith(`${baseRel}/`) || !isWithinCwd(join(cwd, rel));
    };
    const paths = new Set<string>();
    for (const line of before.gitStatus) {
      const { path } = parseGitStatusLine(line);
      if (path && !exclude(path)) paths.add(path);
    }
    for (const entry of declaredAllowed) {
      const normalized = entry.trim().replace(/\\/g, "/");
      if (!normalized || normalized.endsWith("/") || exclude(normalized)) continue;
      paths.add(normalized);
    }
    for (const rel of [...paths].sort()) {
      if (Object.keys(files).length >= EDIT_TRANSACTION_MAX_SNAPSHOT_FILES) {
        throw new Error(
          `edit-transaction ${transactionId}: snapshot exceeds ${EDIT_TRANSACTION_MAX_SNAPSHOT_FILES} files; narrow the declared scope or split the edit`,
        );
      }
      const abs = join(cwd, rel);
      if (!fs.existsSync(abs)) continue;
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      const content = fs.readFileSync(abs);
      if (content.byteLength > EDIT_TRANSACTION_MAX_SNAPSHOT_FILE_BYTES) {
        throw new Error(
          `edit-transaction ${transactionId}: snapshot file ${rel} exceeds ${EDIT_TRANSACTION_MAX_SNAPSHOT_FILE_BYTES} bytes; exclude it from the transaction scope`,
        );
      }
      files[rel] = content.toString("base64");
    }
    snapshot = {
      transactionId,
      namespace,
      cwd,
      repoRoot,
      before,
      allowedPaths: [...declaredAllowed],
      files,
    };
    // Crash-safe manifest: tmp + rename (the durable-store atomic-write pattern).
    ensureDir(fs, snapshotDir);
    writeJsonAtomicWithBackup(fs, manifestPath, snapshot);
    state = "active";
    return { transactionId, snapshotDir, snapshot, snapshottedFiles: Object.keys(files) };
  };

  /**
   * Read the begin-tree blob for a clean tracked file (byte-exact restore via
   * `git restore --source=<begin tree>`), or null when the path was not in the
   * begin tree (it was created during the edit → rollback deletes it).
   */
  const gitRestoreFile = async (rel: string): Promise<boolean> => {
    if (snapshot === null || snapshot.repoRoot === null || snapshot.before.treeHash === null) return false;
    try {
      await gitExec(["-C", cwd, "restore", "--source", snapshot.before.treeHash, "--worktree", "--", rel]);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Roll back to the exact pre-edit state. Every changed path is handled:
   * snapshot copies win (dirty-at-begin / declared files), else the begin-tree
   * blob (clean tracked files), else the path is removed (created during the
   * edit) UNLESS it lives under a declared allowed subtree (runtime/output
   * dirs are the sanctioned surface, never deleted). Failures are collected
   * and reported — a failed restore never silently leaves partial state.
   */
  const doRollback = async (after: WorkspaceFingerprint): Promise<EditTransactionRollbackResult> => {
    if (snapshot === null) {
      throw new Error(`edit-transaction ${transactionId}: rollback requires a begun transaction`);
    }
    const diff = dropSnapshotPaths(diffWorkspaceFingerprints(snapshot.before, after));
    const allowedPrefixes = allowedSubtreePrefixes(snapshot.allowedPaths);
    const underAllowedSubtree = (rel: string): boolean =>
      allowedPrefixes.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
    const set = new Set<string>([...diff.added, ...diff.modified, ...diff.removed]);
    // Declared exact scoped files with captured copies: compare current bytes
    // against the snapshot to catch edits to files git ignores (never listed
    // in porcelain status, so invisible to the diff).
    for (const rel of Object.keys(snapshot.files)) {
      if (set.has(rel)) continue;
      const abs = join(cwd, rel);
      let current: Buffer | null = null;
      try {
        if (fs.existsSync(abs)) current = fs.readFileSync(abs);
      } catch {
        current = null;
      }
      const copy = Buffer.from(snapshot.files[rel], "base64");
      if (current === null || !current.equals(copy)) set.add(rel);
    }
    const restored: string[] = [];
    const deleted: string[] = [];
    const failures: Array<{ path: string; error: string }> = [];
    for (const rel of [...set].sort()) {
      const abs = join(cwd, rel);
      try {
        const copy = snapshot.files[rel];
        if (copy !== undefined) {
          fs.writeFileSync(abs, Buffer.from(copy, "base64"));
          restored.push(rel);
        } else if (await gitRestoreFile(rel)) {
          restored.push(rel);
        } else if (underAllowedSubtree(rel)) {
          // Created during the edit under a declared allowed subtree — the
          // sanctioned runtime/output surface, left in place.
        } else if (fs.existsSync(abs)) {
          fs.unlinkSync(abs);
          deleted.push(rel);
        }
      } catch (error) {
        failures.push({ path: rel, error: error instanceof Error ? error.message : String(error) });
      }
    }
    state = "rolled-back";
    return { state: "rolled-back", diff, restored, deleted, failures, clean: failures.length === 0 };
  };

  const commit = async (options: EditTransactionCommitOptions = {}): Promise<EditTransactionCommitResult> => {
    if (state !== "active" || snapshot === null) {
      throw new Error(`edit-transaction ${transactionId}: commit() requires an active transaction (state=${state})`);
    }
    const tool: TestGateTool = options.tool ?? "bash";
    const tests = options.tests ?? [];
    const runStep = options.runStep;
    const after = await captureWorkspaceFingerprint(cwd, EDIT_TRANSACTION_FINGERPRINT_PHASE);
    const diff = dropSnapshotPaths(diffWorkspaceFingerprints(snapshot.before, after));
    const allowed = workspaceScopeAllowedPaths(options.allowedPaths ?? snapshot.allowedPaths);
    const violations = workspaceScopeViolations(diff, allowed);
    const testResults: TestGateStepResult[] = [];
    let ok = violations.length === 0;
    if (ok && tests.length > 0) {
      if (runStep === undefined) {
        throw new TypeError(
          "edit-transaction commit(): a runStep is required when tests are supplied (the host-side command execution channel)",
        );
      }
      for (const test of validateTestGateTests(tests, tool)) {
        let step: unknown = null;
        try {
          step = await runStep(test, tool);
        } catch {
          step = null; // a failed step is machine-validated fail-closed below
        }
        const outcome = machineValidateTest(step, test.assert);
        const capture = step !== null && typeof step === "object" ? (step as Record<string, unknown>) : {};
        testResults.push({
          command: test.command,
          passed: outcome.passed,
          detail: outcome.detail,
          exitCode: typeof capture.exitCode === "number" ? capture.exitCode : null,
          output: typeof capture.output === "string" ? capTestGateOutput(capture.output) : "",
        });
        if (!outcome.passed) ok = false;
      }
    }
    if (!ok) {
      // Gate failure ALWAYS attempts rollback — the workspace is never left
      // partially edited, and the rollback diff is the evidence report.
      const rollback = await doRollback(after);
      return {
        ok: false,
        state: "rolled-back",
        diff: rollback.diff,
        violations,
        testResults,
        reason:
          violations.length > 0
            ? `workspace scope violations: ${violations.join(", ")}`
            : `machine postcondition(s) failed: ${testResults
                .filter((result) => !result.passed)
                .map((result) => result.detail)
                .join("; ")}`,
      };
    }
    const ledgerEntry = await recordCommitCert(diff, testResults, options);
    state = "committed";
    return {
      ok: true,
      state: "committed",
      diff,
      violations,
      testResults,
      ...(ledgerEntry !== undefined ? { ledgerEntry } : {}),
    };
  };

  /**
   * Evidence commit cert: one content-derived ProvenanceEntry recording the
   * mutation transaction. The id is a pure function of the transaction's
   * deterministic facts (no timestamps, no wall clock), so a re-recorded
   * identical cert dedupes in the ledger (replay-idempotent) and a changed
   * transaction produces a distinct entry. Best-effort: provenance is
   * observability, never a reason to fail the commit.
   */
  const recordCommitCert = async (
    diff: WorkspaceScopeDiff,
    testResults: TestGateStepResult[],
    options: EditTransactionCommitOptions,
  ): Promise<ProvenanceEntry | undefined> => {
    if (snapshot === null) return undefined;
    // The transaction's own runId is the default ledger route (the commit
    // options may override it with an explicit store/runId).
    const ledgerRunId = options.runId ?? runId;
    if (options.ledger === undefined && ledgerRunId === undefined) return undefined;
    const scope = {
      added: diff.added,
      removed: diff.removed,
      modified: diff.modified,
      treeHashChanged: diff.treeHashChanged,
    };
    const tests = testResults.map((result) => ({ command: result.command, passed: result.passed }));
    const entry: ProvenanceEntry = {
      id: provenanceContentId({
        source: "edit-transaction",
        transactionId: snapshot.transactionId,
        cwd: snapshot.cwd,
        treeHash: snapshot.before.treeHash,
        scope,
        tests,
      }),
      source: "edit-transaction",
      detail: { transactionId: snapshot.transactionId, treeHash: snapshot.before.treeHash, scope, tests },
    };
    try {
      if (options.ledger !== undefined) await options.ledger.record(entry);
      else if (ledgerRunId !== undefined) await recordProvenance(ledgerRunId, entry);
    } catch {
      // provenance is best-effort
    }
    return entry;
  };

  const rollback = async (): Promise<EditTransactionRollbackResult> => {
    if (state !== "active" || snapshot === null) {
      throw new Error(`edit-transaction ${transactionId}: rollback() requires an active transaction (state=${state})`);
    }
    const after = await captureWorkspaceFingerprint(cwd, EDIT_TRANSACTION_FINGERPRINT_PHASE);
    return doRollback(after);
  };

  const scopeDiff = async (): Promise<WorkspaceScopeDiff> => {
    if (snapshot === null) {
      throw new Error(`edit-transaction ${transactionId}: scopeDiff() requires a begun transaction`);
    }
    const after = await captureWorkspaceFingerprint(cwd, EDIT_TRANSACTION_FINGERPRINT_PHASE);
    return dropSnapshotPaths(diffWorkspaceFingerprints(snapshot.before, after));
  };

  return {
    get transactionId() {
      return transactionId;
    },
    get state() {
      return state;
    },
    get snapshot() {
      return snapshot;
    },
    begin,
    commit,
    rollback,
    scopeDiff,
  };
}

/**
 * Resolve the git repo root for `cwd` (read-only, best-effort) — the rollback
 * anchor for `git restore --source=<begin tree>`. Null outside a repo.
 */
export async function resolveRepoRoot(cwd: string): Promise<string | null> {
  try {
    const root = (await gitExec(["-C", cwd, "rev-parse", "--show-toplevel"])).trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Flatten an impact partition's emitted `testScope` (P08) into a deduped,
 * deterministic file list — the consumed half of the auto test-scope feature.
 */
export function testScopeFromPartition(partition: ImpactPartition): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slice of partition.slices) {
    for (const file of slice.testScope) {
      const trimmed = file.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Auto test-scope: derive testGate test commands from impact-scope's emitted
 * `testScope` file list. `commandFor` maps a test file to its runnable command
 * (default {@link DEFAULT_TEST_SCOPE_COMMAND}); each derived test asserts a
 * clean exit (the standard machine postcondition for a test run).
 */
export function deriveTestGateTestsFromScope(
  testScope: readonly string[],
  commandFor: (file: string) => string = DEFAULT_TEST_SCOPE_COMMAND,
): TestGateTest[] {
  return testScope.map((file) => ({
    command: commandFor(file.trim()),
    assert: { exitCode: 0 },
  }));
}

/** Convenience: flatten an impact partition and derive its testGate tests. */
export function deriveTestGateTestsFromPartition(
  partition: ImpactPartition,
  commandFor?: (file: string) => string,
): TestGateTest[] {
  return deriveTestGateTestsFromScope(testScopeFromPartition(partition), commandFor);
}

/**
 * Recursively remove a snapshot directory (the run-sweep cleanup). Best-effort.
 */
function removePathRecursive(fs: EditTransactionFs, target: string): void {
  const stat: Stats = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) removePathRecursive(fs, join(target, name));
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
}

/**
 * V2-P03 run sweep: remove every edit-transaction snapshot dir namespaced
 * under `runId` (`getAgentDir()/edit-transactions/<runId>`). No-op when the
 * run never created a transaction. Best-effort — snapshot cleanup is hygiene,
 * never a reason to fail the run's settle.
 */
export async function pruneEditTransactionSnapshots(
  runId?: string,
  options?: { baseDir?: string; fs?: Partial<PersistenceFsLayer> },
): Promise<string[]> {
  if (runId === undefined) return [];
  const fs = { ...resolvePersistenceFs(options?.fs), rmdirSync } as EditTransactionFs;
  const baseDir = resolve(options?.baseDir ?? join(getAgentDir(), EDIT_TRANSACTION_SUBDIR));
  const target = join(baseDir, runId);
  if (!fs.existsSync(target)) return [];
  try {
    removePathRecursive(fs, target);
    return [target];
  } catch {
    return [];
  }
}
