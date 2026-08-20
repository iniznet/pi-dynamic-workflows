/**
 * F2 — V2-QW3 run-level total-output budget ceiling.
 *
 * A host-side accumulator caps the SUM of final agent() result chars
 * (post-P05-cap) across the whole run tree, in addition to P05's per-agent
 * cap. The pre-call gate throws OUTPUT_BUDGET_EXCEEDED once the accumulator
 * crosses the frozen `maxTotalOutputChars` ceiling (option > env > none). The
 * accumulator is journal-seeded on resume so the ceiling holds cumulatively
 * across pause/resume, and the knob is deliberately NEVER part of any agent()
 * resume identity (a journal produced with the ceiling ON replays with it OFF).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveMaxTotalOutputChars } from "../../src/config.js";
import { closeRunDurableStore, runDurableStore } from "../../src/durable-store.js";
import { WorkflowErrorCode } from "../../src/errors.js";
import type { PersistedRunState } from "../../src/run-persistence.js";
import { buildRunReport } from "../../src/run-report.js";
import type { JournalEntry } from "../../src/workflow.js";
import { countOutputChars, hashAgentCall, runWorkflow } from "../../src/workflow.js";
import { withFakeHomeAsync } from "../helpers/fake-home.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "f2-output-"));
}

/** A runner whose result length is caller-controlled, per call index. */
function lengthRunner(lengths: number[]) {
  let call = 0;
  return {
    async run() {
      const len = lengths[Math.min(call++, lengths.length - 1)] ?? 0;
      return "x".repeat(len);
    },
  };
}

// ─── ceiling resolution (option > env > none) ───────────────────────────────

test("resolveMaxTotalOutputChars: explicit value wins; env falls back; undefined is none", () => {
  assert.equal(resolveMaxTotalOutputChars(1234), 1234, "explicit positive passes through");
  assert.equal(resolveMaxTotalOutputChars(null), null, "explicit null disables the ceiling");
  assert.equal(
    resolveMaxTotalOutputChars(undefined, { PI_WORKFLOW_MAX_TOTAL_OUTPUT_CHARS: "777" }),
    777,
    "undefined falls back to the env var",
  );
  assert.equal(
    resolveMaxTotalOutputChars(undefined, { PI_WORKFLOW_MAX_TOTAL_OUTPUT_CHARS: "null" }),
    null,
    "env 'null' disables the ceiling",
  );
  assert.equal(
    resolveMaxTotalOutputChars(undefined, { PI_WORKFLOW_MAX_TOTAL_OUTPUT_CHARS: "garbage" }),
    null,
    "an unparseable env value means no ceiling",
  );
  assert.equal(resolveMaxTotalOutputChars(undefined, {}), null, "no env, no ceiling");
  assert.equal(resolveMaxTotalOutputChars(200, { PI_WORKFLOW_MAX_TOTAL_OUTPUT_CHARS: "50" }), 200, "option beats env");
});

// ─── run-level trip ─────────────────────────────────────────────────────────

test("the run-level ceiling trips OUTPUT_BUDGET_EXCEEDED at the next agent() call", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    // Ceiling 200: the FIRST agent's 200-char result exactly fills it (allowed),
    // the SECOND call is refused — the pre-call gate sees 200 >= 200.
    const script = `export const meta = { name: "f2_trip", description: "ceiling trip" }
const out = []
for (let i = 0; i < 3; i++) {
  try {
    out.push(await agent("work " + i, { label: "a" + i }))
  } catch (e) {
    out.push({ tripped: true, code: e.code, msg: e.message })
  }
}
return out`;
    const res = await runWorkflow(script, {
      agent: lengthRunner([200, 200, 200]),
      cwd,
      persistLogs: false,
      runId: "f2-trip",
      maxTotalOutputChars: 200,
    });
    const out = res.result as unknown[];
    assert.equal(typeof out[0], "string", "the first call fills the budget exactly and is allowed");
    const second = out[1] as { tripped: boolean; code: string };
    assert.equal(second.tripped, true, "the second call is refused");
    assert.equal(second.code, WorkflowErrorCode.OUTPUT_BUDGET_EXCEEDED, "the refusal carries the code");
    assert.equal((out[2] as { tripped: boolean }).tripped, true, "every later call is refused too");
    assert.equal(res.totalOutputChars, 200, "the accumulator surfaced the counted output");
    closeRunDurableStore("f2-trip");
  }));

test("the output ceiling is independent of the token budget (a token-free run still trips)", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const script = `export const meta = { name: "f2_notoken", description: "no token budget" }
const a = await agent("one", { label: "a" })
try {
  await agent("two", { label: "b" })
  return JSON.stringify({ ok: true })
} catch (e) {
  return JSON.stringify({ tripped: true, code: e.code })
}`;
    const res = await runWorkflow(script, {
      agent: lengthRunner([150, 150]),
      cwd,
      persistLogs: false,
      runId: "f2-notoken",
      maxTotalOutputChars: 150,
    });
    assert.deepEqual(JSON.parse(res.result as string), {
      tripped: true,
      code: WorkflowErrorCode.OUTPUT_BUDGET_EXCEEDED,
    });
    closeRunDurableStore("f2-notoken");
  }));

