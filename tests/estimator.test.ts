import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTokenSegment,
  estimateTokens,
  estimateTokensDetailed,
  TOKEN_ESTIMATE_SEGMENT_DIVISORS,
  type TokenSegmentClass,
} from "../src/workflow.js";

/**
 * T1-16: the segment-aware estimator. The chars/4 heuristic undercounts
 * code/JSON/tool-call payloads (they tokenize denser than prose), so the
 * estimator classifies each value and divides by the calibrated per-segment
 * divisor (see scripts/calibrate-estimator.ts + measurements.md). These tests
 * pin the pure classification + the per-segment arithmetic; the budget-level
 * wiring (recordTokens) is covered in workflow-runtime.test.ts.
 */

const DIVISORS = TOKEN_ESTIMATE_SEGMENT_DIVISORS;

test("classifyTokenSegment: prose text is prose", () => {
  assert.equal(classifyTokenSegment("Review the following proposal and summarize the risks."), "prose");
  assert.equal(classifyTokenSegment(""), "prose");
  assert.equal(classifyTokenSegment(null), "prose");
  assert.equal(classifyTokenSegment(42), "prose");
  assert.equal(classifyTokenSegment(undefined), "prose");
});

test("classifyTokenSegment: JSON envelopes are json (not code)", () => {
  assert.equal(classifyTokenSegment('{"key": "value", "n": 1}'), "json");
  assert.equal(classifyTokenSegment('[1, 2, {"a": true}]'), "json");
  assert.equal(classifyTokenSegment('  \n{"pretty": "printed"}'), "json");
  assert.equal(classifyTokenSegment({ a: 1, b: [1, 2] }), "json", "structured values are JSON payloads");
  assert.equal(classifyTokenSegment([1, 2, 3]), "json");
});

test("classifyTokenSegment: code markers are code", () => {
  assert.equal(classifyTokenSegment("```ts\nconst x = 1;\n```"), "code");
  assert.equal(classifyTokenSegment("function add(a, b) { return a + b; }"), "code");
  assert.equal(classifyTokenSegment("export const meta = { name: 'x' }"), "code");
  assert.equal(classifyTokenSegment("import { join } from 'node:path'"), "code");
  assert.equal(classifyTokenSegment("async (ctx) => await ctx.run()"), "code");
  assert.equal(classifyTokenSegment("def run(self):\n    return 42"), "code");
});

test("classifyTokenSegment: tool-call envelopes are tool", () => {
  assert.equal(classifyTokenSegment('{"name": "bash", "input": "ls"}'), "tool");
  assert.equal(classifyTokenSegment('{"tool": "read", "arguments": {"path": "a.ts"}}'), "tool");
  // A JSON envelope with tool-call keys but no input/arguments stays json.
  assert.equal(classifyTokenSegment('{"name": "bash", "cwd": "/tmp"}'), "json");
});

test("estimateTokens divides by the per-segment divisor (ceil)", () => {
  const prose = "The quick brown fox jumps over the lazy dog and keeps running.";
  assert.equal(estimateTokens(prose), Math.ceil(prose.length / DIVISORS.prose));

  const code = "const add = (a, b) => a + b; // dense tokenizer content";
  assert.equal(classifyTokenSegment(code), "code");
  assert.equal(estimateTokens(code), Math.ceil(code.length / DIVISORS.code));

  const json = '{"items": [1, 2, 3], "ok": true}';
  assert.equal(classifyTokenSegment(json), "json");
  assert.equal(estimateTokens(json), Math.ceil(json.length / DIVISORS.json));

  const tool = '{"name": "grep", "input": {"pattern": "foo", "path": "src"}}';
  assert.equal(classifyTokenSegment(tool), "tool");
  assert.equal(estimateTokens(tool), Math.ceil(tool.length / DIVISORS.tool));
});

test("code/JSON/tool divisors are denser (smaller) than prose — the plan's claim", () => {
  assert.ok(DIVISORS.code < DIVISORS.prose, "code tokenizes denser than prose");
  assert.ok(DIVISORS.json < DIVISORS.prose, "json tokenizes denser than prose");
  assert.ok(DIVISORS.tool < DIVISORS.prose, "tool payloads tokenize denser than prose");
});

test("estimateTokensDetailed returns the same chars/segment the estimator uses", () => {
  for (const value of ["plain text here", '{"a": 1}', "function f() {}", '{"name": "x", "input": "y"}', [1, 2], 7]) {
    const detail = estimateTokensDetailed(value);
    assert.equal(detail.segment, classifyTokenSegment(value));
    assert.equal(estimateTokens(value), Math.ceil(detail.chars / DIVISORS[detail.segment]));
  }
});

test("estimateTokensDetailed counts object values by their serialized length (probe parity)", () => {
  const obj = { a: 1, b: [1, 2, 3], c: "text" };
  const detail = estimateTokensDetailed(obj);
  assert.equal(detail.segment, "json");
  assert.equal(detail.chars, JSON.stringify(obj).length);
});

test("estimateTokens is a pure function (deterministic, allocation-light path)", () => {
  const inputs: unknown[] = [
    "a paragraph of prose that should stay deterministic across calls",
    '{"k": "v"}',
    "const x = 1;",
    undefined,
    null,
    { nested: { deep: [1, 2] } },
  ];
  for (const input of inputs) {
    const first = estimateTokens(input);
    assert.equal(estimateTokens(input), first, `deterministic for ${JSON.stringify(input)?.slice(0, 30)}`);
  }
});

test("large values keep the probe fallback and still honor the segment divisor", () => {
  // Beyond TOKEN_ESTIMATE_STRINGIFY_BUDGET the estimator skips the exact
  // stringify; the length probe must still produce a positive, sane count.
  const big = { data: "x".repeat(300_000) };
  const tokens = estimateTokens(big);
  assert.ok(Number.isInteger(tokens) && tokens > 0);
  assert.equal(classifyTokenSegment(big), "json");
});

test("all four segment classes resolve to positive divisors", () => {
  for (const cls of ["prose", "code", "json", "tool"] as TokenSegmentClass[]) {
    assert.ok(Number.isFinite(DIVISORS[cls]) && DIVISORS[cls] > 0, `${cls} divisor must be finite and positive`);
  }
});
