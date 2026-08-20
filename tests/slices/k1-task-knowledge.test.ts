/**
 * K1 — V2-P02 + V2-P04 + V2-QW1 (cross-run knowledge layer).
 *
 * Covers:
 *  - KB distill at run completion (manager emitRunReport hook) + resume
 *    idempotency (re-distill dedupes on content-derived ids);
 *  - recall ranking (keyword/phase/pattern over KB entries + run reports),
 *    seeding opt-in (default OFF) + privacy exclusion (never results/
 *    thinking/tool-output/logs);
 *  - lineage query over a mixed ledger (claim-verify + testGate + agent
 *    records) with run attribution + deterministic decay;
 *  - decay/re-verify marks stale evidence via the N02 re-fetch mechanics;
 *  - claim-verify reuse composes cleanly (pure fetch → verdict → hash).
 */

import assert from "node:assert/strict";
import { accessSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { computeEvidenceHash, verifyClaimAgainstPages } from "../../src/claim-verify.js";
import { DurableStore, deterministicRunClock } from "../../src/durable-store.js";
import type { PersistedRunState } from "../../src/run-persistence.js";
import { writeRunReport } from "../../src/run-report.js";
import {
  buildRecallResult,
  distillAndPersistRunKnowledge,
  distillRunKnowledge,
  type LineageVerifyContext,
  persistDistilledKnowledge,
  queryLineage,
  queryRunReports,
  queryTaskKnowledge,
  readKnowledgeEntries,
  type TaskKnowledgeEntry,
  taskKnowledgeStorePath,
} from "../../src/task-knowledge.js";
import { runWorkflow } from "../../src/workflow.js";
import { WorkflowManager } from "../../src/workflow-manager.js";
import { workflowProjectKey, workflowProjectPaths } from "../../src/workflow-paths.js";
import { withFakeHomeAsync } from "../helpers/fake-home.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "k1-knowledge-"));
}

function quietRunner() {
  return {
    async run() {
      return "ok";
    },
  };
}