// ─── capped output counts against the run budget ────────────────────────────

test("the accumulator counts the CAPPED (post-P05) output, not the raw result", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    // Each agent returns 1_000 raw chars; the per-agent cap trims to <= 100.
    // The run ceiling (1_000) is high enough to never trip — the assertion is
    // that totalOutputChars equals the sum of the CAPPED lengths.
    const script = `export const meta = { name: "f2_capped", description: "capped counting" }
const r1 = await agent("one", { label: "a" })
const r2 = await agent("two", { label: "b" })
return [r1.length, r2.length]`;
    const res = await runWorkflow(script, {
      agent: lengthRunner([1_000, 1_000]),
      cwd,
      persistLogs: false,
      runId: "f2-capped",
      defaultMaxAgentResultChars: 100,
      maxTotalOutputChars: 1_000,
    });
    const lengths = res.result as number[];
    assert.ok(lengths[0] <= 100, "the per-agent cap trimmed the first result");
    assert.ok(lengths[1] <= 100, "the per-agent cap trimmed the second result");
    assert.equal(
      res.totalOutputChars,
      lengths[0] + lengths[1],
      "the accumulator is the sum of the capped results, not the 2_000 raw chars",
    );
    closeRunDurableStore("f2-capped");
  }));

test("countOutputChars is deterministic and counts JSON for non-string results", () => {
  assert.equal(countOutputChars("abc"), 3);
  assert.equal(countOutputChars(""), 0);
  assert.equal(countOutputChars(null), 0);
  assert.equal(countOutputChars(undefined), 0);
  assert.equal(countOutputChars({ ok: true }), JSON.stringify({ ok: true }).length);
  assert.equal(countOutputChars([1, 2]), JSON.stringify([1, 2]).length);
  assert.equal(
    countOutputChars({
      toJSON: () => {
        throw new Error("boom");
      },
    }),
    0,
    "unserializable counts 0",
  );
});

// ─── resume-hash exclusion + cumulative resume seed ─────────────────────────

test("the knob is excluded from hashAgentCall (same prompt → same identity)", () => {
  const base = {
    model: "prov/m",
    tierModel: undefined,
    phase: "exec",
    agentDefKey: null,
    mainModel: undefined,
    isolation: undefined as "worktree" | undefined,
  };
  // maxTotalOutputChars is a RUN option, not an AgentOptions field, so it is
  // structurally absent from the hash — the P05-style probe (adding an
  // agent-options key) would be the wrong tool. Instead assert the exact
  // identity is a pure function of the call inputs and stable across calls.
  const options = { label: "x" } as const;
  const first = hashAgentCall(
    "p",
    base.model,
    base.tierModel,
    base.phase,
    options,
    base.agentDefKey,
    base.mainModel,
    base.isolation,
  );
  const second = hashAgentCall(
    "p",
    base.model,
    base.tierModel,
    base.phase,
    options,
    base.agentDefKey,
    base.mainModel,
    base.isolation,
  );
  assert.equal(first, second, "call identity does not depend on any run-level budget state");
});

test("a journal produced with the ceiling ON replays with the ceiling OFF (cached results are the truth)", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    let calls = 0;
    const runner = {
      async run() {
        calls++;
        return "y".repeat(250);
      },
    };
    const journal = new Map<string, JournalEntry>();
    const script = `export const meta = { name: "f2_replay", description: "replay across knob flip" }
return [await agent("big", { label: "a" }), await agent("big2", { label: "b" })]`;
    const options = (ceiling: number | null) => ({
      agent: runner,
      cwd,
      persistLogs: false,
      runId: "f2-replay",
      maxTotalOutputChars: ceiling,
      onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? "f2-replay"}:${entry.index}`, entry),
    });

    const first = await runWorkflow(script, options(1_000));
    assert.equal(calls, 2, "first live run ran each of the two agent calls");
    assert.equal(first.totalOutputChars, 500, "two 250-char results accumulated");

    const replayed = await runWorkflow(script, { ...options(600), resumeJournal: journal });
    assert.equal(calls, 2, "the cached results replay (hash matched despite the ceiling flip 1000 → 600)");
    assert.deepEqual(
      JSON.parse(JSON.stringify(replayed.result)),
      JSON.parse(JSON.stringify(first.result)),
      "the journaled results are the replay truth",
    );
    assert.equal(
      replayed.totalOutputChars,
      500,
      "the journal seed reconstructed the pre-pause accumulator even with no live calls",
    );
    closeRunDurableStore("f2-replay");
  }));

test("the accumulator is journal-seeded on resume so the ceiling holds cumulatively", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    let calls = 0;
    const runner = {
      async run(prompt: string) {
        calls++;
        return `${prompt}-content`;
      },
    };
    const journal = new Map<string, JournalEntry>();
    const firstScript = `export const meta = { name: "f2_seed", description: "seed" }
return await agent("first", { label: "a" })`;
    await runWorkflow(firstScript, {
      agent: runner,
      cwd,
      persistLogs: false,
      runId: "f2-seed",
      maxTotalOutputChars: 100_000,
      onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? "f2-seed"}:${entry.index}`, entry),
    });
    // Seed = the first call's output length. The resumed script keeps the same
    // first call (replays, no re-accumulation) and adds two LIVE calls. The
    // ceiling is set so that WITHOUT the journal seed the live calls would
    // both fit (seed + first live = over) — proving the ceiling is cumulative.
    const seed = countOutputChars("first-content");
    const ceiling = seed + 5; // only ONE live call fits after the seed
    const resumedScript = `export const meta = { name: "f2_seed", description: "seed resume" }
await agent("first", { label: "a" })
const out = []
for (const item of ["second", "third"]) {
  try {
    out.push(await agent(item, { label: item }))
  } catch (e) {
    out.push({ tripped: true, code: e.code })
  }
}
return out`;
    const res = await runWorkflow(resumedScript, {
      agent: runner,
      cwd,
      persistLogs: false,
      runId: "f2-seed",
      maxTotalOutputChars: ceiling,
      resumeJournal: journal,
    });
    assert.equal(calls, 1 + 1, "the first call replayed, the second ran live");
    const out = res.result as unknown[];
    assert.equal(typeof out[0], "string", "the first LIVE call fit within the seeded remainder");
    assert.equal(
      (out[1] as { tripped: boolean }).tripped,
      true,
      "the second live call is refused — the seed counted the prior output",
    );
    assert.equal(
      res.totalOutputChars,
      seed + countOutputChars("second-content"),
      "the accumulator is seed + the live output that fit",
    );
    closeRunDurableStore("f2-seed");
  }));

