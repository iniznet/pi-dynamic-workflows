/**
 * Slice H2 tests — V2-N2 conformance-trend ledger.
 *
 * The spec-conformance pattern must: capture the workspace fingerprint ONCE at
 * audit start (a bash-captured agent step relaying the N01 git commands,
 * normalized MACHINE-side); key per-requirement scores by that fingerprint;
 * compare against the last audit of the SAME fingerprint (read-only ledger
 * compare over DETERMINISTIC timestamps); write a trend record per run via the
 * durable store (putOnce/record dedupe — replay-idempotent, never resume
 * identity); and surface a machine-readable trend block in the run report
 * (`conformanceTrend:<runId>` read from the durable entries view).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { DurableStore } from "../../../src/durable-store.js";
import { buildRunReport } from "../../../src/run-report.js";
import {
  conformanceNormalizersSource,
  generateSpecConformanceWorkflow,
  normalizeWorkspaceFingerprint,
  workspaceFingerprintKey,
  workspaceFingerprintSource,
} from "../../../src/spec-conformance.js";
import { parseWorkflowScript, runWorkflow } from "../../../src/workflow.js";

const GIT_OUT = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n M src/x.js\n?? src/new.js\n";

/** The trend-shaped run result the runtime tests assert on. */
type TrendRun = {
  result: {
    score?: number;
    trend?: {
      score?: number;
      priorScore?: number | null;
      scoreDelta?: number | null;
      regression?: string[];
      improvement?: string[];
      fingerprint?: string;
      perRequirement?: Array<{ id: string; status: string }>;
    };
  };
  logs?: string[];
};

const SPEC = {
  goal: "g",
  requirements: [
    { id: "R1", statement: "a" },
    { id: "R2", statement: "b" },
    { id: "R3", statement: "c" },
  ],
};

/** A fake agent whose evidence coverage is parameterizable per run. */
function conformanceRunner(covered: string[]) {
  return {
    async run(prompt: string) {
      if (prompt.includes("git rev-parse")) return { exitCode: 0, output: GIT_OUT };
      if (prompt.includes("conformance evidence auditor")) {
        const match = prompt.match(/"R(\d)"/);
        const req = match ? `R${match[1]}` : "R1";
        if (covered.includes(req)) {
          return { requirementId: req, evidence: [{ kind: "symbol", target: req, detail: "src/x.js:1" }] };
        }
        return { requirementId: req, evidence: [] };
      }
      if (prompt.includes("spec-conformance auditor")) return { extras: [] };
      if (prompt.includes("spec-conformance report writer")) return "report";
      return null;
    },
  };
}

// ─── Fingerprint normalizer ───────────────────────────────────────────────────

test("normalizeWorkspaceFingerprint parses the git capture deterministically", () => {
  const fp = normalizeWorkspaceFingerprint({ exitCode: 0, output: GIT_OUT });
  // The porcelain status rows keep their leading-space XY column (staged vs
  // worktree-modified) and sort deterministically.
  assert.deepEqual(fp, {
    treeHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    gitStatus: [" M src/x.js", "?? src/new.js"],
  });
  assert.ok(workspaceFingerprintKey(fp), "a fingerprintable capture yields a key");
  // Not fingerprint-able: git errors, empty repos, blank output.
  assert.equal(normalizeWorkspaceFingerprint({ output: "fatal: not a git repository" }), null);
  assert.equal(normalizeWorkspaceFingerprint({ output: "" }), null);
  assert.equal(normalizeWorkspaceFingerprint({}), null);
  assert.equal(normalizeWorkspaceFingerprint(null), null);
  assert.equal(workspaceFingerprintKey(null), null);
});

test("workspaceFingerprintKey is content-derived (same state → same key)", () => {
  const a = normalizeWorkspaceFingerprint({ output: GIT_OUT });
  const b = normalizeWorkspaceFingerprint({ output: GIT_OUT });
  const changed = normalizeWorkspaceFingerprint({
    output: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n M src/x.js\n",
  });
  assert.equal(workspaceFingerprintKey(a), workspaceFingerprintKey(b));
  assert.notEqual(workspaceFingerprintKey(a), workspaceFingerprintKey(changed), "a changed workspace → a distinct key");
});

