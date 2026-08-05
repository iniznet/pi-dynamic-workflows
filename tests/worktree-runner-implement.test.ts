import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorktreeTask } from "../src/agent/worktree-runner.js";
import {
  createWorktreeRunner,
  executeTask,
  type ImplementProtocolResult,
  type ImplementTaskSpec,
  implementProtocol,
  type RunResult,
  resolveProtocolCommands,
  reviewProtocolDiff,
  type WorktreeRunnerConfig,
} from "../src/agent/worktree-runner.js";
import { createRunPersistence, loadRunState, saveCheckpoint } from "../src/run-persistence.js";
import { createWorktree as createWorktreeLive } from "../src/worktree.js";

/** Minimal git repo with identity + a base commit, like the worktree suite. */
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

const TEST_CODE = `import test from "node:test";
import assert from "node:assert/strict";
import { add } from "../math.mjs";

test("adds", () => {
  assert.equal(add(1, 2), 3);
});
`;

const IMPL_CODE = `export function add(a, b) {
  return a + b;
}
`;

function specTask(
  id: string,
  wt: { cwd: string; branch?: string; repoRoot?: string },
  overrides: Partial<WorktreeTask["spec"]> = {},
): WorktreeTask {
  return {
    id,
    description: "add two numbers",
    branch: wt.branch as string,
    worktreePath: wt.cwd,
    repoRoot: wt.repoRoot as string,
    status: "pending",
    spec: {
      testPath: "tests/math.test.mjs",
      testCode: TEST_CODE,
      implPath: "math.mjs",
      implCode: IMPL_CODE,
      testCommand: "node --test tests/math.test.mjs",
      typecheckCommand: "node --check math.mjs",
      ...overrides,
    },
  };
}

function protocolOf(result: { output: string }): ImplementProtocolResult {
  return JSON.parse(result.output) as ImplementProtocolResult;
}

// ── G1 acceptance: a fixture run produces a commit whose tests pass and whose
//    typecheck is clean — the all-true stub is gone, every step is real. ──

