/**
 * Slice D1 tests — P07 spec-conformance builtin.
 *
 * The pattern must: normalize a spec (artifact, spec-generation run result, or
 * JSON string) into requirements with deterministic ids; map MECHANICAL
 * evidence per requirement (symbols, registrations, probed behavior) via
 * parallel evidence agents; detect missing requirements MACHINE-side and
 * extras via an auditor; compute a machine score; and write a conformance
 * report. The embedded normalizers must behave identically to the TS
 * references (parity), and a mid-run resume replays completed steps.
 */

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  conformanceNormalizersSource,
  generateSpecConformanceWorkflow,
  normalizeConformanceEvidence,
  normalizeConformanceSpec,
  normalizeEvidenceResults,
} from "../../../src/spec-conformance.js";
import type { JournalEntry } from "../../../src/workflow.js";
import { parseWorkflowScript, runWorkflow } from "../../../src/workflow.js";

const RUN_ID = "spec-conformance-run";

const SPEC_FIXTURE = {
  goal: "A counter that persists across restarts",
  requirements: [
    { id: "R1", statement: "increment() increases the count by one" },
    { id: "R2", statement: "the count survives a process restart" },
    { id: "R3", statement: "decrement() never goes below zero" },
  ],
  constraints: ["no external database"],
  acceptanceCriteria: ["increment() returns the new count"],
  risks: [],
  openQuestions: [],
};

/** Extract a vm-realm function from the embedded normalizer source. */
function embedded(name: string): (value: unknown, extra?: unknown) => unknown {
  return vm.runInNewContext(`${conformanceNormalizersSource()}\n${name}`) as (
    value: unknown,
    extra?: unknown,
  ) => unknown;
}

// ─── Normalizer references ─────────────────────────────────────────────────────

test("normalizeConformanceSpec unwraps artifact / run-result / JSON shapes with deterministic ids", () => {
  // Raw artifact shape.
  const artifact = normalizeConformanceSpec(SPEC_FIXTURE);
  assert.equal(artifact.goal, SPEC_FIXTURE.goal);
  assert.deepEqual(
    artifact.requirements.map((r) => r.id),
    ["R1", "R2", "R3"],
  );
  // spec-generation run-result shape (spec nested under .spec).
  const runResult = normalizeConformanceSpec({ spec: SPEC_FIXTURE, artifact: "x", error: "" });
  assert.deepEqual(
    runResult.requirements.map((r) => r.id),
    ["R1", "R2", "R3"],
  );
  // Missing/duplicate requirement ids are deterministically reassigned.
  const reassigned = normalizeConformanceSpec({
    goal: "g",
    requirements: [{ statement: "no id" }, { id: "R1", statement: "dup" }, { statement: "also no id" }],
  });
  assert.deepEqual(
    reassigned.requirements.map((r) => r.id),
    ["REQ-1", "R1", "REQ-2"],
  );
  // Non-objects degrade to an empty spec (the script errors loudly on zero requirements).
  assert.equal(normalizeConformanceSpec(null).requirements.length, 0);
  assert.equal(normalizeConformanceSpec("garbage").requirements.length, 0);
});

test("normalizeConformanceEvidence enforces the mechanical-evidence contract", () => {
  const cleaned = normalizeConformanceEvidence([
    { kind: "symbol", target: "increment", detail: "src/counter.js:12" },
    { kind: "symbol", target: "increment", detail: "duplicate dropped" },
    {
      kind: "probe",
      target: "npm test",
      detail: "ok",
      probeCommand: "npm test",
      probeExitCode: 0,
      probeOutput: "PASS",
    },
    { kind: "made-up", target: "x", detail: "bad kind dropped" },
    { kind: "behavior", target: "", detail: "empty target dropped" },
    "not-an-object",
    { kind: "registration", target: "counter", detail: "routes.js:4", probeOutput: "a".repeat(3000) },
  ]);
  assert.deepEqual(
    cleaned.map((e) => e.kind),
    ["symbol", "probe", "registration"],
  );
  assert.equal(cleaned[0].target, "increment");
  assert.equal(cleaned[1].probeExitCode, 0);
  // Probe output is capped deterministically.
  const probeOutput = cleaned[2].probeOutput;
  assert.ok(probeOutput !== undefined && probeOutput.length <= 2001, "probe output capped");
  assert.equal(normalizeConformanceEvidence(null).length, 0);
});

