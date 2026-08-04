/**
 * task8-crash-e2e.test.ts — PRD Task 8 crash recovery, end-to-end.
 *
 * The manager + `/workflows resume|clean` command path is live (report.md row
 * 8); this file proves the crash lifecycle on real disk state:
 *
 *   1. A REAL journaled run is started and abandoned mid-flight the way a
 *      crash leaves it: persisted status "running" with a journaled prefix,
 *      plus a lease lock whose owning process is dead. (The run file is
 *      written by the real manager; only the lock's pid is fabricated, because
 *      a test cannot kill its own process — a dead pid is exactly the artifact
 *      a crashed owner leaves.)
 *   2. A fresh manager over the same cwd — the startup recovery scanner
 *      (WorkflowManager.recoverStaleRuns, the run-side mirror of
 *      sweepOrphanWorktrees) — classifies the orphan: flips it to "paused"
 *      (recoverable, never "failed"), preserves the journal, and releases the
 *      lease.
 *   3. manager.resume() replays the journaled prefix — agent 0 is NOT re-run;
 *      its ORIGINAL result returns — and runs the tail live → the run
 *      completes from the journal.
 *   4. `/workflows clean` then removes the crashed run's worktree/branch
 *      leftovers (real git), the same cleanup the slash command performs.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunPersistence } from "../src/run-persistence.js";
import { registerWorkflowCommands } from "../src/workflow-commands.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createWorktree } from "../src/worktree.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

const TWO_AGENT_SCRIPT = `export const meta = { name: 'crash_recovery', description: 'crash e2e' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

/** Agent runner with PER-CALL deferred promises (each run() hangs until its own resolve). */
function perCallDeferredAgent() {
  const resolves: Array<(value: unknown) => void> = [];
  let callIdx = 0;
  return {
    /** How many agent() calls have actually REACHED the runner (see the start window below). */
    started: () => callIdx,
    resolve: (idx: number, value: unknown = "done") => resolves[idx]?.(value),
    runner: {
      async run() {
        const idx = callIdx++;
        return new Promise((resolve) => {
          resolves[idx] = resolve;
        });
      },
    },
  };
}

async function until(probe: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

/** A temp git repo with one committed file (worktrees + `/workflows clean` need it). */
function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pi-dw-crash-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "crash@test.local");
  git("config", "user.name", "crash");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
}

