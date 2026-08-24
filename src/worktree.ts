/**
 * Per-agent git worktree isolation. When an agent requests `isolation: "worktree"`,
 * it runs in a throwaway worktree on its own branch so parallel agents can edit the
 * same files without conflict. Falls back to a logged no-op when isolation isn't
 * possible.
 *
 * Teardown contract (worktree-isolation:f2): before a worktree is removed, its
 * working tree is finalized (`git add -A` + `git commit --allow-empty`, best-effort)
 * so agent edits are never silently destroyed by `git worktree remove --force`.
 * Callers may opt out of removal entirely (keepWorktree) to retain the branch and
 * path for inspection; otherwise the finalized branch and worktree are discarded.
 * Every git invocation goes through the central `gitExec` helper (worktree-isolation:i4)
 * so a hung git process can never pin a worktree slot forever. Leaked worktrees from
 * crashed runs are reclaimed at startup via `sweepOrphanWorktrees` (worktree-isolation:i1).
 */

import { type ChildProcess, execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { recordProvenance } from "./durable-store.js";

export interface Worktree {
  /** True when a real worktree was created; false means "ran in the shared tree". */
  isolated: boolean;
  /** cwd the agent should run in (worktree path when isolated, else the base cwd). */
  cwd: string;
  branch?: string;
  /** Repo root the worktree was added to (for teardown). */
  repoRoot?: string;
  /** Why isolation was skipped, when isolated === false. */
  reason?: string;
}

/** Optional knobs for the central git exec helper. */
interface GitExecOptions {
  /** Hard per-command timeout in ms (default GIT_TIMEOUT_MS). */
  timeoutMs?: number;
  /** When aborted, the in-flight git child is SIGKILLed and the call rejects. */
  signal?: AbortSignal;
  /**
   * P06 provenance: the stable run identity whose durable-store ledger the
   * worktree-finalize claim should be recorded into (resolved from the
   * durable-store module registry; no-op when unset or no store is bound).
   * The workflow runner's own finalize call site does not pass it (the
   * manager records the same claim from onAgentEnd instead); direct callers
   * and tests can wire it here.
   */
  provenanceRunId?: string;
}

const GIT_TIMEOUT_MS = 30_000;
/** `git worktree list --porcelain` on a large repo can exceed the 1 MB default. */
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
/** Marker commit message used when finalizing an agent worktree pre-teardown. */
const FINALIZE_COMMIT_MESSAGE = "pi-dynamic-workflows: finalize agent worktree (pre-teardown)";
/** Path (relative to the repo root) where isolated worktrees live. */
const WORKTREES_SUBDIR = ".pi/worktrees";

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent"
  );
}

/**
 * Central git exec helper (worktree-isolation:i4). Runs `git` with a hard timeout
 * and an optional AbortSignal so a hung git process cannot pin a worktree slot
 * forever. The underlying child is SIGKILLed on timeout/abort (on Windows `kill`
 * terminates the process). Resolves with stdout.
 */
