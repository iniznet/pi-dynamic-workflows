/**
 * V2-P10 — golden-master regression per built-in workflow.
 *
 * For each built-in pattern: RECORD a real script execution against a
 * deterministic per-prompt mock runner (capturing the journal), build a canned
 * fixture, then REPLAY the same script against the cached results. The replay
 * must reproduce the record's semantic output BYTE-IDENTICALLY (the golden
 * signature) while never invoking a live runner — the no-launch CI surface.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { generateAdversarialReviewWorkflow } from "../../../src/adversarial-review.js";
import { generateCodeReviewWorkflow } from "../../../src/code-review.js";
import { generateDeepResearchWorkflow } from "../../../src/deep-research.js";
import {
  buildReplayFixture,
  createReplayAgent,
  type ReplayFixture,
  replaySignature,
  replayWorkflow,
  stringifyReplaySignature,
} from "../../../src/replay-harness.js";
import { generateSpecGenerationWorkflow } from "../../../src/spec-generation.js";
import type { JournalEntry } from "../../../src/workflow.js";
import { runWorkflow } from "../../../src/workflow.js";

/**
 * Record one builtin script against a per-prompt mock runner, then replay it
 * from the captured journal. Asserts the golden-master contract:
 *  - replay result/phases/agentCount byte-identical to the record's;
 *  - the replay never invoked a live runner (zero misses).
 */
async function goldenMaster(
  name: string,
  script: string,
  runner: (prompt: string) => unknown,
  args: Record<string, unknown>,
): Promise<void> {
  const journal: JournalEntry[] = [];
  const record = await runWorkflow(script, {
    agent: { run: async (prompt: string) => runner(prompt) } as never,
    persistLogs: false,
    args,
    onAgentJournal: (entry) => journal.push(entry),
  });
  assert.ok(record.agentCount > 0, `${name}: record must have run agents`);
  assert.equal(journal.length, record.agentCount, `${name}: every agent must journal`);

  const fixture: ReplayFixture = buildReplayFixture({
    runId: record.runId ?? "golden-run",
    name: record.meta.name,
    description: record.meta.description,
    args,
    journal,
  });

  const misses: unknown[] = [];
  const replayed = await replayWorkflow(script, fixture, {
    agent: createReplayAgent({ fixture, onMiss: (miss) => misses.push(miss) }),
  });

  assert.equal(misses.length, 0, `${name}: replay must never launch a live agent`);
  assert.equal(replayed.agentCount, record.agentCount, `${name}: agent count stable`);
  assert.deepEqual(replayed.phases, record.phases, `${name}: phases stable`);
  assert.equal(
    stringifyReplaySignature(replayed),
    stringifyReplaySignature(record),
    `${name}: golden signature must be byte-identical`,
  );
}

// ─── deep-research ────────────────────────────────────────────────────────────

test("golden-master: deep-research replays byte-identically without launching", async () => {
  const runner = (prompt: string) => {
    if (prompt.includes("planning web research")) return { queries: ["webgpu basics", "gpu compute"] };
    if (prompt.includes("Research this query")) {
      return {
        sources: [
          { url: "https://a.example", claims: ["The sky is blue", "Unicorns run the stock market"] },
          { url: "https://b.example", claims: ["The sky is blue"] },
        ],
      };
    }
    if (prompt.includes("fact-checking cross-checker")) {
      return {
        supported: [{ claim: "The sky appears blue", sources: ["https://a.example", "https://b.example"] }],
        discarded: ["Unicorns run the stock market"],
        conflicts: [],
      };
    }
    if (prompt.includes("claim-evidence verifier")) {
      return { pages: [{ url: "https://a.example", text: "The sky appears blue" }] };
    }
    if (prompt.includes("well-structured research report")) return "research report text";
    return null;
  };
  await goldenMaster("deep-research", generateDeepResearchWorkflow(), runner, {
    question: "What color is the sky?",
    angles: 1,
    minSupport: 1,
  });
});

// ─── code-review ──────────────────────────────────────────────────────────────

const REVIEW_DIFF = [
  "diff --git a/src/f1.ts b/src/f1.ts",
  "index 111..222 100644",
  "--- a/src/f1.ts",
  "+++ b/src/f1.ts",
  "@@ -1,9 +1,9 @@",
  " function inc(n) {",
  "-  return n + 1;",
  "+  return n + 2;",
  " }",
].join("\n");

