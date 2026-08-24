import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { WorkflowError, WorkflowErrorCode } from "../../../src/errors.js";
import {
  createModelCrosschecker,
  type ModelCrosschecker,
  parseCrosscheckVerdict,
  resolveModelForCrosscheck,
} from "../../../src/model-crosscheck.js";
import { type JournalEntry, runWorkflow } from "../../../src/workflow.js";

/**
 * W2 P09 — distinctModel multi-model cross-check for verify() / consensus() /
 * judgePanel(). The cross-checker is injected (ModelRuntime-backed in
 * production; fakes here); the judge pass is a normal agent() call pinned to
 * the distinct model (hashAgentCall model/tierModel fields carry it).
 */

const crosscheckerOf = (replies: Record<string, string | null>): ModelCrosschecker => ({
  async ask(_question: string, modelSpec: string) {
    return replies[modelSpec] ?? null;
  },
});

// ─── parseCrosscheckVerdict unit ─────────────────────────────────────────────

test("parseCrosscheckVerdict: lenient TRUE/FALSE word parsing", () => {
  assert.equal(parseCrosscheckVerdict("TRUE: the claim holds"), true);
  assert.equal(parseCrosscheckVerdict("FALSE: not convinced"), false);
  assert.equal(parseCrosscheckVerdict(" true "), true);
  assert.equal(parseCrosscheckVerdict("yes, definitely true here"), true);
  assert.equal(parseCrosscheckVerdict("false positive claim"), false);
  assert.equal(parseCrosscheckVerdict("true, though a false caveat follows"), true, "first occurrence wins");
  assert.equal(parseCrosscheckVerdict("uncertain"), null);
  assert.equal(parseCrosscheckVerdict(""), null);
  assert.equal(parseCrosscheckVerdict(null), null);
  assert.equal(parseCrosscheckVerdict(undefined), null);
});

test("resolveModelForCrosscheck: provider/id split, bare-id fallback, unknown → undefined", () => {
  const runtime = {
    getModel: (provider: string, id: string) => (provider === "prov" && id === "second" ? { provider, id } : undefined),
    getModels: () => [
      { provider: "other", id: "bare-model" },
      { provider: "prov", id: "second" },
    ],
  } as unknown as ModelRuntime;

  assert.equal(resolveModelForCrosscheck(runtime, "prov/second")?.id, "second");
  assert.equal(resolveModelForCrosscheck(runtime, "bare-model")?.provider, "other", "bare id searches all providers");
  assert.equal(resolveModelForCrosscheck(runtime, "nope/missing"), undefined);
});

test("createModelCrosschecker: wraps completeSimple, parses the reply, tolerates failures", async () => {
  const complete = async () => ({ content: [{ type: "text", text: "  FALSE: disagree  " }] });
  const runtime = {
    getModel: () => ({ provider: "prov", id: "second" }),
    getModels: () => [],
    completeSimple: complete,
  } as unknown as ModelRuntime;
  const checker = createModelCrosschecker({ runtime, timeoutMs: 1000 });

  assert.equal(await checker.ask("q", "prov/second"), "FALSE: disagree");
  // Unknown model → unavailable (null), never a throw.
  const missing = {
    getModel: () => undefined,
    getModels: () => [],
    completeSimple: complete,
  } as unknown as ModelRuntime;
  const checkerMissing = createModelCrosschecker({ runtime: missing, timeoutMs: 1000 });
  assert.equal(await checkerMissing.ask("q", "prov/second"), null);
  // Throwing runtime → unavailable (null).
  const throwing = {
    getModel: () => ({ provider: "prov", id: "second" }),
    getModels: () => [],
    completeSimple: async () => {
      throw new Error("auth");
    },
  } as unknown as ModelRuntime;
  const checkerThrowing = createModelCrosschecker({ runtime: throwing, timeoutMs: 1000 });
  assert.equal(await checkerThrowing.ask("q", "prov/second"), null);
});

// ─── verify + distinctModel ──────────────────────────────────────────────────

const verifyReviewers = (real: boolean) => ({
  async run(_prompt: string, o?: { schema?: unknown }) {
    return o?.schema ? { real, reason: "reviewer" } : "ok";
  },
});