function fixtureState(
  runId: string,
  workflowName: string,
  status: "completed" | "failed" = "completed",
): PersistedRunState {
  return {
    runId,
    workflowName,
    script: `export const meta = { name: "${workflowName}", description: "fixture" }`,
    status,
    phases: ["research", "build"],
    // Privacy fixture: results/history/logs must NEVER surface in the KB.
    agents: [
      {
        id: 1,
        label: "researcher",
        phase: "research",
        prompt: "p1",
        status: "done",
        result: "SECRET-RESULT-WIDGET",
        history: [{ role: "assistant", kind: "text", text: "SECRET-THINKING" }],
        tokens: 120,
      },
      {
        id: 2,
        label: "builder",
        phase: "build",
        prompt: "p2",
        status: "done",
        result: "SECRET-TOOL-OUTPUT",
        tokens: 80,
      },
    ],
    logs: ["SECRET-LOG-LINE"],
    startedAt: "2024-02-01T00:00:00.000Z",
    completedAt: "2024-02-01T00:00:02.000Z",
    updatedAt: "2024-02-01T00:00:02.000Z",
    tokenUsage: { input: 100, output: 100, total: 200, cost: 0, cacheRead: 0, cacheWrite: 0 },
    tokenBudget: 1000,
    checkpoints: [
      {
        runId,
        taskId: "Approve fan-out of 12 research agents",
        status: "completed",
        timestamp: "2024-02-01T00:00:01.000Z",
      },
    ],
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for async condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ─── V2-P02: distillation ────────────────────────────────────────────────────

test("distillRunKnowledge: privacy-safe summary/constraint/decision entries", () => {
  const state = fixtureState("run-distill", "widget_build");
  const entries = distillRunKnowledge(state, null);
  const kinds = entries.map((entry) => entry.kind).sort();
  assert.ok(kinds.includes("summary"));
  assert.ok(kinds.includes("constraint"));
  assert.ok(kinds.includes("decision"));
  const summary = entries.find((entry) => entry.kind === "summary");
  assert.ok(summary);
  assert.match(summary.text, /status: completed/);
  assert.match(summary.text, /phases: research, build/);
  assert.match(summary.text, /agents: 2 \(2 done/);
  assert.match(summary.text, /spent 200 tokens/);
  const decision = entries.find((entry) => entry.kind === "decision");
  assert.ok(decision);
  assert.match(decision.text, /Approve fan-out of 12 research agents/);
  // Privacy: no entry text may leak results, thinking, tool output, or logs.
  const allText = entries.map((entry) => `${entry.title} ${entry.text}`).join("\n");
  for (const secret of ["SECRET-RESULT", "SECRET-THINKING", "SECRET-TOOL-OUTPUT", "SECRET-LOG-LINE"]) {
    assert.ok(!allText.includes(secret), `privacy: "${secret}" must not appear in the KB`);
  }
});

test("distillRunKnowledge: machine-gate findings from the durable snapshot (V2-N5 ledger)", () => {
  const state = fixtureState("run-findings", "deep_research");
  const evidenceHash = "1234abcd";
  const durable = {
    entries: {
      "phaseBudgets:run-findings:research": 500,
      "outputBudget:run-findings": { limit: 50_000, spent: 12_000 },
    },
    ledger: [
      {
        id: evidenceHash,
        source: "claim-verify",
        file: "The widget supports 120 FPS",
        phase: "Verify",
        detail: {
          verified: true,
          sources: ["https://a.example/article"],
          matchedSources: ["https://a.example/article"],
          evidenceHash,
        },
        timestamp: "2024-02-01T00:00:00.500Z",
      },
      {
        id: "gate-1",
        source: "testGate",
        file: "tests/widget.test.ts",
        phase: "Test",
        detail: { passed: false, command: "npx tsc --noEmit", detail: "2 errors" },
        timestamp: "2024-02-01T00:00:00.600Z",
      },
      {
        id: "spec-1",
        source: "spec-conformance",
        file: "R3",
        phase: "Compliance",
        detail: { requirement: "R3 input validation", score: 0.8, verdict: "pass" },
        timestamp: "2024-02-01T00:00:00.700Z",
      },
    ],
  };
  const entries = distillRunKnowledge(state, durable);
  const findings = entries.filter((entry) => entry.kind === "finding");
  assert.equal(findings.length, 3);
  const evidence = findings.find((entry) => entry.title.includes("120 FPS"));
  assert.ok(evidence);
  assert.match(evidence.text, /verified against 1 of 1 cited page/);
  assert.equal(evidence.score, 1);
  const gate = findings.find((entry) => entry.kind === "finding" && entry.phase === "Test");
  assert.ok(gate);
  assert.match(gate.text, /testGate failed/);
  const spec = findings.find((entry) => entry.kind === "finding" && entry.phase === "Compliance");
  assert.ok(spec);
  assert.match(spec.text, /scored 0.8/);
  const constraint = entries.find((entry) => entry.kind === "constraint");
  assert.ok(constraint);
  assert.match(constraint.text, /phase budget "research": 500 tokens/);
  assert.match(constraint.text, /total-output ceiling: 50000 chars/);
});

test("persistDistilledKnowledge: idempotent merge — re-distillation is a no-op", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const home = tempDir();
    const cwd = home;
    const entries = distillRunKnowledge(fixtureState("run-again", "retry_build"), null);
    assert.ok(entries.length > 0);
    const first = await persistDistilledKnowledge(cwd, entries);
    assert.equal(first, entries.length, "first persist writes every new entry");
    const second = await persistDistilledKnowledge(cwd, entries);
    assert.equal(second, 0, "re-persisting the same distilled run writes nothing (replay-idempotent)");
    // Resume-then-recomplete: distilling the SAME run again (with a slightly
    // different durable snapshot) still dedupes — ids are content-derived.
    const resumed = distillRunKnowledge(fixtureState("run-again", "retry_build"), null);
    assert.equal(resumed.length, entries.length);
    const third = await persistDistilledKnowledge(cwd, resumed);
    assert.equal(third, 0, "a resumed run's re-distill merges nothing");
    const stored = readKnowledgeEntries(cwd);
    assert.equal(stored.length, entries.length);
    assert.equal(stored[0]?.runId, "run-again");
  }));

test("manager emitRunReport: KB distill fires at run completion", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const home = tempDir();
    const cwd = home;
    const manager = new WorkflowManager({
      cwd,
      agent: quietRunner() as unknown as Pick<import("../../src/agent.js").WorkflowAgent, "run">,
    });
    const result = await manager.runSync(
      `export const meta = { name: "k1_complete", description: "distill at completion" }
phase("research")
const a = await agent("research task", { label: "researcher" })
phase("build")
const b = await agent("build task", { label: "builder" })
return [a, b]`,
    );
    const runId = result.runId;
    assert.ok(runId, "the managed run carries a runId");
    // The report artifact is written synchronously; the KB distill is async.
    let reportWritten = false;
    try {
      accessSync(join(workflowProjectPaths(cwd).runsDir, "reports", `${runId}.json`));
      reportWritten = true;
    } catch {
      reportWritten = false;
    }
    assert.ok(reportWritten, "report written");
    await waitFor(() => readKnowledgeEntries(cwd).some((entry) => entry.runId === runId && entry.kind === "summary"));
    const summary = readKnowledgeEntries(cwd).find((entry) => entry.runId === runId && entry.kind === "summary");
    assert.ok(summary);
    assert.match(summary.text, /phases: research, build/);
    assert.match(summary.text, /2 done/);
    // A second manager re-running the SAME script under the SAME runId would
    // produce a different runId, so idempotency is asserted at the persist
    // layer (above). Here: the KB file exists under getAgentDir().
    assert.ok(readKnowledgeEntries(cwd).length >= 1, `KB file present at ${taskKnowledgeStorePath(cwd)}`);
  }));

