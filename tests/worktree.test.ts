import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorktreeTask } from "../src/agent/worktree-runner.js";
import { createWorktreeRunner } from "../src/agent/worktree-runner.js";
import {
  createWorktree as createWorktreeLive,
  finalizeWorktree,
  gitExec,
  removeWorktree,
  sweepOrphanWorktrees,
} from "../src/worktree.js";

// ── Existing tests (unchanged) ──

test("createWorktree no-ops (not isolated) outside a git repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-nogit-"));
  try {
    const wt = await createWorktreeLive(dir, "run-1-0-task");
    assert.equal(wt.isolated, false);
    assert.equal(wt.cwd, dir);
    assert.match(wt.reason ?? "", /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createWorktree isolates in a git repo, then removeWorktree cleans up", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-9-0-edit");
    assert.equal(wt.isolated, true);
    assert.ok(wt.cwd !== repo && existsSync(wt.cwd), "worktree dir exists");
    assert.ok(existsSync(join(wt.cwd, "file.txt")), "worktree has a checkout");

    // Editing inside the worktree must not touch the base tree.
    writeFileSync(join(wt.cwd, "file.txt"), "changed in worktree\n");
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "base\n");

    await removeWorktree(wt);
    assert.ok(!existsSync(wt.cwd), "worktree dir removed");
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", wt.branch ?? ""], { encoding: "utf8" });
    assert.equal(branches.trim(), "", "branch deleted");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── NEW TESTS ──