test("verify + distinctModel: agreement leaves the primary verdict and reports the cross-check", async () => {
  const cross = crosscheckerOf({ "prov/second": "TRUE: correct" });
  const script = `export const meta = { name: 'xc_agree', description: 'cross-check agrees' }
const r = await verify('claim', { reviewers: 2, distinctModel: 'prov/second' })
return r`;
  const res = await runWorkflow<{
    real: boolean;
    realCount: number;
    total: number;
    crossCheck?: { model: string; verdict: boolean; agreement: boolean; judged: boolean };
  }>(script, { agent: verifyReviewers(true), modelCrosschecker: cross, persistLogs: false });

  assert.equal(res.result.real, true);
  assert.equal(res.result.realCount, 2);
  assert.equal(res.result.crossCheck?.model, "prov/second");
  assert.equal(res.result.crossCheck?.verdict, true);
  assert.equal(res.result.crossCheck?.agreement, true);
  assert.equal(res.result.crossCheck?.judged, false);
});

test("verify + distinctModel: disagreement triggers a judge pass whose ruling becomes real", async () => {
  let schemaCalls = 0;
  const agent = {
    async run(_prompt: string, o?: { schema?: unknown; model?: string }) {
      if (!o?.schema) return "ok";
      schemaCalls++;
      if (o.model) return { verdict: !/it is NOT real/.test(_prompt), reason: "judge" };
      return { real: true, reason: "reviewer" };
    },
  };
  const cross = crosscheckerOf({ "prov/second": "FALSE: not convinced" });
  const script = `export const meta = { name: 'xc_judge', description: 'judge adjudicates' }
const r = await verify('claim', { reviewers: 2, distinctModel: 'prov/second' })
return r`;
  const res = await runWorkflow<{
    real: boolean;
    crossCheck?: { agreement: boolean; judged: boolean; judge?: { verdict: boolean; reason?: string } };
  }>(script, { agent, modelCrosschecker: cross, persistLogs: false });

  assert.equal(res.result.real, false, "the judge's ruling becomes the final verdict");
  assert.equal(res.result.crossCheck?.agreement, false);
  assert.equal(res.result.crossCheck?.judged, true);
  assert.equal(res.result.crossCheck?.judge?.verdict, false);
  assert.equal(schemaCalls, 3, "2 reviewers + 1 judge pass — the cross-check itself costs no agent call");
});

test("verify + distinctModel: the judge pass carries the distinct model (joins hashAgentCall model/tierModel)", async () => {
  let judgeModel: string | undefined;
  const agent = {
    async run(_prompt: string, o?: { schema?: unknown; model?: string }) {
      if (!o?.schema) return "ok";
      if (o.model) {
        judgeModel = o.model;
        return { verdict: false };
      }
      return { real: true };
    },
  };
  await runWorkflow(
    `export const meta = { name: 'xc_model', description: 'model pin' }
await verify('claim', { reviewers: 1, distinctModel: 'prov/second' })`,
    { agent, modelCrosschecker: crosscheckerOf({ "prov/second": "FALSE: no" }), persistLogs: false },
  );
  assert.equal(judgeModel, "prov/second", "the judge agent() call is pinned to the distinct model");
});

test("verify + distinctModel: unavailable second model falls back gracefully (logged, no crossCheck block)", async () => {
  const logs: string[] = [];
  const script = `export const meta = { name: 'xc_fallback', description: 'unavailable fallback' }
const r = await verify('claim', { reviewers: 2, distinctModel: 'prov/dead' })
return r`;
  const res = await runWorkflow<{ real: boolean; realCount: number; crossCheck?: unknown }>(script, {
    agent: verifyReviewers(true),
    modelCrosschecker: crosscheckerOf({}),
    persistLogs: false,
    onLog: (message) => logs.push(message),
  });

  assert.equal(res.result.real, true, "the primary verdict is returned unchanged");
  assert.equal(res.result.crossCheck, undefined, "no cross-check block when the second model is unavailable");
  assert.ok(
    logs.some((line) => line.includes("falling back to the primary verdict")),
    "the skip is logged",
  );
});