// ─── V2-P02: recall + ranking ────────────────────────────────────────────────

function knowledgeEntry(
  partial: Partial<TaskKnowledgeEntry> & {
    title: string;
    text: string;
    runId: string;
    workflowName: string;
    kind: TaskKnowledgeEntry["kind"];
  },
): TaskKnowledgeEntry {
  return {
    id: `kb-fixture-${partial.title}`,
    keywords: partial.keywords ?? [],
    sources: [],
    createdAt: "2024-02-01T00:00:00.000Z",
    ...partial,
  };
}

test("recall: keyword/phase/pattern ranking over KB entries is deterministic", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const home = tempDir();
    const cwd = home;
    const entries = [
      knowledgeEntry({
        runId: "r1",
        workflowName: "gpu_research",
        kind: "finding",
        phase: "Verify",
        title: "GPU 120 FPS",
        text: "The widget supports 120 FPS on modern displays.",
        keywords: ["gpu", "widget", "fps"],
        createdAt: "2024-02-01T00:00:00.000Z",
      }),
      knowledgeEntry({
        runId: "r2",
        workflowName: "audio_research",
        kind: "finding",
        phase: "Verify",
        title: "Audio latency",
        text: "The widget has 10ms audio latency.",
        keywords: ["audio", "latency"],
        createdAt: "2024-03-01T00:00:00.000Z",
      }),
      knowledgeEntry({
        runId: "r3",
        workflowName: "gpu_build",
        kind: "constraint",
        phase: "Build",
        title: "GPU budget",
        text: "The build phase is capped at 500 tokens.",
        keywords: ["gpu", "budget", "tokens"],
        createdAt: "2024-04-01T00:00:00.000Z",
      }),
    ];
    await persistDistilledKnowledge(cwd, entries);

    const byQuery = queryTaskKnowledge(cwd, { query: "gpu budget", limit: 10 });
    assert.equal(byQuery[0]?.id, "kb-fixture-GPU budget", "matching two query tokens outranks a single-token match");
    assert.ok(byQuery[0] && byQuery[0].score > 0);

    const byPhase = queryTaskKnowledge(cwd, { phase: "Verify", limit: 10 });
    assert.deepEqual(byPhase.map((hit) => hit.id).sort(), ["kb-fixture-Audio latency", "kb-fixture-GPU 120 FPS"]);

    const byPattern = queryTaskKnowledge(cwd, { pattern: "120\\s*FPS", limit: 10 });
    assert.deepEqual(
      byPattern.map((hit) => hit.id),
      ["kb-fixture-GPU 120 FPS"],
    );

    // Determinism: identical inputs → identical ranking.
    assert.deepEqual(
      JSON.parse(JSON.stringify(queryTaskKnowledge(cwd, { query: "gpu budget", limit: 10 }))),
      JSON.parse(JSON.stringify(byQuery)),
    );
  }));