test("normalizeEvidenceResults maps evidence back by requirement position (null-safe)", () => {
  const results = [
    { evidence: [{ kind: "symbol", target: "a", detail: "1" }] },
    null, // recoverable agent failure degrades only its own requirement
    { evidence: [{ kind: "probe", target: "b", detail: "2" }] },
  ];
  const byId = normalizeEvidenceResults(results, [{ id: "R1" }, { id: "R2" }, { id: "R3" }]);
  assert.equal(byId.R1.length, 1);
  assert.deepEqual(byId.R2, [], "a null result scores its requirement missing");
  assert.equal(byId.R3.length, 1);
});

// ─── Parity: vm-embedded copy vs TS reference ─────────────────────────────────

test("the vm-embedded normalizers behave identically to the TS references", () => {
  const embeddedSpec = embedded("normalizeConformanceSpec") as (value: unknown) => {
    goal: string;
    requirements: Array<{ id: string; statement: string }>;
  };
  const embeddedEvidence = embedded("normalizeConformanceEvidence") as (value: unknown) => unknown;
  const embeddedResults = embedded("normalizeEvidenceResults") as (results: unknown, reqs: unknown) => unknown;
  const fixtures = [
    SPEC_FIXTURE,
    { spec: SPEC_FIXTURE, artifact: "x", error: "" },
    { goal: "g", requirements: [{ statement: "a" }, { id: "R1", statement: "b" }] },
    { goal: "g", requirements: [] },
    null,
    "garbage",
  ];
  for (const fixture of fixtures) {
    // JSON round-trip sidesteps the vm realm's distinct Array/Object prototypes.
    assert.deepEqual(
      JSON.parse(JSON.stringify(embeddedSpec(fixture))),
      normalizeConformanceSpec(fixture),
      `parity mismatch for spec fixture ${JSON.stringify(fixture)}`,
    );
  }
  const evidenceFixtures = [
    [{ kind: "symbol", target: "increment", detail: "a" }],
    [
      { kind: "symbol", target: "increment", detail: "dup" },
      { kind: "symbol", target: "increment", detail: "2" },
    ],
    [{ kind: "probe", target: "t", detail: "d", probeExitCode: 0, probeOutput: "x".repeat(2500) }],
    [{ kind: "nope", target: "x", detail: "d" }],
    null,
    "not-an-array",
  ];
  for (const fixture of evidenceFixtures) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(embeddedEvidence(fixture))),
      normalizeConformanceEvidence(fixture),
      `parity mismatch for evidence fixture ${JSON.stringify(fixture)}`,
    );
  }
  const resultsFixture = [{ evidence: [{ kind: "symbol", target: "a", detail: "1" }] }, null, { evidence: [] }];
  assert.deepEqual(
    JSON.parse(JSON.stringify(embeddedResults(resultsFixture, [{ id: "R1" }, { id: "R2" }, { id: "R3" }]))),
    normalizeEvidenceResults(resultsFixture, [{ id: "R1" }, { id: "R2" }, { id: "R3" }]),
    "parity mismatch for evidence-results mapping",
  );
});

// ─── Generated script surface ─────────────────────────────────────────────────

test("spec-conformance declares the 4 phases and the mechanical-evidence schema", () => {
  const { meta, body } = parseWorkflowScript(generateSpecConformanceWorkflow());
  assert.equal(meta.name, "spec_conformance");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Requirements", "Evidence", "Audit", "Report"],
  );
  // The four mechanical-evidence kinds are declared in the schema.
  for (const kind of ["symbol", "registration", "behavior", "probe"]) {
    assert.ok(body.includes(kind), `EVIDENCE_SCHEMA must declare kind ${kind}`);
  }
  assert.match(body, /label: 'evidence ' \+ \(i \+ 1\)/);
  assert.match(body, /label: 'auditor'/);
  assert.match(body, /label: 'report writer'/);
  // Missing is a machine decision; the score is machine-computed.
  assert.match(body, /const missing = requirements\.filter/);
  assert.match(body, /Math\.round\(\(covered \/ requirements\.length\) \* 100\)/);
  assert.match(body, /maxRequirements/);
});

// ─── Runtime: evidence mapping, missing/extra detection, scored report ────────