// ─── report block ───────────────────────────────────────────────────────────

test("the run report surfaces the output budget from the durable view", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const script = `export const meta = { name: "f2_report", description: "report block" }
return await agent("work", { label: "a" })`;
    const res = await runWorkflow(script, {
      agent: lengthRunner([80]),
      cwd,
      persistLogs: false,
      runId: "f2-report",
      maxTotalOutputChars: 100,
    });
    assert.equal(res.totalOutputChars, 80, "the run result surfaces the accumulator");
    const store = runDurableStore("f2-report");
    assert.ok(store, "the run bound a durable sink");
    assert.deepEqual(store?.get("outputBudget:f2-report"), { limit: 100, spent: 80 });

    const state: PersistedRunState = {
      runId: "f2-report",
      workflowName: "f2_report",
      script,
      status: "completed",
      phases: [],
      agents: [{ id: 1, label: "a", prompt: "work", status: "done", result: "x".repeat(80), tokens: 10 }],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:01.000Z",
    };
    const report = buildRunReport(state, {
      durable: store?.snapshot() as { entries: Record<string, unknown>; ledger: unknown[] },
    });
    assert.deepEqual(report.outputBudget, { limit: 100, spent: 80 }, "the report carries the ceiling + spent");
    assert.equal(report.schemaVersion, 3);
    closeRunDurableStore("f2-report");
  }));

test("a run with no ceiling persists no output budget (report shape unchanged)", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const script = `export const meta = { name: "f2_nobudget", description: "no ceiling" }
return await agent("work", { label: "a" })`;
    await runWorkflow(script, { agent: lengthRunner([50]), cwd, persistLogs: false, runId: "f2-nobudget" });
    const store = runDurableStore("f2-nobudget");
    assert.equal(store?.get("outputBudget:f2-nobudget"), undefined, "no ceiling, no entry");
    const report = buildRunReport(
      {
        runId: "f2-nobudget",
        workflowName: "f2_nobudget",
        script: "",
        status: "completed",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:01.000Z",
      },
      { durable: store?.snapshot() as { entries: Record<string, unknown>; ledger: unknown[] } },
    );
    assert.equal(report.outputBudget, undefined, "the report block is absent for ceiling-less runs");
    closeRunDurableStore("f2-nobudget");
  }));

// ─── env channel ────────────────────────────────────────────────────────────

test("the env var applies a default ceiling when the option is omitted", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const previous = process.env.PI_WORKFLOW_MAX_TOTAL_OUTPUT_CHARS;
    process.env.PI_WORKFLOW_MAX_TOTAL_OUTPUT_CHARS = "120";
    try {
      const script = `export const meta = { name: "f2_env", description: "env ceiling" }
const a = await agent("one", { label: "a" })
try {
  await agent("two", { label: "b" })
  return JSON.stringify({ ok: true })
} catch (e) {
  return JSON.stringify({ tripped: true, code: e.code })
}`;
      const res = await runWorkflow(script, {
        agent: lengthRunner([120, 120]),
        cwd,
        persistLogs: false,
        runId: "f2-env",
      });
      assert.deepEqual(JSON.parse(res.result as string), {
        tripped: true,
        code: WorkflowErrorCode.OUTPUT_BUDGET_EXCEEDED,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.PI_WORKFLOW_MAX_TOTAL_OUTPUT_CHARS;
      } else {
        process.env.PI_WORKFLOW_MAX_TOTAL_OUTPUT_CHARS = previous;
      }
    }
    closeRunDurableStore("f2-env");
  }));
