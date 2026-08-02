/**
 * Slice N tests — spec-generation builtin workflow.
 *
 * Covers:
 *  - normalizeSpecArtifact (unit): the artifact contract — all six sections
 *    always present, requirements deduped to {id, statement} with unique ids
 *    (missing/duplicate ids deterministically reassigned REQ-N).
 *  - Parity: the vm-embedded copy (normalizeSpecArtifactSource) behaves
 *    identically to the TS reference.
 *  - Runtime: parallel drafters → adversarial reviewer → artifact, json
 *    rendering, missing-topic and bad-format degradation, failed drafts
 *    dropped with a log.
 */

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  generateSpecGenerationWorkflow,
  normalizeSpecArtifact,
  normalizeSpecArtifactSource,
  SPEC_GENERATION_FORMATS,
} from "../../../src/spec-generation.js";
import { parseWorkflowScript, runWorkflow } from "../../../src/workflow.js";

/**
 * Convert a vm-realm run result into host-realm plain data. Script results are
 * created inside the vm realm, so their arrays/objects carry the realm's
 * prototypes and fail node's strict deepEqual against host literals.
 */
function toHost<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ─── normalizeSpecArtifact: unit contract ─────────────────────────────────────

test("normalizeSpecArtifact preserves a complete artifact untouched", () => {
  const spec = normalizeSpecArtifact({
    goal: "ship the thing",
    requirements: [
      { id: "R1", statement: "users can sign in" },
      { id: "R2", statement: "sessions expire after 24h" },
    ],
    constraints: ["must run offline"],
    acceptanceCriteria: ["sign-in flow works in the demo"],
    risks: ["credential theft"],
    openQuestions: ["which auth provider?"],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(spec)), {
    goal: "ship the thing",
    requirements: [
      { id: "R1", statement: "users can sign in" },
      { id: "R2", statement: "sessions expire after 24h" },
    ],
    constraints: ["must run offline"],
    acceptanceCriteria: ["sign-in flow works in the demo"],
    risks: ["credential theft"],
    openQuestions: ["which auth provider?"],
  });
});

test("normalizeSpecArtifact always returns all six sections (schema completeness)", () => {
  const empty = normalizeSpecArtifact(null);
  assert.deepEqual(Object.keys(empty).sort(), [
    "acceptanceCriteria",
    "constraints",
    "goal",
    "openQuestions",
    "requirements",
    "risks",
  ]);
  const partial = normalizeSpecArtifact({ goal: "g" });
  assert.deepEqual(partial.constraints, []);
  assert.deepEqual(partial.acceptanceCriteria, []);
  assert.deepEqual(partial.risks, []);
  assert.deepEqual(partial.openQuestions, []);
  assert.deepEqual(partial.requirements, []);
});

test("normalizeSpecArtifact assigns unique ids to missing/duplicate requirement ids (REQ-N in input order)", () => {
  const spec = normalizeSpecArtifact({
    goal: "g",
    requirements: [
      { statement: "no id" },
      { id: "R1", statement: "has id" },
      { statement: "no id again" },
      { id: "R1", statement: "duplicate id" },
      { statement: "" },
      { id: "R2", statement: "kept" },
    ],
  });
  assert.deepEqual(spec.requirements, [
    { id: "REQ-1", statement: "no id" },
    { id: "R1", statement: "has id" },
    { id: "REQ-2", statement: "no id again" },
    { id: "REQ-3", statement: "duplicate id" },
    { id: "R2", statement: "kept" },
  ]);
});

test("normalizeSpecArtifact drops non-string requirements and non-string section entries", () => {
  const spec = normalizeSpecArtifact({
    goal: 42,
    requirements: [null, "not-an-object", { statement: 5 }, { statement: "ok" }],
    constraints: ["keep", 7, null, ""],
  });
  assert.equal(spec.goal, "", "non-string goal degrades to empty");
  assert.deepEqual(spec.requirements, [{ id: "REQ-1", statement: "ok" }]);
  assert.deepEqual(spec.constraints, ["keep"]);
});

// ─── Parity: vm-embedded copy vs TS reference ─────────────────────────────────

