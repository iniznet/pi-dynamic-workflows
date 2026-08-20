import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeRunDurableStore } from "../../../src/durable-store.js";
import { computeSpendAnalytics, readSpendLedgerEntries, spendLedgerKey } from "../../../src/spend-ledger.js";
import type { JournalEntry } from "../../../src/workflow.js";
import { runWorkflow } from "../../../src/workflow.js";
import { withFakeHomeAsync } from "../../helpers/fake-home.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "replan-ledger-test-"));
}

/** The single project durable-store file under the (fake) agent dir. */
function storeFilePath(): string {
  const dir = join(process.env.HOME ?? "", ".pi", "agent", "durable-store");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".bak"));
  assert.equal(files.length, 1, "one per-project store file");
  return join(dir, files[0] ?? "");
}

function readStoreFile(): string {
  return readFileSync(storeFilePath(), "utf-8");
}

function readStoreEntries(): Record<string, unknown> {
  const raw = JSON.parse(readStoreFile()) as { entries: Record<string, unknown> };
  return raw.entries;
}

const okAgent = {
  async run(prompt: string) {
    return prompt;
  },
};

// ─── V2-P11: budget-adaptive re-planning ─────────────────────────────────────

test("replan: the signal fires when the forecast crosses the threshold before caps trip", async () => {
  const events: Array<{ type: string; forecast?: { projectedTotal: number; budget: number | null } }> = [];
  const script = `export const meta = { name: 'replan_signal', description: 'forecast crossing' }
phase('a', { budget: 600 })
const first = replanSignal()
phase('b', { budget: 600 })
const second = replanSignal()
await agent('work', { phase: 'b' })
const third = replanSignal()
return { first, second, third }`;
  const res = await runWorkflow<{
    first: {
      triggered: boolean;
      forecast: {
        spent: number;
        plannedRemaining: number;
        projectedTotal: number;
        budget: number | null;
        threshold: number;
        overBudget: boolean;
      };
    };
    second: {
      triggered: boolean;
      forecast: {
        spent: number;
        plannedRemaining: number;
        projectedTotal: number;
        budget: number | null;
        threshold: number;
        overBudget: boolean;
      };
    };
    third: {
      triggered: boolean;
      forecast: {
        spent: number;
        plannedRemaining: number;
        projectedTotal: number;
        budget: number | null;
        threshold: number;
        overBudget: boolean;
      };
    };
  }>(script, {
    agent: okAgent,
    persistLogs: false,
    tokenBudget: 1000,
    onRuntimeEvent: (event) => events.push(event),
  });

  assert.equal(res.result.first.triggered, false, "one phase budget (600/1000) stays under the 0.9 threshold");
  assert.equal(res.result.first.forecast.plannedRemaining, 600);
  assert.equal(res.result.second.triggered, true, "two phase budgets (1200 projected) cross 900 BEFORE any agent runs");
  assert.equal(res.result.second.forecast.projectedTotal, 1200);
  assert.equal(res.result.second.forecast.overBudget, true);
  assert.equal(res.result.third.triggered, true, "the triggered state is monotonic across settles");
  const replanEvents = events.filter((event) => event.type === "replan");
  assert.equal(replanEvents.length, 1, "the re-plan event fires exactly once per run");
  assert.equal(replanEvents[0]?.forecast?.projectedTotal, 1200);
});

test("replan: the script re-scopes remaining phases and finishes without tripping caps", async () => {
  const script = `export const meta = { name: 'replan_rescope', description: 'script re-scopes' }
phase('a', { budget: 800 })
phase('b', { budget: 800 })
const signal = replanSignal()
let rescaled = false
if (signal.triggered) {
  // Re-scope: shrink the remaining plan so the projected total stays under the cap.
  phase('a', { budget: 100 })
  phase('b', { budget: 100 })
  rescaled = true
}
await agent('execute', { phase: 'b' })
const final = replanSignal()
return { rescaled, projected: final.forecast.projectedTotal, overBudget: final.forecast.overBudget, remaining: final.forecast.plannedRemaining }`;
  const res = await runWorkflow<{
    rescaled: boolean;
    projected: number;
    overBudget: boolean;
    remaining: number;
  }>(script, {
    agent: okAgent,
    persistLogs: false,
    tokenBudget: 1000,
  });
  assert.equal(res.result.rescaled, true, "the script observed the re-plan signal and re-scoped");
  assert.equal(res.result.projected, 200, "the rescoped plan projects 200 tokens — back under the 900 threshold");
  assert.equal(res.result.overBudget, false, "the rescope pulls the forecast under the budget");
  assert.ok(res.result.remaining < 200 && res.result.remaining > 0, "the remaining plan reflects the rescope");
});