test("verify + distinctModel: a judge-pass failure (MODEL_NOT_FOUND) is flagged, never fatal", async () => {
  const logs: string[] = [];
  const agent = {
    async run(_prompt: string, o?: { schema?: unknown; model?: string }) {
      if (!o?.schema) return "ok";
      if (o.model) {
        throw new WorkflowError("prov/second is not available", WorkflowErrorCode.MODEL_NOT_FOUND, {
          recoverable: false,
        });
      }
      return { real: true };
    },
  };
  const script = `export const meta = { name: 'xc_judgefail', description: 'judge omitted' }
const r = await verify('claim', { reviewers: 2, distinctModel: 'prov/second' })
return r`;
  const res = await runWorkflow<{
    real: boolean;
    crossCheck?: { agreement: boolean; judged: boolean };
  }>(script, {
    agent,
    modelCrosschecker: crosscheckerOf({ "prov/second": "FALSE: no" }),
    persistLogs: false,
    onLog: (m) => logs.push(m),
  });

  assert.equal(res.result.real, true, "the primary verdict stands when the judge cannot run");
  assert.equal(res.result.crossCheck?.agreement, false, "the disagreement stays flagged");
  assert.equal(res.result.crossCheck?.judged, false, "no judge ruling");
  assert.ok(
    logs.some((line) => line.includes("judge omitted (MODEL_NOT_FOUND)")),
    "the omission is logged",
  );
});