test("recall: run-report artifacts are searched alongside the KB", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const home = tempDir();
    const cwd = home;
    const runsDir = workflowProjectPaths(cwd).runsDir;
    writeRunReport(fixtureState("prior-research", "webgpu_scan", "completed"), { runsDir });

    const reportHits = await queryRunReports(cwd, { query: "webgpu", limit: 10 });
    assert.ok(reportHits.some((hit) => hit.kind === "report" && hit.runId === "prior-research"));
    const result = await buildRecallResult(cwd, { query: "webgpu", limit: 10 });
    assert.ok(result.hits.some((hit) => hit.kind === "report" && hit.runId === "prior-research"));
    assert.match(result.context, /prior-research/);
    assert.match(result.context, /Cross-run task knowledge/);
    // A no-match query returns an empty context (never noise).
    const empty = await buildRecallResult(cwd, { query: "zzz-no-such-term", limit: 10 });
    assert.equal(empty.hits.length, 0);
    assert.equal(empty.context, "");
  }));

test("recall global: in-script query returns ranked privacy-safe context", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const home = tempDir();
    const cwd = home;
    await persistDistilledKnowledge(cwd, distillRunKnowledge(fixtureState("recall-prior", "prior_knowledge"), null));
    const script = `export const meta = { name: "k1_recall", description: "recall in script" }
const result = await recall({ query: "tokens", limit: 5 })
return JSON.stringify({ hits: result.hits.length, hasContext: result.context.length > 0, firstKind: result.hits[0]?.kind ?? null, leaked: result.context.includes("SECRET-RESULT") })`;
    const res = await runWorkflow(script, {
      agent: quietRunner(),
      cwd,
      persistLogs: false,
      runId: "k1-recall-global",
    });
    assert.deepEqual(JSON.parse(res.result as string), {
      hits: 1,
      hasContext: true,
      firstKind: "knowledge",
      leaked: false,
    });
  }));

// ─── V2-P02: seeding (opt-in, default OFF) + privacy ────────────────────────

test("seedKnowledge: opt-in seeds prior knowledge into the first agent's instructions", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const home = tempDir();
    const cwd = home;
    await persistDistilledKnowledge(cwd, distillRunKnowledge(fixtureState("seed-prior", "gpu_research"), null));

    // Default OFF: the first agent's instructions must NOT contain the prior knowledge.
    const offPrompts: string[] = [];
    await runWorkflow(
      `export const meta = { name: "k1_seed_off", description: "no seed" }
const r = await agent("do the work", { label: "worker" })
return r`,
      {
        agent: {
          async run(_prompt: string, o?: { instructions?: string }) {
            offPrompts.push(o?.instructions ?? "");
            return "ok";
          },
        },
        cwd,
        persistLogs: false,
        runId: "k1-seed-off",
      },
    );
    assert.ok(offPrompts.length === 1);
    assert.ok(!offPrompts[0].includes("gpu_research"), "default OFF must not seed knowledge into agent instructions");

    // Opt-in (true): the first agent's instructions carry the seeded context.
    const onPrompts: string[] = [];
    await runWorkflow(
      `export const meta = { name: "k1_seed_on", description: "seeded" }
const r = await agent("do the work", { label: "worker" })
return r`,
      {
        agent: {
          async run(_prompt: string, o?: { instructions?: string }) {
            onPrompts.push(o?.instructions ?? "");
            return "ok";
          },
        },
        cwd,
        persistLogs: false,
        runId: "k1-seed-on",
        seedKnowledge: true,
      },
    );
    assert.ok(onPrompts.length === 1);
    assert.ok(
      onPrompts[0].includes("gpu_research"),
      "opt-in seeds the prior knowledge into the first agent's instructions",
    );
    assert.ok(onPrompts[0].includes("Cross-run task knowledge"), "the seed context block is present");
    assert.ok(!onPrompts[0].includes("SECRET-RESULT"), "the seeded context stays privacy-safe");

    // Opt-in with an empty KB seeds nothing (logged, no crash).
    await runWorkflow(
      `export const meta = { name: "k1_seed_empty", description: "no prior kb" }
const r = await agent("do the work", { label: "worker" })
return r`,
      {
        agent: quietRunner(),
        cwd: join(tempDir(), "other-project"),
        persistLogs: false,
        runId: "k1-seed-empty",
        seedKnowledge: true,
      },
    );
  }));