test("implementProtocol fixture: TDD write → green tests → typecheck → review → commit on the worktree branch", async () => {
  const repo = initRepo("pi-wt-impl-");
  try {
    const wt = await createWorktreeLive(repo, "run-1-0-math");
    assert.equal(wt.isolated, true);

    // Runner-config command overrides are threaded through to the protocol.
    const runner = createWorktreeRunner({
      cleanupOnComplete: false,
      testCommand: "node --test tests/math.test.mjs",
      typecheckCommand: "node --check math.mjs",
    });
    const results = await runner.executeTasks([specTask("run-1-0", wt)]);

    assert.equal(results.length, 1);
    assert.equal(results[0].success, true, "protocol must land a verified commit");
    const protocol = protocolOf(results[0]);
    assert.equal(protocol.testsWritten, true);
    assert.equal(protocol.testsPassed, true);
    assert.equal(protocol.implWritten, true, "impl is materialized after the first red run");
    assert.equal(protocol.typecheckPassed, true);
    assert.equal(protocol.reviewPassed, true);
    assert.equal(protocol.committed, true);
    assert.ok(protocol.commitHash, "protocol reports the real commit hash");
    assert.equal(protocol.steps.length, 5, "all five protocol steps ran");
    for (const step of protocol.steps) {
      assert.ok(step.ok, `step ${step.name} must pass in the fixture`);
      assert.ok(step.output.length > 0, `step ${step.name} captures output`);
      assert.ok(step.durationMs >= 0);
    }

    // The commit really exists on the worktree branch and carries both files.
    const mathInCommit = execFileSync("git", ["-C", repo, "show", `${wt.branch}:math.mjs`], { encoding: "utf8" });
    assert.match(mathInCommit, /export function add/);
    const testInCommit = execFileSync("git", ["-C", repo, "show", `${wt.branch}:tests/math.test.mjs`], {
      encoding: "utf8",
    });
    assert.match(testInCommit, /test\("adds"/);

    // The worktree's tests genuinely pass after the commit (re-run, not trust).
    execFileSync("node", ["--test", join(wt.cwd, "tests", "math.test.mjs")], { encoding: "utf8" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("implementProtocol honest short-circuit: a task without a spec writes, runs, and commits nothing", async () => {
  const repo = initRepo("pi-wt-impl-nospec-");
  try {
    const wt = await createWorktreeLive(repo, "run-2-0-empty");
    const runner = createWorktreeRunner({ cleanupOnComplete: false });
    const task = specTask("run-2-0", wt);
    delete task.spec;

    const results = await runner.executeTasks([task]);
    const protocol = protocolOf(results[0]);

    // The stub is dead: a spec-less task gets honest FALSE booleans, never the
    // old all-true fiction.
    assert.equal(protocol.testsWritten, false);
    assert.equal(protocol.testsPassed, false);
    assert.equal(protocol.implWritten, false);
    assert.equal(protocol.typecheckPassed, false);
    assert.equal(protocol.reviewPassed, false);
    assert.equal(protocol.committed, false);
    assert.equal(results[0].success, false);
    assert.ok(
      protocol.steps.every((s) => s.output.includes("no implement spec")),
      "each step explains why it could not run",
    );

    // No phantom commit on the branch: HEAD is still the base commit.
    const head = execFileSync("git", ["-C", repo, "rev-parse", `${wt.branch}`], { encoding: "utf8" }).trim();
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(head, base, "nothing was committed without a spec");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("implementProtocol self-review blocks the commit when the diff carries a TODO marker", async () => {
  const repo = initRepo("pi-wt-impl-todo-");
  try {
    const wt = await createWorktreeLive(repo, "run-3-0-todo");
    const runner = createWorktreeRunner({ cleanupOnComplete: false });
    const task = specTask("run-3-0", wt, {
      testCode: `// TODO: verify overflow handling\n${TEST_CODE}`,
    });

    const results = await runner.executeTasks([task]);
    const protocol = protocolOf(results[0]);

    assert.equal(protocol.testsPassed, true, "the test itself still passes");
    assert.equal(protocol.typecheckPassed, true);
    assert.equal(protocol.reviewPassed, false, "a TODO marker must fail self-review");
    assert.equal(protocol.committed, false, "a failed self-review must block the commit");
    assert.equal(results[0].success, false);
    assert.match(protocol.steps[3].output, /TODO marker/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("implementProtocol reports red tests AND a failed typecheck for broken impl code", async () => {
  const repo = initRepo("pi-wt-impl-broken-");
  try {
    const wt = await createWorktreeLive(repo, "run-4-0-broken");
    const runner = createWorktreeRunner({ cleanupOnComplete: false });
    const task = specTask("run-4-0", wt, {
      implCode: "export function add(a, b) { return a + b", // syntax error
    });

    const results = await runner.executeTasks([task]);
    const protocol = protocolOf(results[0]);

    assert.equal(protocol.implWritten, true, "impl is still materialized");
    assert.equal(protocol.testsPassed, false, "the test runner cannot import broken code");
    assert.equal(protocol.typecheckPassed, false, "the typechecker rejects the broken file");
    assert.equal(protocol.committed, false, "red tests + failed typecheck block the commit");
    assert.equal(results[0].success, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("implementProtocol spec-level command overrides beat runner-config defaults", async () => {
  const repo = initRepo("pi-wt-impl-priority-");
  try {
    const wt = await createWorktreeLive(repo, "run-5-0-priority");
    // Config points at commands that would fail; the spec overrides win.
    const runner = createWorktreeRunner({
      cleanupOnComplete: false,
      testCommand: "node --test nonexistent.mjs",
      typecheckCommand: "node --check nonexistent.mjs",
    });
    const task = specTask("run-5-0", wt);

    const results = await runner.executeTasks([task]);
    const protocol = protocolOf(results[0]);
    assert.equal(protocol.testsPassed, true, "spec testCommand wins over config");
    assert.equal(protocol.typecheckPassed, true, "spec typecheckCommand wins over config");
    assert.equal(protocol.committed, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("implementProtocol runs directly with runtime overrides (no runner required)", async () => {
  const repo = initRepo("pi-wt-impl-direct-");
  try {
    const wt = await createWorktreeLive(repo, "run-6-0-direct");
    const protocol = await implementProtocol(specTask("run-6-0", wt), {
      testCommand: "node --test tests/math.test.mjs",
      typecheckCommand: "node --check math.mjs",
    });
    assert.equal(protocol.committed, true);
    assert.ok(protocol.commitHash);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── G5 acceptance: saveCheckpoint (atomic tmp+rename via the persistence
//    layer) lands per-subagent state writes the moment each task completes. ──

/** Seed a persisted run in the same store the real WorkflowManager uses. */
function seedRun(cwd: string, runId: string): void {
  createRunPersistence(cwd).save({
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
}

function checkpointOnComplete(runId: string, repo: string): (task: WorktreeTask, result: RunResult) => Promise<void> {
  return async (task, result) => {
    await saveCheckpoint(
      runId,
      {
        runId,
        taskId: task.id,
        status: result.success ? "completed" : "failed",
        worktreePath: task.worktreePath,
        branch: task.branch,
        output: result.output.slice(0, 256),
        timestamp: new Date().toISOString(),
      },
      repo,
    );
  };
}

const GIT_TASK_COMMANDS = {
  testCommand: "node --test tests/math.test.mjs",
  typecheckCommand: "node --check math.mjs",
} as const;

test("G5: onTaskComplete persists an atomic per-subagent checkpoint exactly once per completed task", async () => {
  const repo = initRepo("pi-wt-ckpt-");
  try {
    seedRun(repo, "run-ckpt");
    const wt = await createWorktreeLive(repo, "run-ckpt-0-math");
    const calls: string[] = [];
    const runner = createWorktreeRunner({
      cleanupOnComplete: false,
      ...GIT_TASK_COMMANDS,
      onTaskComplete: async (task, result) => {
        calls.push(task.id);
        await checkpointOnComplete("run-ckpt", repo)(task, result);
      },
    });
    const results = await runner.executeTasks([specTask("run-ckpt-0", wt)]);

    assert.equal(results[0].success, true);
    assert.deepEqual(calls, ["run-ckpt-0"], "the completion hook fires exactly once per task");

    const state = await loadRunState("run-ckpt", repo);
    assert.ok(state, "the run's persisted state exists after fan-out");
    assert.equal(state?.checkpoints.length, 1);
    assert.equal(state?.checkpoints[0].taskId, "run-ckpt-0");
    assert.equal(state?.checkpoints[0].status, "completed");
    assert.equal(state?.checkpoints[0].branch, wt.branch);
    assert.equal(state?.checkpoints[0].worktreePath, wt.cwd);
    assert.ok(state?.checkpoints[0].timestamp, "the checkpoint carries a timestamp");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("G5: state.json writes land after EACH completion, never batched at the end", async () => {
  const repo = initRepo("pi-wt-ckpt-seq-");
  try {
    seedRun(repo, "run-ckpt-seq");
    const wt1 = await createWorktreeLive(repo, "run-ckpt-seq-0-a");
    const wt2 = await createWorktreeLive(repo, "run-ckpt-seq-1-b");
    const config: WorktreeRunnerConfig = {
      maxConcurrent: 1,
      modelTier: "medium",
      cleanupOnComplete: false,
      ...GIT_TASK_COMMANDS,
      onTaskComplete: checkpointOnComplete("run-ckpt-seq", repo),
    };

    await executeTask(specTask("run-ckpt-seq-0", wt1), config);
    const afterFirst = await loadRunState("run-ckpt-seq", repo);
    assert.equal(
      afterFirst?.checkpoints.length,
      1,
      "the first completion is already on disk before the second task even runs",
    );

    await executeTask(specTask("run-ckpt-seq-1", wt2), config);
    const afterSecond = await loadRunState("run-ckpt-seq", repo);
    assert.equal(afterSecond?.checkpoints.length, 2);
    assert.deepEqual(
      afterSecond?.checkpoints.map((c) => c.taskId),
      ["run-ckpt-seq-0", "run-ckpt-seq-1"],
      "checkpoints keep first-seen order (dedupe by taskId)",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("G5: a rejecting onTaskComplete never flips an already-landed task result", async () => {
  const repo = initRepo("pi-wt-ckpt-throw-");
  try {
    seedRun(repo, "run-ckpt-throw");
    const wt = await createWorktreeLive(repo, "run-ckpt-throw-0");
    const task = specTask("run-ckpt-throw-0", wt);
    const config: WorktreeRunnerConfig = {
      maxConcurrent: 1,
      modelTier: "medium",
      cleanupOnComplete: false,
      ...GIT_TASK_COMMANDS,
      onTaskComplete: async () => {
        throw new Error("disk unavailable");
      },
    };

    const result = await executeTask(task, config);
    assert.equal(result.success, true, "the protocol verdict stands despite the checkpoint write failure");
    assert.equal(task.status, "completed");
    assert.ok(task.completedAt, "completedAt is stamped on the task");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── pure helpers ──

test("resolveProtocolCommands defaults to npx tsx --test and npx tsc --noEmit", () => {
  const d = resolveProtocolCommands(undefined, undefined, "tests/math.test.ts");
  assert.equal(d.testCommand, "npx tsx --test tests/math.test.ts");
  assert.equal(d.typecheckCommand, "npx tsc --noEmit");
});

test("resolveProtocolCommands precedence: spec > runtime > default", () => {
  const runtime = { testCommand: "node --test all", typecheckCommand: "node --check a.mjs" };
  const spec = {
    testCommand: "node --test spec-only",
    typecheckCommand: "npx svelte-check",
  } as ImplementTaskSpec;
  const withSpec = resolveProtocolCommands(runtime, spec, "t.mjs");
  assert.equal(withSpec.testCommand, "node --test spec-only");
  assert.equal(withSpec.typecheckCommand, "npx svelte-check");
  const withRuntime = resolveProtocolCommands(runtime, undefined, "t.mjs");
  assert.equal(withRuntime.testCommand, "node --test all");
  assert.equal(withRuntime.typecheckCommand, "node --check a.mjs");
});

test("reviewProtocolDiff flags TODO markers and out-of-scope files", () => {
  const diff = [
    "diff --git a/math.mjs b/math.mjs",
    "+++ b/math.mjs",
    "+export function add(a, b) { return a + b; } // TODO: overflow",
    "diff --git a/stray.txt b/stray.txt",
    "+++ b/stray.txt",
    "+unexpected",
  ].join("\n");
  const verdict = reviewProtocolDiff(diff, ["math.mjs", "tests/math.test.mjs"]);
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.findings.some((f) => f.includes("TODO marker")),
    "flags the TODO",
  );
  assert.ok(
    verdict.findings.some((f) => f.includes("out-of-scope file: stray.txt")),
    "flags scope creep",
  );
});

test("reviewProtocolDiff passes for an in-scope, marker-free diff and skips deletions", () => {
  const diff = [
    "diff --git a/math.mjs b/math.mjs",
    "+++ b/math.mjs",
    "+export function add(a, b) { return a + b; }",
    "+++ /dev/null",
  ].join("\n");
  const verdict = reviewProtocolDiff(diff, ["math.mjs"]);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.findings, []);
});