test("spec-conformance: 2 of 3 requirements covered → score 67, missing detected, extras reported", async () => {
  const result = await runWorkflow(generateSpecConformanceWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("conformance evidence auditor")) {
          if (prompt.includes('"R1"')) {
            return {
              requirementId: "R1",
              evidence: [
                { kind: "symbol", target: "increment", detail: "src/counter.js:12" },
                { kind: "probe", target: "npm test", detail: "passes", probeExitCode: 0, probeOutput: "PASS" },
              ],
            };
          }
          if (prompt.includes('"R2"')) {
            return { requirementId: "R2", evidence: [] };
          }
          if (prompt.includes('"R3"')) {
            return {
              requirementId: "R3",
              evidence: [{ kind: "behavior", target: "decrement clamps at zero", detail: "src/counter.js:41" }],
            };
          }
        }
        if (prompt.includes("spec-conformance auditor")) {
          return {
            extras: [
              { what: "reset() clears the count", reason: "not mentioned in any requirement (src/counter.js:55)" },
            ],
          };
        }
        if (prompt.includes("spec-conformance report writer")) return "conformance report text";
        return null;
      },
    },
    persistLogs: false,
    args: { spec: SPEC_FIXTURE },
  });

  const r = result.result as {
    perRequirement?: Array<{ id: string; status: string; evidence: unknown[] }>;
    covered?: number;
    total?: number;
    score?: number;
    missing?: string[];
    extras?: Array<{ what: string; reason: string }>;
    report?: string;
  };
  assert.equal(r.total, 3);
  assert.equal(r.covered, 2);
  assert.equal(r.score, 67, "machine score = round(2/3 * 100)");
  // Spread out of the vm realm before deepEqual (its Array prototype differs).
  assert.deepEqual([...(r.missing ?? [])], ["R2"], "the requirement with zero mechanical evidence is missing");
  const perRequirement = [...(r.perRequirement ?? [])].map((p) => ({
    id: p.id,
    status: p.status,
    evidence: p.evidence.length,
  }));
  assert.deepEqual(perRequirement, [
    { id: "R1", status: "covered", evidence: 2 },
    { id: "R2", status: "missing", evidence: 0 },
    { id: "R3", status: "covered", evidence: 1 },
  ]);
  const extras = (r.extras ?? []).map((e) => e.what);
  assert.deepEqual(extras, ["reset() clears the count"], "auditor-detected extras reach the artifact");
  assert.equal(r.report, "conformance report text");
});

test("spec-conformance: an empty/invalid spec degrades into an explicit error result", async () => {
  const result = await runWorkflow(generateSpecConformanceWorkflow(), {
    agent: {
      async run() {
        return null;
      },
    },
    persistLogs: false,
    args: { spec: { goal: "g", requirements: [] } },
  });
  const r = result.result as { error?: string; total?: number };
  assert.match(r.error ?? "", /at least one requirement/);
  assert.equal(r.total, 0);
});

// ─── Resume: a mid-pattern run replays completed steps ───────────────────────

test("spec-conformance: a full run replays from the journal without re-calling the agent", async () => {
  const journal = new Map<string, JournalEntry>();
  const agent = {
    async run(prompt: string) {
      if (prompt.includes("conformance evidence auditor")) {
        if (prompt.includes('"R1"'))
          return {
            requirementId: "R1",
            evidence: [{ kind: "symbol", target: "increment", detail: "src/counter.js:12" }],
          };
        if (prompt.includes('"R2"')) return { requirementId: "R2", evidence: [] };
      }
      if (prompt.includes("spec-conformance auditor")) return { extras: [] };
      if (prompt.includes("spec-conformance report writer")) return "report";
      return null;
    },
  };
  const options = (capture: boolean) => ({
    agent,
    persistLogs: false,
    runId: RUN_ID,
    args: { spec: SPEC_FIXTURE, maxRequirements: 2 },
    ...(capture
      ? { onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry) }
      : {}),
  });

  const first = await runWorkflow(generateSpecConformanceWorkflow(), options(true));
  assert.equal((first.result as { score?: number }).score, 50);
  assert.ok(journal.size >= 4, "2 evidence + auditor + report writer journal entries");

  let calls = 0;
  const replay = await runWorkflow(generateSpecConformanceWorkflow(), {
    agent: {
      async run(_prompt: string) {
        calls++;
        return null;
      },
    },
    persistLogs: false,
    runId: RUN_ID,
    resumeJournal: journal,
    args: { spec: SPEC_FIXTURE, maxRequirements: 2 },
  });
  assert.equal(calls, 0, "a full prefix replay must not re-call the agent");
  assert.equal((replay.result as { score?: number }).score, 50, "the replayed run reconstructs the same score");
});