test("createWorktree falls back when git fails (non-git directory)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-noexec-"));
  try {
    const wt = await createWorktreeLive(dir, "run-1-0-task");

    assert.equal(wt.isolated, false);
    assert.equal(wt.cwd, dir);
    assert.ok(wt.reason, "should provide a fallback reason when git fails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeWorktree does not throw when worktree directory is already missing", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-missing-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-missing-dir");
    assert.equal(wt.isolated, true);

    // Remove the worktree directory so git worktree remove --force fails
    rmSync(wt.cwd, { recursive: true, force: true });
    assert.ok(!existsSync(wt.cwd), "worktree dir removed manually before removeWorktree");

    // removeWorktree must not throw despite git commands failing
    await assert.doesNotReject(removeWorktree(wt));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree falls back when target branch already exists", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-conflict-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    // Pre-create the branch that createWorktree will try to create.
    // slug("conflict-branch") → "conflict-branch"
    const name = "conflict-branch";
    git("branch", "pi/wf/conflict-branch");

    // createWorktree should fail: git worktree add -b <existing-branch> errors out
    const wt = await createWorktreeLive(repo, name);
    assert.equal(wt.isolated, false);
    assert.equal(wt.cwd, repo);
    assert.ok(/already exists/i.test(wt.reason ?? ""), `Expected 'already exists' error, got: ${wt.reason}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree does not throw when git operations fail (corrupted metadata)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-failrm-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-fail-rm");
    assert.equal(wt.isolated, true);

    // Remove worktree dir so git worktree remove fails
    rmSync(wt.cwd, { recursive: true, force: true });

    // Corrupt git worktree metadata so git worktree remove --force also fails
    const branchSuffix = wt.branch?.replace("pi/wf/", "") ?? "";
    const worktreeMeta = join(repo, ".git", "worktrees", branchSuffix);
    if (existsSync(worktreeMeta)) {
      writeFileSync(join(worktreeMeta, "gitdir"), "/nonexistent/path\n");
    }

    // Both git operations should fail silently — no throw from removeWorktree
    await assert.doesNotReject(removeWorktree(wt));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── worktree-isolation:f1 — the runner now passes the full worktree shape ──

function initRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
}

function taskFromWorktree(id: string, wt: { cwd: string; branch?: string; repoRoot?: string }): WorktreeTask {
  assert.ok(wt.branch, "worktree must carry a branch");
  assert.ok(wt.repoRoot, "worktree must carry a repoRoot");
  return {
    id,
    description: `task ${id}`,
    branch: wt.branch,
    worktreePath: wt.cwd,
    repoRoot: wt.repoRoot,
    status: "pending",
  };
}

function assertBranchGone(repo: string, branch: string): void {
  const branches = execFileSync("git", ["-C", repo, "branch", "--list", branch], { encoding: "utf8" });
  assert.equal(branches.trim(), "", `branch ${branch} should be deleted`);
}

function assertBranchExists(repo: string, branch: string): void {
  const branches = execFileSync("git", ["-C", repo, "branch", "--list", branch], { encoding: "utf8" });
  assert.ok(branches.includes(branch), `branch ${branch} should still exist`);
}

test("worktree runner cleanup removes the worktree dir and branch after executeTasks", async () => {
  const repo = initRepo("pi-wt-runner-");
  try {
    const wt = await createWorktreeLive(repo, "run-1-0-edit");
    assert.equal(wt.isolated, true);

    const runner = createWorktreeRunner({ cleanupOnComplete: true });
    const results = await runner.executeTasks([taskFromWorktree("t1", wt)]);

    assert.equal(results.length, 1);
    assert.equal(results[0].taskId, "t1");
    assert.ok(!existsSync(wt.cwd), "worktree dir removed after executeTasks cleanup");
    assertBranchGone(repo, wt.branch as string);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree runner cleanup() removes the worktree dir and branch for every registered task", async () => {
  const repo = initRepo("pi-wt-runner-cleanup-");
  try {
    const wtA = await createWorktreeLive(repo, "run-a-0-edit");
    const wtB = await createWorktreeLive(repo, "run-b-1-edit");
    assert.equal(wtA.isolated, true);
    assert.equal(wtB.isolated, true);

    // cleanupOnComplete: false so executeTasks leaves them for cleanup()
    const runner = createWorktreeRunner({ cleanupOnComplete: false });
    const results = await runner.executeTasks([taskFromWorktree("ta", wtA), taskFromWorktree("tb", wtB)]);
    assert.equal(results.length, 2);
    assert.ok(existsSync(wtA.cwd), "cleanupOnComplete=false keeps worktrees until cleanup()");

    await runner.cleanup();
    assert.ok(!existsSync(wtA.cwd), "worktree A removed by cleanup()");
    assert.ok(!existsSync(wtB.cwd), "worktree B removed by cleanup()");
    assertBranchGone(repo, wtA.branch as string);
    assertBranchGone(repo, wtB.branch as string);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── worktree-isolation:i1 — startup orphan sweep ──

test("sweepOrphanWorktrees reclaims leaked worktrees but keeps active + main", async () => {
  const repo = initRepo("pi-wt-sweep-");
  try {
    const active = await createWorktreeLive(repo, "run-active-0-edit");
    const orphan = await createWorktreeLive(repo, "run-orphan-0-edit");
    assert.equal(active.isolated, true);
    assert.equal(orphan.isolated, true);

    await sweepOrphanWorktrees(repo, [active.cwd]);

    assert.ok(existsSync(repo), "main checkout is never removed");
    assert.ok(existsSync(active.cwd), "active worktree is preserved");
    assert.ok(!existsSync(orphan.cwd), "orphan worktree dir is reclaimed");
    assertBranchExists(repo, active.branch as string);
    assertBranchGone(repo, orphan.branch as string);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("sweepOrphanWorktrees swallows errors outside a git repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-sweep-nogit-"));
  try {
    await assert.doesNotReject(sweepOrphanWorktrees(dir, []));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree runner sweeps orphaned worktrees at run start (init path)", async () => {
  const repo = initRepo("pi-wt-runner-sweep-");
  try {
    // Leftover from a "crashed" run — not part of the new run's task set.
    const leftover = await createWorktreeLive(repo, "run-crashed-0-edit");
    // This run's own worktree, pre-created by the caller as executeTasks expects.
    const mine = await createWorktreeLive(repo, "run-new-0-edit");

    const runner = createWorktreeRunner({ cleanupOnComplete: false });
    const results = await runner.executeTasks([taskFromWorktree("t1", mine)]);

    assert.equal(results.length, 1);
    assert.ok(!existsSync(leftover.cwd), "crashed run's worktree swept before execution");
    assert.ok(existsSync(mine.cwd), "this run's own worktree is preserved by the sweep");
    assertBranchGone(repo, leftover.branch as string);
    assertBranchExists(repo, mine.branch as string);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── worktree-isolation:f2 — finalize before teardown ──

test("finalizeWorktree commits agent edits onto the branch before teardown", async () => {
  const repo = initRepo("pi-wt-finalize-");
  try {
    const wt = await createWorktreeLive(repo, "run-finalize-0-edit");
    assert.equal(wt.isolated, true);
    writeFileSync(join(wt.cwd, "agent-output.txt"), "agent edit\n");

    const ok = await finalizeWorktree(wt);
    assert.equal(ok, true, "finalize should succeed with a dirty tree");

    // The edit is committed onto the branch BEFORE teardown — this is exactly what
    // a keepWorktree consumer inspects after the run (see the workflow integration
    // test in tests/agent.test.ts).
    const shown = execFileSync("git", ["-C", repo, "show", `${wt.branch}:agent-output.txt`], { encoding: "utf8" });
    assert.equal(shown, "agent edit\n");

    // Default teardown then deliberately discards the finalized branch + worktree.
    await removeWorktree(wt);
    assert.ok(!existsSync(wt.cwd), "worktree dir removed after teardown");
    assertBranchGone(repo, wt.branch as string);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("finalizeWorktree creates an empty commit on a clean tree (allow-empty)", async () => {
  const repo = initRepo("pi-wt-finalize-clean-");
  try {
    const wt = await createWorktreeLive(repo, "run-finalize-clean");
    assert.equal(wt.isolated, true);

    const ok = await finalizeWorktree(wt);
    assert.equal(ok, true);
    const head = execFileSync("git", ["-C", repo, "log", "-1", "--format=%s", wt.branch as string], {
      encoding: "utf8",
    });
    assert.match(head, /finalize agent worktree/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("finalizeWorktree is a no-op (false) for a non-isolated Worktree", async () => {
  assert.equal(await finalizeWorktree({ isolated: false, cwd: "/tmp", reason: "not a git repository" }), false);
});

// ── worktree-isolation:i4 — central git exec helper ──

test("gitExec rejects on a pre-aborted signal", async () => {
  await assert.rejects(gitExec(["version"], { signal: AbortSignal.abort() }), /aborted/);
});

test("gitExec resolves stdout for a successful command", async () => {
  const out = await gitExec(["version"]);
  assert.match(out, /git version/);
});

// ── worktree-isolation:i5 — real-git lifecycle smoke test (Windows-safe) ──

test("smoke: create → edit → finalize → remove lifecycle on real git", async () => {
  // Full production lifecycle in a temp repo: createWorktree creates the isolated
  // checkout on pi/wf/<id>, an agent edits files inside it, finalizeWorktree commits
  // the edits onto the branch, and removeWorktree reclaims the dir + branch. Paths
  // come from tmpdir() and branch names are ASCII slugs, so this runs on Windows too.
  const repo = initRepo("pi-wt-smoke-");
  try {
    const wt = await createWorktreeLive(repo, "run-smoke-0-edit");
    assert.equal(wt.isolated, true);
    assert.ok(existsSync(join(wt.cwd, "file.txt")), "worktree has a checkout");

    // Agent edit must not touch the base tree.
    writeFileSync(join(wt.cwd, "feature.ts"), "export const feature = true;\n");
    assert.ok(!existsSync(join(repo, "feature.ts")), "agent edits stay inside the worktree");

    assert.equal(await finalizeWorktree(wt), true, "agent edits are committed");
    await removeWorktree(wt);
    assert.ok(!existsSync(wt.cwd), "worktree dir removed");
    assertBranchGone(repo, wt.branch as string);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
