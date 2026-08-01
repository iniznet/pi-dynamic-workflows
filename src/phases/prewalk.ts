/**
 * Prewalk "1986 Aircraft Manual" Blueprint Generator (Phase 1).
 * Generates execution blueprints in strict pre-condition/step/fail-safe/verify format.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat as statFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Cap on checklist item counts so a blueprint never becomes an unbounded dump. */
export const BLUEPRINT_ITEM_CAPS = {
  preconditions: 6,
  executionSteps: 8,
  failSafeProcedures: 4,
  verificationTests: 4,
} as const;

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
  failSafeProcedures: string[];
  verificationTests: string[];
  createdAt: string;
}

export function validateBlueprint(blueprint: ExecutionBlueprint): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!blueprint.title) issues.push("Missing title");
  if (!blueprint.preconditions?.length) issues.push("No preconditions defined");
  if (!blueprint.executionSteps?.length) issues.push("No execution steps defined");
  if (!blueprint.failSafeProcedures?.length) issues.push("No fail-safe procedures defined");
  if (!blueprint.verificationTests?.length) issues.push("No verification tests defined");
  for (const step of blueprint.executionSteps || []) {
    if (!step.action) issues.push(`Step ${step.id}: missing action`);
    if (!step.rollbackProcedure) issues.push(`Step ${step.id}: missing rollback procedure`);
  }
  return { valid: issues.length === 0, issues };
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

  const failSafeProcedures = [
    signals.testFramework
      ? `If the ${signals.testFramework} suite cannot run: fix config/dependencies before proceeding`
      : "If no test runner works: fall back to manual verification with documented steps",
    signals.typecheckCommand
      ? `If typecheck (${signals.typecheckCommand}) fails: fix type errors before committing`
      : "If a build/compile step fails: resolve it before proceeding",
    "If implementation grows beyond the task scope: pause and reassess the approach",
    signals.ci ? "If the CI pipeline fails: treat it as a release blocker and fix before finishing" : undefined,
  ].filter((f): f is string => Boolean(f));

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