test("replan: deterministic on replay (same script + journal → same signal)", async () => {
  const RUN_ID = "replan-replay";
  const journal = new Map<string, JournalEntry>();
  const options = {
    agent: okAgent,
    persistLogs: false,
    runId: RUN_ID,
    tokenBudget: 1000,
    onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry),
  };
  const script = `export const meta = { name: 'replan_replay', description: 'replay determinism' }
phase('a', { budget: 600 })
phase('b', { budget: 600 })
await agent('work', { phase: 'a' })
return replanSignal()`;
  const first = await runWorkflow<{ triggered: boolean; events: number; forecast: { projectedTotal: number } }>(
    script,
    options,
  );
  const replayed = await runWorkflow<{ triggered: boolean; events: number; forecast: { projectedTotal: number } }>(
    script,
    { ...options, resumeJournal: journal },
  );
  assert.equal(replayed.result.triggered, first.result.triggered, "the triggered value is deterministic across replay");
  assert.equal(
    replayed.result.forecast.projectedTotal,
    first.result.forecast.projectedTotal,
    "the forecast is deterministic across replay",
  );
});

test("replan: an invalid threshold falls back to the default and never breaks a run", async () => {
  for (const bad of [2, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const script = `export const meta = { name: 'replan_bad', description: 'bad threshold' }
phase('a', { budget: 500 })
return replanSignal().forecast.threshold`;
    const res = await runWorkflow<number>(script, {
      agent: okAgent,
      persistLogs: false,
      tokenBudget: 1000,
      rePlanThreshold: bad,
    });
    assert.equal(res.result, 0.9, `threshold ${String(bad)} falls back to DEFAULT_REPLAN_THRESHOLD`);
  }
});

// ─── V2-P09 (re-scoped): cross-run token ledger + analytics ──────────────────

const LEDGER_SCRIPT = `export const meta = { name: 'ledger_demo', description: 'spend ledger' }
phase('scan', { budget: 400 })
await agent('scan the codebase', { phase: 'scan' })
await agent('synthesize', { phase: 'scan' })
return 'done'`;

test("spend ledger: writes a per-run entry with token/phase/provider data", () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const runId = "ledger-run-1";
    try {
      await runWorkflow(LEDGER_SCRIPT, {
        agent: okAgent,
        cwd,
        persistLogs: false,
        runId,
        mainModel: "acme/flagship",
        tokenBudget: 10_000,
      });
      const entries = readStoreEntries();
      const value = entries[spendLedgerKey(runId)];
      assert.ok(value, "the spend-ledger entry is persisted under spendLedger:<runId>");
      const parsed = readSpendLedgerEntries(entries);
      assert.equal(parsed.length, 1);
      const entry = parsed[0];
      assert.equal(entry.runId, runId);
      assert.equal(entry.workflowName, "ledger_demo");
      assert.equal(entry.status, "completed");
      assert.equal(entry.budgetLimit, 10_000);
      assert.equal(entry.agents, 2);
      assert.ok(entry.tokenUsage.total > 0, "journaled spend is captured");
      assert.deepEqual(
        Array.from(entry.phases, (phase) => phase.name),
        ["scan"],
        "per-phase attribution lands in the ledger",
      );
      assert.ok(entry.phases[0]?.spend === entry.tokenUsage.total, "the phase spend sums to the run total");
      assert.deepEqual(
        Array.from(entry.providers, (provider) => provider.provider),
        ["acme"],
        "per-provider attribution derives from the resolved model",
      );
      assert.ok(entry.at.length > 0, "a deterministic stamp is recorded");
    } finally {
      closeRunDurableStore(runId);
    }
  }));

test("spend ledger: replay is idempotent and a resumed run replaces the stale entry", () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const runId = "ledger-run-2";
    try {
      await runWorkflow(LEDGER_SCRIPT, {
        agent: okAgent,
        cwd,
        persistLogs: false,
        runId,
        mainModel: "acme/flagship",
        tokenBudget: 10_000,
      });
      const readTotal = (): number => {
        const [entry] = readSpendLedgerEntries(readStoreEntries());
        return entry?.tokenUsage.total ?? 0;
      };
      const firstTotal = readTotal();
      assert.ok(firstTotal > 0);
      const before = readStoreFile();
      // Byte-identical replay: same runId + same script → the entry is a no-op.
      await runWorkflow(LEDGER_SCRIPT, {
        agent: okAgent,
        cwd,
        persistLogs: false,
        runId,
        mainModel: "acme/flagship",
        tokenBudget: 10_000,
      });
      assert.equal(readStoreFile(), before, "replay leaves the ledger byte-identical");
      // Resumed run: seeded cumulative spend + a fresh agent settle → the
      // entry is REPLACED (same key) with the cumulative total, never appended.
      await runWorkflow(LEDGER_SCRIPT, {
        agent: okAgent,
        cwd,
        persistLogs: false,
        runId,
        mainModel: "acme/flagship",
        tokenBudget: 10_000,
        initialTokenUsage: { input: 100, output: 50, total: 150, cost: 0.01, cacheRead: 0, cacheWrite: 0 },
        initialFreshSpend: 150,
      });
      const secondTotal = readTotal();
      assert.ok(secondTotal > firstTotal, "the resumed run's cumulative total replaces the stale entry");
      const entries = readSpendLedgerEntries(readStoreEntries());
      assert.equal(entries.length, 1, "one entry per runId — the ledger is a map, never a growing list");
    } finally {
      closeRunDurableStore(runId);
    }
  }));