test("the vm-embedded normalizeSpecArtifact behaves identically to the TS reference", () => {
  const embedded = vm.runInNewContext(`${normalizeSpecArtifactSource()}\nnormalizeSpecArtifact`) as (
    raw: unknown,
  ) => unknown;
  const fixtures: unknown[] = [
    null,
    undefined,
    42,
    {},
    { goal: "g" },
    { goal: "g", requirements: [{ statement: "a" }, { id: "X", statement: "b" }] },
    {
      goal: "g",
      requirements: [
        { id: "X", statement: "a" },
        { id: "X", statement: "b" },
      ],
      risks: ["r", 1, null],
    },
    { goal: " g ", requirements: [{ statement: " s " }], constraints: [" c "], acceptanceCriteria: ["ac"] },
  ];
  for (const fixture of fixtures) {
    // JSON round-trip sidesteps the vm realm's distinct Array/Object prototypes.
    assert.deepEqual(
      JSON.parse(JSON.stringify(embedded(fixture))),
      JSON.parse(JSON.stringify(normalizeSpecArtifact(fixture))),
      `parity mismatch for fixture ${JSON.stringify(fixture)}`,
    );
  }
});

// ─── Generated script surface ─────────────────────────────────────────────────

test("generateSpecGenerationWorkflow declares the 3 phases, the artifact schema, and the normalizer", () => {
  const { meta, body } = parseWorkflowScript(generateSpecGenerationWorkflow());
  assert.equal(meta.name, "spec_generation");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Draft", "Review", "Finalize"],
  );
  assert.match(body, /args && args\.topic/);
  assert.match(body, /const normalizeSpecArtifact = /);
  // The artifact contract's six sections are all declared in the SPEC_SCHEMA.
  for (const section of ["goal", "requirements", "constraints", "acceptanceCriteria", "risks", "openQuestions"]) {
    assert.ok(body.includes(section), `SPEC_SCHEMA must declare ${section}`);
  }
  assert.match(
    body,
    /required: \['goal', 'requirements', 'constraints', 'acceptanceCriteria', 'risks', 'openQuestions'\]/,
  );
});

// ─── Runtime: drafters → reviewer → artifact (markdown) ───────────────────────

test("spec-generation produces a complete six-section artifact with uniquely-id'd requirements", async () => {
  const result = await runWorkflow(generateSpecGenerationWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("product drafter")) {
          return {
            goal: "g",
            requirements: [{ id: "P1", statement: "product req" }],
            constraints: ["c1"],
            acceptanceCriteria: ["ac1"],
            risks: ["r1"],
            openQuestions: ["oq1"],
          };
        }
        if (prompt.includes("technical drafter")) {
          return { goal: "g", requirements: [{ id: "T1", statement: "tech req" }] };
        }
        if (prompt.includes("risk drafter")) {
          return { goal: "g", requirements: [{ id: "K1", statement: "risk req" }] };
        }
        if (prompt.includes("adversarial requirements reviewer")) {
          // Reviewer consolidates but sloppily: requirements lack unique ids and
          // the constraint/risk sections are omitted entirely.
          return {
            review: "merged all three",
            conflicts: ["P1 vs T1"],
            gaps: ["no rollback plan"],
            spec: {
              goal: "the consolidated goal",
              requirements: [{ statement: "first" }, { statement: "second" }],
            },
          };
        }
        if (prompt.includes("spec writer")) return "MARKDOWN ARTIFACT";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { topic: "an app", audience: "developers", format: "markdown" },
  });

  const r = result.result as {
    topic?: string;
    audience?: string;
    format?: string;
    drafts?: unknown[];
    review?: string;
    conflicts?: string[];
    gaps?: string[];
    spec?: {
      goal?: string;
      requirements?: Array<{ id: string; statement: string }>;
      constraints?: string[];
      acceptanceCriteria?: string[];
      risks?: string[];
      openQuestions?: string[];
    };
    artifact?: string;
    error?: string;
  };
  assert.equal(r.error, "");
  assert.equal(r.topic, "an app");
  assert.equal(r.audience, "developers");
  assert.equal(r.format, "markdown");
  assert.equal(r.drafts?.length, 3, "all three perspective drafts must be produced");
  assert.equal(r.review, "merged all three");
  assert.deepEqual(r.conflicts, ["P1 vs T1"]);
  assert.deepEqual(r.gaps, ["no rollback plan"]);
  // Artifact schema completeness: every section present, ids deterministically assigned.
  assert.equal(r.spec?.goal, "the consolidated goal");
  assert.deepEqual(
    toHost(r.spec?.requirements)?.map((x) => x.id),
    ["REQ-1", "REQ-2"],
    "requirements without ids must get unique REQ-N ids",
  );
  assert.deepEqual(toHost(r.spec?.constraints), [], "missing section degrades to empty array, never undefined");
  assert.deepEqual(toHost(r.spec?.acceptanceCriteria), []);
  assert.deepEqual(toHost(r.spec?.risks), []);
  assert.deepEqual(toHost(r.spec?.openQuestions), []);
  assert.equal(r.artifact, "MARKDOWN ARTIFACT");
  // Requirements were filled by the reviewer, so the empty-section log must NOT fire.
  assert.ok(
    !result.logs.some((l) => l.includes("empty requirements section")),
    "no misleading empty-section log (requirements were filled)",
  );
});