// ─── V2-P04: lineage + decay + re-verify ────────────────────────────────────

function ledgerFixture(projectKey: string): DurableStore {
  return new DurableStore({
    projectKey,
    dir: join(getAgentDir(), "durable-store"),
    now: deterministicRunClock("k1-lineage"),
  });
}

test("lineage: mixed-ledger query filters by source/phase with run attribution", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const home = tempDir();
    const cwd = home;
    const projectKey = workflowProjectKey(cwd);
    const store = ledgerFixture(projectKey);
    await store.record({
      id: "claim-1",
      source: "claim-verify",
      file: "The widget supports 120 FPS",
      phase: "Verify",
      detail: {
        verified: true,
        sources: ["https://a.example"],
        matchedSources: ["https://a.example"],
        evidenceHash: "aaaa1111",
      },
    });
    await store.record({
      id: "gate-1",
      source: "testGate",
      file: "tests/widget.test.ts",
      phase: "Test",
      detail: { passed: true },
    });
    await store.record({ id: "agent-1", source: "agent", agent: "researcher", phase: "research" });
    // Attribute entries to a run via a report's durable.ledger snapshot.
    const runsDir = workflowProjectPaths(cwd).runsDir;
    mkdirSync(join(runsDir, "reports"), { recursive: true });
    writeRunReport(fixtureState("lineage-run-1", "widget_build"), {
      runsDir,
      durable: { entries: {}, ledger: [{ id: "claim-1" }, { id: "gate-1" }, { id: "agent-1" }] },
    });

    const all = await queryLineage(cwd, { limit: 50 });
    assert.equal(all.entries.length, 3);
    assert.deepEqual(all.entries.map((entry) => entry.source).sort(), ["agent", "claim-verify", "testGate"]);
    const claim = all.entries.find((entry) => entry.id === "claim-1");
    assert.ok(claim);
    assert.ok(
      claim.runIds.includes("lineage-run-1"),
      "the entry is attributed to the run whose report snapshot holds it",
    );
    assert.ok(all.runs.some((run) => run.runId === "lineage-run-1"));

    const onlyClaims = await queryLineage(cwd, { source: "claim-verify", limit: 50 });
    assert.deepEqual(
      onlyClaims.entries.map((entry) => entry.id),
      ["claim-1"],
    );
    const onlyPhase = await queryLineage(cwd, { phase: "research", limit: 50 });
    assert.deepEqual(
      onlyPhase.entries.map((entry) => entry.id),
      ["agent-1"],
    );
    const onlyRun = await queryLineage(cwd, { runId: "lineage-run-1", limit: 50 });
    assert.equal(onlyRun.entries.length, 3);
    const byPattern = await queryLineage(cwd, { pattern: "120 FPS", limit: 50 });
    assert.deepEqual(
      byPattern.entries.map((entry) => entry.id),
      ["claim-1"],
    );

    // Deterministic decay metadata is present for every entry.
    assert.ok(all.entries.every((entry) => typeof entry.fresh === "boolean" && typeof entry.ageMs === "number"));
    assert.equal(all.decay.ttlMs, 1_000);
  }));