test("spend analytics: aggregates totals/per-phase/per-pattern/per-provider + trend", () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const runOptions = (runId: string, model: string, budget: number) => ({
      agent: okAgent,
      cwd,
      persistLogs: false,
      runId,
      mainModel: model,
      tokenBudget: budget,
    });
    try {
      await runWorkflow(
        `export const meta = { name: 'alpha_pattern', description: 'a' }
phase('p1', { budget: 100 })
await agent('a1', { phase: 'p1' })
await agent('a2', { phase: 'p1' })
return 'ok'`,
        runOptions("agg-run-1", "acme/flagship", 1000),
      );
      await runWorkflow(
        `export const meta = { name: 'beta_pattern', description: 'b' }
phase('p1', { budget: 100 })
await agent('b1', { phase: 'p1' })
return 'ok'`,
        runOptions("agg-run-2", "zeta/model-z", 500),
      );
      await runWorkflow(
        `export const meta = { name: 'alpha_pattern', description: 'a2' }
await agent('a3')
return 'ok'`,
        runOptions("agg-run-3", "acme/flagship", 1000),
      );

      const analytics = computeSpendAnalytics(cwd);
      assert.equal(analytics.runCount, 3);
      assert.ok(analytics.totals.total > 0, "totals aggregate the journaled spend");
      assert.equal(analytics.totals.agents, 4, "2 + 1 + 1 agent calls");

      const alpha = analytics.perPattern.find((row) => row.name === "alpha_pattern");
      const beta = analytics.perPattern.find((row) => row.name === "beta_pattern");
      assert.ok(alpha && beta);
      assert.equal(alpha.runs, 2);
      assert.equal(beta.runs, 1);
      assert.equal(alpha.spend + beta.spend, analytics.totals.total, "per-pattern sums to the total");

      const p1 = analytics.perPhase.find((row) => row.name === "p1");
      assert.ok(p1, "per-phase analytics exist");
      assert.equal(p1.runs, 2, "two runs spent in phase p1");

      const acme = analytics.perProvider.find((row) => row.name === "acme");
      const zeta = analytics.perProvider.find((row) => row.name === "zeta");
      assert.ok(acme && zeta, "per-provider analytics derive from the resolved models");
      assert.equal(acme.spend + zeta.spend, analytics.totals.total, "per-provider sums to the total");

      assert.equal(analytics.trend.length, 3, "one trend row per run");
      // Newest-first: the deterministic stamp is constant per runId, so the
      // runId (time-ordered) tiebreak decides — reverse insertion order.
      assert.equal(analytics.trend[0]?.runId, "agg-run-3");
      assert.equal(analytics.trend[2]?.runId, "agg-run-1");

      // Idempotent analytics: a second computation over the same ledger is
      // byte-identical (pure function of the persisted entries).
      const again = computeSpendAnalytics(cwd);
      assert.deepEqual(again, analytics);
    } finally {
      closeRunDurableStore("agg-run-1");
      closeRunDurableStore("agg-run-2");
      closeRunDurableStore("agg-run-3");
    }
  }));

test("spend analytics: the spendAnalytics global reads cross-run aggregates in-script", () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    try {
      await runWorkflow(
        `export const meta = { name: 'ledger_demo', description: 'seed run' }
await agent('seed work')
return 'ok'`,
        { agent: okAgent, cwd, persistLogs: false, runId: "global-seed", mainModel: "acme/flagship" },
      );
      const script = `export const meta = { name: 'ledger_query', description: 'query run' }
const stats = await spendAnalytics()
return { runCount: stats.runCount, perProvider: stats.perProvider, totals: stats.totals.total }`;
      const res = await runWorkflow<{
        runCount: number;
        perProvider: Array<{ name: string; spend: number }>;
        totals: number;
      }>(script, { agent: okAgent, cwd, persistLogs: false, runId: "global-query", mainModel: "acme/flagship" });
      assert.equal(res.result.runCount, 1, "the query sees the seed run (its own ledger entry lands after settle)");
      assert.deepEqual(
        Array.from(res.result.perProvider, (row) => row.name),
        ["acme"],
      );
      assert.ok(res.result.totals > 0);
      // After the run settles, the query run's own entry lands in the ledger.
      const after = computeSpendAnalytics(cwd);
      assert.equal(after.runCount, 2, "the settled query run appends its own ledger entry");
    } finally {
      closeRunDurableStore("global-seed");
      closeRunDurableStore("global-query");
    }
  }));