test("the vm-embedded fingerprint normalizer behaves identically to the TS reference", () => {
  const embedded = runInNewContext(
    `${workspaceFingerprintSource()}\n({ normalizeWorkspaceFingerprint, workspaceFingerprintKey })`,
  ) as {
    normalizeWorkspaceFingerprint: (raw: unknown) => unknown;
    workspaceFingerprintKey: (fp: unknown) => unknown;
  };
  const fixtures = [{ exitCode: 0, output: GIT_OUT }, { output: "fatal: not a git repository" }, { output: "" }, null];
  for (const fixture of fixtures) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(embedded.normalizeWorkspaceFingerprint(fixture))),
      normalizeWorkspaceFingerprint(fixture),
      `parity mismatch for ${JSON.stringify(fixture)}`,
    );
  }
  // The combined conformance normalizers source also carries the fingerprint
  // machinery (provenanceContentId is defined in that block).
  const combined = runInNewContext(
    `${conformanceNormalizersSource()}\nworkspaceFingerprintKey(normalizeWorkspaceFingerprint({ output: ${JSON.stringify(GIT_OUT)} }))`,
  );
  assert.equal(combined, workspaceFingerprintKey(normalizeWorkspaceFingerprint({ output: GIT_OUT })));
});

// ─── Generated script surface ─────────────────────────────────────────────────

test("spec-conformance declares the fingerprint capture + trend ledger machinery", () => {
  const { body } = parseWorkflowScript(generateSpecConformanceWorkflow());
  assert.ok(body.includes("git rev-parse HEAD^{tree}"), "the fingerprint step runs the N01 git commands");
  assert.ok(body.includes("normalizeWorkspaceFingerprint"), "the capture is normalized machine-side");
  assert.ok(body.includes("spec-conformance-trend"), "the trend ledger records carry their own source kind");
  assert.ok(body.includes("conformanceTrend:"), "the report-facing trend pointer is written per run");
  assert.ok(body.includes("durableStore.record"), "the trend record is durableStore state");
  assert.ok(body.includes("trend"), "the result exposes the trend block");
});

// ─── Runtime: trend delta vs prior + replay determinism ───────────────────────

test("spec-conformance: second audit of the same fingerprint reports the delta vs prior", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-trend-"));
  const run1 = (await runWorkflow(generateSpecConformanceWorkflow(), {
    agent: conformanceRunner(["R1", "R2"]),
    cwd,
    persistLogs: false,
    runId: "trend-run-1",
    args: { spec: SPEC },
  })) as TrendRun;
  const t1 = run1.result.trend as {
    score?: number;
    priorScore?: number | null;
    scoreDelta?: number | null;
    regression?: string[];
    improvement?: string[];
    fingerprint?: string;
    perRequirement?: Array<{ id: string; status: string }>;
  };
  assert.equal(run1.result.score, 67);
  assert.equal(t1?.score, 67);
  assert.equal(t1?.priorScore, null, "the first audit has no prior");
  assert.equal(t1?.scoreDelta, null);
  assert.deepEqual([...(t1?.regression ?? [])], []);
  assert.deepEqual([...(t1?.improvement ?? [])], []);

  // Second audit of the SAME workspace fingerprint: all covered → delta +33,
  // R3 improves missing → covered.
  const run2 = (await runWorkflow(generateSpecConformanceWorkflow(), {
    agent: conformanceRunner(["R1", "R2", "R3"]),
    cwd,
    persistLogs: false,
    runId: "trend-run-2",
    args: { spec: SPEC },
  })) as TrendRun;
  const t2 = run2.result.trend as {
    score?: number;
    priorScore?: number | null;
    scoreDelta?: number | null;
    regression?: string[];
    improvement?: string[];
    fingerprint?: string;
  };
  assert.equal(run2.result.score, 100);
  assert.equal(t2?.score, 100);
  assert.equal(t2?.priorScore, 67, "the prior is the last audit of the same fingerprint");
  assert.equal(t2?.scoreDelta, 33);
  assert.deepEqual([...(t2?.improvement ?? [])], ["R3"]);
  assert.deepEqual([...(t2?.regression ?? [])], []);
  assert.equal(t1?.fingerprint, t2?.fingerprint, "both runs key on the same workspace fingerprint");
});

