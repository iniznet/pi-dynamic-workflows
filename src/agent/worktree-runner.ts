/**
 * Worktree Subagent Execution & /implement Protocol (Phase 3).
 * Fans out parallel subagent tasks in isolated Git worktrees.
 *
 * The /implement protocol is the TDD → typecheck → self-review → commit sequence
 * a task's code goes through before landing on its worktree branch. Every step
 * reports a REAL boolean plus captured output — nothing is assumed to have
 * happened. A task without a structured `spec` (subagent-authored test/impl
 * content) short-circuits to honest `false` steps: the protocol never fabricates
 * tests, typechecks, or commits that did not occur.
 */

import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { SUITE_CONCURRENCY_CAP } from "../../scripts/suite-constants.mjs";
import { gitExec, removeWorktree, sweepOrphanWorktrees } from "../worktree.js";

/** Max captured bytes per protocol command run (test/typecheck output). */
const COMMAND_MAX_BUFFER = 16 * 1024 * 1024;
/** Hard per-command timeout for test/typecheck runs inside a worktree. */
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
/** How many test-run attempts the protocol may make before declaring red. */
const MAX_TEST_RUN_ATTEMPTS = 3;
/**
 * Default test-runner command when neither the task spec nor the runner config
 * overrides it. Capped like the suite runner (shared SUITE_CONCURRENCY_CAP) so
 * N parallel /implement tasks spawn N capped processes instead of
 * N × (availableParallelism() - 1) CPU-bound workers. The full runner
 * (`npm run test:unit`) is deliberately NOT used here: it always appends the
 * whole-suite globs, which would blow the 120s per-command timeout on every
 * TDD step. Single-file invocation keeps per-task semantics.
 */
const DEFAULT_TEST_COMMAND = (testPath: string) =>
  `node --import tsx --test --test-concurrency=${SUITE_CONCURRENCY_CAP} ${testPath}`;
/** Default typecheck command when neither the task spec nor the runner config overrides it. */
const DEFAULT_TYPECHECK_COMMAND = "npx tsc --noEmit";