test("golden-master: code-review replays byte-identically without launching", async () => {
  const runner = (prompt: string) => {
    if (prompt.includes("You are a verifier")) {
      return { verdicts: [{ verdict: "CONFIRMED", reason: "traced in the slice" }] };
    }
    if (prompt.includes("final report")) return "synthesis text";
    if (prompt.includes("shard=")) {
      return {
        candidates: [
          { file: "src/f1.ts", line: 2, severity: "low", summary: "off-by-one", failure_scenario: "mis-index" },
        ],
      };
    }
    return null;
  };
  await goldenMaster("code-review", generateCodeReviewWorkflow(), runner, { diff: REVIEW_DIFF, maxCandidates: 1 });
});

// ─── adversarial-review ───────────────────────────────────────────────────────

test("golden-master: adversarial-review replays byte-identically without launching", async () => {
  const runner = (prompt: string) => {
    if (prompt.includes("Investigate the following")) return { findings: ["finding one", "finding two"] };
    if (prompt.includes("skeptical reviewer")) return { real: true };
    if (prompt.includes("final review report")) return "consensus report";
    return null;
  };
  await goldenMaster("adversarial-review", generateAdversarialReviewWorkflow(), runner, {
    task: "review the widget",
    reviewers: 2,
  });
});

// ─── multi-perspective ────────────────────────────────────────────────────────

test("golden-master: multi-perspective replays byte-identically without launching", async () => {
  const script = `export const meta = {
  name: 'multi_perspective_analysis',
  description: 'Analyze from 2 different perspectives',
  phases: [
    { title: 'Perspective Analysis' },
    { title: 'Synthesis' },
  ],
};

phase('Perspective Analysis');
const topic = 'test topic';
const analyses = await parallel([
  () => agent('Analyze from economic perspective: ' + topic, { label: 'economic' }),
  () => agent('Analyze from technical perspective: ' + topic, { label: 'technical' }),
], { autoApproved: true });

phase('Synthesis');
const synthesis = await agent(
  'Synthesize these different perspectives into a balanced analysis:\\n' +
  'Analyses: ' + JSON.stringify(analyses) + '\\n' +
  'Topic: ' + topic,
  { label: 'synthesizer' }
);

return { analyses, synthesis };`;
  const runner = (prompt: string) => {
    if (prompt.includes("Analyze from economic perspective")) return "economic view";
    if (prompt.includes("Analyze from technical perspective")) return "technical view";
    if (prompt.includes("Synthesize these different perspectives")) return "balanced synthesis";
    return null;
  };
  await goldenMaster("multi-perspective", script, runner, {});
});

// ─── spec-generation ──────────────────────────────────────────────────────────

test("golden-master: spec-generation replays byte-identically without launching", async () => {
  const draft = (label: string) => ({
    goal: `${label} goal`,
    requirements: [{ id: "R1", statement: `${label} requirement` }],
    constraints: [`${label} constraint`],
    acceptanceCriteria: [`${label} criterion`],
    risks: [`${label} risk`],
    openQuestions: [`${label} question`],
  });
  const runner = (prompt: string) => {
    if (prompt.includes("product drafter")) return draft("product");
    if (prompt.includes("technical drafter")) return draft("technical");
    if (prompt.includes("risk drafter")) return draft("risk");
    if (prompt.includes("adversarial requirements reviewer")) {
      return {
        review: "consolidated review",
        conflicts: ["conflict one"],
        gaps: ["gap one"],
        spec: {
          goal: "consolidated goal",
          requirements: [{ id: "R1", statement: "consolidated requirement" }],
          constraints: ["constraint"],
          acceptanceCriteria: ["criterion"],
          risks: ["risk"],
          openQuestions: ["question"],
        },
      };
    }
    if (prompt.includes("spec writer")) return "final markdown spec";
    return null;
  };
  await goldenMaster("spec-generation", generateSpecGenerationWorkflow(), runner, {
    topic: "a widget",
    format: "markdown",
  });
});

// ─── the golden signature is stable across replays ────────────────────────────

test("golden-master: the stored signature is byte-stable across repeated replays", async () => {
  const journal: JournalEntry[] = [];
  const runner = { run: async (prompt: string) => ({ echo: prompt.slice(0, 6) }) };
  const script = `export const meta = { name: 'stable_golden', description: 'repeated replay' }
const a = await agent('one')
const b = await agent('two')
return { a, b }`;
  const record = await runWorkflow(script, {
    agent: runner as never,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  const fixture = buildReplayFixture({
    runId: record.runId ?? "golden-run",
    name: record.meta.name,
    journal,
  });
  const first = await replayWorkflow(script, fixture);
  const second = await replayWorkflow(script, fixture);
  const golden = stringifyReplaySignature(first);
  assert.equal(golden, stringifyReplaySignature(second));
  assert.equal(JSON.stringify(replaySignature(first)), golden);
});