test("task8 e2e: a crashed journaled run is recovered to paused, resumes from the journal, and /workflows clean removes its leftovers", async () => {
  const repo = initRepo();
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-crash-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      // ── 1. A real journaled run, abandoned mid-flight ───────────────────
      const da = perCallDeferredAgent();
      const managerA = new WorkflowManager({ cwd: repo, agent: da.runner });
      managerA.on("error", () => {});
      const { runId } = managerA.startInBackground(TWO_AGENT_SCRIPT);
      const runsDir = managerA.getPersistence().getRunsDir();
      const rp = createRunPersistence(repo);

      // Agent 0 completes → journal entry 0; agent 1 hangs (the crash window).
      // startInBackground returns before the first agent() reaches the runner,
      // so resolving too early would no-op and the run would never journal
      // anything — wait for agent 0 to actually start first.
      await until(() => da.started() >= 1, `agent 0 of ${runId} never started`);
      da.resolve(0, "first-result");
      await until(
        () => (rp.load(runId)?.journal?.length ?? 0) >= 1 && rp.load(runId)?.status === "running",
        `journal for ${runId} never persisted while running`,
      );
      const crashedState = rp.load(runId);
      assert.equal(crashedState?.status, "running", "the crash artifact is a run left 'running' on disk");
      assert.equal(crashedState?.journal?.[0]?.result, "first-result", "the completed prefix is journaled");

      // The crashed run's worktree leftover (the run died before removing it).
      const leftover = await createWorktree(repo, runId);
      assert.equal(leftover.isolated, true, "the crashed run left a real isolated worktree behind");
      assert.ok(leftover.cwd && leftover.branch, "the leftover carries its path + branch");

      // Crash: the owner process dies. Its lease lock stays on disk with a
      // dead pid (the run file above is real; the pid is the only artifact a
      // test must fabricate — the pid is one no live process on this host can
      // own). Keep the TTL unexpired so the reclaim is triggered by the DEAD
      // PID (the crash signal), not by lease expiry.
      writeFileSync(
        join(runsDir, `${runId}.lock`),
        JSON.stringify(
          {
            runId,
            runPath: join(runsDir, `${runId}.json`),
            pid: 2_147_483_647,
            startedAt: new Date().toISOString(),
            token: "crashed-owner-token",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          null,
          2,
        ),
        "utf-8",
      );
      // Abandon manager A — its hung agent-1 promise never settles, exactly
      // like a process that no longer exists.

      // ── 2. Startup recovery scanner: classification ─────────────────────
      // A fresh manager over the same cwd = the extension-activation recovery
      // (recoverStaleRuns runs in the constructor).
      const bRunnerPrompts: string[] = [];
      const managerB = new WorkflowManager({
        cwd: repo,
        agent: {
          async run(prompt: string) {
            bRunnerPrompts.push(prompt);
            return "done";
          },
        },
      });
      managerB.on("error", () => {});

      const recovered = rp.load(runId);
      assert.equal(
        recovered?.status,
        "paused",
        "the scanner classifies a crashed 'running' orphan as paused (recoverable), never failed",
      );
      assert.deepEqual(
        (recovered?.journal ?? []).map((e) => e.result),
        ["first-result"],
        "the journaled prefix survived the recovery untouched",
      );
      const reacquired = rp.acquireRunLease(runId);
      assert.ok(reacquired, "the scanner released the reclaimed lease after reconciling");
      if (reacquired) rp.releaseRunLease(reacquired);

      // ── 3. resumeRun → completes from the journal ───────────────────────
      assert.equal(await managerB.resume(runId), true, "the recovered run is resumable");
      await until(() => rp.load(runId)?.status === "completed", `resumed run ${runId} never completed`);

      const finished = rp.load(runId);
      // The PERSISTED result is the script's return value (writeRunToDisk stores
      // managed.result.result — the inner value, unlike getRun()'s in-memory
      // WorkflowRunResult envelope).
      const body = finished?.result as { a?: unknown; b?: unknown } | undefined;
      assert.equal(body?.a, "first-result", "agent 0's ORIGINAL journaled result returned (replayed, not re-run)");
      assert.equal(body?.b, "done", "agent 1 ran live after the replay");
      assert.deepEqual(
        bRunnerPrompts,
        ["second"],
        "the resume replayed the journaled prefix (agent 0 never re-ran) and executed only the live tail",
      );

      // ── 4. /workflows clean removes the crash leftovers ─────────────────
      const { pi, commands } = makeCommandRegistryPi();
      const { ctx, notified } = makeNotifyCtx();
      registerWorkflowCommands(pi, managerB, { cwd: repo });
      const command = commands.find((c) => c.name === "workflows");
      assert.ok(command, "the /workflows command is registered");
      await (command.handler as (args: string, c: typeof ctx) => Promise<void>)("clean", ctx);

      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      const branches = git("branch", "--list", "pi/wf/*").trim();
      assert.equal(branches, "", "the crashed run's temporary pi/wf branch is deleted");
      assert.ok(leftover.cwd && !existsSync(leftover.cwd), "the orphaned worktree directory is gone");
      const worktreeList = git("worktree", "list", "--porcelain");
      assert.ok(!worktreeList.includes(leftover.cwd), "the orphaned worktree is no longer registered");
      assert.ok(
        notified.some((n) => /project worktrees pruned/.test(n.message)),
        `/workflows clean reported the sweep: ${JSON.stringify(notified.map((n) => n.message))}`,
      );
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
