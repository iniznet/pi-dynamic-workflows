import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { WorkflowAgent } from "../../src/agent.js";
import { generateDeepResearchWorkflow } from "../../src/deep-research.js";
import {
  closeRunDurableStore,
  createRunDurableStore,
  provenanceContentId,
  runDurableStore,
} from "../../src/durable-store.js";
import type { PersistedRunState } from "../../src/run-persistence.js";
import { buildRunReport } from "../../src/run-report.js";
import { generateSpecConformanceWorkflow } from "../../src/spec-conformance.js";
import { runWorkflow } from "../../src/workflow.js";
import { withFakeHomeAsync } from "../helpers/fake-home.js";

/**
 * F1 — V2-QW2 + V2-N5 provenance/ledger foundation.
 *
 * - V2-QW2(a): the workflow layer threads `provenancePhase` into every
 *   agent() run, and WorkflowAgent.settle records it — settle ledger records
 *   stop carrying phase:undefined.
 * - V2-QW2(b): carved phase budgets persist into the run's durable store and
 *   surface in the run report (and a resumed run's report).
 * - V2-N5: machine-gate evidence (testGate verdicts, spec-conformance
 *   per-requirement scores, claim-verify FNV-1a hashes) auto-wires into the
 *   provenance ledger with content-derived stable ids, replay byte-identical.
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "f1-provenance-"));
}

function quietRunner() {
  return {
    async run() {
      return "ok";
    },
  };
}

// ─── V2-QW2(a): provenancePhase wiring ───────────────────────────────────────

test("V2-QW2(a): agent() threads the assigned phase into the runner as provenancePhase", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const calls: Array<{ label?: string; phase?: string }> = [];
    const runner = {
      async run(_prompt: string, o?: Record<string, unknown>) {
        calls.push({
          label: o?.label as string | undefined,
          phase: o?.provenancePhase as string | undefined,
        });
        return "ok";
      },
    };
    const script = `export const meta = { name: "f1_phases", description: "phase threading", phases: [{ title: "research" }, { title: "build" }] }
phase("research")
const r1 = await agent("research task", { label: "researcher" })
phase("build")
const r2 = await agent("build task", { label: "builder" })
return [r1, r2]`;
    await runWorkflow(script, { agent: runner, persistLogs: false, runId: "f1-wiring", cwd });
    assert.deepEqual(
      calls.map((c) => [c.label, c.phase]),
      [
        ["researcher", "research"],
        ["builder", "build"],
      ],
      "each agent() call carries the phase it was assigned at call time",
    );
    closeRunDurableStore("f1-wiring");
  }));

test("V2-QW2(a): the settle ledger record carries provenancePhase (never phase:undefined)", async () => {
  const home = tempDir();
  const store = createRunDurableStore({
    runId: "f1-settle",
    projectKey: "f1-settle",
    dir: tempDir(),
    now: (s) => `t-${s}`,
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const core = createFauxCore({
        provider: "fauxtest-f1",
        models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
      });
      core.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider(core.provider, {
        name: "Faux Test",
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: core.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          reasoning: false,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow ?? 128000,
          maxTokens: m.maxTokens ?? 4096,
        })),
      });
      const registry = new ModelRegistry(runtime);
      const agent = new WorkflowAgent({ cwd: tempDir(), modelRegistry: registry, provenanceRunId: "f1-settle" });
      const outcome = await agent.run("do the thing", { label: "worker", provenancePhase: "research" });
      assert.equal(outcome, "done");
    });
    const entries = store.ledgerEntries();
    assert.equal(entries.length, 1, "the settle recorded exactly one provenance entry");
    assert.equal(entries[0]?.source, "agent");
    assert.equal(entries[0]?.agent, "worker");
    assert.equal(entries[0]?.phase, "research", "the settle record carries the provenancePhase");
    // Replaying the same settle (content identity) dedupes; a different phase
    // is a DISTINCT record — the phase is part of the identity.
    assert.equal(await store.record({ source: "agent", agent: "worker", phase: "research" }), false, "deduped");
    assert.equal(await store.record({ source: "agent", agent: "worker", phase: "build" }), true, "distinct phase");
  } finally {
    closeRunDurableStore("f1-settle");
  }
});

// ─── V2-QW2(b): persisted phase budgets ──────────────────────────────────────

test("V2-QW2(b): carved phase budgets persist, surface in the report, and survive a re-run", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const script = `export const meta = { name: "f1_budget", description: "budgets", phases: [{ title: "research" }, { title: "build" }] }
phase("research", { budget: 400 })
await agent("research task", { label: "researcher" })
phase("build", { budget: 200 })
return "ok"`;
    const first = await runWorkflow(script, { agent: quietRunner(), persistLogs: false, runId: "f1-budget", cwd });
    assert.equal(first.result, "ok");
    const store = runDurableStore("f1-budget");
    assert.ok(store, "the run bound a durable sink");
    assert.equal(store?.get("phaseBudgets:f1-budget:research"), 400, "research carve persisted");
    assert.equal(store?.get("phaseBudgets:f1-budget:build"), 200, "build carve persisted");

    // The run report surfaces the persisted ceilings from the durable view.
    const state: PersistedRunState = {
      runId: "f1-budget",
      workflowName: "f1_budget",
      script,
      status: "completed",
      phases: ["research", "build"],
      agents: [
        {
          id: 1,
          label: "researcher",
          phase: "research",
          prompt: "p",
          status: "done",
          result: "ok",
          tokens: 10,
          startedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:01.000Z",
    };
    const report = buildRunReport(state, {
      durable: store?.snapshot() as { entries: Record<string, unknown>; ledger: unknown[] },
    });
    assert.equal(report.schemaVersion, 3, "additive report schema bump");
    assert.equal(report.phases.find((p) => p.name === "research")?.budget, 400);
    assert.equal(report.phases.find((p) => p.name === "build")?.budget, 200);

    // A re-run against the same sink (resume replay) keeps the budgets intact
    // and leaves the store byte-identical.
    const file = store?.path() ?? "";
    const before = readFileSync(file, "utf-8");
    await runWorkflow(script, { agent: quietRunner(), persistLogs: false, runId: "f1-budget", cwd });
    assert.equal(runDurableStore("f1-budget")?.get("phaseBudgets:f1-budget:research"), 400);
    assert.equal(readFileSync(file, "utf-8"), before, "replay leaves the durable store byte-identical");
    closeRunDurableStore("f1-budget");
  }));

test("V2-QW2(b): a run with no declared budgets persists nothing (report shape unchanged)", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const script = `export const meta = { name: "f1_nobudget", description: "no budgets" }
phase("research")
return await agent("x", { label: "a" })`;
    await runWorkflow(script, { agent: quietRunner(), persistLogs: false, runId: "f1-nobudget", cwd });
    const store = runDurableStore("f1-nobudget");
    assert.equal(store?.get("phaseBudgets:f1-nobudget:research"), undefined, "no carve, no entry");
    closeRunDurableStore("f1-nobudget");
  }));

// ─── V2-N5: machine-gate ledger auto-wiring ──────────────────────────────────

function bashAgent(results: Record<string, unknown>) {
  return {
    async run(prompt: string, o?: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      return results[prompt] ?? { exitCode: 0, output: "unknown" };
    },
  };
}

test("V2-N5: testGate verdicts land in the ledger with content-derived ids; replay is byte-identical", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const script = `export const meta = { name: "f1_gate", description: "machine gate" }
phase("verify", { budget: 100 })
const out = await testGate(() => 'work', {
  tests: [{ command: 'npx tsc --noEmit', assert: { exitCode: 0 } }],
})
return out`;
    const agent = bashAgent({});
    const result = await runWorkflow(script, { agent, persistLogs: false, runId: "f1-gate", cwd });
    assert.equal((result.result as { ok: boolean }).ok, true);
    const store = runDurableStore("f1-gate");
    const entries = store?.ledgerEntries() ?? [];
    const gate = entries.filter((e) => e.source === "testGate");
    assert.equal(gate.length, 1, "one ledger record for the machine verdict");
    assert.equal(gate[0]?.phase, "verify", "the gate ran under the declared phase");
    assert.equal(gate[0]?.file, "npx tsc --noEmit", "the test command is the entry subject");
    assert.deepEqual(gate[0]?.detail, { passed: true, exitCode: 0, detail: "passed" });
    assert.ok(gate[0]?.id, "a content-derived id is present");
    assert.equal(
      gate[0]?.id,
      provenanceContentId({
        source: "testGate",
        phase: "verify",
        command: "npx tsc --noEmit",
        passed: true,
        exitCode: 0,
        detail: "passed",
      }),
      "the id is a deterministic content hash",
    );
    // Replay: re-running the same script against the same sink is a
    // byte-identical no-op (the pure verdict re-derives the same id).
    const file = store?.path() ?? "";
    const before = readFileSync(file, "utf-8");
    await runWorkflow(script, { agent, persistLogs: false, runId: "f1-gate", cwd });
    assert.equal(readFileSync(file, "utf-8"), before, "replay leaves the durable store byte-identical");
    closeRunDurableStore("f1-gate");
  }));

test("V2-N5: a failed testGate verdict is recorded (evidence never lost)", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const script = `export const meta = { name: "f1_gate_fail", description: "failing gate" }
const out = await testGate(() => 'work', {
  tests: [{ command: 'npm test', assert: { outputContains: 'PASS' } }],
  attempts: 1,
})
return out`;
    const agent = bashAgent({});
    const result = await runWorkflow(script, { agent, persistLogs: false, runId: "f1-gate-fail", cwd });
    assert.equal((result.result as { ok: boolean }).ok, false);
    const entries = runDurableStore("f1-gate-fail")?.ledgerEntries() ?? [];
    const gate = entries.filter((e) => e.source === "testGate");
    assert.equal(gate.length, 1);
    assert.deepEqual(gate[0]?.detail, {
      passed: false,
      exitCode: 0,
      detail: "output does not contain: PASS",
    });
    closeRunDurableStore("f1-gate-fail");
  }));

test("V2-N5: spec-conformance per-requirement scores land in the ledger with stable ids", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const agent = {
      async run(prompt: string) {
        if (prompt.includes("conformance evidence auditor")) {
          if (prompt.includes('"R1"')) {
            return {
              requirementId: "R1",
              evidence: [{ kind: "symbol", target: "increment", detail: "src/counter.js:12" }],
            };
          }
          if (prompt.includes('"R2"')) return { requirementId: "R2", evidence: [] };
        }
        if (prompt.includes("spec-conformance auditor")) return { extras: [] };
        if (prompt.includes("spec-conformance report writer")) return "report";
        return null;
      },
    };
    const spec = {
      goal: "g",
      requirements: [
        { id: "R1", statement: "increment() increases the count" },
        { id: "R2", statement: "the count survives a restart" },
      ],
    };
    const result = await runWorkflow(generateSpecConformanceWorkflow(), {
      agent,
      persistLogs: false,
      runId: "f1-spec",
      cwd,
      args: { spec },
    });
    assert.equal((result.result as { score: number }).score, 50);
    const entries = runDurableStore("f1-spec")?.ledgerEntries() ?? [];
    const scores = entries.filter((e) => e.source === "spec-conformance");
    assert.equal(scores.length, 2, "one ledger record per requirement");
    const r1 = scores.find((e) => e.file === "R1");
    assert.equal((r1?.detail as { status?: string })?.status, "covered");
    assert.equal((r1?.detail as { evidenceCount?: number })?.evidenceCount, 1);
    const r2 = scores.find((e) => e.file === "R2");
    assert.equal((r2?.detail as { status?: string })?.status, "missing");
    assert.equal((r2?.detail as { evidenceCount?: number })?.evidenceCount, 0);
    assert.match(r1?.id ?? "", /^[0-9a-f]{8}$/, "content-derived id");
    assert.notEqual(r1?.id, r2?.id, "different requirements yield different ids");
    closeRunDurableStore("f1-spec");
  }));

test("V2-N5: claim-verify FNV-1a hash envelopes land in the ledger", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const agent = {
      async run(prompt: string) {
        if (prompt.includes("planning web research")) return { queries: ["webgpu basics"] };
        if (prompt.includes("Research this query")) {
          return {
            sources: [{ url: "https://a.example/article", claims: ["The widget supports 120 FPS"] }],
          };
        }
        if (prompt.includes("fact-checking cross-checker")) {
          return {
            supported: [{ claim: "The widget supports 120 FPS", sources: ["https://a.example/article"] }],
            discarded: [],
            conflicts: [],
          };
        }
        if (prompt.includes("claim-evidence verifier")) {
          return { pages: [{ url: "https://a.example/article", content: "The widget supports 120 FPS at 4K." }] };
        }
        if (prompt.includes("well-structured research report")) return "report text";
        return null;
      },
    };
    const result = await runWorkflow(generateDeepResearchWorkflow(), {
      agent: agent as never,
      persistLogs: false,
      runId: "f1-claim",
      cwd,
      args: { question: "What is the widget refresh rate?", angles: 2, minSupport: 1 },
    });
    const verification = (result.result as { verification?: Array<{ evidenceHash: string }> }).verification ?? [];
    assert.equal(verification.length, 1);
    const entries = runDurableStore("f1-claim")?.ledgerEntries() ?? [];
    const claims = entries.filter((e) => e.source === "claim-verify");
    assert.equal(claims.length, 1, "one ledger record per verified claim");
    assert.equal(claims[0]?.phase, "Verify", "recorded under the deep-research Verify phase");
    assert.equal((claims[0]?.detail as { verified?: boolean })?.verified, true);
    assert.equal(claims[0]?.id, verification[0]?.evidenceHash, "the id IS the content-derived FNV-1a hash");
    closeRunDurableStore("f1-claim");
  }));
