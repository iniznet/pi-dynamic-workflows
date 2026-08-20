/**
 * Slice H2 tests — V2-P05 multi-model panel builtin.
 *
 * The pattern must: fan the SAME task across N distinct resolved models
 * concurrently (per-model agent() calls journaled + resumable, model in
 * hashAgentCall); enforce distinctness MACHINE-side (dedupe on the base spec,
 * caps per mode); judge the panel compare-not-merge into a structured envelope
 * (the judge never merges — the caller writes the final answer); and in act
 * mode run ONE reconciling actor against the untrusted reference verdicts.
 * The embedded distinctness normalizer must behave identically to the TS
 * reference (parity), and a mid-run resume replays completed panel verdicts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  basePanelModelSpec,
  generateMultiModelPanelWorkflow,
  normalizePanelModelSpecs,
  PANEL_MAX_MODELS_ACT,
  PANEL_MAX_MODELS_COMPARE,
  PANEL_MIN_MODELS_COMPARE,
  panelMode,
  panelModelSpecsSource,
} from "../../../src/multi-model-panel.js";
import type { JournalEntry } from "../../../src/workflow.js";
import { parseWorkflowScript, runWorkflow } from "../../../src/workflow.js";

const RUN_ID = "multi-model-run";

// ─── Normalizer reference ─────────────────────────────────────────────────────

test("normalizePanelModelSpecs enforces distinct membership deterministically", () => {
  // Compare mode: distinct specs survive in input order.
  assert.deepEqual(normalizePanelModelSpecs(["a/b", "c/d", "e/f"], "compare"), ["a/b", "c/d", "e/f"]);
  // Duplicates are deduped first-wins.
  assert.deepEqual(normalizePanelModelSpecs(["a/b", "a/b", "c/d"], "compare"), ["a/b", "c/d"]);
  // A :thinking suffix is the same base model — never a second member.
  assert.deepEqual(normalizePanelModelSpecs(["a/b", "a/b:high", "c/d"], "compare"), ["a/b", "c/d"]);
  // Non-strings / blanks are dropped; a non-array degrades to [].
  assert.deepEqual(normalizePanelModelSpecs(["a/b", "", 42, null, "  "], "compare"), ["a/b"]);
  assert.deepEqual(normalizePanelModelSpecs(null, "compare"), []);
  assert.deepEqual(normalizePanelModelSpecs("nope", "compare"), []);
  // Mode caps: compare 2-8, act 1-4.
  assert.equal(PANEL_MIN_MODELS_COMPARE, 2);
  assert.equal(PANEL_MAX_MODELS_COMPARE, 8);
  assert.equal(PANEL_MAX_MODELS_ACT, 4);
  const many = Array.from({ length: 20 }, (_, i) => `p${i}/m${i}`);
  assert.equal(normalizePanelModelSpecs(many, "compare").length, 8, "compare mode caps at 8");
  assert.equal(normalizePanelModelSpecs(many, "act").length, 4, "act mode caps at 4");
});

test("basePanelModelSpec strips only real thinking levels", () => {
  assert.equal(basePanelModelSpec("a/b:high"), "a/b");
  assert.equal(basePanelModelSpec("a/b"), "a/b");
  assert.equal(basePanelModelSpec("a/b:off"), "a/b");
  // A colon that is not a thinking level stays (the model id contains it).
  assert.equal(basePanelModelSpec("openrouter/vendor/model"), "openrouter/vendor/model");
  assert.equal(basePanelModelSpec("a/b:nope"), "a/b:nope");
});

test("panelMode resolves compare/act with a compare default", () => {
  assert.equal(panelMode("act"), "act");
  assert.equal(panelMode("compare"), "compare");
  assert.equal(panelMode(undefined), "compare");
  assert.equal(panelMode("whatever"), "compare");
});

test("the vm-embedded panel normalizer behaves identically to the TS reference", () => {
  const embedded = vm.runInNewContext(`${panelModelSpecsSource()}\nnormalizePanelModels`) as (
    raw: unknown,
    mode: string,
  ) => unknown;
  const fixtures: Array<{ raw: unknown; mode: string }> = [
    { raw: ["a/b", "c/d"], mode: "compare" },
    { raw: ["a/b", "a/b", "c/d"], mode: "compare" },
    { raw: ["a/b:high", "a/b", "c/d"], mode: "compare" },
    { raw: ["a/b", "", 42, null], mode: "act" },
    { raw: null, mode: "compare" },
    { raw: "garbage", mode: "act" },
    { raw: Array.from({ length: 12 }, (_, i) => `p${i}/m${i}`), mode: "compare" },
    { raw: Array.from({ length: 12 }, (_, i) => `p${i}/m${i}`), mode: "act" },
  ];
  for (const { raw, mode } of fixtures) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(embedded(raw, mode))),
      normalizePanelModelSpecs(raw, mode === "act" ? "act" : "compare"),
      `parity mismatch for ${JSON.stringify(raw)} in ${mode} mode`,
    );
  }
});

// ─── Generated script surface ─────────────────────────────────────────────────

test("multi-model declares the Panel/Judge/Act phases and the compare-not-merge contract", () => {
  const { meta, body } = parseWorkflowScript(generateMultiModelPanelWorkflow());
  assert.equal(meta.name, "multi_model_panel");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Panel", "Judge", "Act"],
  );
  assert.match(body, /label: 'panel ' \+ \(i \+ 1\), model: m/);
  assert.match(body, /label: 'judge', model: judgeModel/);
  assert.match(body, /compareNotMerge: true/);
  assert.match(body, /callerWritesFinal: true/);
  assert.match(body, /DO NOT MERGE/);
  assert.match(body, /label: 'actor'/);
});

// ─── Runtime: compare mode (compare-not-merge) ────────────────────────────────

const compareRunner = {
  async run(prompt: string) {
    if (prompt.includes("judge of a multi-model review panel")) {
      return {
        perModel: [
          { model: "anthropic/claude-sonnet-4", verdict: "yes with caveats", confidence: 0.8 },
          { model: "openrouter/deepseek/x", verdict: "no — blocking risk", confidence: 0.6 },
        ],
        consensus: ["the design is not final"],
        contradictions: ["the retry loop is acceptable vs a blocking risk"],
        coverage: ["api shape", "retry semantics"],
        blindSpots: ["error paths were not deeply covered"],
        insights: ["backoff may be unbounded"],
        recommendation: "caller decides; fix the retry bound first",
      };
    }
    if (prompt.includes("multi-model review panel")) {
      if (prompt.includes("is this design sound")) {
        return {
          conclusion: "yes with caveats",
          reasoning: "the interface is clean",
          confidence: 0.8,
          coverage: ["api shape"],
          insights: ["could reuse the existing sink"],
          blindSpots: ["error paths"],
          caveats: [],
        };
      }
      return {
        conclusion: "no — blocking risk",
        reasoning: "the retry loop can starve",
        confidence: 0.6,
        coverage: ["retry semantics"],
        insights: ["backoff is unbounded"],
        blindSpots: [],
        caveats: ["timing assumptions"],
      };
    }
    return null;
  },
};

test("multi-model compare: distinct verdicts stay distinct, the judge envelope never merges", async () => {
  const prompts: string[] = [];
  let panelCalls = 0;
  const result = await runWorkflow(generateMultiModelPanelWorkflow(), {
    agent: {
      async run(prompt: string) {
        prompts.push(prompt);
        // The judge prompt also contains the phrase "multi-model review panel",
        // so the judge check runs BEFORE the panel member check.
        if (prompt.includes("judge of a multi-model review panel")) {
          return {
            perModel: [
              { model: "anthropic/claude-sonnet-4", verdict: "yes with caveats", confidence: 0.8 },
              { model: "openrouter/deepseek/x", verdict: "no — blocking risk", confidence: 0.6 },
            ],
            consensus: ["the design is not final"],
            contradictions: ["the retry loop is acceptable vs a blocking risk"],
            coverage: ["api shape", "retry semantics"],
            blindSpots: ["error paths were not deeply covered"],
            insights: ["backoff may be unbounded"],
            recommendation: "caller decides; fix the retry bound first",
          };
        }
        if (prompt.includes("multi-model review panel")) {
          panelCalls += 1;
          // Both members receive the SAME task text; the runner differentiates
          // them by call order (the per-member prompts are identical).
          return panelCalls === 1
            ? {
                conclusion: "yes with caveats",
                reasoning: "the interface is clean",
                confidence: 0.8,
                coverage: ["api shape"],
                insights: ["could reuse the existing sink"],
                blindSpots: ["error paths"],
                caveats: [],
              }
            : {
                conclusion: "no — blocking risk",
                reasoning: "the retry loop can starve",
                confidence: 0.6,
                coverage: ["retry semantics"],
                insights: ["backoff is unbounded"],
                blindSpots: [],
                caveats: ["timing assumptions"],
              };
        }
        return null;
      },
    },
    persistLogs: false,
    args: {
      task: "is this design sound?",
      models: ["anthropic/claude-sonnet-4", "openrouter/deepseek/x"],
      mode: "compare",
    },
  });

  const r = result.result as {
    mode?: string;
    panel?: string[];
    verdicts?: Array<{ conclusion?: string; confidence?: number }>;
    envelope?: { perModel?: Array<{ model: string; verdict: string }>; contradictions?: string[] };
    actor?: unknown;
    compareNotMerge?: boolean;
    callerWritesFinal?: boolean;
  };
  assert.equal(r.mode, "compare");
  assert.deepEqual([...(r.panel ?? [])], ["anthropic/claude-sonnet-4", "openrouter/deepseek/x"]);
  assert.equal(r.compareNotMerge, true);
  assert.equal(r.callerWritesFinal, true, "the caller writes the final answer — the judge never merges");
  // Two DISTINCT verdicts survive (not averaged/merged).
  const verdicts = [...(r.verdicts ?? [])];
  assert.equal(verdicts.length, 2);
  assert.deepEqual(
    [...verdicts.map((v) => v.conclusion)].sort(),
    ["no — blocking risk", "yes with caveats"],
    "each model's distinct verdict is listed",
  );
  // The judge envelope lists perModel + contradictions rather than one answer.
  const perModel = r.envelope?.perModel ?? [];
  assert.equal(perModel.length, 2, "the envelope lists every distinct model verdict");
  assert.ok((r.envelope?.contradictions ?? []).length > 0, "contradictions are surfaced, not smoothed over");
  assert.equal(r.actor, null, "compare mode has no actor");
  // The task travels via the run's ctx() shared-context mechanism (the panel
  // member prompts embed the ctx pointer, never caller-interpolated text).
  const memberPrompt = prompts.find((p) => p.includes("multi-model review panel"));
  assert.ok(memberPrompt?.includes("TASK: "), "each panel member embeds the shared task pointer");
  assert.equal(prompts.length, 3, "two panel members + one judge");
});

// ─── Runtime: act mode (1-4 reference models → one reconciling actor) ─────────

test("multi-model act: one actor reconciles the untrusted reference verdicts and executes", async () => {
  const result = await runWorkflow(generateMultiModelPanelWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("judge of a multi-model review panel"))
          return {
            perModel: [{ model: "anthropic/claude-sonnet-4", verdict: "the offset is wrong", confidence: 0.7 }],
            consensus: [],
            contradictions: [],
            coverage: [],
            blindSpots: [],
            insights: [],
            recommendation: "fix the offset",
          };
        if (prompt.includes("multi-model review panel"))
          return {
            conclusion: "the offset is wrong",
            reasoning: "the shard key skips a range",
            confidence: 0.7,
            coverage: [],
            insights: [],
            blindSpots: [],
            caveats: [],
          };
        if (prompt.includes("executing actor"))
          return {
            reconciliation: "agreed with the panel; applied the offset fix",
            actions: [{ file: "src/shard.ts", change: "added 1 to the shard offset" }],
            result: "the shard range now covers the full space",
            deviations: [],
          };
        return null;
      },
    },
    persistLogs: false,
    args: { task: "fix the shard offset bug", models: ["anthropic/claude-sonnet-4"], mode: "act" },
  });

  const r = result.result as {
    mode?: string;
    actor?: { reconciliation?: string; actions?: Array<{ file: string; change: string }>; result?: string };
    envelope?: unknown;
    verdicts?: unknown[];
  };
  assert.equal(r.mode, "act");
  assert.deepEqual([...(r.verdicts ?? [])].length, 1, "one reference model in act mode");
  assert.ok(r.envelope, "the judge envelope still feeds the actor");
  assert.equal(r.actor?.reconciliation, "agreed with the panel; applied the offset fix");
  assert.deepEqual(r.actor?.actions, [{ file: "src/shard.ts", change: "added 1 to the shard offset" }]);
  assert.equal(r.actor?.result, "the shard range now covers the full space");
});

test("multi-model degrades to an explicit error when the model list is insufficient", async () => {
  const result = await runWorkflow(generateMultiModelPanelWorkflow(), {
    agent: {
      async run() {
        return null;
      },
    },
    persistLogs: false,
    args: { task: "t", models: ["a/b"], mode: "compare" },
  });
  const r = result.result as { error?: string; compareNotMerge?: boolean };
  assert.match(r.error ?? "", /compare mode requires 2-8 distinct model specs/);
  assert.equal(r.compareNotMerge, true);

  const act = await runWorkflow(generateMultiModelPanelWorkflow(), {
    agent: {
      async run() {
        return null;
      },
    },
    persistLogs: false,
    args: { task: "t", mode: "act" },
  });
  assert.match((act.result as { error?: string }).error ?? "", /act mode requires 1-4 distinct model specs/);

  const noTask = await runWorkflow(generateMultiModelPanelWorkflow(), {
    agent: {
      async run() {
        return null;
      },
    },
    persistLogs: false,
    args: { models: ["a/b", "c/d"] },
  });
  assert.match((noTask.result as { error?: string }).error ?? "", /task is required/);
});

// ─── Resume: a mid-pattern run replays completed panel verdicts ───────────────

test("multi-model: a full run replays from the journal without re-calling the agent", async () => {
  const journal = new Map<string, JournalEntry>();
  const options = (capture: boolean) => ({
    agent: compareRunner,
    persistLogs: false,
    runId: RUN_ID,
    args: { task: "is this design sound?", models: ["anthropic/claude-sonnet-4", "openrouter/deepseek/x"] },
    ...(capture
      ? { onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry) }
      : {}),
  });

  const first = await runWorkflow(generateMultiModelPanelWorkflow(), options(true));
  const firstResult = first.result as { verdicts?: unknown[]; envelope?: unknown };
  assert.equal((firstResult.verdicts ?? []).length, 2);
  assert.ok(journal.size >= 3, "2 panel verdicts + judge journal entries");

  let calls = 0;
  const replay = await runWorkflow(generateMultiModelPanelWorkflow(), {
    agent: {
      async run(_prompt: string) {
        calls++;
        return null;
      },
    },
    persistLogs: false,
    runId: RUN_ID,
    resumeJournal: journal,
    args: { task: "is this design sound?", models: ["anthropic/claude-sonnet-4", "openrouter/deepseek/x"] },
  });
  assert.equal(calls, 0, "a full prefix replay must not re-call the agent");
  const replayResult = replay.result as { verdicts?: unknown[]; envelope?: unknown };
  assert.equal((replayResult.verdicts ?? []).length, 2, "the replayed run reconstructs the same panel");
  assert.ok(replayResult.envelope, "the replayed judge envelope is reconstructed");
});