test("verify without distinctModel: the crosschecker is never consulted", async () => {
  let asked = 0;
  const cross: ModelCrosschecker = {
    async ask() {
      asked++;
      return "TRUE";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'xc_off', description: 'no distinct model' }
await verify('claim', { reviewers: 1 })`,
    { agent: verifyReviewers(true), modelCrosschecker: cross, persistLogs: false },
  );
  assert.equal(asked, 0, "backward-compatible: no distinctModel → no cross-check");
});

// ─── consensus + distinctModel ───────────────────────────────────────────────

test("consensus + distinctModel: agreement keeps the panel outcome and reports the cross-check", async () => {
  const script = `export const meta = { name: 'xc_c_agree', description: 'consensus agrees' }
const r = await consensus('the sky is blue', { panelists: 3, distinctModel: 'prov/second' })
return r`;
  const res = await runWorkflow<{
    agreed: boolean;
    verdict: boolean | null;
    crossCheck?: { agreement: boolean; judged: boolean; verdict: boolean };
  }>(script, {
    agent: {
      async run(_prompt: string, o?: { schema?: unknown }) {
        return o?.schema ? { verdict: true } : "ok";
      },
    },
    modelCrosschecker: crosscheckerOf({ "prov/second": "TRUE: agree" }),
    persistLogs: false,
  });

  assert.equal(res.result.agreed, true);
  assert.equal(res.result.verdict, true);
  assert.equal(res.result.crossCheck?.agreement, true);
  assert.equal(res.result.crossCheck?.judged, false);
});

test("consensus + distinctModel: a split panel's disagreement is adjudicated by the judge pass", async () => {
  let n = 0;
  const agent = {
    async run(_prompt: string, o?: { schema?: unknown; model?: string }) {
      if (!o?.schema) return "ok";
      if (o.model) return { verdict: false, reason: "judge disagrees" };
      n++;
      // 2 true / 1 false with threshold 1.0 → never agreed; majority side true.
      return { verdict: n !== 2 };
    },
  };
  const script = `export const meta = { name: 'xc_c_judge', description: 'consensus adjudicated' }
const r = await consensus('split?', { panelists: 3, rounds: 2, agreeThreshold: 1, distinctModel: 'prov/second' })
return r`;
  const res = await runWorkflow<{
    agreed: boolean;
    verdict: boolean | null;
    count: number;
    total: number;
    crossCheck?: { agreement: boolean; judged: boolean; judge?: { verdict: boolean } };
  }>(script, { agent, modelCrosschecker: crosscheckerOf({ "prov/second": "FALSE: disagree" }), persistLogs: false });

  assert.equal(res.result.agreed, true, "the judge pass adjudicates the split");
  assert.equal(res.result.verdict, false, "the judge's ruling is the final verdict");
  assert.equal(res.result.count, 0, "the panel itself never reached the gate");
  assert.equal(res.result.total, 3);
  assert.equal(res.result.crossCheck?.agreement, false);
  assert.equal(res.result.crossCheck?.judged, true);
  assert.equal(res.result.crossCheck?.judge?.verdict, false);
});

test("consensus + distinctModel: unavailable second model degrades to the panel outcome", async () => {
  const logs: string[] = [];
  const script = `export const meta = { name: 'xc_c_fallback', description: 'consensus fallback' }
const r = await consensus('the sky is blue', { panelists: 2, distinctModel: 'prov/dead' })
return r`;
  const res = await runWorkflow<{ agreed: boolean; crossCheck?: unknown }>(script, {
    agent: {
      async run(_prompt: string, o?: { schema?: unknown }) {
        return o?.schema ? { verdict: true } : "ok";
      },
    },
    modelCrosschecker: crosscheckerOf({}),
    persistLogs: false,
    onLog: (m) => logs.push(m),
  });

  assert.equal(res.result.agreed, true);
  assert.equal(res.result.crossCheck, undefined);
  assert.ok(logs.some((line) => line.includes("falling back to the primary verdict")));
});

// ─── judgePanel + distinctModel ──────────────────────────────────────────────

const judgePanelScorer = (scores: number[]) => ({
  async run(_prompt: string, o?: { schema?: unknown }) {
    if (!o?.schema) return "ok";
    if (/WIN/.test(_prompt)) return { score: scores[0] };
    if (/ALTERNATIVE/.test(_prompt)) return { score: scores[1] };
    return { score: 0.5 };
  },
});

test("judgePanel + distinctModel: agreement keeps the panel's winner with a cross-check report", async () => {
  const script = `export const meta = { name: 'xc_j_agree', description: 'panel agrees' }
const r = await judgePanel(['WIN candidate', 'ALTERNATIVE loser'], { judges: 1, distinctModel: 'prov/second' })
return r`;
  const res = await runWorkflow<{
    index: number;
    crossCheck?: { agreement: boolean; judged: boolean };
  }>(script, {
    agent: judgePanelScorer([0.9, 0.1]),
    modelCrosschecker: crosscheckerOf({ "prov/second": "TRUE: the panel is right" }),
    persistLogs: false,
  });

  assert.equal(res.result.index, 0, "the panel's winner stands");
  assert.equal(res.result.crossCheck?.agreement, true);
  assert.equal(res.result.crossCheck?.judged, false);
});

test("judgePanel + distinctModel: disagreement lets the top-2 judge pass override the winner", async () => {
  let judgeModel: string | undefined;
  const agent = {
    async run(_prompt: string, o?: { schema?: unknown; model?: string }) {
      if (!o?.schema) return "ok";
      if (o.model) {
        judgeModel = o.model;
        return { pick: 1, reason: "the alternative is better" };
      }
      return /WIN/.test(_prompt) ? { score: 0.9 } : { score: 0.1 };
    },
  };
  const script = `export const meta = { name: 'xc_j_override', description: 'judge overrides' }
const r = await judgePanel(['WIN candidate', 'ALTERNATIVE loser'], { judges: 1, distinctModel: 'prov/second' })
return { index: r.index, attempt: r.attempt, crossCheck: r.crossCheck }`;
  const res = await runWorkflow<{
    index: number;
    attempt: string;
    crossCheck?: { agreement: boolean; judged: boolean; judge?: { verdict: boolean; reason?: string } };
  }>(script, {
    agent,
    modelCrosschecker: crosscheckerOf({ "prov/second": "FALSE: the panel picked the wrong candidate" }),
    persistLogs: false,
  });

  assert.equal(res.result.index, 1, "the judge's pick (alternative) replaces the panel's winner");
  assert.equal(res.result.attempt, "ALTERNATIVE loser");
  assert.equal(judgeModel, "prov/second", "the judge pass is pinned to the distinct model");
  assert.equal(res.result.crossCheck?.judged, true);
  assert.equal(res.result.crossCheck?.judge?.verdict, false, "judge.verdict false = the alternative won");
});

test("judgePanel + distinctModel: unavailable second model keeps the panel's pick", async () => {
  const logs: string[] = [];
  const script = `export const meta = { name: 'xc_j_fallback', description: 'panel fallback' }
const r = await judgePanel(['WIN candidate', 'ALTERNATIVE loser'], { judges: 1, distinctModel: 'prov/dead' })
return { index: r.index, crossCheck: r.crossCheck ?? null }`;
  const res = await runWorkflow<{ index: number; crossCheck: unknown }>(script, {
    agent: judgePanelScorer([0.9, 0.1]),
    modelCrosschecker: crosscheckerOf({}),
    persistLogs: false,
    onLog: (m) => logs.push(m),
  });

  assert.equal(res.result.index, 0);
  assert.equal(res.result.crossCheck, null);
  assert.ok(logs.some((line) => line.includes("falling back to the primary verdict")));
});

test("judgePanel + distinctModel: a one-candidate panel skips the cross-check entirely", async () => {
  let asked = 0;
  const cross: ModelCrosschecker = {
    async ask() {
      asked++;
      return "FALSE";
    },
  };
  const script = `export const meta = { name: 'xc_j_single', description: 'single candidate' }
const r = await judgePanel(['only'], { judges: 1, distinctModel: 'prov/second' })
return r`;
  const res = await runWorkflow<{ index: number; crossCheck?: unknown }>(script, {
    agent: judgePanelScorer([0.5]),
    modelCrosschecker: cross,
    persistLogs: false,
  });

  assert.equal(res.result.index, 0);
  assert.equal(res.result.crossCheck, undefined, "no alternative candidate → no cross-check");
  assert.equal(asked, 0);
});

// ─── accounting: economy tier is never double-charged ────────────────────────

test("distinctModel: the cross-check adds zero agent calls (no run double-charge)", async () => {
  const runnerWithCount = () => {
    let schemaCalls = 0;
    return {
      schemaCalls: () => schemaCalls,
      async run(_prompt: string, o?: { schema?: unknown }) {
        if (!o?.schema) return "ok";
        schemaCalls++;
        return { real: true, verdict: true, score: 1, reason: "mock" };
      },
    };
  };
  const agreement = runnerWithCount();
  await runWorkflow(
    `export const meta = { name: 'xc_cost_agree', description: 'agreement cost' }
await verify('claim', { reviewers: 3, distinctModel: 'prov/second' })
await consensus('q', { panelists: 2, distinctModel: 'prov/second' })
await judgePanel(['a', 'b'], { judges: 1, distinctModel: 'prov/second' })`,
    {
      agent: agreement,
      modelCrosschecker: crosscheckerOf({ "prov/second": "TRUE" }),
      persistLogs: false,
    },
  );
  assert.equal(agreement.schemaCalls(), 3 + 2 + 2, "only the primary votes/judges are agent() calls");
});

// ─── DS-1: journaled cross-check (resume determinism + off-ledger budget) ────

const DS1_RUN = "ds1-crosscheck-run";

function ds1Journal(): Map<string, JournalEntry> {
  return new Map<string, JournalEntry>();
}

test("distinctModel: a resumed run replays the journaled cross-check (no live re-ask, no branch flip)", async () => {
  let asks = 0;
  const cross: ModelCrosschecker = {
    async ask() {
      asks++;
      return "FALSE: not convinced";
    },
  };
  let schemaCalls = 0;
  const agent = {
    async run(_prompt: string, o?: { schema?: unknown; model?: string }) {
      if (!o?.schema) return "ok";
      schemaCalls++;
      if (o.model) return { verdict: false, reason: "judge" };
      return { real: true, reason: "reviewer" };
    },
  };
  const journal = ds1Journal();
  const base = {
    agent,
    modelCrosschecker: cross,
    persistLogs: false,
    runId: DS1_RUN,
    onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? DS1_RUN}:${entry.index}`, entry),
  };
  const script = `export const meta = { name: 'ds1_resume', description: 'journaled cross-check resume' }
const r = await verify('claim', { reviewers: 2, distinctModel: 'prov/second' })
return r`;

  const first = await runWorkflow<{
    real: boolean;
    crossCheck?: { agreement: boolean; judged: boolean };
  }>(script, base);
  assert.equal(first.result.real, false, "the judge's ruling becomes the final verdict");
  assert.equal(first.result.crossCheck?.agreement, false);
  assert.equal(first.result.crossCheck?.judged, true);
  assert.equal(asks, 1, "first run asks the second model live");
  const schemaCallsAfterFirst = schemaCalls; // 2 reviewers + 1 judge = 3

  const resumed = await runWorkflow<{
    real: boolean;
    crossCheck?: { agreement: boolean; judged: boolean };
  }>(script, { ...base, resumeJournal: journal });
  assert.equal(asks, 1, "resume replays the journaled cross-check reply — no live re-ask");
  assert.equal(schemaCalls, schemaCallsAfterFirst, "the judge pass replays from the journal too");
  assert.equal(resumed.result.real, first.result.real, "byte-identical outcome on resume");
  assert.equal(resumed.result.crossCheck?.agreement, first.result.crossCheck?.agreement);
  assert.equal(resumed.result.crossCheck?.judged, first.result.crossCheck?.judged);
});

