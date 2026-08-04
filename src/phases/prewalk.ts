/**
 * Prewalk "1986 Aircraft Manual" Blueprint Generator (Phase 1).
 * Generates execution blueprints in strict pre-condition/step/fail-safe/verify format.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat as statFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import type { WorkflowStateManager } from "./state-machine.js";

/** Cap on checklist item counts so a blueprint never becomes an unbounded dump. */
export const BLUEPRINT_ITEM_CAPS = {
  preconditions: 6,
  executionSteps: 8,
  // The fail-safe set is a closed enum of exactly six kinds (FAIL_SAFE_KINDS),
  // so the cap equals the set size and can never truncate a mandated kind.
  failSafeProcedures: 6,
  verificationTests: 4,
} as const;

/**
 * Closed set of failure triggers a fail-safe procedure can answer to. Keeping
 * the set closed prevents a blueprint from omitting a failure class the PRD
 * mandates (timeouts and API errors must always carry explicit fallback).
 */
export const FAIL_SAFE_KINDS = ["test-runner", "typecheck", "scope-creep", "ci", "timeout", "api-error"] as const;

/** One of the closed fail-safe trigger kinds. */
export type FailSafeKind = (typeof FAIL_SAFE_KINDS)[number];

/** Explicit fallback logic bound to one failure trigger. */
export interface FailSafeProcedure {
  /** The failure trigger this procedure answers to. */
  kind: FailSafeKind;
  /** Condition that must hold for the procedure to engage. */
  trigger: string;
  /** Imperative fallback steps to execute when the trigger fires. */
  fallback: string;
  /** Attempt ceiling before the fallback gives up (timeout/api-error). */
  maxAttempts?: number;
}

/**
 * Fail-safe kinds every valid blueprint must include (PRD Task 5: explicit
 * fallback logic for timeouts/API errors). Enforced by validateBlueprint so a
 * blueprint cannot pass validation while omitting either failure class.
 */
export const REQUIRED_FAIL_SAFE_KINDS: readonly FailSafeKind[] = ["timeout", "api-error"];

export interface BlueprintStep {
  id: string;
  description: string;
  action: string;
  expectedOutcome: string;
  rollbackProcedure: string;
}

export interface ExecutionBlueprint {
  id: string;
  title: string;
  preconditions: string[];
  executionSteps: BlueprintStep[];
  failSafeProcedures: FailSafeProcedure[];
  verificationTests: string[];
  createdAt: string;
}

export function validateBlueprint(blueprint: ExecutionBlueprint): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!blueprint.title) issues.push("Missing title");
  if (!blueprint.preconditions?.length) issues.push("No preconditions defined");
  if (!blueprint.executionSteps?.length) issues.push("No execution steps defined");
  if (!blueprint.verificationTests?.length) issues.push("No verification tests defined");
  for (const step of blueprint.executionSteps || []) {
    if (!step.action) issues.push(`Step ${step.id}: missing action`);
    if (!step.rollbackProcedure) issues.push(`Step ${step.id}: missing rollback procedure`);
  }

  if (!blueprint.failSafeProcedures?.length) {
    issues.push("No fail-safe procedures defined");
  } else {
    const seenKinds = new Set<FailSafeKind>();
    for (const procedure of blueprint.failSafeProcedures) {
      // Blueprints round-trip through JSON on disk, so re-check the kind even
      // though the static type already constrains it.
      if (!FAIL_SAFE_KINDS.includes(procedure.kind)) {
        issues.push(`Fail-safe procedure has unknown kind: ${String(procedure.kind)}`);
        continue;
      }
      seenKinds.add(procedure.kind);
      if (!procedure.trigger) issues.push(`Fail-safe ${procedure.kind}: missing trigger`);
      if (!procedure.fallback) issues.push(`Fail-safe ${procedure.kind}: missing fallback`);
    }
    for (const required of REQUIRED_FAIL_SAFE_KINDS) {
      if (!seenKinds.has(required)) issues.push(`Missing ${required} fail-safe procedure`);
    }
  }
  return { valid: issues.length === 0, issues };
}

/** Human-readable manual labels for each fail-safe kind (rendered uppercase). */
const FAIL_SAFE_KIND_LABELS: Record<FailSafeKind, string> = {
  "test-runner": "TEST RUNNER",
  typecheck: "TYPECHECK",
  "scope-creep": "SCOPE CREEP",
  ci: "CI",
  timeout: "TIMEOUT",
  "api-error": "API ERROR",
};

/**
 * Render the blueprint as the strict "1986 Aircraft Manual" execution manual
 * the PRD mandates: the four sections in fixed order, every item an imperative,
 * numbered directive ready for the plannotator review page. Rendering is total
 * — hand-edited or legacy blueprints still produce the four headers, with the
 * items they actually carry.
 */
