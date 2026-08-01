/**
 * Optional pre-run typecheck for workflow scripts (P2-2 guardrail).
 *
 * runWorkflow's acorn parse already catches syntax errors; this adds a
 * voluntary `tsc --noEmit` pass so type mistakes (bad literal assignments,
 * wrong agent() argument types, misspelled globals) surface BEFORE execution
 * instead of mid-run. It is strictly OPT-IN (`preRunTypecheck` on
 * WorkflowRunOptions) and SOFT-FAIL: every failure mode — no TypeScript
 * toolchain, a spawn error, a timeout, or tsc reporting problems — degrades
 * to a warning and the run proceeds. Users without a toolchain are never
 * blocked; the check is advisory only.
 *
 * The script is typechecked via a generated temp project (a minimal tsconfig
 * plus an ambient declaration of the workflow runtime globals), so genuine
 * authoring errors stand out instead of being drowned in "cannot find name
 * 'agent'" noise. The body is re-scoped into an async runner function because
 * workflow scripts use top-level `return`/`await`, which is legal in the vm
 * (parseWorkflowScript parses with allowReturnOutsideFunction) but is a
 * TS1108 error at module top level.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The parsed workflow script segments the runtime already extracted. */
export interface TypecheckInput {
  /** The evaluated `export const meta` value (literal-only, JSON-safe). */
  meta: unknown;
  /** The script minus the meta export — the same `body` the vm executes. */
  body: string;
}

/** Result of the advisory pre-run typecheck. Never throws; never blocks the run. */
export interface TypecheckOutcome {
  /** True when tsc reported zero problems (or the check did not run because the toolchain is missing). */
  ok: boolean;
  /** Whether the check itself could not run (no toolchain, spawn failure, timeout). */
  unavailable: boolean;
  /** Human-readable diagnostics: the first lines of tsc output, or why the check could not run. */
  detail: string;
}

export interface TypecheckOptions {
  /** Base directory used to resolve a project-local TypeScript install. */
  cwd?: string;
  /** Hard cap on the tsc child process in ms. Defaults to TYPECHECK_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Explicit tsc bin path (tests). `null` forces the toolchain-missing path;
   * omitted means resolve from this package, then the caller's project.
   */
  binPath?: string | null;
}

/** Hard cap on the tsc child process; a hung tsc must never hang a run. */
export const TYPECHECK_TIMEOUT_MS = 30_000;

/** Cap on how much tsc output is folded into the run's warning log. */
const MAX_DETAIL_LENGTH = 600;

/**
 * Ambient declarations for every global the vm context injects (see the
 * runtimeImplementations object in workflow.ts), so a clean script passes and
 * real type errors — not missing-global noise — are what tsc reports.
 */
const WORKFLOW_GLOBALS_DECLARATION = `declare global {
  function agent(prompt: string, options?: unknown): Promise<unknown>;
  function parallel(thunks: Array<() => Promise<unknown>>): Promise<Array<unknown | null>>;
  function pipeline(
    items: unknown[],
    ...stages: Array<(previousValue: unknown, item: unknown, index: number) => unknown>
  ): Promise<Array<unknown | null>>;
  function workflow(nameOrScript: string, childArgs?: unknown): Promise<unknown>;
  function verify(
    item: unknown,
    options?: { reviewers?: number; threshold?: number; lens?: string | string[] },
  ): Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real: boolean; reason?: string }> }>;
  function judgePanel(
    attempts: unknown[],
    options?: { judges?: number; rubric?: string },
  ): Promise<{ index: number; attempt: unknown; score: number; judgments: Array<{ score: number; reason?: string }> } | undefined>;
  function loopUntilDry(options: {
    round: (roundIndex: number) => Promise<unknown[]> | unknown[];
    key?: (item: unknown) => string;
    consecutiveEmpty?: number;
    maxRounds?: number;
  }): Promise<unknown[]>;
  function completenessCheck(taskArgs: unknown, results: unknown): Promise<unknown>;
  function retry(
    thunk: (attempt: number) => Promise<unknown> | unknown,
    options?: { attempts?: number; until?: (r: unknown) => boolean },
  ): Promise<unknown>;
  function gate(
    thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
    validator: (r: unknown) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string },
    options?: { attempts?: number },
  ): Promise<{ ok: boolean; value: unknown; attempts: number }>;
  function checkpoint(promptText: string, options?: unknown): Promise<unknown>;
  function log(message: unknown): void;
  function phase(title: string, options?: unknown): void;
  const args: unknown;
  const cwd: string;
  const budget: { total: number | null; spent: () => number; remaining: () => number };
  const process: { cwd: () => string };
}
export {};
`;

