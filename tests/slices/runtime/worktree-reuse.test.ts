import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorktree, pruneWorktrees, removeWorktree } from "../../../src/worktree.js";
import { rmForce } from "../../helpers/rm-force.js";

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

test("M14: a deterministic-slug path left behind is REUSED, never a silent shared-tree fallback", async () => {
  const repo = initRepo("pi-wt-reuse-");
  try {
    const first = await createWorktree(repo, "run-1-0-edit");
    assert.equal(first.isolated, true);

    // Simulate a crashed prior run: the worktree is still registered + on disk.
    const second = await createWorktree(repo, "run-1-0-edit");
    assert.equal(second.isolated, true, "the second call must NOT silently degrade to the shared tree");
    assert.equal(second.cwd, first.cwd, "the existing worktree is reused in place");
    assert.match(second.reason ?? "", /reused/i, "the reuse decision is surfaced");

    await removeWorktree(second);
  } finally {
    await rmForce(repo);
  }
});

test("M14: a registered worktree whose directory vanished is recreated fresh, not reused broken", async () => {
  const repo = initRepo("pi-wt-recreate-");
  try {
    const wt = await createWorktree(repo, "run-2-0-edit");
    assert.equal(wt.isolated, true);
    // A crashed run removed the working directory but git still tracks it.
    await rmForce(wt.cwd);

    const recreated = await createWorktree(repo, "run-2-0-edit");
    assert.equal(recreated.isolated, true, "recreated, not degraded");
    assert.ok(existsSync(recreated.cwd), "the recreated worktree has a real directory");
    assert.match(recreated.reason ?? "", /recreated/i, "the recreate decision is surfaced");
    assert.ok(existsSync(join(recreated.cwd, "file.txt")), "the recreated checkout has content");

    await removeWorktree(recreated);
  } finally {
    await rmForce(repo);
  }
});

test("M14: pruneWorktrees clears stale registrations and never throws outside a repo", async () => {
  const repo = initRepo("pi-wt-prune-");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  try {
    const wt = await createWorktree(repo, "run-3-0-edit");
    assert.equal(wt.isolated, true);
    // Wipe the directory the way a crashed run would; the registration lingers.
    await rmForce(wt.cwd);
    // git reports paths with forward slashes on every platform — normalize for
    // the porcelain comparison.
    const normalizedCwd = wt.cwd.replace(/\\/g, "/");
    assert.ok(
      git("worktree", "list", "--porcelain").includes(normalizedCwd),
      "stale registration present before prune",
    );

    await pruneWorktrees(repo);
    assert.ok(
      !git("worktree", "list", "--porcelain").includes(normalizedCwd),
      "prune cleared the stale registration (M14)",
    );

    // Non-repo cwd: best-effort no-op.
    const nonRepo = mkdtempSync(join(tmpdir(), "pi-wt-norepo-"));
    await pruneWorktrees(nonRepo);
    await rmForce(nonRepo);
  } finally {
    await rmForce(repo);
  }
});