export function toMarkdown(blueprint: ExecutionBlueprint): string {
  const lines: string[] = [];
  lines.push(`# ${blueprint.title}`);
  lines.push("");
  lines.push("> 1986 Aircraft Manual execution blueprint");
  lines.push(`> Blueprint \`${blueprint.id}\` · generated ${blueprint.createdAt}`);
  lines.push("");

  lines.push("## PRE-CONDITIONS & CONSTRAINTS");
  lines.push("");
  blueprint.preconditions.forEach((precondition, index) => {
    lines.push(`${index + 1}. ${precondition}`);
  });
  lines.push("");

  lines.push("## EXECUTION STEPS");
  lines.push("");
  blueprint.executionSteps.forEach((step, index) => {
    lines.push(`### Step ${index + 1} — ${step.description}`);
    lines.push("");
    lines.push(`- **ACTION:** ${step.action}`);
    lines.push(`- **EXPECTED OUTCOME:** ${step.expectedOutcome}`);
    lines.push(`- **ROLLBACK PROCEDURE:** ${step.rollbackProcedure}`);
    lines.push("");
  });

  lines.push("## FAIL-SAFE & ERROR HANDLING");
  lines.push("");
  // Blueprints predating the typed fail-safe model store plain sentences;
  // render those verbatim instead of failing on a missing kind field.
  for (const entry of blueprint.failSafeProcedures as Array<FailSafeProcedure | string>) {
    if (typeof entry === "string") {
      lines.push(`- ${entry}`);
      continue;
    }
    const label =
      (FAIL_SAFE_KIND_LABELS as Record<string, string | undefined>)[entry.kind] ?? String(entry.kind).toUpperCase();
    const attempts = entry.maxAttempts ? ` (max ${entry.maxAttempts} attempts)` : "";
    lines.push(`- **${label}** — if ${entry.trigger}: ${entry.fallback}${attempts}`);
  }
  lines.push("");

  lines.push("## VERIFICATION TESTS");
  lines.push("");
  blueprint.verificationTests.forEach((test, index) => {
    lines.push(`${index + 1}. [ ] ${test}`);
  });
  lines.push("");

  return lines.join("\n");
}

/** Signals mined from the codebase summary to tailor the generated checklist. */
interface CodebaseSignals {
  testFramework?: string;
  testCommand?: string;
  language?: string;
  packageManager?: string;
  typecheckCommand?: string;
  lintCommand?: string;
  monorepo: boolean;
  docker: boolean;
  ci: boolean;
}

/**
 * Mine a codebase summary for tooling/stack signals the checklist can build on.
 * Pure best-effort keyword matching — an empty summary yields generic defaults.
 */
export function detectCodebaseSignals(codebaseSummary: string): CodebaseSignals {
  const text = codebaseSummary.toLowerCase();
  const find = (patterns: string[]): string | undefined => patterns.find((p) => text.includes(p));
  const signal: CodebaseSignals = {
    testFramework: find([
      "vitest",
      "jest",
      "mocha",
      "pytest",
      "unittest",
      "rspec",
      "minitest",
      "go test",
      "cargo test",
    ]),
    language: find(["typescript", "javascript", "python", "go", "rust", "java", "ruby", "c#", "c++", "c", "php"]),
    packageManager: find(["pnpm", "yarn", "npm", "cargo", "gradle", "maven", "poetry", "pip"]),
    typecheckCommand: find(["tsc --noemit", "tsc", "mypy", "cargo check"]),
    lintCommand: find(["biome", "eslint", "ruff", "golangci-lint", "rubocop", "cargo clippy"]),
    monorepo: /monorepo|workspaces|packages\//.test(text),
    docker: text.includes("docker"),
    ci: /ci|github actions|pipeline/.test(text),
  };
  return signal;
}

/**
 * Generate an execution blueprint whose checklist is DERIVED from the codebase
 * summary (detected test framework, typechecker, linter, package manager), not a
 * hardcoded template. Item counts are capped (see BLUEPRINT_ITEM_CAPS) and the
 * result always passes validateBlueprint — every step carries a rollback
 * procedure and every section is populated.
 */
