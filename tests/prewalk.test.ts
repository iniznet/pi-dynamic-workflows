/**
 * Unit tests for the Prewalk "1986 Aircraft Manual" blueprint module (Phase 1).
 */

import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  type ExecutionBlueprint,
  type FailSafeProcedure,
  generateBlueprint,
  loadBlueprint,
  REQUIRED_FAIL_SAFE_KINDS,
  saveBlueprint,
  toMarkdown,
  validateBlueprint,
} from "../src/phases/prewalk.js";

function validBlueprint(): ExecutionBlueprint {
  return {
    id: "bp-1",
    title: "Add health endpoint",
    preconditions: ["Server scaffolded"],
    executionSteps: [
      {
        id: "s1",
        description: "Write failing test",
        action: "Create test file",
        expectedOutcome: "Test fails",
        rollbackProcedure: "Delete test file",
      },
    ],
    failSafeProcedures: [
      {
        kind: "timeout",
        trigger: "a command exceeds its allotted time",
        fallback: "retry once, then abort and log",
        maxAttempts: 2,
      },
      {
        kind: "api-error",
        trigger: "an API call returns a non-2xx status",
        fallback: "retry with backoff, then surface the error",
        maxAttempts: 3,
      },
      {
        kind: "typecheck",
        trigger: "typecheck fails",
        fallback: "fix types",
      },
    ],
    verificationTests: ["tsc --noEmit passes"],
    createdAt: new Date().toISOString(),
  };
}

describe("validateBlueprint", () => {
  it("accepts a fully specified blueprint", () => {
    const result = validateBlueprint(validBlueprint());
    assert.equal(result.valid, true);
    assert.deepEqual(result.issues, []);
  });

  it("rejects a missing title", () => {
    const bp = validBlueprint();
    bp.title = "";
    const result = validateBlueprint(bp);
    assert.equal(result.valid, false);
    assert.ok(result.issues.includes("Missing title"));
  });

  it("reports every missing required section", () => {
    const bp: ExecutionBlueprint = {
      id: "bp-empty",
      title: "x",
      preconditions: [],
      executionSteps: [],
      failSafeProcedures: [],
      verificationTests: [],
      createdAt: new Date().toISOString(),
    };
    const result = validateBlueprint(bp);
    assert.equal(result.valid, false);
    assert.ok(result.issues.includes("No preconditions defined"));
    assert.ok(result.issues.includes("No execution steps defined"));
    assert.ok(result.issues.includes("No fail-safe procedures defined"));
    assert.ok(result.issues.includes("No verification tests defined"));
  });

  it("flags steps missing an action or rollback procedure", () => {
    const bp = validBlueprint();
    bp.executionSteps.push({
      id: "s2",
      description: "Broken step",
      action: "",
      expectedOutcome: "whatever",
      rollbackProcedure: "",
    });
    const result = validateBlueprint(bp);
    assert.equal(result.valid, false);
    assert.ok(result.issues.includes("Step s2: missing action"));
    assert.ok(result.issues.includes("Step s2: missing rollback procedure"));
  });
});