test("spec-generation json format renders the artifact as parseable spec JSON", async () => {
  const result = await runWorkflow(generateSpecGenerationWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (
          prompt.includes("product drafter") ||
          prompt.includes("technical drafter") ||
          prompt.includes("risk drafter")
        ) {
          return { goal: "g", requirements: [{ id: "R1", statement: "req" }] };
        }
        // NB: the reviewer prompt mentions "Three drafters (...)", so the
        // broad "drafter" substring would match it — match the reviewer first.
        if (prompt.includes("adversarial requirements reviewer")) {
          return { review: "ok", spec: { goal: "goal", requirements: [{ statement: "req" }] } };
        }
        return null;
      },
    } as never,
    persistLogs: false,
    args: { topic: "t", format: "json" },
  });

  const r = result.result as { format?: string; spec?: unknown; artifact?: string; error?: string };
  assert.equal(r.format, "json");
  assert.equal(r.error, "");
  const parsed = JSON.parse(r.artifact ?? "{}") as { goal?: string; requirements?: Array<{ id: string }> };
  assert.equal(parsed.goal, "goal");
  assert.deepEqual(
    parsed.requirements?.map((x) => x.id),
    ["REQ-1"],
  );
});

test("a failed perspective draft is dropped and logged; the review still runs", async () => {
  const result = await runWorkflow(generateSpecGenerationWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("product drafter")) return null; // recoverable failure
        if (prompt.includes("technical drafter")) return { goal: "g", requirements: [{ id: "T1", statement: "req" }] };
        if (prompt.includes("risk drafter")) return { goal: "g", requirements: [{ id: "K1", statement: "req" }] };
        if (prompt.includes("adversarial requirements reviewer")) {
          return { review: "ok", spec: { goal: "g", requirements: [{ id: "R1", statement: "req" }] } };
        }
        if (prompt.includes("spec writer")) return "artifact";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { topic: "t" },
  });

  const r = result.result as { drafts?: unknown[]; error?: string };
  assert.equal(r.error, "");
  assert.equal(r.drafts?.length, 2, "the failed product draft must be excluded from the review");
  assert.ok(
    result.logs.some((l) => l.includes("perspective draft(s) failed")),
    "the dropped draft must be logged",
  );
});

// ─── Runtime: degradation ──────────────────────────────────────────────────────

test("a missing topic degrades into an explicit error result without any agent calls", async () => {
  const result = await runWorkflow(generateSpecGenerationWorkflow(), {
    agent: {
      async run() {
        throw new Error("no agent should be called without a topic");
      },
    } as never,
    persistLogs: false,
    args: {},
  });
  const r = result.result as { error?: string; spec?: unknown; artifact?: unknown };
  assert.match(r.error ?? "", /topic is required/);
  assert.equal(r.spec, null);
  assert.equal(r.artifact, null);
});

test("an unsupported format degrades into an explicit error result", async () => {
  const result = await runWorkflow(generateSpecGenerationWorkflow(), {
    agent: {
      async run() {
        throw new Error("no agents expected");
      },
    } as never,
    persistLogs: false,
    args: { topic: "t", format: "pdf" },
  });
  const r = result.result as { error?: string };
  assert.match(r.error ?? "", new RegExp(`format must be one of: ${SPEC_GENERATION_FORMATS.join(", ")}`));
});
