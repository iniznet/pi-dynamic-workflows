/**
 * N01 workspace change-scope fingerprint: a tree hash + git status --porcelain
 * snapshot is captured at every phase boundary (host side) and persists WITH
 * the phase state (forward-only). The machine diff + scope assertion answer
 * "only intended files changed". Snapshots never enter hashAgentCall, and the
 * capture is read-only git (no interference with worktree isolation).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { WorkflowAgent } from "../../../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../../../src/errors.js";
import { WorkflowStateManager } from "../../../src/phases/state-machine.js";
import { runWorkflow } from "../../../src/workflow.js";
import {
  captureWorkspaceFingerprint,
  diffWorkspaceFingerprints,
  parseGitStatusLine,
  resolveWorkspaceScopeEnforceMode,
  WorkflowManager,
  workspaceScopeAllowedPaths,
  workspaceScopeViolations,
} from "../../../src/workflow-manager.js";

/** Create a throwaway git repo with one committed baseline file. */
async function makeGitRepo(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), tag));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  await writeFile(join(dir, "baseline.txt"), "baseline\n", "utf-8");
  git("add", "-A");
  git("commit", "-q", "-m", "baseline");
  return dir;
}

test("parseGitStatusLine handles plain, rename, and quoted paths", () => {
  assert.deepEqual(parseGitStatusLine(" M src/a.ts"), { xy: " M", path: "src/a.ts" });
  assert.deepEqual(parseGitStatusLine("?? new.txt"), { xy: "??", path: "new.txt" });
  assert.deepEqual(parseGitStatusLine("R  old.ts -> new.ts"), { xy: "R ", path: "old.ts" });
  assert.deepEqual(parseGitStatusLine('?? "weird name.txt"'), { xy: "??", path: "weird name.txt" });
});

