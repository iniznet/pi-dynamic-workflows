/**
 * Shared registry of the 12 curated built-in workflow patterns
 * (`deep-research`, `adversarial-review`, `code-review`, `multi-perspective`,
 * `codebase-audit`, `plan-then-execute`, `spec-generation`, `debug-loop`,
 * `spec-conformance`, `supervised-run`, `review-remediate`, `multi-model`).
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
import { createCodingTools, createReadOnlyTools, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { generateAdversarialReviewWorkflow, generateMultiPerspectiveWorkflow } from "./adversarial-review.js";
import {
  ADVERSARIAL_REVIEW_NUMERIC_ARGS,
  CODE_REVIEW_NUMERIC_ARGS,
  DEEP_RESEARCH_NUMERIC_ARGS,
  validateNumericArgs,
} from "./builtin-args.js";
import { generateCodeReviewWorkflow } from "./code-review.js";
import { applyCommandWatchdogToTools, type CommandWatchdogOptions } from "./command-watchdog.js";
import { DEBUG_LOOP_NUMERIC_ARGS, generateDebugLoopWorkflow } from "./debug-loop.js";
import { generateCodebaseAuditWorkflow, generateDeepResearchWorkflow } from "./deep-research.js";
import { DIFF_EXEC_KILL_SIGNAL, DIFF_EXEC_MAX_BUFFER, DIFF_EXEC_TIMEOUT_MS } from "./diff-exec.js";
import {
  ADVERSARIAL_REVIEW_PROMPT_SEAM,
  ADVERSARIAL_REVIEW_RETURN_SEAM,
  CODE_REVIEW_RETURN_SEAM,
  CODEBASE_AUDIT_PROMPT_SEAM,
  CODEBASE_AUDIT_RETURN_SEAM,
  codeReviewImpactSeams,
  injectImpactScopePhase,
  MULTI_PERSPECTIVE_PROMPT_SEAM,
  MULTI_PERSPECTIVE_RETURN_SEAM,
  SPEC_CONFORMANCE_PROMPT_SEAM,
  SPEC_CONFORMANCE_RETURN_SEAM,
} from "./impact-scope.js";
import { generateMultiModelPanelWorkflow } from "./multi-model-panel.js";
import { generatePlanThenExecuteWorkflow, PLAN_THEN_EXECUTE_NUMERIC_ARGS } from "./plan-then-execute.js";
import { injectRemediationLoop } from "./remediation.js";
import { generateSpecConformanceWorkflow, SPEC_CONFORMANCE_NUMERIC_ARGS } from "./spec-conformance.js";
import { generateSpecGenerationWorkflow, SPEC_GENERATION_FORMATS } from "./spec-generation.js";
import { generateSupervisedRunWorkflow, SUPERVISED_RUN_NUMERIC_ARGS } from "./supervisor.js";
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

/**
 * Lazy supplier of host-captured extension tool defs (P04) — the same
 * function shape `createExtensionToolsSupplier` returns. Absent/undefined
 * yields no captured defs (the setting is off); present-but-empty yields none
 * either (every enabled source failed to capture).
 */
export type ExtensionToolsSupplier = () => ToolDefinition[] | Promise<ToolDefinition[]>;

/**
 * Resolve-time context a caller (workflow tool / slash commands) may pass so
 * a pattern's task-fit toolset can append the ALREADY-CAPTURED extension defs
 * (codegraph_*, web_fetch_md, web_docs_*, describe_image). Threading the
 * supplier through the registry — instead of naming captured tools in
 * BUILTIN_TOOLSET_TOOLS — is what makes the append real: builtinToolsetTools
 * only materializes createCodingTools/createReadOnlyTools, so a bare name
 * would filter out to nothing (the silent no-op P04 fixes).
 *
 * I1: `commandWatchdog` is the same-shaped lazy supplier for the command
 * watchdog knobs (idle-detector). When active, the pattern toolset's bash def
 * gets its execute rebound to the watchdog-wrapped local backend — the
 * toolset-assembly choke point for builtin patterns (agent.ts is out of scope
 * for I1/I2).
 */