describe("generateBlueprint", () => {
  it("produces a complete 1986 Aircraft Manual structure", async () => {
    const bp = await generateBlueprint("codebase summary", "Add auth middleware");
    assert.equal(bp.title, "Add auth middleware");
    assert.ok(bp.preconditions.length >= 3);
    assert.ok(bp.executionSteps.length >= 3);
    assert.ok(bp.failSafeProcedures.length >= REQUIRED_FAIL_SAFE_KINDS.length);
    assert.ok(bp.verificationTests.length >= 1);
    for (const step of bp.executionSteps) {
      assert.ok(step.description);
      assert.ok(step.action);
      assert.ok(step.rollbackProcedure);
    }
    assert.ok(!Number.isNaN(Date.parse(bp.createdAt)));
    assert.equal(validateBlueprint(bp).valid, true);
  });

  it("generates unique ids per call", async () => {
    const a = await generateBlueprint("s", "t");
    const b = await generateBlueprint("s", "t");
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.executionSteps[0].id, b.executionSteps[0].id);
  });

  it("derives checklist items from the codebase summary (test framework, typechecker, linter)", async () => {
    const summary = [
      "TypeScript monorepo using pnpm workspaces.",
      "Tests are written with vitest and run via `pnpm test`.",
      "Type checking runs `tsc --noEmit`; linting uses biome.",
      "CI (GitHub Actions) runs tests, typecheck, and lint on every PR.",
    ].join(" ");
    const bp = await generateBlueprint(summary, "Add an endpoint");
    const text = JSON.stringify(bp);
    assert.ok(text.includes("vitest"), "the test framework from the summary must appear");
    assert.ok(text.includes("tsc --noemit"), "the typecheck command from the summary must appear");
    assert.ok(text.includes("biome"), "the linter from the summary must appear");
    assert.ok(text.toLowerCase().includes("monorepo"), "monorepo detection must shape the checklist");
    assert.equal(validateBlueprint(bp).valid, true);
  });

  it("caps item counts so the blueprint stays bounded", async () => {
    const big = Array.from(
      { length: 40 },
      (_, i) => `module-${i} with tests (jest) and tsc and eslint and docker`,
    ).join(". ");
    const bp = await generateBlueprint(big, "Huge task");
    assert.ok(bp.preconditions.length <= 6, `preconditions capped: ${bp.preconditions.length}`);
    assert.ok(bp.executionSteps.length <= 8, `steps capped: ${bp.executionSteps.length}`);
    assert.ok(
      bp.failSafeProcedures.length <= 6,
      `fail-safes capped at the closed kind set: ${bp.failSafeProcedures.length}`,
    );
    assert.ok(bp.verificationTests.length <= 4, `verification tests capped: ${bp.verificationTests.length}`);
    assert.ok(bp.executionSteps.length >= 3, "caps must not starve the required minimum");
    assert.equal(validateBlueprint(bp).valid, true);
  });

  it("stays valid for an empty summary (generic defaults)", async () => {
    const bp = await generateBlueprint("", "Do the thing");
    assert.equal(validateBlueprint(bp).valid, true);
    assert.ok(bp.preconditions.length >= 3);
    assert.ok(bp.executionSteps.length >= 3);
  });
});

describe("fail-safe model (PRD Task 5: explicit timeout/API-error fallback)", () => {
  it("always includes timeout and api-error procedures, regardless of the summary", async () => {
    const summaries = ["", "a plain codebase", "TypeScript with vitest, tsc, biome, and GitHub Actions CI"];
    for (const summary of summaries) {
      const bp = await generateBlueprint(summary, "Any task");
      const kinds = new Set(bp.failSafeProcedures.map((procedure) => procedure.kind));
      for (const required of REQUIRED_FAIL_SAFE_KINDS) {
        assert.ok(kinds.has(required), `${required} fail-safe must be present for summary: ${JSON.stringify(summary)}`);
      }
      assert.equal(validateBlueprint(bp).valid, true);
    }
  });

  it("gives timeout and api-error entries an explicit attempt ceiling", async () => {
    const bp = await generateBlueprint("", "Task");
    const timeout = bp.failSafeProcedures.find((procedure) => procedure.kind === "timeout");
    const apiError = bp.failSafeProcedures.find((procedure) => procedure.kind === "api-error");
    assert.ok(timeout?.maxAttempts && timeout.maxAttempts >= 1, "timeout procedure carries maxAttempts");
    assert.ok(apiError?.maxAttempts && apiError.maxAttempts >= 1, "api-error procedure carries maxAttempts");
  });

  it("rejects a blueprint that omits the mandated timeout kind", () => {
    const bp = validBlueprint();
    bp.failSafeProcedures = bp.failSafeProcedures.filter((procedure) => procedure.kind !== "timeout");
    const result = validateBlueprint(bp);
    assert.equal(result.valid, false);
    assert.ok(result.issues.includes("Missing timeout fail-safe procedure"));
  });

  it("rejects a fail-safe entry missing its fallback steps", () => {
    const bp = validBlueprint();
    bp.failSafeProcedures.push({ kind: "ci", trigger: "CI fails", fallback: "" });
    const result = validateBlueprint(bp);
    assert.equal(result.valid, false);
    assert.ok(result.issues.includes("Fail-safe ci: missing fallback"));
  });

  it("rejects an unknown fail-safe kind (defensive JSON round-trip guard)", () => {
    const bp = validBlueprint();
    const malformed = { kind: "crash-loop", trigger: "x", fallback: "y" } as unknown as FailSafeProcedure;
    bp.failSafeProcedures.push(malformed);
    const result = validateBlueprint(bp);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => issue.includes("unknown kind")));
  });
});