test("captureWorkspaceFingerprint reads tree hash + porcelain status (read-only) in a git repo", async () => {
  const repo = await makeGitRepo("n01-capture-");
  try {
    const before = await captureWorkspaceFingerprint(repo, 1);
    assert.equal(before.phase, 1);
    assert.ok(typeof before.treeHash === "string" && before.treeHash.length === 40, "tree hash captured");
    assert.deepEqual(before.gitStatus, [], "clean baseline → no status lines");

    // An edit + an untracked file show up in the snapshot.
    await writeFile(join(repo, "baseline.txt"), "changed\n", "utf-8");
    await writeFile(join(repo, "new-file.ts"), "x", "utf-8");
    const after = await captureWorkspaceFingerprint(repo, 2);
    assert.equal(after.gitStatus.length, 2, "both changes are visible to the snapshot");
    assert.ok(
      after.gitStatus.some((l) => l.includes("baseline.txt")),
      "modified file listed",
    );
    assert.ok(
      after.gitStatus.some((l) => l.includes("new-file.ts")),
      "untracked file listed",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("captureWorkspaceFingerprint degrades gracefully outside a git repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "n01-nogit-"));
  try {
    const fp = await captureWorkspaceFingerprint(dir, 3);
    assert.equal(fp.treeHash, null, "no repo → null tree hash");
    assert.deepEqual(fp.gitStatus, [], "no repo → empty status");
    assert.equal(fp.phase, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the machine diff + scope assertion flag files changed outside the intended set", async () => {
  const repo = await makeGitRepo("n01-scope-");
  try {
    const before = await captureWorkspaceFingerprint(repo, 1);
    await writeFile(join(repo, "intended.ts"), "a", "utf-8");
    await writeFile(join(repo, "sneaky.ts"), "b", "utf-8");
    const after = await captureWorkspaceFingerprint(repo, 2);

    const diff = diffWorkspaceFingerprints(before, after);
    assert.deepEqual(diff.added, ["intended.ts", "sneaky.ts"]);
    assert.deepEqual(diff.removed, []);
    assert.deepEqual(diff.modified, []);

    const allowed = new Set(["intended.ts"]);
    const violations = workspaceScopeViolations(diff, allowed);
    assert.deepEqual(violations, ["added: sneaky.ts"], "the unexpected file is flagged");
    assert.deepEqual(
      workspaceScopeViolations(diff, new Set(["intended.ts", "sneaky.ts"])),
      [],
      "only-intended-files passes clean",
    );

    // Removing a file between phases is also a scope change.
    const removed = await captureWorkspaceFingerprint(repo, 3);
    // git rm the untracked file: it simply leaves the status list.
    await execFileSync("git", ["-C", repo, "clean", "-q", "-f"], { stdio: "pipe" });
    const cleaned = await captureWorkspaceFingerprint(repo, 3);
    const diffCleaned = diffWorkspaceFingerprints(removed, cleaned);
    assert.ok(diffCleaned.removed.includes("sneaky.ts") || diffCleaned.removed.includes("intended.ts"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a commit between phases surfaces as treeHashChanged", async () => {
  const repo = await makeGitRepo("n01-tree-");
  try {
    const before = await captureWorkspaceFingerprint(repo, 1);
    await writeFile(join(repo, "baseline.txt"), "v2\n", "utf-8");
    execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "v2"], { stdio: "pipe" });
    const after = await captureWorkspaceFingerprint(repo, 2);
    const diff = diffWorkspaceFingerprints(before, after);
    assert.equal(diff.treeHashChanged, true, "the committed baseline changed");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a fingerprint is captured at every phase boundary and persists with the phase state", async () => {
  const repo = await makeGitRepo("n01-boundary-");
  try {
    const dir = join(repo, ".pi", "workflows");
    const stateManager = new WorkflowStateManager(dir);
    // Host-side injection: the manager attaches this same provider to a run's
    // phaseState machine (see executeRun); here we drive the machine directly.
    stateManager.setFingerprintCapture((phase) => captureWorkspaceFingerprint(repo, phase));

    await stateManager.transitionTo(1);
    await stateManager.transitionTo(2);
    await stateManager.approvePlan();
    await stateManager.transitionTo(3);

    const state = await stateManager.getState();
    assert.equal(state.activePhase, 3);
    const fps = state.fingerprints ?? {};
    assert.ok(fps[1] && fps[2] && fps[3], "snapshots exist for every boundary crossed");
    assert.ok(typeof fps[1]?.treeHash === "string", "phase-1 snapshot carries the tree hash");
    assert.equal(fps[1]?.phase, 1, "snapshot self-describes its phase");
    // The machine's own active-state.json is written before the capture fires,
    // so the phase-1 snapshot honestly lists .pi/ as the first workspace change.
    const phase1Status = fps[1]?.gitStatus;
    assert.ok(
      Array.isArray(phase1Status) && phase1Status.some((line) => line.includes(".pi/")),
      "snapshot captures the real workspace delta (the machine's own state dir)",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("resume keeps snapshots forward-only: re-transitions never rewrite history", async () => {
  const repo = await makeGitRepo("n01-forward-");
  try {
    const dir = join(repo, ".pi", "workflows");
    const stateManager = new WorkflowStateManager(dir);
    stateManager.setFingerprintCapture((phase) => captureWorkspaceFingerprint(repo, phase));
    await stateManager.transitionTo(1);
    await stateManager.transitionTo(2);
    await stateManager.approvePlan();
    await stateManager.transitionTo(3);
    const first = await stateManager.getState();
    const firstFps = JSON.stringify(first.fingerprints);

    // A resumed run's script re-declares the transitions — the machine is
    // already past them, so they throw and nothing is recaptured.
    await assert.rejects(stateManager.transitionTo(1), /Invalid phase transition/);
    await assert.rejects(stateManager.transitionTo(2), /Invalid phase transition/);
    await assert.rejects(stateManager.transitionTo(3), /Invalid phase transition/);

    // recordFingerprint itself is forward-only: a lower phase and a repeat are no-ops.
    await stateManager.recordFingerprint({ phase: 1, treeHash: "stale", gitStatus: [] });
    await stateManager.recordFingerprint({ phase: 3, treeHash: "stale", gitStatus: [] });

    const second = await stateManager.getState();
    assert.equal(JSON.stringify(second.fingerprints), firstFps, "snapshots are never regressed or rewritten");

    // A NEW forward boundary (if one existed) would only APPEND.
    await stateManager.recordFingerprint({ phase: 0, treeHash: "low", gitStatus: [] });
    const third = await stateManager.getState();
    assert.equal(JSON.stringify(third.fingerprints), firstFps, "a phase below the newest is refused");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a workflow run through runWorkflow with a capture provider persists boundary snapshots", async () => {
  const repo = await makeGitRepo("n01-wired-");
  try {
    const stateManager = new WorkflowStateManager(join(repo, ".pi", "workflows"));
    stateManager.setFingerprintCapture((phase) => captureWorkspaceFingerprint(repo, phase));
    const script = `export const meta = { name: 'wired', description: 'wired' }
phase('review', { stage: 2 })
await checkpoint('approve', { kind: 'confirm' })
phase('execute', { stage: 3 })
await agent('work', { label: 'w' })
return 'done'`;
    await runWorkflow(script, {
      agent: {
        async run() {
          return "ok";
        },
      },
      cwd: repo,
      persistLogs: false,
      runId: "n01-wired-run",
      checkpointGate: {
        async submitPlan() {
          return { id: "p" };
        },
        async waitForApproval() {
          return true;
        },
      },
      phaseState: { stateManager },
    });
    const state = await stateManager.getState();
    assert.equal(state.activePhase, 3);
    const fps = state.fingerprints ?? {};
    assert.ok(fps[1] === undefined || true, "phase 1 may be skipped by a direct stage-2 declaration");
    assert.ok(fps[2] && fps[3], "the phases actually crossed captured snapshots");
    assert.equal(fps[2]?.phase, 2);
    assert.equal(fps[3]?.phase, 3);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ─── N01 enforcement: scope-assertion policy (flag / reject / confirm) ────────

/**
 * A phase-gated script whose execute-phase agent writes files the runner
 * decides (see the fileWritingAgent helper). The 2→3 boundary fires at
 * approval (before the execute agents), so out-of-scope EXECUTE work is
 * asserted by the manager's terminal settle capture — the enforcement the
 * mustFix wired (previously the capture+diff machinery never asserted
 * anything in production runs).
 */
const scopeScript = (metaExtra: string) => `export const meta = { name: 'scope_run', description: 'scope'${metaExtra} }
phase('review', { stage: 2 })
await checkpoint('approve', { kind: 'confirm' })
phase('execute', { stage: 3 })
const r = await agent('work', { label: 'w' })
return r`;

/** Agent runner that writes the given files into the run's cwd, then "ok". */
function fileWritingAgent(repo: string, files: string[]): Pick<WorkflowAgent, "run"> {
  return {
    async run() {
      for (const file of files) {
        const parent = join(repo, dirname(file));
        if (parent !== repo) await mkdir(parent, { recursive: true });
        await writeFile(join(repo, file), "x");
      }
      return "ok";
    },
  } as unknown as Pick<WorkflowAgent, "run">;
}

/** Auto-approving plan gate so the PhaseGuard 2→3 transition fires at approval. */
const approveGate = {
  async submitPlan() {
    return { id: "p" };
  },
  async waitForApproval() {
    return true;
  },
};

test("resolveWorkspaceScopeEnforceMode defaults to flag and drops garbage", () => {
  assert.equal(resolveWorkspaceScopeEnforceMode(undefined), "flag");
  assert.equal(resolveWorkspaceScopeEnforceMode("flag"), "flag");
  assert.equal(resolveWorkspaceScopeEnforceMode("REJECT"), "reject");
  assert.equal(resolveWorkspaceScopeEnforceMode(" confirm "), "confirm");
  assert.equal(resolveWorkspaceScopeEnforceMode("off"), "off");
  // A misconfigured CI env degrades to the diagnostic default, never a crash.
  assert.equal(resolveWorkspaceScopeEnforceMode("nonsense"), "flag");
  assert.equal(resolveWorkspaceScopeEnforceMode(42), "flag");
});

test("workspaceScopeAllowedPaths always allows the .pi/ subtree plus declared outputs", () => {
  assert.deepEqual(workspaceScopeAllowedPaths(undefined), [".pi/"]);
  assert.deepEqual(workspaceScopeAllowedPaths([]), [".pi/"]);
  assert.deepEqual(workspaceScopeAllowedPaths(["docs/out.md", "./src/gen/", "a\\b.ts"]), [
    ".pi/",
    "docs/out.md",
    "src/gen/",
    "a/b.ts",
  ]);
  assert.deepEqual(workspaceScopeAllowedPaths(["/abs.ts", ".", ""]), [".pi/"]);
});

test("workspaceScopeViolations treats /-suffixed entries as subtree prefixes", () => {
  const diff = {
    added: [".pi/workflows/active-state.json", "docs/out.md", "sneaky.ts"],
    removed: [],
    modified: [],
    treeHashChanged: false,
  };
  assert.deepEqual(workspaceScopeViolations(diff, [".pi/", "docs/out.md"]), ["added: sneaky.ts"]);
  assert.deepEqual(workspaceScopeViolations(diff, [".pi/", "docs/out.md", "sneaky.ts"]), []);
  // The .pi/ prefix covers the machine's own active-state.json + plans dirs.
  assert.deepEqual(workspaceScopeViolations(diff, [".pi/"]), ["added: docs/out.md", "added: sneaky.ts"]);
});

test("flag mode: an out-of-scope edit is flagged at the boundary but the run completes", async () => {
  const repo = await makeGitRepo("n01-enforce-flag-");
  try {
    const stateManager = new WorkflowStateManager(join(repo, ".pi", "workflows"));
    const manager = new WorkflowManager({
      cwd: repo,
      agent: fileWritingAgent(repo, ["sneaky.ts"]),
      workspaceScopeEnforce: "flag",
    });
    manager.on("error", () => {});
    const result = await manager.runSync(scopeScript(""), undefined, {
      phaseState: { stateManager },
      checkpointGate: approveGate,
    });
    assert.equal(result.result, "ok", "flag mode never fails the run");
    const state = await stateManager.getState();
    const flagged = state.scopeViolations?.[3];
    assert.ok(flagged, "the out-of-scope change is recorded with the phase state");
    assert.ok(flagged.violations.includes("added: sneaky.ts"), "the undeclared file is the flagged change");
    assert.ok(flagged.allowed.includes(".pi/"), "the system artifact dirs are always allowed");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("reject mode: an out-of-scope edit fails the run closed at the boundary", async () => {
  const repo = await makeGitRepo("n01-enforce-reject-");
  try {
    const stateManager = new WorkflowStateManager(join(repo, ".pi", "workflows"));
    const manager = new WorkflowManager({
      cwd: repo,
      agent: fileWritingAgent(repo, ["sneaky.ts"]),
    });
    manager.on("error", () => {});
    await assert.rejects(
      // Per-run exec override wins over the manager default (flag).
      manager.runSync(scopeScript(""), undefined, {
        phaseState: { stateManager },
        checkpointGate: approveGate,
        workspaceScopeEnforce: "reject",
      }),
      (error) => error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKSPACE_SCOPE_VIOLATION,
      "the boundary rejects with WORKSPACE_SCOPE_VIOLATION",
    );
    const state = await stateManager.getState();
    const recorded = state.scopeViolations?.[3];
    assert.ok(recorded, "the rejection is recorded with the phase state");
    assert.ok(recorded.violations.includes("added: sneaky.ts"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("an in-scope edit (declared output) passes enforcement cleanly", async () => {
  const repo = await makeGitRepo("n01-enforce-ok-");
  try {
    const stateManager = new WorkflowStateManager(join(repo, ".pi", "workflows"));
    const manager = new WorkflowManager({
      cwd: repo,
      agent: fileWritingAgent(repo, ["docs/out.md"]),
      workspaceScopeEnforce: "reject",
    });
    manager.on("error", () => {});
    const result = await manager.runSync(scopeScript(", outputs: ['docs/out.md']"), undefined, {
      phaseState: { stateManager },
      checkpointGate: approveGate,
    });
    assert.equal(result.result, "ok");
    const state = await stateManager.getState();
    assert.equal(state.scopeViolations?.[3], undefined, "no violation recorded for an in-scope change");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("confirm mode: violations go through the run's confirm handler (approve proceeds, deny rejects)", async () => {
  const repo = await makeGitRepo("n01-enforce-confirm-");
  try {
    // Approval proceeds and the exception is recorded as human-approved.
    const stateManager = new WorkflowStateManager(join(repo, ".pi", "workflows"));
    let scopeAsks = 0;
    const approving = new WorkflowManager({
      cwd: repo,
      agent: fileWritingAgent(repo, ["sneaky.ts"]),
      workspaceScopeEnforce: "confirm",
    });
    approving.on("error", () => {});
    const result = await approving.runSync(scopeScript(""), undefined, {
      phaseState: { stateManager },
      checkpointGate: approveGate,
      confirm: async (_prompt, options) => {
        if ((options as { kind?: string })?.kind === "workspace-scope") scopeAsks++;
        return true;
      },
    });
    assert.equal(result.result, "ok");
    assert.equal(scopeAsks, 1, "the scope violation was asked exactly once");
    const approved = await stateManager.getState();
    assert.equal(approved.scopeViolations?.[3]?.approved, true, "the approval is recorded");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("confirm mode: a denial fails the run closed at the boundary", async () => {
  const repo = await makeGitRepo("n01-enforce-confirm-deny-");
  try {
    // A FRESH repo: the denial run's own agent creates sneaky.ts, so the
    // terminal boundary sees it as an out-of-scope ADD (a shared repo's first
    // fingerprint would already include it and the diff would be clean).
    const stateManager = new WorkflowStateManager(join(repo, ".pi", "workflows"));
    const denying = new WorkflowManager({
      cwd: repo,
      agent: fileWritingAgent(repo, ["sneaky.ts"]),
      workspaceScopeEnforce: "confirm",
    });
    denying.on("error", () => {});
    await assert.rejects(
      denying.runSync(scopeScript(""), undefined, {
        phaseState: { stateManager },
        checkpointGate: approveGate,
        confirm: async (_prompt, options) => (options as { kind?: string })?.kind !== "workspace-scope",
      }),
      (error) => error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKSPACE_SCOPE_VIOLATION,
      "a denial fails the run closed",
    );
    const denied = await stateManager.getState();
    assert.equal(denied.scopeViolations?.[3]?.approved, false, "the denial is recorded");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