export interface BuiltinWorkflowResolveContext {
  extensionTools?: ExtensionToolsSupplier;
  commandWatchdog?: () => CommandWatchdogOptions | undefined;
}

/**
 * Task-fit toolset per builtin pattern (T2-06). Each entry is the exact tool
 * subset the pattern's agents actually need — verified against the generated
 * scripts (nothing the scripts call is dropped) — instead of inheriting the
 * FULL default toolset (host bundle + every mcp_* tool) that untagged runs
 * pay (~2.8 ktok/turn, up to 5.5 ktok with chrome). deep-research is absent:
 * it already resolves its own tools/toolset ("web-research", below).
 *
 * P04: `code-dev` is the named SUPERSET — the union of every pattern's
 * task-fit subset (the general coding/research surface) — which also carries
 * the captured extension research defs (codegraph_* / web / vision) via
 * builtinToolsetTools' extension supplier. Every other pattern appends the
 * same captured defs when the supplier yields them, so code-dev research
 * tools reach pattern agents (gated by the single `subagentExtensionTools`
 * default, on).
 */
export const BUILTIN_TOOLSET_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "code-review": ["read", "grep", "find"],
  "spec-generation": ["read", "bash", "write"],
  // V2-QW4: adversarial-review's impact-analysis phase (and its finder surface)
  // locates the task's impact radius with find alongside read/grep.
  "adversarial-review": ["read", "grep", "find"],
  "codebase-audit": ["read", "grep", "find"],
  "plan-then-execute": ["read", "write", "bash"],
  // V2-QW4: multi-perspective's impact-analysis phase traces the topic's real
  // surface with find alongside read/grep.
  "multi-perspective": ["read", "grep", "find"],
  // D1 P03/P07: the new patterns need the command surface (reproduce/probe)
  // plus the code surface (inspect/fix) — debug-loop also writes the fix.
  "debug-loop": ["read", "grep", "find", "bash", "write"],
  "spec-conformance": ["read", "grep", "find", "bash"],
  // P02: the work agent (task/corrective) needs the full work surface; the
  // supervisor turn itself is pure-reasoning (toolNames: []) and needs none.
  "supervised-run": ["read", "grep", "find", "bash", "write"],
  // V2-P06: review-remediate finders/verifiers read + grep, the remediation
  // fixer and the re-reviewer edit files and run the machine verification
  // command.
  "review-remediate": ["read", "grep", "find", "bash", "write"],
  // V2-P05: panel members reason (read/grep to ground), the act-mode actor
  // executes (write + bash for the machine verification surface).
  "multi-model": ["read", "grep", "find", "bash", "write"],
  "code-dev": ["read", "grep", "find", "bash", "write"],
};

/** Stable name of the P04 superset toolset (builtinToolsetTools ∪ captured defs). */
export const CODE_DEV_TOOLSET = "code-dev";

/**
 * Build a pattern's task-fit coding-tool subset, optionally appended with the
 * captured extension research defs (P04). Both SDK factories overlap on
 * `read`, so names are deduped first-wins; the extension supplier's defs join
 * the same map, so a captured name listed in the toolset resolves (adding the
 * name to BUILTIN_TOOLSET_TOOLS alone would silently no-op — the map only
 * materializes coding/read-only tools). Unknown tags resolve to an empty set
 * (the caller should only pass BUILTIN_TOOLSET_TOOLS keys).
 */