export async function generateBlueprint(codebaseSummary: string, task: string): Promise<ExecutionBlueprint> {
  const now = new Date().toISOString();
  const signals = detectCodebaseSignals(codebaseSummary);
  const testCmd = signals.testFramework
    ? `run the ${signals.testFramework} test suite (${signals.testCommand ?? "project test command"})`
    : "run the project's test suite if one exists (otherwise verify behavior manually)";

  const preconditions = [
    "Codebase analysis complete: key modules and change surface identified",
    signals.monorepo
      ? "Monorepo layout understood — changes scoped to the affected package"
      : "Single-project layout understood — change surface mapped",
    signals.testFramework
      ? `Test framework detected (${signals.testFramework}) — tests must stay runnable`
      : "No test framework detected — manual verification steps required",
    signals.typecheckCommand
      ? `Type checking available (${signals.typecheckCommand}) — run before committing`
      : "No type checker detected — review for type regressions manually",
    signals.docker
      ? "Docker images/locally-run services identified — no container changes without verification"
      : undefined,
    signals.ci ? "CI pipeline detected — changes must not break the configured pipeline" : undefined,
  ].filter((p): p is string => Boolean(p));

  const steps: BlueprintStep[] = [
    {
      id: randomUUID(),
      description: "Write a failing test (or acceptance check) for the requested behavior",
      action: `Create the test/acceptance check that asserts the requested outcome; ${testCmd}`,
      expectedOutcome: "The new check fails for the right reason before implementation",
      rollbackProcedure: "Delete the new test file and any scaffolding it required",
    },
    {
      id: randomUUID(),
      description: "Implement the minimal change",
      action: "Write the minimal code that makes the failing check pass, following existing project conventions",
      expectedOutcome: "The check passes and the change is scoped to the task",
      rollbackProcedure: "Revert implementation changes (git checkout on the touched files)",
    },
    {
      id: randomUUID(),
      description: "Run the full verification suite",
      action: `Execute the project's verification: ${testCmd}${signals.typecheckCommand ? `, typecheck (${signals.typecheckCommand})` : ""}${signals.lintCommand ? `, lint (${signals.lintCommand})` : ""}`,
      expectedOutcome: "No regressions: tests, typecheck, and lint all pass",
      rollbackProcedure: "Fix or revert the change until the suite is green again",
    },
    {
      id: randomUUID(),
      description: "Self-review the diff",
      action: "Review the change for correctness, security, style, and edge cases (empty input, errors, concurrency)",
      expectedOutcome: "No critical issues; the diff is minimal and self-documenting",
      rollbackProcedure: "Address flagged issues before committing; revert if the approach is wrong",
    },
    {
      id: randomUUID(),
      description: "Commit the verified change",
      action: "Commit with a clear, scoped message describing what changed and why",
      expectedOutcome: "A clean, reviewable commit on top of the verified state",
      rollbackProcedure: "git revert the commit if it must be removed later",
    },
  ];

  // Timeout and API-error procedures are unconditional (PRD Task 5 requires
  // explicit fallback for both) and lead the section so a cap truncation can
  // never remove a mandated kind; the signal-derived entries follow.
  const failSafeProcedures: FailSafeProcedure[] = [
    {
      kind: "timeout",
      trigger: "a command or external tool exceeds its allotted execution time",
      fallback:
        "retry once with the documented timeout raised, then abort the step and record the timeout in the run log",
      maxAttempts: 2,
    },
    {
      kind: "api-error",
      trigger: "an API call returns a non-2xx status or a network error",
      fallback: "retry with exponential backoff up to the attempt ceiling, then surface the structured error and stop",
      maxAttempts: 3,
    },
    signals.testFramework
      ? {
          kind: "test-runner",
          trigger: `the ${signals.testFramework} suite cannot run`,
          fallback: "fix config or dependencies before proceeding",
        }
      : {
          kind: "test-runner",
          trigger: "no test runner is available",
          fallback: "fall back to manual verification with documented steps",
        },
    signals.typecheckCommand
      ? {
          kind: "typecheck",
          trigger: `typecheck (${signals.typecheckCommand}) fails`,
          fallback: "fix type errors before committing",
        }
      : {
          kind: "typecheck",
          trigger: "a build or compile step fails",
          fallback: "resolve it before proceeding",
        },
    {
      kind: "scope-creep",
      trigger: "implementation grows beyond the task scope",
      fallback: "pause and reassess the approach",
    },
    ...(signals.ci
      ? ([
          {
            kind: "ci",
            trigger: "the CI pipeline fails",
            fallback: "treat it as a release blocker and fix before finishing",
          },
        ] as const)
      : []),
  ];

  const verificationTests = [
    signals.testFramework
      ? `Test suite passes (${signals.testFramework})`
      : "Acceptance criteria verified manually against the requested behavior",
    signals.typecheckCommand
      ? `Type check passes (${signals.typecheckCommand})`
      : "No type errors introduced (reviewed manually)",
    signals.lintCommand ? `Lint passes (${signals.lintCommand})` : "No lint/style regressions (reviewed manually)",
    signals.monorepo
      ? "Only the affected package changed; dependents still build"
      : "Change is minimal and scoped to the task",
  ];

  // Enforce the caps: truncate each section to its ceiling, then guarantee the
  // result still validates (a truncated blueprint must remain fully specified).
  const blueprint: ExecutionBlueprint = {
    id: randomUUID(),
    title: task,
    preconditions: preconditions.slice(0, BLUEPRINT_ITEM_CAPS.preconditions),
    executionSteps: steps.slice(0, BLUEPRINT_ITEM_CAPS.executionSteps),
    failSafeProcedures: failSafeProcedures.slice(0, BLUEPRINT_ITEM_CAPS.failSafeProcedures),
    verificationTests: verificationTests.slice(0, BLUEPRINT_ITEM_CAPS.verificationTests),
    createdAt: now,
  };

  const validation = validateBlueprint(blueprint);
  if (!validation.valid) {
    throw new Error(`generated blueprint failed validation: ${validation.issues.join("; ")}`);
  }
  return blueprint;
}