export async function gitExec(args: string[], opts: GitExecOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | undefined;
    const finish = (error: Error | null, stdout?: string) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(stdout as string);
    };
    const onAbort = () => {
      child?.kill("SIGKILL");
      finish(new Error(`git command aborted: git ${args.join(" ")}`));
    };
    child = execFile("git", args, { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        finish(new Error(`git ${args.join(" ")} failed: ${error.message}${detail}`));
      } else {
        finish(null, stdout);
      }
    });
    timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish(new Error(`git command timed out after ${timeoutMs}ms: git ${args.join(" ")}`));
    }, timeoutMs);
    timer.unref?.();
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Create an isolated worktree under `<repoRoot>/.pi/worktrees/<name>` on branch
 * `pi/wf/<name>`. The `name` must be deterministic (derived from runId + call index,
 * never wall-clock) so resume keys stay stable. Returns a no-op Worktree on any failure.
 *
 * M14: the deterministic slug means a crashed prior run (or a keepWorktree'd run)
 * may have left the exact path behind — `git worktree add` would fail on it and
 * silently degrade this agent to the shared tree while the stale worktree leaks.
 * So the path is checked FIRST: a REGISTERED worktree at that path is reused (with
 * its real branch surfaced for teardown), an orphaned directory is cleaned and
 * recreated, and only a genuine creation failure falls back with a surfaced reason.
 */
export async function createWorktree(baseCwd: string, name: string, opts: GitExecOptions = {}): Promise<Worktree> {
  const id = slug(name);
  let repoRoot: string;
  try {
    repoRoot = (await gitExec(["-C", baseCwd, "rev-parse", "--show-toplevel"], opts)).trim();
  } catch {
    return { isolated: false, cwd: baseCwd, reason: "not a git repository" };
  }

  const path = join(repoRoot, WORKTREES_SUBDIR, id);
  const branch = `pi/wf/${id}`;
  // Existence/registration pre-check (M14): a deterministic slug means a
  // crashed prior run (or a keepWorktree'd run) may have left this exact path
  // behind — `git worktree add` would fail on it and silently degrade this
  // agent to the shared tree while the stale worktree leaks. Handle every
  // stale shape explicitly and surface the outcome:
  //   - REGISTERED worktree whose directory still EXISTS -> reuse it (report
  //     the real branch for teardown);
  //   - registered but the directory is GONE (crashed run removed files) ->
  //     clear the stale registration and recreate fresh;
  //   - orphaned directory (exists but not registered) -> clean + recreate;
  //   - anything else -> a plain `git worktree add`.
  const registered = await findRegisteredWorktree(repoRoot, path, opts);
  if (registered && existsSync(path)) {
    return {
      isolated: true,
      cwd: path,
      branch: registered.branch ?? branch,
      repoRoot,
      reason: "reused existing worktree (registered at this path)",
    };
  }
  if (registered) {
    // Registration without a directory: clear it (best-effort) so the add
    // below can mint a fresh, usable worktree; never return an isolated cwd
    // that doesn't exist.
    try {
      await gitExec(["-C", repoRoot, "worktree", "remove", "--force", path], opts);
    } catch {
      // a removal that fails (locked/missing metadata) is retried below via
      // the add failure path with a surfaced reason
    }
    try {
      if (registered.branch) await gitExec(["-C", repoRoot, "branch", "-D", registered.branch], opts);
    } catch {
      // branch may already be gone or checked out elsewhere — the add below
      // decides
    }
  }
  if (existsSync(path)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      return {
        isolated: false,
        cwd: baseCwd,
        reason: `stale worktree at ${path} could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  try {
    await gitExec(["-C", repoRoot, "worktree", "add", "-b", branch, path, "HEAD"], opts);
    return {
      isolated: true,
      cwd: path,
      branch,
      repoRoot,
      reason: registered ? "recreated after clearing a stale registration" : undefined,
    };
  } catch (error) {
    return { isolated: false, cwd: baseCwd, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Look up a registered git worktree at `path` via `git worktree list
 * --porcelain`, returning its branch when present. Returns null when the path
 * is NOT registered (an orphaned directory left behind by a crashed run).
 */
async function findRegisteredWorktree(
  repoRoot: string,
  path: string,
  opts: GitExecOptions = {},
): Promise<{ branch?: string } | null> {
  let list: string;
  try {
    list = await gitExec(["-C", repoRoot, "worktree", "list", "--porcelain"], opts);
  } catch {
    return null;
  }
  const target = normalizePath(path);
  for (const record of list.split(/\n\s*\n/)) {
    const lines = record.split("\n");
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (!pathLine) continue;
    if (normalizePath(pathLine.slice("worktree ".length).trim()) !== target) continue;
    const branchLine = lines.find((line) => line.startsWith("branch "));
    return {
      branch: branchLine
        ? branchLine
            .slice("branch ".length)
            .trim()
            .replace(/^refs\/heads\//, "")
        : undefined,
    };
  }
  return null;
}

/**
 * Reclaim stale worktree administrative data (M14): `git worktree prune`
 * removes metadata for worktrees whose directories are already gone. Best-effort;
 * callers (e.g. the manager constructor) invoke it opportunistically so a
 * deterministic slug's reuse path never collides with ghost registrations.
 */
export async function pruneWorktrees(repoRoot: string, opts: GitExecOptions = {}): Promise<void> {
  try {
    await gitExec(["-C", repoRoot, "worktree", "prune"], opts);
  } catch {
    // best-effort — a locked/odd repo is retried on the next opportunistic call
  }
}

/** Remove a worktree and its branch. Best-effort; safe to call on a no-op Worktree. */
export async function removeWorktree(wt: Worktree, opts: GitExecOptions = {}): Promise<void> {
  if (!wt.isolated || !wt.repoRoot || !wt.cwd) return;
  try {
    await gitExec(["-C", wt.repoRoot, "worktree", "remove", "--force", wt.cwd], opts);
  } catch {
    // already gone / locked — fall through
  }
  if (wt.branch) {
    try {
      await gitExec(["-C", wt.repoRoot, "branch", "-D", wt.branch], opts);
    } catch {
      // branch already deleted or checked out in another worktree
    }
  }
}

/** Result of {@link finalizeWorktree}; surfaces the failing git step + stderr so an
 * operator can distinguish trivially fixable failures (e.g. no user.identity) from
 * ones requiring different remediation (worktree gone / locked / git broken). */
interface FinalizeResult {
  ok: boolean;
  /** `git` step that failed (`add -A` or `commit`) plus the trimmed stderr, when !ok. */
  reason?: string;
}

/**
 * Commit any uncommitted agent edits in an isolated worktree so teardown can never
 * silently destroy them (worktree-isolation:f2). Runs `git add -A` + `git commit
 * --allow-empty` inside the worktree. Best-effort: returns `{ ok: false }` (leaving
 * the tree untouched) when the repo has no user identity, the worktree is gone, or
 * any git call fails — with `reason` naming the failing git step + trimmed stderr so
 * the caller can log actionable context rather than a generic string. A no-op
 * Worktree also returns `{ ok: false }`.
 */
export async function finalizeWorktree(wt: Worktree, opts: GitExecOptions = {}): Promise<FinalizeResult> {
  if (!wt.isolated || !wt.repoRoot || !wt.cwd) return { ok: false };
  // Each git step is run sequentially and tracked so the surfaced `reason`
  // identifies WHICH step failed (`add -A` vs `commit`) plus the trimmed stderr.
  const steps: Array<{ step: string; run: () => Promise<string> }> = [
    { step: "add -A", run: () => gitExec(["-C", wt.cwd, "add", "-A"], opts) },
    {
      step: "commit",
      run: () => gitExec(["-C", wt.cwd, "commit", "--allow-empty", "-m", FINALIZE_COMMIT_MESSAGE], opts),
    },
  ];
  for (const { step, run } of steps) {
    try {
      await run();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `git ${step} failed: ${detail}` };
    }
  }
  // P06 provenance at worktree finalize: a successful finalize IS the claim
  // that this worktree's agent edits were committed (so teardown could never
  // silently destroy them). Recorded into the run's durable-store ledger when
  // a run identity is wired (see GitExecOptions.provenanceRunId). Best-effort
  // — a durable-store failure must never fail the finalize.
  if (opts.provenanceRunId) {
    try {
      await recordProvenance(opts.provenanceRunId, {
        source: "worktree",
        file: wt.cwd,
        agent: wt.branch,
      });
    } catch {
      // provenance is observability, not execution
    }
  }
  return { ok: true };
}

function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, "").replace(/\\/g, "/");
}

/**
 * Startup orphan-worktree sweep (worktree-isolation:i1): enumerate every git
 * worktree under `repoRoot` (`git worktree list --porcelain`) and remove the ones
 * whose paths are NOT in `activeWorktreePaths`. Callers pass the worktrees they
 * currently own so a concurrent run's live worktrees are never touched; the main
 * checkout and bare repositories are always skipped. Best-effort: failures are
 * swallowed, so a leftover is simply retried on the next sweep.
 *
 * NOTE: the active set is caller-provided by design. A consumer running several
 * runners over the same repo must include every live worktree in the active set,
 * otherwise another run's worktrees look orphaned and are reclaimed.
 */
export async function sweepOrphanWorktrees(
  repoRoot: string,
  activeWorktreePaths: readonly string[],
  opts: GitExecOptions = {},
): Promise<void> {
  let list: string;
  try {
    list = await gitExec(["-C", repoRoot, "worktree", "list", "--porcelain"], opts);
  } catch {
    return; // not a git repository / git missing — nothing to sweep
  }
  const active = new Set(activeWorktreePaths.map(normalizePath));
  const root = normalizePath(repoRoot);
  for (const record of list.split(/\n\s*\n/)) {
    const lines = record.split("\n");
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (!pathLine) continue;
    // Bare repositories have no working tree to reclaim.
    if (lines.some((line) => line === "bare")) continue;
    const path = normalizePath(pathLine.slice("worktree ".length).trim());
    // Never touch the main checkout.
    if (path === root) continue;
    if (active.has(path)) continue;
    const branchLine = lines.find((line) => line.startsWith("branch "));
    const branch = branchLine
      ? branchLine
          .slice("branch ".length)
          .trim()
          .replace(/^refs\/heads\//, "")
      : undefined;
    try {
      await removeWorktree({ isolated: true, cwd: path, branch, repoRoot }, opts);
    } catch {
      // best-effort — a locked or already-removed worktree is retried next sweep
    }
  }
}
