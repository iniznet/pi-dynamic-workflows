/**
 * F2 — V2-QW5 in-script prior-run query global (`getRunReport`).
 *
 * A read-only runtime global that returns a prior run's report artifact
 * (`<runsDir>/reports/<runId>.json`) or lists recent reports newest-first —
 * letting a script seed context from a prior run's roster/phases/budget/
 * truncations before launching new work. Read-only by construction and never
 * part of any agent() resume identity (a cache-hit replay never re-reads a
 * report). Missing-file safe: an unknown runId resolves to null; the listing
 * skips malformed artifacts instead of throwing.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PersistedRunState } from "../../src/run-persistence.js";
import { listRunReports, readRunReport, writeRunReport } from "../../src/run-report.js";
import { runWorkflow } from "../../src/workflow.js";
import { workflowProjectPaths } from "../../src/workflow-paths.js";
import { withFakeHomeAsync } from "../helpers/fake-home.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "f2-report-global-"));
}

function fixtureState(
  runId: string,
  workflowName: string,
  startedAt: string,
  status: "completed" | "failed",
): PersistedRunState {
  return {
    runId,
    workflowName,
    script: `export const meta = { name: "${workflowName}", description: "fixture" }`,
    status,
    phases: ["research", "build"],
    agents: [
      {
        id: 1,
        label: "researcher",
        phase: "research",
        prompt: "p1",
        status: "done",
        result: "found things",
        tokens: 120,
      },
      { id: 2, label: "builder", phase: "build", prompt: "p2", status: "done", result: "built things", tokens: 80 },
    ],
    logs: [],
    startedAt,
    completedAt: "2024-02-01T00:00:02.000Z",
    updatedAt: "2024-02-01T00:00:02.000Z",
    tokenUsage: { input: 100, output: 100, total: 200, cost: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

// ─── host helpers (missing-file safe) ───────────────────────────────────────

test("readRunReport: missing file → null; present file → parsed report", async () => {
  const home = tempDir();
  const runsDir = workflowProjectPaths(home).runsDir;
  const report = await readRunReport(runsDir, "never-ran");
  assert.equal(report, null, "an unknown runId resolves to null, never throws");

  mkdirSync(join(runsDir, "reports"), { recursive: true });
  const written = writeRunReport(fixtureState("run-1", "prior", "2024-02-01T00:00:00.000Z", "completed"), { runsDir });
  assert.ok(written, "the fixture report was written");
  const loaded = await readRunReport(runsDir, "run-1");
  assert.ok(loaded, "the report loads back");
  assert.equal(loaded?.runId, "run-1");
  assert.equal(loaded?.agents.length, 2);
});

test("readRunReport: a malformed artifact resolves to null instead of throwing", async () => {
  const home = tempDir();
  const runsDir = workflowProjectPaths(home).runsDir;
  mkdirSync(join(runsDir, "reports"), { recursive: true });
  writeFileSync(join(runsDir, "reports", "broken.json"), "{ not json", "utf-8");
  writeFileSync(join(runsDir, "reports", "not-report.json"), JSON.stringify({ hello: 1 }), "utf-8");
  assert.equal(await readRunReport(runsDir, "broken"), null, "malformed JSON is null");
  assert.equal(await readRunReport(runsDir, "not-report"), null, "a non-report object is null");
  assert.deepEqual(await listRunReports(runsDir), [], "malformed artifacts are skipped, not listed");
});

test("listRunReports: newest-first with a stable runId tiebreak", async () => {
  const home = tempDir();
  const runsDir = workflowProjectPaths(home).runsDir;
  writeRunReport(fixtureState("run-old", "older", "2024-01-01T00:00:00.000Z", "completed"), { runsDir });
  writeRunReport(fixtureState("run-new", "newer", "2024-03-01T00:00:00.000Z", "completed"), { runsDir });
  writeRunReport(fixtureState("run-mid", "middle", "2024-02-01T00:00:00.000Z", "failed"), { runsDir });

  const rows = await listRunReports(runsDir, 2);
  assert.deepEqual(
    rows.map((r) => r.runId),
    ["run-new", "run-mid"],
    "newest-first, bounded by limit",
  );
  assert.equal(rows[0]?.workflowName, "newer");
  assert.equal(rows[0]?.status, "completed");
  assert.equal(rows[1]?.status, "failed");
  assert.ok(rows[0]?.reportPath.endsWith("run-new.json"), "the row carries the artifact path");
});

// ─── the runtime global ─────────────────────────────────────────────────────

test("getRunReport(runId) reads a prior run's report from inside a workflow script", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const home = tempDir();
    const cwd = home;
    // Seed one prior run's report under the fake home's runs dir.
    writeRunReport(fixtureState("prior-run", "seed_me", "2024-02-01T00:00:00.000Z", "completed"), {
      runsDir: workflowProjectPaths(home).runsDir,
    });

    const script = `export const meta = { name: "f2qw5_read", description: "read prior report" }
const report = await getRunReport("prior-run")
return JSON.stringify({
  found: report !== null,
  runId: report?.runId ?? null,
  name: report?.workflowName ?? null,
  agentCount: report?.agents?.length ?? 0,
  budgetSpent: report?.budget?.spent ?? null,
  phases: report?.phases?.map((p) => p.name) ?? [],
})`;
    const res = await runWorkflow(script, {
      agent: {
        async run() {
          return "ok";
        },
      },
      cwd,
      persistLogs: false,
      runId: "f2-qw5-read",
    });
    // JSON round-trip: vm-realm objects carry the vm Object prototype.
    assert.deepEqual(JSON.parse(res.result as string), {
      found: true,
      runId: "prior-run",
      name: "seed_me",
      agentCount: 2,
      budgetSpent: 200,
      phases: ["research", "build"],
    });
  }));

test("getRunReport() lists recent reports newest-first inside a workflow script", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const home = tempDir();
    const cwd = home;
    writeRunReport(fixtureState("run-a", "alpha", "2024-01-01T00:00:00.000Z", "completed"), {
      runsDir: workflowProjectPaths(home).runsDir,
    });
    writeRunReport(fixtureState("run-b", "beta", "2024-02-01T00:00:00.000Z", "failed"), {
      runsDir: workflowProjectPaths(home).runsDir,
    });

    const script = `export const meta = { name: "f2qw5_list", description: "list reports" }
const rows = await getRunReport({ limit: 10 })
return JSON.stringify(rows.map((r) => ({ runId: r.runId, name: r.workflowName, status: r.status })))`;
    const res = await runWorkflow(script, {
      agent: {
        async run() {
          return "ok";
        },
      },
      cwd,
      persistLogs: false,
      runId: "f2-qw5-list",
    });
    assert.deepEqual(JSON.parse(res.result as string), [
      { runId: "run-b", name: "beta", status: "failed" },
      { runId: "run-a", name: "alpha", status: "completed" },
    ]);
  }));

test("getRunReport is missing-file safe inside a script (unknown id → null, empty listing → [])", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const home = tempDir();
    const cwd = home;
    const script = `export const meta = { name: "f2qw5_missing", description: "missing safe" }
const single = await getRunReport("does-not-exist")
const all = await getRunReport()
return JSON.stringify({ single: single === null, listingIsArray: Array.isArray(all), empty: all.length === 0 })`;
    const res = await runWorkflow(script, {
      agent: {
        async run() {
          return "ok";
        },
      },
      cwd,
      persistLogs: false,
      runId: "f2-qw5-missing",
    });
    // JSON round-trip the script result: vm-realm objects carry the vm Object
    // prototype, which deepStrictEqual rejects.
    assert.deepEqual(JSON.parse(res.result as string), { single: true, listingIsArray: true, empty: true });
  }));

test("getRunReport is available in a nested workflow() frame (options spread carries the binding)", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const home = tempDir();
    const cwd = home;
    writeRunReport(fixtureState("prior-run", "seed_me", "2024-02-01T00:00:00.000Z", "completed"), {
      runsDir: workflowProjectPaths(home).runsDir,
    });
    // Seed a saved workflow so workflow() resolves it; the nested frame
    // inherits the parent's options (and therefore the same getRunReport
    // binding against the same project runs dir).
    const savedDir = join(workflowProjectPaths(home).rootDir, "saved");
    mkdirSync(savedDir, { recursive: true });
    writeFileSync(
      join(savedDir, "saved_child.json"),
      JSON.stringify({
        name: "saved_child",
        script: `export const meta = { name: "saved_child", description: "child" }
const report = await getRunReport("prior-run")
return report?.workflowName ?? null`,
      }),
      "utf-8",
    );
    const script = `export const meta = { name: "f2qw5_nested", description: "nested read" }
return await workflow("saved_child")`;
    const res = await runWorkflow(script, {
      agent: {
        async run() {
          return "ok";
        },
      },
      cwd,
      persistLogs: false,
      runId: "f2-qw5-nested",
      loadSavedWorkflow: (name) => {
        if (name !== "saved_child") return undefined;
        return (JSON.parse(readFileSync(join(savedDir, "saved_child.json"), "utf-8")) as { script: string }).script;
      },
    });
    assert.equal(res.result, "seed_me", "the nested frame read the prior report");
  }));