describe("toMarkdown (1986 Aircraft Manual renderer)", () => {
  it("renders the four mandated section headers in order", async () => {
    const bp = await generateBlueprint("typescript with vitest", "Add auth");
    const md = toMarkdown(bp);
    const headers = [
      "## PRE-CONDITIONS & CONSTRAINTS",
      "## EXECUTION STEPS",
      "## FAIL-SAFE & ERROR HANDLING",
      "## VERIFICATION TESTS",
    ];
    let last = -1;
    for (const header of headers) {
      const index = md.indexOf(header);
      assert.ok(index !== -1, `header ${header} must be present`);
      assert.ok(index > last, `headers must appear in PRD order: ${header}`);
      last = index;
    }
  });

  it("renders the title, per-step directives, and verification checklist", () => {
    const md = toMarkdown(validBlueprint());
    assert.ok(md.startsWith("# Add health endpoint"));
    assert.ok(md.includes("### Step 1 — Write failing test"));
    assert.ok(md.includes("**ACTION:** Create test file"));
    assert.ok(md.includes("**EXPECTED OUTCOME:** Test fails"));
    assert.ok(md.includes("**ROLLBACK PROCEDURE:** Delete test file"));
    assert.ok(md.includes("1. [ ] tsc --noEmit passes"));
  });

  it("labels fail-safe entries by kind with fallback and attempt ceiling", () => {
    const md = toMarkdown(validBlueprint());
    assert.ok(md.includes("**TIMEOUT** — if a command exceeds its allotted time"));
    assert.ok(md.includes("(max 2 attempts)"));
    assert.ok(md.includes("**API ERROR** — if an API call returns a non-2xx status"));
    assert.ok(md.includes("(max 3 attempts)"));
    assert.ok(md.includes("**TYPECHECK** — if typecheck fails: fix types"));
  });

  it("still renders legacy string-shaped fail-safes read back from disk", () => {
    // A blueprint persisted before the typed fail-safe model round-trips as
    // plain strings; the renderer must not choke on them.
    const legacy = validBlueprint();
    const raw = JSON.stringify({ ...legacy, failSafeProcedures: ["If typecheck fails, fix types"] });
    const parsed = JSON.parse(raw) as ExecutionBlueprint;
    const md = toMarkdown(parsed);
    assert.ok(md.includes("## FAIL-SAFE & ERROR HANDLING"));
    assert.ok(md.includes("If typecheck fails, fix types"));
  });
});

describe("blueprint persistence", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prewalk-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips the most recent blueprint through .pi/workflows/blueprints", async () => {
    const first = await generateBlueprint("s", "first task");
    await saveBlueprint(first, dir);
    const loaded = await loadBlueprint(dir);
    assert.ok(loaded);
    assert.deepEqual(loaded, first);
  });

  it("loads the newest blueprint when several exist", async () => {
    const old = await generateBlueprint("s", "old task");
    const newer = await generateBlueprint("s", "newer task");
    await saveBlueprint(old, dir);
    await new Promise((r) => setTimeout(r, 10)); // ensure distinct mtimes
    await saveBlueprint(newer, dir);
    const loaded = await loadBlueprint(dir);
    assert.equal(loaded?.id, newer.id);
  });

  it("returns null when no blueprints exist", async () => {
    assert.equal(await loadBlueprint(dir), null);
  });

  it("returns null on a corrupt blueprint file", async () => {
    const bpDir = join(dir, ".pi", "workflows", "blueprints");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(bpDir, { recursive: true });
    await writeFile(join(bpDir, "corrupt.json"), "{oops", "utf-8");
    assert.equal(await loadBlueprint(dir), null);
  });
});