test("distinctModel: a resumed run replays an unavailable cross-check (null reply journaled)", async () => {
  let asks = 0;
  const cross: ModelCrosschecker = {
    async ask() {
      asks++;
      return null; // second model unavailable on the live run
    },
  };
  const journal = ds1Journal();
  const base = {
    agent: verifyReviewers(true),
    modelCrosschecker: cross,
    persistLogs: false,
    runId: `${DS1_RUN}-fallback`,
    onAgentJournal: (entry: JournalEntry) =>
      journal.set(`${entry.runId ?? `${DS1_RUN}-fallback`}:${entry.index}`, entry),
  };
  const script = `export const meta = { name: 'ds1_resume_null', description: 'null cross-check resume' }
const r = await verify('claim', { reviewers: 2, distinctModel: 'prov/dead' })
return r`;

  const first = await runWorkflow<{ real: boolean; crossCheck?: unknown }>(script, base);
  assert.equal(first.result.crossCheck, undefined, "unavailable second model falls back to the primary verdict");
  assert.equal(asks, 1);

  const resumed = await runWorkflow<{ real: boolean; crossCheck?: unknown }>(script, {
    ...base,
    resumeJournal: journal,
  });
  assert.equal(asks, 1, "the journaled null reply replays — no re-ask on resume");
  assert.equal(resumed.result.real, first.result.real);
  assert.equal(resumed.result.crossCheck, first.result.crossCheck);
});