export async function builtinToolsetTools(
  cwd: string,
  toolset: string,
  extensionTools?: ExtensionToolsSupplier,
  commandWatchdog?: () => CommandWatchdogOptions | undefined,
): Promise<ToolDefinition[]> {
  const names = BUILTIN_TOOLSET_TOOLS[toolset];
  if (!names) return [];
  const extension = (await extensionTools?.()) ?? [];
  const available = new Map<string, ToolDefinition>();
  for (const tool of [...createCodingTools(cwd), ...createReadOnlyTools(cwd), ...extension]) {
    if (!available.has(tool.name)) available.set(tool.name, tool);
  }
  const selected = names
    .map((name) => available.get(name))
    .filter((tool): tool is ToolDefinition => tool !== undefined);
  // I1 command watchdog: the HOST-ORIGIN selected defs (createCodingTools /
  // createReadOnlyTools) get their bash execute rebound to the watchdog-wrapped
  // local backend when the knobs are active; the captured third-party extension
  // defs ride along unwrapped (never rebind a non-host bash). Absent/disabled →
  // thin passthrough.
  const resolvedWatchdog = commandWatchdog?.();
  const watchdogWrapped =
    resolvedWatchdog && (resolvedWatchdog.idleTimeoutMs > 0 || resolvedWatchdog.hardTimeoutMs > 0)
      ? applyCommandWatchdogToTools(selected, cwd, resolvedWatchdog)
      : selected;
  // P04: the captured research defs append WHOLESALE on top of the task-fit
  // subset (codegraph_*/web_fetch_md/web_docs_*/describe_image, default-ON) —
  // they are the research surface, not names the pattern's subset lists.
  // Deduped against the already-selected defs (first-wins preserved).
  const selectedNames = new Set(watchdogWrapped.map((tool) => tool.name));
  return [...watchdogWrapped, ...extension.filter((def) => !selectedNames.has(def.name))];
}

