/**
 * P05 per-agent result cap: agent() results (unstructured text) are bounded
 * (default DEFAULT_MAX_AGENT_RESULT_CHARS = 50_000) with tail-preserving
 * middle truncation + a written artifact path for full retrieval; the capped
 * output counts against the run budget. The cap is a PURE function of the
 * result (mirroring capEmbedded), so resume replay is byte-identical and the
 * knob itself is deliberately NOT part of hashAgentCall.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_MAX_AGENT_RESULT_CHARS } from "../../../src/config.js";
import type { JournalEntry } from "../../../src/workflow.js";
import {
  capAgentResultText,
  estimateTokens,
  hashAgentCall,
  resolveMaxAgentResultChars,
  runWorkflow,
  truncateAgentResultMiddle,
} from "../../../src/workflow.js";

const RUN_ID = "p05-cap-run";
const FULL = `${"A".repeat(60_000)}THE-TAIL-MARKER`;
const CAP = 1_000;

test("truncateAgentResultMiddle keeps head AND tail with a deterministic marker (pure)", () => {
  const value = `head-content-${'"x"'.repeat(500)}-tail-content`;
  const once = truncateAgentResultMiddle(value, 100);
  assert.ok(once.length <= 100, "output stays within the budget");
  assert.ok(once.endsWith("-tail-content"), "the TAIL (conclusion) is preserved");
  assert.ok(once.startsWith("head-content-"), "the HEAD (context) is preserved");
  assert.ok(once.includes("characters omitted"), "the omission is visible, not silent");
  assert.equal(truncateAgentResultMiddle(value, 100), once, "pure: same input → same output");
  assert.equal(truncateAgentResultMiddle("short", 100), "short", "no truncation under budget");
});

test("capAgentResultText counts the artifact suffix inside the budget", () => {
  const text = "y".repeat(2_000);
  const capped = capAgentResultText(text, 500, "/tmp/artifacts/x.txt");
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.length <= 500, "final text never exceeds maxChars");
  assert.ok(capped.text.includes("/tmp/artifacts/x.txt"), "artifact path is retrievable from the text");
  assert.equal(capped.originalChars, 2_000);
  assert.ok(capped.omittedChars > 0);
  const noArtifact = capAgentResultText(text, 500);
  assert.equal(noArtifact.artifactPath, undefined);
  assert.ok(noArtifact.text.length <= 500);
});

test("resolveMaxAgentResultChars: null/Infinity = no cap, undefined = default, positives clamp", () => {
  assert.equal(resolveMaxAgentResultChars(null, 50_000), null, "explicit null disables the cap");
  assert.equal(resolveMaxAgentResultChars(Infinity, 50_000), null, "Infinity also disables the cap");
  assert.equal(resolveMaxAgentResultChars(undefined, 50_000), 50_000, "omitted falls back to the default");
  assert.equal(resolveMaxAgentResultChars(1234.9, 50_000), 1234, "finite positives floor to integers");
  assert.equal(resolveMaxAgentResultChars(0, 50_000), 50_000, "a non-positive number is ignored");
});

test("agent() results are capped tail-preservingly and the full text is written to an artifact path", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "p05-cap-run-"));
  try {
    const journal = new Map<string, JournalEntry>();
    const res = await runWorkflow<string>(
      `export const meta = { name: 'cap', description: 'cap test' }
return await agent('big', { label: 'big' })`,
      {
        agent: {
          async run() {
            return FULL;
          },
        },
        cwd,
        persistLogs: false,
        runId: RUN_ID,
        defaultMaxAgentResultChars: CAP,
        onAgentJournal: (entry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry),
      },
    );

    assert.ok(res.result.length <= CAP, `result is bounded (got ${res.result.length})`);
    assert.ok(res.result.includes("THE-TAIL-MARKER"), "the tail of the answer is preserved");
    assert.ok(res.result.includes("characters omitted"), "the truncation is marked");
    assert.ok(
      res.logs.some((line) => line.includes("result capped") && line.includes(RUN_ID)),
      "the cap is logged with the artifact identity",
    );

    // The FULL result is retrievable from the deterministic artifact path.
    const artifactPath = join(cwd, ".pi", "workflows", "artifacts", `${RUN_ID}-c0.txt`);
    const artifact = await readFile(artifactPath, "utf-8");
    assert.equal(artifact, FULL, "the artifact holds the full untruncated result");
    assert.equal(res.result.includes(artifactPath), true, "the capped text points at the artifact");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the capped output counts against the run budget (estimate path)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "p05-budget-"));
  try {
    const prompt = "budget";
    const run = (cap: number | null) =>
      runWorkflow(
        `export const meta = { name: 'budget', description: 'budget test' }
return await agent('${prompt}', { label: 'b' })`,
        {
          agent: {
            async run() {
              return FULL;
            },
          },
          cwd,
          persistLogs: false,
          runId: `p05-budget-${String(cap)}`,
          defaultMaxAgentResultChars: cap,
        },
      );

    const capped = await run(CAP);
    const cappedResult = capped.result as string;
    const expected = estimateTokens(cappedResult) + estimateTokens(prompt);
    assert.equal(capped.tokenUsage?.total, expected, "budget counts the CAPPED result + prompt");

    const uncapped = await run(null);
    assert.equal(uncapped.result, FULL, "null cap leaves the full result intact");
    assert.ok(
      (uncapped.tokenUsage?.total ?? 0) > (capped.tokenUsage?.total ?? 0),
      "the uncapped run budgets more tokens than the capped run",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resume hash is stable across cap-on/off (the knob never joins hashAgentCall)", () => {
  const base = {
    model: "prov/m",
    tierModel: undefined,
    phase: "exec",
    options: { label: "x" } as const,
    agentDefKey: null,
    mainModel: undefined,
    isolation: undefined as "worktree" | undefined,
  };
  const withoutCap = hashAgentCall(
    "same prompt",
    base.model,
    base.tierModel,
    base.phase,
    base.options,
    base.agentDefKey,
    base.mainModel,
    base.isolation,
  );
  const withCap = hashAgentCall(
    "same prompt",
    base.model,
    base.tierModel,
    base.phase,
    { ...base.options, maxResultChars: 1000 },
    base.agentDefKey,
    base.mainModel,
    base.isolation,
  );
  assert.equal(withCap, withoutCap, "adding the cap knob must not change the resume identity");
});

test("a journal produced with the cap ON replays with the cap OFF (capped bytes are the cached truth)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "p05-replay-"));
  try {
    let calls = 0;
    const agent = {
      async run() {
        calls++;
        return FULL;
      },
    };
    const journal = new Map<string, JournalEntry>();
    const options = (cap: number | null) => ({
      agent,
      cwd,
      persistLogs: false,
      runId: RUN_ID,
      defaultMaxAgentResultChars: cap,
      onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry),
    });

    const first = await runWorkflow<string>(
      `export const meta = { name: 'replay', description: 'replay test' }
return await agent('big', { label: 'big' })`,
      options(CAP),
    );
    assert.ok(first.result.length <= CAP, "first live run is capped");
    assert.equal(calls, 1);

    const replayed = await runWorkflow<string>(
      `export const meta = { name: 'replay', description: 'replay test' }
return await agent('big', { label: 'big' })`,
      {
        ...options(null),
        resumeJournal: journal,
      },
    );
    assert.equal(calls, 1, "the cached result replays (hash matched despite the cap flip)");
    assert.equal(replayed.result, first.result, "the journaled CAPPED bytes are the replay truth");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("schema (structured) results are never capped — the shape contract wins", async () => {
  const schema = {
    type: "object",
    properties: { verdict: { type: "boolean" }, reason: { type: "string" } },
    required: ["verdict", "reason"],
  };
  const res = await runWorkflow(
    `export const meta = { name: 'judge', description: 'judge test' }
return await agent('judge', { label: 'j', schema: ${JSON.stringify(schema)} })`,
    {
      agent: {
        async run() {
          // structured_output's resolved shape: the object result is returned as-is
          return { verdict: true, reason: "r".repeat(10_000) };
        },
      },
      persistLogs: false,
      runId: "p05-schema",
      defaultMaxAgentResultChars: 100,
    },
  );
  const result = res.result as { verdict: boolean; reason: string };
  assert.equal(result.verdict, true);
  assert.equal(result.reason.length, 10_000, "a structured field is not truncated by the text cap");
});

test("the DEFAULT cap is DEFAULT_MAX_AGENT_RESULT_CHARS (50_000)", () => {
  assert.equal(DEFAULT_MAX_AGENT_RESULT_CHARS, 50_000);
});