test("distinctModel: the journaled cross-check participates in the resume journal but never bills the ledger", async () => {
  const agentEnds: string[] = [];
  const journal = ds1Journal();
  const script = `export const meta = { name: 'ds1_budget', description: 'journaled, not billed' }
await verify('claim', { reviewers: 2, distinctModel: 'prov/second' })
return 'done'`;
  const res = await runWorkflow(script, {
    agent: verifyReviewers(true),
    modelCrosschecker: crosscheckerOf({ "prov/second": "TRUE" }),
    persistLogs: false,
    onAgentEnd: (event) => agentEnds.push(event.label),
    onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? DS1_RUN}:${entry.index}`, entry),
  });
  assert.equal(res.result, "done");
  // 2 reviewers + 1 journaled cross-check ask = 3 journal entries. The ask
  // must be journaled (deterministic replay) but must NEVER feed the ledger:
  // onAgentEnd fires once per billing agent (the budget gate's only feed), and
  // the cross-check ask is not an agent() call, so it adds no event and no
  // spend — the run ledger sees only the primary votes.
  assert.ok(journal.size >= 3, "reviewers + journaled cross-check ask are all journaled");
  assert.equal(agentEnds.length, 2, "only the 2 primary reviewers bill — the cross-check adds no agent, no spend");
});

test("distinctModel: quality events emit crosscheck start/end around the second-model pass", async () => {
  const events: string[] = [];
  await runWorkflow(
    `export const meta = { name: 'xc_evt', description: 'crosscheck events' }
await verify('claim', { reviewers: 1, distinctModel: 'prov/second' })`,
    {
      agent: verifyReviewers(true),
      modelCrosschecker: crosscheckerOf({ "prov/second": "TRUE" }),
      persistLogs: false,
      onRuntimeEvent: (event) => {
        if (event.type === "quality") events.push(`${event.helper}:${event.stage}`);
      },
    },
  );
  assert.deepEqual(events, ["verify:start", "crosscheck:start", "crosscheck:end", "verify:end"]);
});