export async function saveBlueprint(blueprint: ExecutionBlueprint, dir: string): Promise<void> {
  const bpDir = join(dir, ".pi", "workflows", "blueprints");
  await mkdir(bpDir, { recursive: true });
  await writeFile(join(bpDir, `${blueprint.id}.json`), JSON.stringify(blueprint, null, 2), "utf-8");
}

/** Options for the run-entry Phase 1 stage (see runPrewalkStage). */
export interface PrewalkStageOptions {
  /** Persisted phase state machine: prewalk is gated on wayfinderComplete. */
  stateManager: WorkflowStateManager;
  /** The task the blueprint plans (used as the blueprint title). */
  task: string;
  /** Codebase summary feeding generateBlueprint's signal detection. */
  codebaseSummary: string;
  /** Directory that receives `.pi/workflows/plans/<runId>.json`. */
  dir: string;
  /** Run id namespacing the plan file — the path the Phase 2 gate reads. */
  runId: string;
  /** Run-log sink so pipeline steps are visible in the run's logs. */
  onLog?: (message: string) => void;
}

/**
 * Phase 1 stage wired into the workflow run entry: gate on the Phase 0
 * wayfinder step, generate the "1986 Aircraft Manual" blueprint, persist it
 * to `.pi/workflows/plans/<runId>.json` (the path the plannotator gate
 * reads), and mark prewalkComplete so the Phase 2 gate opens.
 *
 * The gate check is unconditional: a caller that skipped (or failed to
 * persist) the wayfinder step is refused with PHASE_TRANSITION_INVALID rather
 * than silently producing a blueprint ahead of its phase.
 */
export async function runPrewalkStage(options: PrewalkStageOptions): Promise<ExecutionBlueprint> {
  const state = await options.stateManager.getState();
  if (!state.wayfinderComplete) {
    throw new WorkflowError(
      "prewalk blocked: the Phase 0 wayfinder step must complete (wayfinderComplete) before a blueprint can be generated",
      WorkflowErrorCode.PHASE_TRANSITION_INVALID,
      {
        recoverable: false,
        details: { code: WorkflowErrorCode.PHASE_TRANSITION_INVALID, unmet: ["wayfinderComplete"] },
      },
    );
  }

  const blueprint = await generateBlueprint(options.codebaseSummary, options.task);
  const planDir = join(options.dir, ".pi", "workflows", "plans");
  await mkdir(planDir, { recursive: true });
  await writeFile(join(planDir, `${options.runId}.json`), JSON.stringify(blueprint, null, 2), "utf-8");
  await options.stateManager.markPrewalkComplete();
  options.onLog?.(`prewalk complete: blueprint ${blueprint.id} written to .pi/workflows/plans/${options.runId}.json`);
  return blueprint;
}

export async function loadBlueprint(dir: string): Promise<ExecutionBlueprint | null> {
  const bpDir = join(dir, ".pi", "workflows", "blueprints");
  try {
    const entries = await readdir(bpDir);
    const files = entries.filter((name) => name.endsWith(".json"));
    if (files.length === 0) return null;
    // Most recently written blueprint wins (mtime, then name for determinism).
    const stats = await Promise.all(
      files.map(async (name) => {
        const path = join(bpDir, name);
        const stat = await statFile(path);
        return { name, mtimeMs: stat.mtimeMs };
      }),
    );
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
    const data = await readFile(join(bpDir, stats[0].name), "utf-8");
    return JSON.parse(data) as ExecutionBlueprint;
  } catch {
    return null;
  }
}