interface BuiltinWorkflowDescriptor {
  /** Also the slash-command name (without the leading `/`). */
  name: string;
  description: string;
  /**
   * Build the script (and exec context) for one invocation; throws on invalid
   * `args`. Async since P04: a pattern's task-fit toolset can append the
   * captured extension research defs (the extension supplier is async).
   */
  resolve(cwd: string, args: unknown, context?: BuiltinWorkflowResolveContext): Promise<BuiltinWorkflowInvocation>;
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

/** The 12 curated built-in workflow patterns, keyed by their stable name. */
export const BUILTIN_WORKFLOWS: readonly BuiltinWorkflowDescriptor[] = [
  {
    name: "deep-research",
    description:
      "Research a question across the web with cross-checked sources. args: { question: string, angles?: number, minSupport?: number }.",
    async resolve(cwd, args, context) {
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
        // WorkflowManagerOptions.toolsets). The captured web-research
        // extension defs (web_fetch_md/web_docs_*) ride along via the same
        // supplier so the run's research surface matches the default toolset.
        // I1: the watchdog wrap covers only the HOST-ORIGIN coding+web defs
        // (captured extension defs are never rebind — third-party bash stays
        // untouched).
        tools: [
          ...applyCommandWatchdogToTools(
            [...createCodingTools(cwd), ...createWebTools()],
            cwd,
            context?.commandWatchdog?.(),
          ),
          ...((await context?.extensionTools?.()) ?? []),
        ],
        toolset: "web-research",
      };
    },
  },
  {
    name: "adversarial-review",
    description:
      "Investigate a task, then cross-check each finding with skeptical reviewers. args: { task: string, reviewers?: number, threshold?: number, maxFindings?: number }.",
    async resolve(cwd, args, context) {
      const record = asRecord(args);
      const task = requireNonEmptyString(record.task, "task", "adversarial-review");
      validateNumericArgs(record, ADVERSARIAL_REVIEW_NUMERIC_ARGS, "adversarial-review");
      return {
        // V2-QW4: the pattern gains the impact-analysis phase — one agent maps
        // the task's impact radius (codegraph callers/callees + read/grep/find)
        // and every refute reviewer prompt embeds the partition
        // (impactScopeBlock). The target is baked from the resolved task.
        script: injectImpactScopePhase({
          baseScript: generateAdversarialReviewWorkflow(),
          target: `The review target is the task: ${task}; the refute fan-out must be scoped to the task's impact radius.`,
          promptSeams: [ADVERSARIAL_REVIEW_PROMPT_SEAM],
          returnSeam: ADVERSARIAL_REVIEW_RETURN_SEAM,
        }),
        // Investigate/refute agents check the task against the codebase with
        // read/grep/find (find traces the impact radius); they never need the
        // write/bash/edit surface. The captured codegraph_* research defs append
        // on top when the supplier yields them (P04) so skeptical review can
        // trace callers/impact without extra defs.
        tools: await builtinToolsetTools(cwd, "adversarial-review", context?.extensionTools, context?.commandWatchdog),
        toolset: "adversarial-review",
      };
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
    async resolve(cwd, args, context) {
      const record = asRecord(args);
      // Truncation past MAX_DIFF_CHARS happens inside the generated script at
      // runtime (see code-review.ts); a caller invoking by name either supplies
      // `diff` itself or a `diffSource` command, which prepareArgs resolves
      // into `diff` before this validation runs (GAP-3).
      requireNonEmptyString(record.diff, "diff", "code-review");
      const diff = typeof record.diff === "string" ? record.diff : "";
      validateNumericArgs(record, CODE_REVIEW_NUMERIC_ARGS, "code-review");
      return {
        script: injectImpactScopePhase({
          baseScript: generateCodeReviewWorkflow(),
          // The impact-analysis agent (P08) maps the diff's impact radius + test
          // scope via codegraph callers/callees (captured defs ride the pattern's
          // toolset) and read/grep/find; the finder fan-out embeds the emitted
          // partition in every finder prompt (impactScopeBlock). The target is
          // baked from the resolved diff's length (deterministic per invocation).
          target: `The change under review is a code diff (${diff.length} characters); the review angles must be scoped to its impact radius.`,
          promptSeams: codeReviewImpactSeams(),
          returnSeam: CODE_REVIEW_RETURN_SEAM,
        }),
        // Finders/verifiers pull file context with read/grep (and find to
        // locate call sites); they never write or run commands. The captured
        // codegraph_*/web/vision defs append on top (P04) so finders can trace
        // callers/impact and verify claims without extra defs.
        tools: await builtinToolsetTools(cwd, "code-review", context?.extensionTools, context?.commandWatchdog),
        toolset: "code-review",
      };
    },
  },
  {
    name: "multi-perspective",
    description:
      "Analyze a topic from several independent perspectives in parallel, then synthesize. args: { topic: string, perspectives?: string[] }.",
    async resolve(cwd, args, context) {
      const record = asRecord(args);
      const topic = requireNonEmptyString(record.topic, "topic", "multi-perspective");
      const perspectives =
        Array.isArray(record.perspectives) && record.perspectives.length >= 2
          ? requireStringArray(record.perspectives, "perspectives", "multi-perspective")
          : [...DEFAULT_MULTI_PERSPECTIVES];
      return {
        // V2-QW4: the pattern gains the impact-analysis phase — one agent maps
        // the topic's impact surface and every perspective analyst prompt
        // embeds the partition (impactScopeBlock). The target is baked from the
        // resolved topic (deterministic per invocation).
        script: injectImpactScopePhase({
          baseScript: generateMultiPerspectiveWorkflow(topic, perspectives),
          target: `The analysis target is the topic: ${topic}; ${perspectives.length} perspective(s) must be scoped to the topic's impact surface.`,
          promptSeams: [MULTI_PERSPECTIVE_PROMPT_SEAM],
          returnSeam: MULTI_PERSPECTIVE_RETURN_SEAM,
        }),
        // Analysts check the topic against the codebase with read/grep/find
        // (find traces the impact radius); the captured codegraph_*/web/vision
        // defs append on top (P04) so every perspective can trace the topic's
        // real surface before opining.
        tools: await builtinToolsetTools(cwd, "multi-perspective", context?.extensionTools, context?.commandWatchdog),
        toolset: "multi-perspective",
      };
    },
  },
  {
    name: "codebase-audit",
    description:
      "Run parallel checks against a codebase scope, then cross-validate and report. args: { scope: string, checks: string[] }.",
    async resolve(cwd, args, context) {
      const record = asRecord(args);
      const scope = requireNonEmptyString(record.scope, "scope", "codebase-audit");
      const checks = requireStringArray(record.checks, "checks", "codebase-audit");
      return {
        // P08: the audit gains an impact-analysis phase — one agent maps the
        // scope's impact radius + test scope (codegraph callers/callees + read/
        // grep/find) and emits the parallel work partition; every check agent
        // prompt embeds the partition (impactScopeBlock). The target is baked
        // from the resolved scope/checks (deterministic per invocation).
        script: injectImpactScopePhase({
          baseScript: generateCodebaseAuditWorkflow(scope, checks),
          target: `The audit target is the codebase scope: ${scope}; ${checks.length} check(s) must be scoped to the impact radius.`,
          promptSeams: [CODEBASE_AUDIT_PROMPT_SEAM],
          returnSeam: CODEBASE_AUDIT_RETURN_SEAM,
        }),
        // Check agents inspect the scoped tree with read/grep/find; the
        // captured codegraph_* defs append on top (P04) so checks can trace
        // callers/impact/callees of the audited symbols directly.
        tools: await builtinToolsetTools(cwd, "codebase-audit", context?.extensionTools, context?.commandWatchdog),
        toolset: "codebase-audit",
      };
    },
  },
  {
    name: "plan-then-execute",
    description:
      "Decompose an objective into dependency-ordered steps, gate each step with a verifier (bounded rework), optionally execute each step. Pauses for human approval before any agent work (meta.gate: 'approve'). args: { objective: string, context?: string, maxSteps?: number, execute?: boolean }.",
    async resolve(cwd, args, context) {
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
      return {
        script: generatePlanThenExecuteWorkflow(),
        // Implementers read/write files and run commands; the planner/verifier
        // stages are prompt-only but share the run's toolset. The captured
        // codegraph_*/web/vision defs append on top (P04) so implementers can
        // trace the objective's real surface before editing.
        tools: await builtinToolsetTools(cwd, "plan-then-execute", context?.extensionTools, context?.commandWatchdog),
        toolset: "plan-then-execute",
      };
    },
  },
  {
    name: "spec-generation",
    description:
      'Draft a specification from product/technical/risk perspectives, then adversarially review into a structured artifact. args: { topic: string, audience?: string, format?: "markdown" | "json" }.',
    async resolve(cwd, args, context) {
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
      return {
        script: generateSpecGenerationWorkflow(),
        // Drafters/reviewer may inspect existing specs/docs (read), run build
        // probes (bash), and the writer can persist the artifact (write). The
        // captured codegraph_*/web/vision defs append on top (P04) so the
        // drafter can trace the topic's real surface before writing.
        tools: await builtinToolsetTools(cwd, "spec-generation", context?.extensionTools, context?.commandWatchdog),
        toolset: "spec-generation",
      };
    },
  },
  {
    name: "debug-loop",
    description:
      "Isolate a bug: hypothesize the root cause, reproduce it with machine evidence (bash-captured exit code + output), fix it, and machine-verify the fix with bounded rework. args: { bug: string, reproduce?: string, maxRounds?: number }.",
    async resolve(cwd, args, context) {
      const record = asRecord(args);
      requireNonEmptyString(record.bug, "bug", "debug-loop");
      if (record.reproduce !== undefined && typeof record.reproduce !== "string") {
        throw new Error(`Built-in workflow "debug-loop" requires args.reproduce to be a string when present.`);
      }
      validateNumericArgs(record, DEBUG_LOOP_NUMERIC_ARGS, "debug-loop");
      return {
        script: generateDebugLoopWorkflow(),
        // The loop needs the command surface (reproduce/verify via bash) and
        // the code surface (inspect + edit the fix). The captured
        // codegraph_*/web/vision defs append on top (P04) so the hypothesizer
        // can trace callers/impact of the suspected symbols.
        tools: await builtinToolsetTools(cwd, "debug-loop", context?.extensionTools, context?.commandWatchdog),
        toolset: "debug-loop",
      };
    },
  },
  {
    name: "spec-conformance",
    description:
      "Audit an implementation workspace against a spec: per-requirement mechanical evidence (symbols, registrations, probed behavior), missing/extra detection, scored conformance report. Closes the loop with spec-generation. args: { spec: object | string, workspace?: string, maxRequirements?: number }.",
    async resolve(cwd, args, context) {
      const record = asRecord(args);
      const spec = record.spec;
      const specValid =
        (typeof spec === "object" && spec !== null) || (typeof spec === "string" && spec.trim().length > 0);
      if (!specValid) {
        throw new Error(
          'Built-in workflow "spec-conformance" requires args.spec to be a spec object or a non-empty JSON string.',
        );
      }
      const workspace = typeof record.workspace === "string" && record.workspace.trim() ? record.workspace.trim() : ".";
      if (record.workspace !== undefined && typeof record.workspace !== "string") {
        throw new Error(`Built-in workflow "spec-conformance" requires args.workspace to be a string when present.`);
      }
      validateNumericArgs(record, SPEC_CONFORMANCE_NUMERIC_ARGS, "spec-conformance");
      return {
        // V2-QW4: the pattern gains the impact-analysis phase — one agent maps
        // the audited workspace's impact surface and every requirement's
        // evidence agent prompt embeds the partition (impactScopeBlock). The
        // target is baked from the resolved workspace.
        script: injectImpactScopePhase({
          baseScript: generateSpecConformanceWorkflow(),
          target: `The audit target is the workspace ${workspace}; the requirement evidence fan-out must be scoped to the implementation surface that evidences each requirement.`,
          promptSeams: [SPEC_CONFORMANCE_PROMPT_SEAM],
          returnSeam: SPEC_CONFORMANCE_RETURN_SEAM,
        }),
        // Evidence auditors grep symbols and probe behavior with bash; the
        // captured codegraph_*/web/vision defs append on top (P04) so a
        // requirement can be traced to its implementing symbols.
        tools: await builtinToolsetTools(cwd, "spec-conformance", context?.extensionTools, context?.commandWatchdog),
        toolset: "spec-conformance",
      };
    },
  },
  {
    name: "supervised-run",
    description:
      "Delegate a task to a work agent and supervise it: after every settle an economy supervisor agent (pure-reasoning) checks progress against a concrete measurable completion criterion, injects ONE corrective agent on drift/stall, and declares done when the criterion is verified met. args: { task: string, criterion: string, maxRounds?: number }.",
    async resolve(cwd, args, context) {
      const record = asRecord(args);
      requireNonEmptyString(record.task, "task", "supervised-run");
      requireNonEmptyString(record.criterion, "criterion", "supervised-run");
      validateNumericArgs(record, SUPERVISED_RUN_NUMERIC_ARGS, "supervised-run");
      return {
        script: generateSupervisedRunWorkflow(),
        // The work agent (task + corrective) edits files and runs commands; the
        // captured codegraph_*/web/vision defs append on top (P04) so the work
        // can trace the task's real surface. The supervisor turn itself is
        // pure-reasoning (toolNames: []) and needs no tools.
        tools: await builtinToolsetTools(cwd, "supervised-run", context?.extensionTools, context?.commandWatchdog),
        toolset: "supervised-run",
      };
    },
  },
  {
    name: "review-remediate",
    description:
      "Full code review + remediation loop: 8 finders + verify pass → ranked findings, then per-finding durable lifecycle (open → in-progress → fixed → verified → closed), gated fixes, testGate-closed re-review, and a machine compliance pass. args: { diff?: string, diffSource?: string, diffTruncated?: boolean, diffLength?: number, maxCandidates?: number, verifyBatchSize?: number, remediationRounds?: number }.",
    // Same GAP-3 diffSource resolution as code-review: a model passing
    // diffSource:'git diff HEAD' gets a real diff before resolve() validates.
    async prepareArgs(cwd, args, onNotify) {
      const record = asRecord(args);
      if (record.diffSource !== undefined && typeof record.diffSource !== "string") {
        throw new Error('Built-in workflow "review-remediate" requires args.diffSource to be a string when present.');
      }
      const diff = typeof record.diff === "string" ? record.diff : "";
      const diffSource = typeof record.diffSource === "string" ? record.diffSource.trim() : "";
      if (diff.trim() || !diffSource) return args;
      const fetched = await fetchDiffFromSource(diffSource, cwd, onNotify);
      return { ...record, diff: fetched, diffSource };
    },
    async resolve(cwd, args, context) {
      const record = asRecord(args);
      requireNonEmptyString(record.diff, "diff", "review-remediate");
      const diff = typeof record.diff === "string" ? record.diff : "";
      validateNumericArgs(record, CODE_REVIEW_NUMERIC_ARGS, "review-remediate");
      if (record.remediationRounds !== undefined && typeof record.remediationRounds !== "number") {
        throw new Error(
          'Built-in workflow "review-remediate" requires args.remediationRounds to be a number when present.',
        );
      }
      return {
        // V2-P06: the full code-review machinery (impact-scoped — P08) plus the
        // remediation loop (per-finding durable lifecycle, testGate-closed
        // re-review, machine compliance). The target is baked from the resolved
        // diff's length (deterministic per invocation).
        script: injectRemediationLoop({
          baseScript: injectImpactScopePhase({
            baseScript: generateCodeReviewWorkflow(),
            target: `The change under review is a code diff (${diff.length} characters); the review angles and remediation fixes must be scoped to its impact radius.`,
            promptSeams: codeReviewImpactSeams(),
            returnSeam: CODE_REVIEW_RETURN_SEAM,
          }),
        }),
        // Finders/verifiers pull file context with read/grep/find; the
        // remediation fixer and re-reviewer edit files and run the machine
        // verification command (write + bash). The captured codegraph_* defs
        // append on top (P04).
        tools: await builtinToolsetTools(cwd, "review-remediate", context?.extensionTools, context?.commandWatchdog),
        toolset: "review-remediate",
      };
    },
  },
  {
    name: "multi-model",
    description:
      'Fan the same task across 2-8 distinct models (compare-not-merge verdicts → judge envelope), optionally act mode (1-4 reference models → one reconciling executor). args: { task: string, models?: string[], mode?: "compare" | "act", judgeModel?: string, actorModel?: string }.',
    async resolve(cwd, args, context) {
      const record = asRecord(args);
      requireNonEmptyString(record.task, "task", "multi-model");
      if (record.mode !== undefined && record.mode !== "compare" && record.mode !== "act") {
        throw new Error('Built-in workflow "multi-model" requires args.mode to be "compare" or "act" when present.');
      }
      if (record.models !== undefined) {
        if (
          !Array.isArray(record.models) ||
          !record.models.every((m) => typeof m === "string" && m.trim().length > 0)
        ) {
          throw new Error(
            'Built-in workflow "multi-model" requires args.models to be an array of non-empty model-spec strings when present.',
          );
        }
      }
      for (const key of ["judgeModel", "actorModel"]) {
        if (record[key] !== undefined && typeof record[key] !== "string") {
          throw new Error(`Built-in workflow "multi-model" requires args.${key} to be a string when present.`);
        }
      }
      return {
        script: generateMultiModelPanelWorkflow(),
        // Panel members ground their verdicts with read/grep/find (pure
        // reasoning otherwise); the act-mode actor edits files and runs
        // commands (write + bash). The captured codegraph_* defs append on top
        // (P04) so a member can trace the task's real surface.
        tools: await builtinToolsetTools(cwd, "multi-model", context?.extensionTools, context?.commandWatchdog),
        toolset: "multi-model",
      };
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
 * The resolve context carries the captured-extension supplier (P04) so a
 * pattern's task-fit tools append the codegraph_* / web / vision defs; a saved
 * workflow is an opaque script and skips it entirely.
 */
export async function resolveWorkflowInvocation(
  name: string,
  args: unknown,
  ctx: {
    storage: WorkflowStorage;
    cwd: string;
    extensionTools?: ExtensionToolsSupplier;
    commandWatchdog?: () => CommandWatchdogOptions | undefined;
  },
): Promise<BuiltinWorkflowInvocation | undefined> {
  const saved = ctx.storage.load(name);
  if (saved) return { script: saved.script };
  const builtin = findBuiltinWorkflow(name);
  if (builtin)
    return builtin.resolve(ctx.cwd, args, {
      extensionTools: ctx.extensionTools,
      commandWatchdog: ctx.commandWatchdog,
    });
  return undefined;
}