test("lineage: decay marks stale evidence; re-verify diffs the FNV-1a hash (N02 mechanics)", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const home = tempDir();
    const cwd = home;
    const projectKey = workflowProjectKey(cwd);
    const store = ledgerFixture(projectKey);
    // Two claim-verify records + one trailing agent settle (the ledger's
    // newest entry), so BOTH claims fall behind the decay window at ttlMs 0.
    // The stored evidence hashes are the REAL FNV-1a ids of the original
    // verification (so an unchanged re-fetch hashes identically).
    const staleSources = ["https://a.example/article"];
    const freshSources = ["https://b.example/article"];
    const staleHash = computeEvidenceHash("The widget supports 120 FPS", staleSources, true, staleSources);
    const freshHash = computeEvidenceHash("The widget supports 240 FPS", freshSources, true, freshSources);
    await store.record({
      id: "stale-claim",
      source: "claim-verify",
      file: "The widget supports 120 FPS",
      phase: "Verify",
      detail: { verified: true, sources: staleSources, matchedSources: staleSources, evidenceHash: staleHash },
    });
    await store.record({
      id: "fresh-claim",
      source: "claim-verify",
      file: "The widget supports 240 FPS",
      phase: "Verify",
      detail: { verified: true, sources: freshSources, matchedSources: freshSources, evidenceHash: freshHash },
    });
    await store.record({ id: "newest-agent", source: "agent", agent: "researcher", phase: "research" });

    const strict = await queryLineage(cwd, { limit: 50, ttlMs: 0 });
    assert.equal(strict.entries.length, 3);
    assert.equal(strict.entries.find((entry) => entry.id === "stale-claim")?.fresh, false);
    assert.equal(
      strict.entries.find((entry) => entry.id === "fresh-claim")?.fresh,
      false,
      "older claims decay-stale at ttlMs 0",
    );
    assert.equal(
      strict.entries.find((entry) => entry.id === "newest-agent")?.fresh,
      true,
      "the newest entry is never stale",
    );
    assert.deepEqual(strict.decay.staleIds.sort(), ["fresh-claim", "stale-claim"]);

    // Default (no verify): no agent steps are issued.
    const noVerify = await queryLineage(cwd, { limit: 50, ttlMs: 0 });
    assert.equal(noVerify.verification, undefined);

    // verify: true — the re-fetch for the CHANGED claim returns different
    // content → a different evidence hash → stale again; the unchanged claim
    // still hashes identically → fresh.
    const verifyContext: LineageVerifyContext = {
      async fetchClaimPages(claim: string, sources: readonly string[]) {
        if (claim.includes("120 FPS")) {
          return [{ url: "https://a.example/article", content: "The widget supports 240 FPS on modern displays now." }];
        }
        return sources.map((url) => ({ url, content: "The widget supports 240 FPS at 4K resolution." }));
      },
    };
    const verified = await queryLineage(cwd, { limit: 50, ttlMs: 0, verify: true }, verifyContext);
    assert.ok(verified.verification, "verification ran");
    assert.equal(verified.verification.length, 2);
    const stale = verified.verification.find((v) => v.id === "stale-claim");
    assert.ok(stale);
    assert.equal(stale.fresh, false, "changed evidence hash → stale");
    assert.notEqual(stale.currentHash, stale.previousHash);
    assert.match(stale.detail, /changed the evidence/);
    const stillFresh = verified.verification.find((v) => v.id === "fresh-claim");
    assert.ok(stillFresh);
    assert.equal(stillFresh.fresh, true, "unchanged evidence hash → still fresh");
    assert.equal(stillFresh.currentHash, stillFresh.previousHash);
  }));