export interface WorktreeTask {
  id: string;
  description: string;
  branch: string;
  worktreePath: string;
  /**
   * Repo root the worktree belongs to — required so teardown can actually remove
   * the worktree and its branch. Populated at worktree creation (via
   * `git rev-parse --show-toplevel` or from `createWorktree`'s returned Worktree).
   * Without it, cleanup would silently no-op and leak every worktree (worktree-isolation:f1).
   */
  repoRoot: string;
  status: "pending" | "running" | "completed" | "failed";
  /**
   * Structured implement spec (subagent-authored content): the protocol writes
   * `testPath`/`testCode` first (TDD), materializes `implPath`/`implCode` when
   * the first test run is red, then typechecks, reviews, and commits. Absent =
   * the protocol honestly reports nothing it can mechanically author.
   */
  spec?: ImplementTaskSpec;
  result?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

/**
 * Authored content the /implement protocol executes mechanically. A workflow
 * author or an LLM pass produces test + implementation for one blueprint step;
 * the protocol only runs the verified sequence over it.
 */
export interface ImplementTaskSpec {
  /** Test file path relative to the worktree root (TDD step 1 writes this). */
  testPath: string;
  /** Test file content. */
  testCode: string;
  /** Implementation file path relative to the worktree root. */
  implPath: string;
  /** Implementation content, materialized when the first test run is red. */
  implCode: string;
  /** Extra files the change is allowed to touch (scope-creep allowlist). */
  allowedPaths?: string[];
  /**
   * Test-runner command override; default the capped single-file invocation
   * (see DEFAULT_TEST_COMMAND). A directory/glob override runs uncapped at
   * node's default availableParallelism() - 1 workers per task.
   */
  testCommand?: string;
  /**
   * Typecheck command override; default `npx tsc --noEmit`. Svelte projects
   * override with e.g. `npx svelte-check --tsconfig ./tsconfig.json`.
   */
  typecheckCommand?: string;
  /** Commit message override; default `implement(<taskId>): <description>`. */
  commitMessage?: string;
}

/** One protocol step's outcome: real boolean + captured output. */
interface ImplementStepResult {
  name: string;
  ok: boolean;
  output: string;
  durationMs: number;
}

/** Full /implement protocol verdict — every field is a real, measured outcome. */
export interface ImplementProtocolResult {
  testsWritten: boolean;
  testsPassed: boolean;
  implWritten: boolean;
  typecheckPassed: boolean;
  reviewPassed: boolean;
  committed: boolean;
  commitHash?: string;
  steps: ImplementStepResult[];
}

/** Command/knob overrides for {@link implementProtocol}, sourced from the runner config. */
interface ImplementRuntimeOptions {
  testCommand?: string;
  typecheckCommand?: string;
  commandTimeoutMs?: number;
}

export interface WorktreeRunnerConfig {
  maxConcurrent: number;
  modelTier: "small" | "medium" | "big";
  cleanupOnComplete: boolean;
  /** Default test-runner command for every task; per-task spec wins. */
  testCommand?: string;
  /** Default typecheck command for every task; per-task spec wins. */
  typecheckCommand?: string;
  /** Hard per-command timeout for test/typecheck runs (default 120s). */
  commandTimeoutMs?: number;
  /**
   * Task-completion hook (G5): fired the moment each task's protocol settles
   * (status final, completedAt stamped), before the runner proceeds to the next
   * task — the exact point a per-subagent checkpoint must be persisted.
   * Production wires this to the run-persistence layer's atomic saveCheckpoint();
   * the runner treats a rejecting hook as best-effort so a checkpoint write
   * failure can never flip an already-landed protocol result.
   */
  onTaskComplete?: (task: WorktreeTask, result: RunResult) => void | Promise<void>;
}

export interface RunResult {
  taskId: string;
  success: boolean;
  output: string;
  duration: number;
  testsPassed?: boolean;
}

export interface WorktreeRunner {
  executeTasks(tasks: WorktreeTask[]): Promise<RunResult[]>;
  getTaskStatus(taskId: string): WorktreeTask | undefined;
  cleanup(): Promise<void>;
  abort(): void;
}

const DEFAULT_CONFIG: WorktreeRunnerConfig = {
  maxConcurrent: 4,
  modelTier: "medium",
  cleanupOnComplete: true,
  commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
};

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

interface CommandResult {
  ok: boolean;
  code: number | string | null;
  stdout: string;
  stderr: string;
}

/**
 * Terminate a spawned command's WHOLE process tree, not just the direct shell
 * child. With `shell: true` the direct child is a shell (cmd.exe on Windows,
 * /bin/sh on POSIX) and a bare `child.kill()` orphans the actual command
 * process — the orphan keeps running (and, on Windows, keeps holding the
 * worktree dir as its cwd) long after the shell died. POSIX spawns detached
 * into their own process group so group-kill reaches every descendant;
 * Windows walks the tree via taskkill.
 */
function killProcessTree(child: ChildProcess): void {
  if (process.platform === "win32") {
    if (child.pid) {
      try {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        return;
      } catch {
        // taskkill unavailable — fall through to the direct kill
      }
    }
  } else {
    try {
      process.kill(-(child.pid ?? 0), "SIGKILL");
      return;
    } catch {
      // group already gone — fall through to the direct kill
    }
  }
  child.kill();
}

/**
 * Run one shell command line in a worktree and capture its exit code and output.
 * Shell-resolved (`npx`/`node` from PATH) so the protocol works on Windows too;
 * the command lines are developer/spec-authored, never raw user input.
 *
 * The child env is sanitized because a test-runner child must never inherit the
 * host's node:test context: when the protocol runs under `tsx --test` (CI,
 * unit tests) the parent sets NODE_TEST_CONTEXT, and a spawned `node --test`
 * that sees it believes it is nested inside another test run, skips the file,
 * and exits 0 — a FALSE green that silently skips TDD verification.
 *
 * stdio lifecycle (G8): the child's stdin is explicitly ignored (protocol
 * commands never read it) and stdout/stderr are piped ONLY for the protocol's
 * captured output — then destroyed the instant the child closes, so the pipe
 * handles are unbound immediately instead of lingering until GC across the
 * many spawn cycles a long fan-out performs.
 */
export async function runWorktreeCommand(commandLine: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise<CommandResult>((resolveCommand) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(commandLine, {
      cwd,
      windowsHide: true,
      env,
      shell: true,
      // Detached on POSIX so the timeout path can group-kill the whole tree
      // (see killProcessTree); stdio: no stdin pipe at all, stdout/stderr
      // piped only for capture and released in the settle path below.
      detached: process.platform !== "win32",
      // G8: no stdin pipe at all; stdout/stderr piped only for capture and
      // released in the settle path below (pipe-then-destroy).
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdioOverflow = false;
    let settled = false;
    const timer = setTimeout(() => {
      killProcessTree(child);
      settle(false, "timeout");
    }, timeoutMs);
    timer.unref?.();
    const settle = (ok: boolean, code: number | string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Pipe-then-destroy (G8): the captured output has been handed to the
      // caller — release the pipe handles NOW so no fd lingers across cycles.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveCommand({ ok, code, stdout, stderr });
    };
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      // exec's maxBuffer analogue: a runaway command flooding stdout must be
      // killed rather than buffered without bound.
      if (stdout.length > COMMAND_MAX_BUFFER) {
        stdioOverflow = true;
        killProcessTree(child);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // A spawn failure (npx missing etc.) reports a string code; a non-zero
    // exit reports a numeric code — neither is a pass.
    child.on("error", (error: NodeJS.ErrnoException) => settle(false, error.code ?? "spawn"));
    child.on("close", (code) => settle(code === 0 && !stdioOverflow, code));
  });
}

function formatCommandOutput(result: CommandResult, attempt: number): string {
  const out = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return `run ${attempt}: exit ${String(result.code)}${out ? `\n${out}` : ""}`;
}

// ---------------------------------------------------------------------------
// Pure review helpers (exported: unit-tested + usable as diagnostics)
// ---------------------------------------------------------------------------

/** Resolve the actual commands for a task: spec > runtime > built-in default. */
export function resolveProtocolCommands(
  runtime: ImplementRuntimeOptions | undefined,
  spec: ImplementTaskSpec | undefined,
  testPath: string | undefined,
): { testCommand: string; typecheckCommand: string } {
  return {
    testCommand: (spec?.testCommand ?? runtime?.testCommand ?? DEFAULT_TEST_COMMAND(testPath ?? "")).trim(),
    typecheckCommand: spec?.typecheckCommand ?? runtime?.typecheckCommand ?? DEFAULT_TYPECHECK_COMMAND,
  };
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Paths of files appearing as additions/modifications in a unified diff. */
function diffPaths(diffText: string): string[] {
  const paths: string[] = [];
  for (const line of diffText.split("\n")) {
    const match = /^\+\+\+\s+"?b\/(.+?)"?$/.exec(line.trim());
    if (!match) continue;
    // A deleted file is `+++ /dev/null` — nothing to review in scope terms.
    if (match[1] === "/dev/null") continue;
    paths.push(normalizeRelPath(match[1].replace(/\\"/g, '"').replace(/\\([\\ ])/g, "$1")));
  }
  return paths;
}

/**
 * Self-review a protocol diff: flag TODO/FIXME/HACK/XXX markers and any file
 * outside the task's allowed change set (scope creep). Pure and deterministic.
 */
export function reviewProtocolDiff(
  diffText: string,
  allowedPaths: readonly string[],
): { ok: boolean; findings: string[] } {
  const findings: string[] = [];
  const marker = /\b(TODO|FIXME|HACK|XXX)\b/;
  for (const line of diffText.split("\n")) {
    const trimmed = line.trim();
    if (marker.test(trimmed)) {
      findings.push(`TODO marker in diff: ${trimmed.slice(0, 120)}`);
    }
  }
  const allowed = new Set(allowedPaths.map(normalizeRelPath));
  for (const path of diffPaths(diffText)) {
    if (!allowed.has(path)) findings.push(`out-of-scope file: ${path}`);
  }
  return { ok: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// implementProtocol — the real TDD → typecheck → review → commit sequence
// ---------------------------------------------------------------------------

function stepOk(step: ImplementStepResult): boolean {
  return step.ok;
}

/**
 * Execute the /implement protocol for one task inside its worktree:
 *
 *   1. write-test     write the spec's test file (TDD),
 *   2. test           run the test runner until green (materializing the impl
 *                     file on the first red run), capped at 3 attempts,
 *   3. typecheck      run the project typechecker,
 *   4. self-review    re-read the diff, flag TODO markers + scope creep,
 *   5. commit         commit to the worktree branch (blocked unless 2–4 passed).
 *
 * Returns every step's real boolean + captured output. A task without a spec
 * short-circuits: nothing is written, run, or committed — honest `false` steps
 * are the whole point (the old stub returned all-`true` fiction).
 */
export async function implementProtocol(
  task: WorktreeTask,
  runtime: ImplementRuntimeOptions = {},
): Promise<ImplementProtocolResult> {
  const spec = task.spec;
  const steps: ImplementStepResult[] = [];
  const timeoutMs = runtime.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  if (!spec) {
    const reason =
      "no implement spec on task (spec.testPath/testCode required) — subagent-authored test/impl content must be attached before mechanical authoring";
    for (const name of ["write-test", "test", "typecheck", "self-review", "commit"]) {
      steps.push({ name, ok: false, output: `${name} skipped: ${reason}`, durationMs: 0 });
    }
    return {
      testsWritten: false,
      testsPassed: false,
      implWritten: false,
      typecheckPassed: false,
      reviewPassed: false,
      committed: false,
      steps,
    };
  }

  const { testCommand, typecheckCommand } = resolveProtocolCommands(runtime, spec, spec.testPath);

  // ── 1. write-test ────────────────────────────────────────────────────────
  const writeStart = Date.now();
  const testFullPath = safeJoin(task.worktreePath, spec.testPath);
  let testsWritten = false;
  let writeOutput: string;
  if (!testFullPath) {
    writeOutput = "write-test failed: test path escapes the worktree";
  } else {
    try {
      await mkdir(dirname(testFullPath), { recursive: true });
      await writeFile(testFullPath, spec.testCode, "utf-8");
      testsWritten = true;
      writeOutput = `wrote ${spec.testPath} (${Buffer.byteLength(spec.testCode, "utf-8")} bytes)`;
    } catch (error) {
      writeOutput = `write-test failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  steps.push({ name: "write-test", ok: testsWritten, output: writeOutput, durationMs: Date.now() - writeStart });

  // ── 2. test (until green, materializing the impl on first red) ──────────
  const testStart = Date.now();
  let testsPassed = false;
  let implWritten = false;
  const testOutputs: string[] = [];
  for (let attempt = 1; attempt <= MAX_TEST_RUN_ATTEMPTS; attempt++) {
    const run = await runWorktreeCommand(testCommand, task.worktreePath, timeoutMs);
    testOutputs.push(formatCommandOutput(run, attempt));
    if (run.ok) {
      testsPassed = true;
      break;
    }
    if (!implWritten) {
      const implFullPath = safeJoin(task.worktreePath, spec.implPath);
      if (implFullPath) {
        try {
          await mkdir(dirname(implFullPath), { recursive: true });
          await writeFile(implFullPath, spec.implCode, "utf-8");
          implWritten = true;
          testOutputs.push(`test run ${attempt} red — materialized ${spec.implPath}`);
        } catch (error) {
          testOutputs.push(`impl materialization failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        testOutputs.push("impl path escapes the worktree — not written");
      }
    }
  }
  steps.push({
    name: "test",
    ok: testsPassed,
    output: testOutputs.join("\n---\n"),
    durationMs: Date.now() - testStart,
  });

  // ── 3. typecheck ─────────────────────────────────────────────────────────
  const typecheckStart = Date.now();
  const tc = await runWorktreeCommand(typecheckCommand, task.worktreePath, timeoutMs);
  const typecheckPassed = tc.ok;
  steps.push({
    name: "typecheck",
    ok: typecheckPassed,
    output: formatCommandOutput(tc, 1),
    durationMs: Date.now() - typecheckStart,
  });

  // ── 4. self-review (re-read the diff, flag TODOs + scope creep) ──────────
  const reviewStart = Date.now();
  let reviewPassed = false;
  let reviewOutput: string;
  try {
    // Intent-to-add makes NEW files visible to `git diff` so the review covers
    // the whole change (untracked files are invisible to plain git diff); the
    // commit step's `git add -A` then promotes them properly.
    await gitExec(["-C", task.worktreePath, "add", "-N", "."]);
    const diff = await gitExec(["-C", task.worktreePath, "diff", "--no-ext-diff"]);
    const allowed = [spec.testPath, spec.implPath, ...(spec.allowedPaths ?? [])];
    const verdict = reviewProtocolDiff(diff, allowed);
    reviewPassed = verdict.ok;
    reviewOutput = diff
      ? `${diff.trim()}\n${verdict.findings.length ? `findings:\n${verdict.findings.join("\n")}` : "no findings"}`
      : "empty diff — nothing to review";
  } catch (error) {
    reviewOutput = `self-review failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  steps.push({
    name: "self-review",
    ok: reviewPassed,
    output: reviewOutput,
    durationMs: Date.now() - reviewStart,
  });

  // ── 5. commit (blocked unless tests + typecheck + review are green) ──────
  const commitStart = Date.now();
  let committed = false;
  let commitHash: string | undefined;
  let commitOutput: string;
  const blockers = [
    testsPassed ? null : "tests are red",
    typecheckPassed ? null : "typecheck failed",
    reviewPassed ? null : "self-review flagged issues",
  ].filter((b): b is string => b !== null);
  if (blockers.length > 0) {
    commitOutput = `commit blocked: ${blockers.join(", ")} — nothing was committed`;
  } else {
    try {
      await gitExec(["-C", task.worktreePath, "add", "-A"]);
      await gitExec([
        "-C",
        task.worktreePath,
        "commit",
        "-m",
        spec.commitMessage ?? `implement(${task.id}): ${task.description.slice(0, 72)}`,
      ]);
      commitHash = (await gitExec(["-C", task.worktreePath, "rev-parse", "HEAD"])).trim();
      committed = true;
      commitOutput = `committed ${commitHash.slice(0, 12)} to ${task.branch}`;
    } catch (error) {
      commitOutput = `commit failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  steps.push({
    name: "commit",
    ok: committed,
    output: commitOutput,
    durationMs: Date.now() - commitStart,
  });

  return {
    testsWritten,
    testsPassed,
    implWritten,
    typecheckPassed,
    reviewPassed,
    committed,
    commitHash,
    steps,
  };
}

/**
 * Join a spec-relative path to the worktree root, refusing anything that
 * escapes the worktree (absolute paths, `..` traversal).
 */
function safeJoin(worktreePath: string, relPath: string): string | null {
  const full = resolve(worktreePath, relPath);
  const rel = relative(worktreePath, full);
  if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === "..") return null;
  return full;
}

export async function executeTask(task: WorktreeTask, config: WorktreeRunnerConfig): Promise<RunResult> {
  const start = Date.now();
  task.status = "running";
  task.startedAt = new Date().toISOString();
  let result: RunResult;
  try {
    const protocol = await implementProtocol(task, {
      testCommand: config.testCommand,
      typecheckCommand: config.typecheckCommand,
      commandTimeoutMs: config.commandTimeoutMs,
    });
    // A task is only "completed" when its protocol actually landed a verified
    // commit on the worktree branch — anything less is an honest failure.
    const success = protocol.committed && protocol.testsPassed && protocol.typecheckPassed;
    task.status = success ? "completed" : "failed";
    task.result = protocol;
    if (!success) {
      task.error = protocol.steps.find((s) => !stepOk(s))?.output ?? "implement protocol incomplete";
    }
    task.completedAt = new Date().toISOString();
    result = {
      taskId: task.id,
      success,
      output: JSON.stringify(protocol, null, 2),
      duration: Date.now() - start,
      testsPassed: protocol.testsPassed && protocol.typecheckPassed,
    };
  } catch (err) {
    task.status = "failed";
    task.error = err instanceof Error ? err.message : String(err);
    task.completedAt = new Date().toISOString();
    result = { taskId: task.id, success: false, output: task.error, duration: Date.now() - start };
  }
  // G5: the task-completion hook fires exactly here — status is final, the
  // protocol result is fixed — so a per-subagent checkpoint can be persisted
  // atomically (tmp+rename via the persistence layer) BEFORE the runner moves
  // on. Rejections are best-effort: a checkpoint write must never flip an
  // already-landed task result (the production wiring additionally collects
  // them for the printed summary).
  try {
    await config.onTaskComplete?.(task, result);
  } catch {
    // durability side-channel failure — the protocol verdict stands
  }
  return result;
}

export function createWorktreeRunner(config?: Partial<WorktreeRunnerConfig>): WorktreeRunner {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const tasks = new Map<string, WorktreeTask>();
  let aborted = false;

  /**
   * Startup orphan-worktree sweep (worktree-isolation:i1): reclaim worktrees left
   * behind by crashed runs before this run executes, so a stale `pi/wf/<id>` branch
   * can't block `git worktree add -b` on resume. The active set is THIS run's task
   * paths — any other worktree in the same repo is reclaimed, per repo root.
   * Best-effort: a failed sweep is retried on the next run.
   */
  const sweepOrphans = async (taskList: WorktreeTask[]): Promise<void> => {
    const byRoot = new Map<string, string[]>();
    for (const task of taskList) {
      const paths = byRoot.get(task.repoRoot) ?? [];
      paths.push(task.worktreePath);
      byRoot.set(task.repoRoot, paths);
    }
    for (const [repoRoot, activePaths] of byRoot) {
      try {
        await sweepOrphanWorktrees(repoRoot, activePaths);
      } catch {
        // best-effort — leftovers are retried on the next run
      }
    }
  };

  return {
    async executeTasks(taskList: WorktreeTask[]): Promise<RunResult[]> {
      await sweepOrphans(taskList);
      const results: RunResult[] = [];
      const chunks: WorktreeTask[][] = [];
      for (let i = 0; i < taskList.length; i += cfg.maxConcurrent) {
        chunks.push(taskList.slice(i, i + cfg.maxConcurrent));
      }
      for (const chunk of chunks) {
        if (aborted) break;
        const batch = await Promise.all(
          chunk.map((t) => {
            tasks.set(t.id, t);
            return executeTask(t, cfg);
          }),
        );
        results.push(...batch);
      }
      if (cfg.cleanupOnComplete) {
        for (const task of taskList) {
          try {
            await removeWorktree({
              isolated: true,
              cwd: task.worktreePath,
              branch: task.branch,
              repoRoot: task.repoRoot,
            });
          } catch {
            // best-effort cleanup; leftovers are reclaimed by sweepOrphanWorktrees
          }
        }
      }
      return results;
    },
    getTaskStatus: (taskId: string) => tasks.get(taskId),
    async cleanup() {
      for (const task of tasks.values()) {
        try {
          await removeWorktree({
            isolated: true,
            cwd: task.worktreePath,
            branch: task.branch,
            repoRoot: task.repoRoot,
          });
        } catch {
          // best-effort cleanup; leftovers are reclaimed by sweepOrphanWorktrees
        }
      }
      tasks.clear();
    },
    abort() {
      aborted = true;
    },
  };
}
