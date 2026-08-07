/**
 * Shared registry of the 7 curated built-in workflow patterns
 * (`deep-research`, `adversarial-review`, `code-review`, `multi-perspective`,
 * `codebase-audit`, `plan-then-execute`, `spec-generation`).
 *
 * This is the single place that turns a pattern's name + caller-supplied args
 * into a runnable script (and, where a pattern needs it, an exec context such
 * as web tools). Both entry points a model or user can reach a built-in
 * through — the `/deep-research`-style slash commands (builtin-commands.ts)
 * and the `workflow` tool's `name` input (workflow-tool.ts) — resolve through
 * this one registry, so the two paths can never drift apart and the
 * per-pattern generator scripts are written exactly once.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCodingTools, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { generateAdversarialReviewWorkflow, generateMultiPerspectiveWorkflow } from "./adversarial-review.js";
import {
  ADVERSARIAL_REVIEW_NUMERIC_ARGS,
  CODE_REVIEW_NUMERIC_ARGS,
  DEEP_RESEARCH_NUMERIC_ARGS,
  validateNumericArgs,
} from "./builtin-args.js";
import { generateCodeReviewWorkflow } from "./code-review.js";
import { generateCodebaseAuditWorkflow, generateDeepResearchWorkflow } from "./deep-research.js";
import { DIFF_EXEC_KILL_SIGNAL, DIFF_EXEC_MAX_BUFFER, DIFF_EXEC_TIMEOUT_MS } from "./diff-exec.js";
import { generatePlanThenExecuteWorkflow, PLAN_THEN_EXECUTE_NUMERIC_ARGS } from "./plan-then-execute.js";
import { generateSpecGenerationWorkflow, SPEC_GENERATION_FORMATS } from "./spec-generation.js";
import { createWebTools } from "./web-tools.js";
import type { WorkflowStorage } from "./workflow-saved.js";

/** Default perspective set used when a caller gives fewer than two. */
export const DEFAULT_MULTI_PERSPECTIVES: readonly string[] = [
  "technical",
  "product",
  "security",
  "user experience",
  "maintainability",
];

/** A resolved, ready-to-run script plus the exec context it needs (if any). */
export interface BuiltinWorkflowInvocation {
  script: string;
  tools?: ToolDefinition[];
  toolset?: string;
}