/** Minimal project file so `tsc --project` works uniformly across TS 5 and TS 6. */
const TYPECHECK_PROJECT = `{
  "compilerOptions": {
    "noEmit": true,
    "skipLibCheck": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": false
  },
  "files": ["./workflow.ts", "./globals.d.ts"]
}
`;

/**
 * Locate a runnable tsc. Order: this package's own install (the package ships
 * typescript as a devDependency, so repo-side tests resolve it), then the
 * caller's project node_modules. Returns null when neither exists — the caller
 * soft-fails rather than shelling out to `npx` (which could hit the network).
 */
function resolveTypeScriptBin(cwd: string): string | null {
  const candidates: Array<() => string> = [
    () => createRequire(import.meta.url).resolve("typescript/package.json"),
    () => createRequire(join(cwd, "noop.js")).resolve("typescript/package.json"),
  ];
  for (const candidate of candidates) {
    try {
      return join(dirname(candidate()), "bin", "tsc");
    } catch {
      // Try the next resolution path.
    }
  }
  return null;
}

/**
 * Run the advisory `tsc --noEmit` pass over a workflow script. Always resolves
 * to a TypecheckOutcome — never throws, never blocks the caller.
 */
export async function typecheckWorkflowScript(
  input: TypecheckInput,
  options: TypecheckOptions = {},
): Promise<TypecheckOutcome> {
  const cwd = options.cwd ?? process.cwd();
  const binPath = options.binPath !== undefined ? options.binPath : resolveTypeScriptBin(cwd);
  if (!binPath) {
    return {
      ok: false,
      unavailable: true,
      detail: "TypeScript toolchain not found (tsc is not installed in this package or the project) — check skipped",
    };
  }

  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-typecheck-"));
  try {
    // Re-scope the body into an async runner so top-level return/await (legal
    // in the vm, TS1108 at module scope) typecheck cleanly.
    const tsSource = `export const meta = ${JSON.stringify(input.meta)};\nconst __run = async () => {\n${input.body}\n};\nvoid __run;\n`;
    writeFileSync(join(dir, "workflow.ts"), tsSource);
    writeFileSync(join(dir, "globals.d.ts"), WORKFLOW_GLOBALS_DECLARATION);
    writeFileSync(join(dir, "tsconfig.json"), TYPECHECK_PROJECT);

    const { code, output } = await runTsc(binPath, dir, cwd, options.timeoutMs ?? TYPECHECK_TIMEOUT_MS);
    if (code === 0) return { ok: true, unavailable: false, detail: "" };
    return {
      ok: false,
      unavailable: false,
      detail: `tsc --noEmit reported problems:\n${truncate(output)}`,
    };
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      detail: `pre-run typecheck could not run: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Spawn tsc against the temp project; resolves with exit code and captured output. */
function runTsc(
  binPath: string,
  projectDir: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, "--project", projectDir], {
      cwd,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`tsc timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: `${stderr}\n${stdout}` });
    });
  });
}

/** Bound the diagnostic text folded into the run log. */
function truncate(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= MAX_DETAIL_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_DETAIL_LENGTH)}\n… (output truncated)`;
}