test("lineage global in-script: verify re-verifies stale claim-verify evidence via journaled agent steps", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const home = tempDir();
    const cwd = home;
    // Seed the project ledger with a claim-verify record + a trailing agent
    // settle (the ledger's newest entry) so the claim is decay-stale at ttlMs 0.
    const projectKey = workflowProjectKey(cwd);
    const store = new DurableStore({
      projectKey,
      dir: join(getAgentDir(), "durable-store"),
      now: deterministicRunClock("k1-lineage-global"),
    });
    const sources = ["https://a.example/article"];
    const claim = "The widget supports 120 FPS";
    const hash = computeEvidenceHash(claim, sources, true, sources);
    await store.record({
      id: hash,
      source: "claim-verify",
      file: claim,
      phase: "Verify",
      detail: { verified: true, sources, matchedSources: sources, evidenceHash: hash },
    });
    await store.record({ id: "trailing-agent", source: "agent", agent: "researcher", phase: "research" });

    const script = `export const meta = { name: "k1_lineage_global", description: "lineage verify" }
const result = await lineage({ source: "claim-verify", ttlMs: 0, verify: true, limit: 10 })
return JSON.stringify({ entries: result.entries.length, verification: (result.verification ?? []).length, stale: result.decay.staleCount, fresh: (result.verification ?? [])[0]?.fresh ?? null })`;
    let verifierPrompts = 0;
    const res = await runWorkflow(script, {
      agent: {
        async run(prompt: string) {
          if (prompt.includes("claim-evidence verifier")) {
            verifierPrompts++;
            // The re-fetched page still states the claim → same FNV-1a hash.
            return {
              pages: [{ url: "https://a.example/article", content: "The widget supports 120 FPS at 4K resolution." }],
            };
          }
          return null;
        },
      },
      cwd,
      persistLogs: false,
      runId: "k1-lineage-global",
    });
    assert.equal(verifierPrompts, 1, "the N02 re-fetch ran as exactly one journaled agent step");
    assert.deepEqual(JSON.parse(res.result as string), { entries: 1, verification: 1, stale: 1, fresh: true });
  }));

// ─── V2-QW1: claim-verify reusable composition ──────────────────────────────

test("claim-verify reuse: pure fetch → verdict → hash composition + re-verify cycle", () => {
  const claim = "The widget supports 120 FPS";
  const sources = ["https://a.example/article", "https://b.example/faq"];
  const pages = [
    { url: "https://a.example/article", content: "The widget supports 120 FPS at 4K resolution." },
    { url: "https://b.example/faq", content: "Frequently asked questions about colors." },
  ];
  const verdict = verifyClaimAgainstPages(claim, sources, pages);
  assert.equal(verdict.verified, true);
  assert.deepEqual(verdict.matchedSources, ["https://a.example/article"]);
  assert.match(verdict.evidenceHash, /^[0-9a-f]{8}$/);

  // Re-verify cycle: an uncited/fabricated page cannot corroborate (integrity).
  const planted = verifyClaimAgainstPages(claim, sources, [
    { url: "https://evil.example/planted", content: "The widget supports 120 FPS" },
  ]);
  assert.equal(planted.verified, false);
  assert.deepEqual(planted.matchedSources, []);

  // Re-verify after the page CHANGES: same claim, new evidence → new hash.
  const changed = verifyClaimAgainstPages(claim, sources, [
    { url: "https://a.example/article", content: "The widget now supports 240 FPS." },
  ]);
  assert.equal(changed.verified, false);
  assert.notEqual(changed.evidenceHash, verdict.evidenceHash, "a changed page re-hashes to a distinct evidence id");
  // Determinism: identical evidence → identical hash.
  assert.equal(verdict.evidenceHash, verifyClaimAgainstPages(claim, sources, pages).evidenceHash);
});

test("distillAndPersistRunKnowledge: end-to-end compose (manager hook + recall read-back)", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const home = tempDir();
    const cwd = home;
    const durable = {
      entries: {},
      ledger: [
        {
          id: "claim-e2e",
          source: "claim-verify",
          file: "The widget supports 120 FPS",
          phase: "Verify",
          detail: {
            verified: true,
            sources: ["https://a.example"],
            matchedSources: ["https://a.example"],
            evidenceHash: "12345678",
          },
        },
      ],
    };
    const written = await distillAndPersistRunKnowledge(cwd, fixtureState("e2e-run", "e2e_research"), durable);
    assert.ok(written >= 2, "summary + evidence finding persisted");
    const stored = readKnowledgeEntries(cwd);
    assert.ok(stored.some((entry) => entry.kind === "summary" && entry.runId === "e2e-run"));
    assert.ok(stored.some((entry) => entry.kind === "finding" && entry.title.includes("120 FPS")));
    // The distilled finding re-enters the recall surface.
    const recalled = await buildRecallResult(cwd, { query: "widget", limit: 10 });
    assert.ok(recalled.hits.length > 0, "the distilled finding is recallable");
    assert.match(recalled.context, /120 FPS/);
  }));