interface BuiltinWorkflowDescriptor {
  /** Also the slash-command name (without the leading `/`). */
  name: string;
  description: string;
  /** Build the script (and exec context) for one invocation; throws on invalid `args`. */
  resolve(cwd: string, args: unknown): BuiltinWorkflowInvocation;
  /**
   * Optional host-side arg preparation for the workflow tool's `name` path,
   * run BEFORE resolve(). May be async because a pattern can need to fetch
   * data in the extension process — code-review resolves `diffSource` (a
   * git/gh command string) into `diff` by executing it (GAP-3). The slash
   * commands never run this hook: they fetch the same data themselves and
   * pass the already-resolved args straight to resolve() (builtin-commands.ts).
   */
  prepareArgs?(cwd: string, args: unknown, onNotify?: (message: string) => void): Promise<unknown>;
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function requireNonEmptyString(value: unknown, argName: string, patternName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Built-in workflow "${patternName}" requires args.${argName} to be a non-empty string.`);
  }
  return value;
}

function requireStringArray(value: unknown, argName: string, patternName: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v.trim())) {
    throw new Error(
      `Built-in workflow "${patternName}" requires args.${argName} to be a non-empty array of non-empty strings.`,
    );
  }
  return value;
}

/** The 7 curated built-in workflow patterns, keyed by their stable name. */
export const BUILTIN_WORKFLOWS: readonly BuiltinWorkflowDescriptor[] = [
  {
    name: "deep-research",
    description:
      "Research a question across the web with cross-checked sources. args: { question: string, angles?: number, minSupport?: number }.",
    resolve(cwd, args) {
      const record = asRecord(args);
      requireNonEmptyString(record.question, "question", "deep-research");
      // Numeric args (angles/minSupport) are bounds-checked here so an invalid
      // value (0, negative, absurd fan-out) fails loudly before a run starts;
      // the generated script enforces the same rules at runtime (builtins:i1).
      validateNumericArgs(record, DEEP_RESEARCH_NUMERIC_ARGS, "deep-research");
      return {
        script: generateDeepResearchWorkflow(),
        // Research agents need real web access on top of the coding tools; the
        // "web-research" tag is what a resumed run re-resolves (see
        // WorkflowManagerOptions.toolsets).
        tools: [...createCodingTools(cwd), ...createWebTools()],
        toolset: "web-research",
      };
    },
  },
  {
    name: "adversarial-review",
    description:
      "Investigate a task, then cross-check each finding with skeptical reviewers. args: { task: string, reviewers?: number, threshold?: number, maxFindings?: number }.",
    resolve(_cwd, args) {
      const record = asRecord(args);
      requireNonEmptyString(record.task, "task", "adversarial-review");
      validateNumericArgs(record, ADVERSARIAL_REVIEW_NUMERIC_ARGS, "adversarial-review");
      return { script: generateAdversarialReviewWorkflow() };
    },
  },
  {
    name: "code-review",
    description:
      "Multi-angle parallel code review: 8 specialized finders (correctness, removed-behavior, call-site, reuse, simplification, efficiency, altitude, security) + verify pass → ranked findings. args: { diff?: string, diffSource?: string (a 'git …'/'gh pr diff …' command whose output becomes diff when diff is not supplied), diffTruncated?: boolean, diffLength?: number, maxCandidates?: number, verifyBatchSize?: number }.",
    /**
     * GAP-3: `diffSource` was documented as a first-class tool-path arg but
     * never resolved there — the generated script only used it as a
     * `<diff source=…>` label (code-review.ts), so a model passing
     * diffSource:'git diff HEAD' could not get a real diff (it hit a
     * misleading "requires args.diff" error, or with an empty diff reviewed
     * nothing). This hook fetches the source host-side BEFORE resolve(),
     * mirroring the /code-review slash command's execFile fetch
     * (builtin-commands.ts) — same buffer cap, timeout, kill signal, and
     * empty-diff error. When `diff` is supplied the fetch is bypassed.
     */
    async prepareArgs(cwd, args, onNotify) {
      const record = asRecord(args);
      if (record.diffSource !== undefined && typeof record.diffSource !== "string") {
        throw new Error('Built-in workflow "code-review" requires args.diffSource to be a string when present.');
      }
      const diff = typeof record.diff === "string" ? record.diff : "";
      const diffSource = typeof record.diffSource === "string" ? record.diffSource.trim() : "";
      // An explicit diff wins; with no source named there is nothing to fetch
      // (resolve() then fails with its usual "requires args.diff" validation).
      if (diff.trim() || !diffSource) return args;
      const fetched = await fetchDiffFromSource(diffSource, cwd, onNotify);
      return { ...record, diff: fetched, diffSource };
    },
    resolve(_cwd, args) {
      const record = asRecord(args);
      // Truncation past MAX_DIFF_CHARS happens inside the generated script at
      // runtime (see code-review.ts); a caller invoking by name either supplies
      // `diff` itself or a `diffSource` command, which prepareArgs resolves
      // into `diff` before this validation runs (GAP-3).
      requireNonEmptyString(record.diff, "diff", "code-review");
      validateNumericArgs(record, CODE_REVIEW_NUMERIC_ARGS, "code-review");
      return { script: generateCodeReviewWorkflow() };
    },
  },
  {
    name: "multi-perspective",
    description:
      "Analyze a topic from several independent perspectives in parallel, then synthesize. args: { topic: string, perspectives?: string[] }.",
    resolve(_cwd, args) {
      const record = asRecord(args);
      const topic = requireNonEmptyString(record.topic, "topic", "multi-perspective");
      const perspectives =
        Array.isArray(record.perspectives) && record.perspectives.length >= 2
          ? requireStringArray(record.perspectives, "perspectives", "multi-perspective")
          : [...DEFAULT_MULTI_PERSPECTIVES];
      return { script: generateMultiPerspectiveWorkflow(topic, perspectives) };
    },
  },
  {
    name: "codebase-audit",
    description:
      "Run parallel checks against a codebase scope, then cross-validate and report. args: { scope: string, checks: string[] }.",
    resolve(_cwd, args) {
      const record = asRecord(args);
      const scope = requireNonEmptyString(record.scope, "scope", "codebase-audit");
      const checks = requireStringArray(record.checks, "checks", "codebase-audit");
      return { script: generateCodebaseAuditWorkflow(scope, checks) };
    },
  },
  {
    name: "plan-then-execute",
    description:
      "Decompose an objective into dependency-ordered steps, gate each step with a verifier (bounded rework), optionally execute each step. Pauses for human approval before any agent work (meta.gate: 'approve'). args: { objective: string, context?: string, maxSteps?: number, execute?: boolean }.",
    resolve(_cwd, args) {
      const record = asRecord(args);
      requireNonEmptyString(record.objective, "objective", "plan-then-execute");
      validateNumericArgs(record, PLAN_THEN_EXECUTE_NUMERIC_ARGS, "plan-then-execute");
      // Optional string/boolean args are type-checked here (loud pre-run failure)
      // and the generated script re-checks the strings at runtime; the boolean
      // is read with `=== true` so a present falsy value never becomes a truthy
      // default (same class of bug the numeric-arg coercion exists to prevent).
      if (record.context !== undefined && typeof record.context !== "string") {
        throw new Error(`Built-in workflow "plan-then-execute" requires args.context to be a string when present.`);
      }
      if (record.execute !== undefined && typeof record.execute !== "boolean") {
        throw new Error(`Built-in workflow "plan-then-execute" requires args.execute to be a boolean when present.`);
      }
      return { script: generatePlanThenExecuteWorkflow() };
    },
  },
  {
    name: "spec-generation",
    description:
      'Draft a specification from product/technical/risk perspectives, then adversarially review into a structured artifact. args: { topic: string, audience?: string, format?: "markdown" | "json" }.',
    resolve(_cwd, args) {
      const record = asRecord(args);
      requireNonEmptyString(record.topic, "topic", "spec-generation");
      if (record.audience !== undefined && typeof record.audience !== "string") {
        throw new Error(`Built-in workflow "spec-generation" requires args.audience to be a string when present.`);
      }
      if (
        record.format !== undefined &&
        (typeof record.format !== "string" ||
          !SPEC_GENERATION_FORMATS.includes(record.format as (typeof SPEC_GENERATION_FORMATS)[number]))
      ) {
        throw new Error(
          `Built-in workflow "spec-generation" requires args.format to be one of: ${SPEC_GENERATION_FORMATS.join(", ")}.`,
        );
      }
      return { script: generateSpecGenerationWorkflow() };
    },
  },
];

/** Stable list of built-in workflow pattern names, in registry order. */
export const BUILTIN_WORKFLOW_NAMES: readonly string[] = BUILTIN_WORKFLOWS.map((w) => w.name);

export function findBuiltinWorkflow(name: string): BuiltinWorkflowDescriptor | undefined {
  return BUILTIN_WORKFLOWS.find((w) => w.name === name);
}

// ─── diffSource host-side resolution (GAP-3) ────────────────────────────────────
// The /code-review slash command fetches the diff itself and passes the
// resolved args to resolve(); the workflow tool's `name` path reaches the same
// builtin through prepareArgs() → fetchDiffFromSource(), so `diffSource`
// behaves identically on both surfaces. The exec profile constants
// (maxBuffer/timeout/killSignal) live in diff-exec.ts — the single home both
// fetch paths import from — and both use the same execFile-no-shell security
// boundary and error shapes.

const execFileAsync = promisify(execFile);

/**
 * Split a diffSource command string into shell words, respecting single/double
 * quotes (same tokenizer the /code-review command uses for its free-text arg).
 */
function tokenizeShellWords(input: string): string[] {
  const tokens: string[] = [];
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

/**
 * Parse a diffSource command string into an execFile-safe (binary, args) pair.
 * execFile never runs a shell, and the binary whitelist (git/gh) keeps a
 * crafted source from being interpreted as anything but a diff fetch.
 */
function parseDiffSourceCommand(source: string): { binary: "git" | "gh"; args: string[] } {
  const tokens = tokenizeShellWords(source);
  const binary = tokens[0];
  if (binary !== "git" && binary !== "gh") {
    throw new Error(
      `workflow: code-review diffSource must start with "git" or "gh" (got ${binary ? `"${binary}"` : "nothing"}) — ` +
        'use e.g. "git diff HEAD", "git diff <range>", or "gh pr diff <n>".',
    );
  }
  return { binary, args: tokens.slice(1) };
}

/**
 * Execute a diffSource command and return its stdout, mirroring the /code-review
 * slash command's fetch (builtin-commands.ts): execFile + bounded buffer +
 * timeout + SIGKILL, with a pre-exec notify and a descriptive error when the
 * source yields nothing. Throws on empty output and on any exec failure.
 */
export async function fetchDiffFromSource(
  source: string,
  cwd: string,
  onNotify?: (message: string) => void,
): Promise<string> {
  const { binary, args } = parseDiffSourceCommand(source);
  onNotify?.(`Fetching diff from ${source}…`);
  let stdout: string;
  try {
    const result = await execFileAsync(binary, args, {
      cwd,
      maxBuffer: DIFF_EXEC_MAX_BUFFER,
      timeout: DIFF_EXEC_TIMEOUT_MS,
      killSignal: DIFF_EXEC_KILL_SIGNAL,
    });
    stdout = result.stdout;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ERR_CHILD_PROCESS_STDOUT_MAXBUFFER") {
      throw new Error(
        `workflow: diff from ${source} exceeds the ${Math.floor(DIFF_EXEC_MAX_BUFFER / (1024 * 1024))}MB capture limit — ` +
          "narrow the target (e.g. a specific file or path) and try again.",
      );
    }
    if (code === "ETIMEDOUT") {
      throw new Error(
        `workflow: diff fetch from ${source} timed out after ${DIFF_EXEC_TIMEOUT_MS / 1000}s — ` +
          "check that the command works in your shell, then try again.",
      );
    }
    throw new Error(`workflow: failed to get diff (${source}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!stdout.trim()) {
    throw new Error(`workflow: no diff output from: ${source} — the source is empty or the working tree is clean.`);
  }
  return stdout;
}

/**
 * Run a built-in's prepareArgs hook (host-side arg resolution for the workflow
 * tool's `name` path) before the registry resolves the script. Returns the args
 * unchanged when the builtin has no hook. A same-named SAVED workflow is an
 * opaque script, so callers skip this entirely for it (workflow-tool.ts).
 */
export async function prepareBuiltinWorkflowArgs(
  name: string,
  args: unknown,
  cwd: string,
  onNotify?: (message: string) => void,
): Promise<unknown> {
  const builtin = findBuiltinWorkflow(name);
  if (!builtin?.prepareArgs) return args;
  return builtin.prepareArgs(cwd, args, onNotify);
}

/**
 * Resolve a name to a runnable invocation, checking project/user saved
 * workflows first and falling back to the built-in patterns — the same
 * precedence `workflow-saved.ts` already uses internally (project > user), one
 * level up: saved workflows (of either scope) beat a built-in of the same name.
 */
export function resolveWorkflowInvocation(
  name: string,
  args: unknown,
  ctx: { storage: WorkflowStorage; cwd: string },
): BuiltinWorkflowInvocation | undefined {
  const saved = ctx.storage.load(name);
  if (saved) return { script: saved.script };
  const builtin = findBuiltinWorkflow(name);
  if (builtin) return builtin.resolve(ctx.cwd, args);
  return undefined;
}