test("spec-conformance: a replayed run (same runId) recomputes the identical trend", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-trend-"));
  const run = (id: string, covered: string[]) =>
    runWorkflow(generateSpecConformanceWorkflow(), {
      agent: conformanceRunner(covered),
      cwd,
      persistLogs: false,
      runId: id,
      args: { spec: SPEC },
    });
  // Baseline audit (score 67) then a 100% audit (delta +33) under a DIFFERENT
  // runId — the trend record is one per run.
  await run("trend-replay-a", ["R1", "R2"]);
  const live = (await run("trend-replay-b", ["R1", "R2", "R3"])) as TrendRun;
  const liveTrend = live.result.trend as { score?: number; priorScore?: number | null; scoreDelta?: number | null };
  assert.equal(liveTrend?.score, 100);
  assert.equal(liveTrend?.priorScore, 67);
  assert.equal(liveTrend?.scoreDelta, 33);
  // Re-running the SAME runId recomputes the identical trend (the putOnce /
  // record dedupe keeps the ledger deterministic).
  const replay = (await run("trend-replay-b", ["R1", "R2", "R3"])) as TrendRun;
  const replayTrend = replay.result.trend as { score?: number; priorScore?: number | null; scoreDelta?: number | null };
  assert.equal(replayTrend?.score, liveTrend?.score);
  assert.equal(replayTrend?.priorScore, liveTrend?.priorScore);
  assert.equal(replayTrend?.scoreDelta, liveTrend?.scoreDelta);
});

test("spec-conformance: a non-fingerprintable workspace skips the trend ledger (logged, never failed)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-trend-"));
  const runner = {
    async run(prompt: string) {
      if (prompt.includes("git rev-parse")) return { exitCode: 128, output: "fatal: not a git repository" };
      if (prompt.includes("conformance evidence auditor"))
        return { requirementId: "R1", evidence: [{ kind: "symbol", target: "R1", detail: "x:1" }] };
      if (prompt.includes("spec-conformance auditor")) return { extras: [] };
      if (prompt.includes("spec-conformance report writer")) return "report";
      return null;
    },
  };
  const result = (await runWorkflow(generateSpecConformanceWorkflow(), {
    agent: runner,
    cwd,
    persistLogs: true,
    runId: "trend-no-git",
    args: { spec: SPEC },
  })) as TrendRun;
  assert.equal(result.result.trend, null, "no fingerprint → no trend record");
  assert.ok(
    (result.logs ?? []).some((l) => l.includes("not fingerprint-able")),
    "the skip is logged, never fatal",
  );
});

// ─── Run-report trend block ───────────────────────────────────────────────────

test("buildRunReport surfaces the conformanceTrend block from the durable entries view", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dw-trend-report-"));
  const store = new DurableStore({ dir, projectKey: "trend-report", now: (s) => `t-${s}` });
  const trendRecord = {
    fingerprint: "cf69f3db",
    runId: "trend-run-x",
    score: 100,
    covered: 3,
    total: 3,
    priorScore: 67,
    scoreDelta: 33,
    regression: [],
    improvement: ["R3"],
    perRequirement: [
      { id: "R1", status: "covered" },
      { id: "R2", status: "covered" },
      { id: "R3", status: "covered" },
    ],
  };
  await store.putOnce("conformanceTrend:trend-run-x", "conformanceTrend:trend-run-x", trendRecord);

  const report = buildRunReport(
    {
      runId: "trend-run-x",
      workflowName: "spec_conformance",
      status: "completed",
      startedAt: "s",
      script: generateSpecConformanceWorkflow(),
      phases: ["Report"],
      agents: [],
      checkpoints: [],
      logs: [],
    } as never,
    { durable: store.snapshot() as { entries: Record<string, unknown>; ledger: unknown[] } },
  );
  assert.equal(report.conformanceTrend?.score, 100);
  assert.equal(report.conformanceTrend?.priorScore, 67);
  assert.equal(report.conformanceTrend?.scoreDelta, 33);
  assert.deepEqual([...(report.conformanceTrend?.improvement ?? [])], ["R3"]);
  // Absent on runs without the record (other patterns / non-fingerprintable).
  const clean = buildRunReport(
    {
      runId: "x",
      workflowName: "w",
      status: "completed",
      startedAt: "s",
      phases: [],
      agents: [],
      checkpoints: [],
      logs: [],
    } as never,
    { durable: { entries: {}, ledger: [] } },
  );
  assert.equal(clean.conformanceTrend, undefined);
  // Malformed records degrade to null, never a throw.
  await store.put("conformanceTrend:bad", "not-an-object");
  const bad = buildRunReport(
    {
      runId: "bad",
      workflowName: "w",
      status: "completed",
      startedAt: "s",
      phases: [],
      agents: [],
      checkpoints: [],
      logs: [],
    } as never,
    { durable: store.snapshot() as { entries: Record<string, unknown>; ledger: unknown[] } },
  );
  assert.equal(bad.conformanceTrend, null);
});
