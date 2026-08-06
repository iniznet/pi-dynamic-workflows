import assert from "node:assert/strict";
import test from "node:test";
import { createEffortState, effortDirective, isSubstantive, registerEffortCommand } from "../src/effort-command.js";
import { buildArmedWorkflowPrompt } from "../src/workflow-editor.js";

test("effortDirective shapes fan-out without inventing token budgets", () => {
  const high = effortDirective("high") ?? "";
  const ultra = effortDirective("ultra") ?? "";

  assert.equal(effortDirective("off"), undefined);
  assert.match(high, /HIGH/);
  assert.match(ultra, /ULTRA/);
  assert.match(high, /maxAgents/);
  assert.match(ultra, /maxAgents/);
  assert.doesNotMatch(high, /tokenBudget/);
  assert.doesNotMatch(ultra, /tokenBudget/);
});

test("isSubstantive accepts real requests, rejects terse text and slash commands", () => {
  assert.equal(isSubstantive("audit the auth module for race conditions"), true);
  assert.equal(isSubstantive("ok"), false);
  assert.equal(isSubstantive("/workflows"), false);
  assert.equal(isSubstantive("    "), false);
});

test("buildArmedWorkflowPrompt appends the extra directive only when provided", () => {
  const base = buildArmedWorkflowPrompt("do X");
  assert.ok(!/ULTRA/.test(base), "no directive by default");
  assert.ok(base.startsWith("do X"));
  const ultra = buildArmedWorkflowPrompt("do X", { reason: "effort", extraDirective: effortDirective("ultra") });
  assert.match(ultra, /ULTRA/, "ultra directive appended");
  assert.ok(ultra.startsWith("do X"));
});

type CmdDef = { handler: (a: string, c: unknown) => Promise<void> };

type Completion = { value: string; label: string; description?: string };

type CompletionSpec = { getArgumentCompletions?: (prefix: string) => Completion[] | null };

function registerAndCapture(state: ReturnType<typeof createEffortState>) {
  const cmds = new Map<string, CmdDef>();
  const pi = {
    registerCommand: (name: string, d: unknown) => cmds.set(name, d as CmdDef),
    sendMessage: () => {},
  };
  registerEffortCommand(pi as never, state);
  return cmds;
}

test("registerEffortCommand: /effort toggles the shared state", async () => {
  const state = createEffortState();
  const effort = registerAndCapture(state).get("effort");
  assert.ok(effort, "/effort registered");
  assert.equal(state.level, "off");

  await effort?.handler("ultra", {});
  assert.equal(state.level, "ultra");
  await effort?.handler("high", {});
  assert.equal(state.level, "high");
  await effort?.handler("off", {});
  assert.equal(state.level, "off");
  await effort?.handler("bogus", {});
  assert.equal(state.level, "off", "unknown arg leaves the level unchanged");
});

test("registerEffortCommand: /ultracode turns ultra on, /ultracode off turns it off", async () => {
  const state = createEffortState();
  const ultracode = registerAndCapture(state).get("ultracode");
  assert.ok(ultracode, "/ultracode registered");

  await ultracode?.handler("", {});
  assert.equal(state.level, "ultra", "/ultracode (no arg) sets ultra");
  await ultracode?.handler("off", {});
  assert.equal(state.level, "off", "/ultracode off turns it off");
  await ultracode?.handler("anything", {});
  assert.equal(state.level, "ultra", "/ultracode <anything-but-off> sets ultra");
});

test("registerEffortCommand: /effort argument completions suggest off/high/ultra, prefix-filtered", () => {
  const state = createEffortState();
  const effort = registerAndCapture(state).get("effort") as unknown as CompletionSpec;
  assert.equal(typeof effort.getArgumentCompletions, "function", "/effort must expose argument completions");

  const all = effort.getArgumentCompletions?.("") ?? [];
  assert.deepEqual(
    all.map((c) => c.value),
    ["off", "high", "ultra"],
  );
  // every candidate carries a hint description
  for (const c of all) assert.ok(c.description, `candidate ${c.value} needs a description`);

  assert.deepEqual(
    (effort.getArgumentCompletions?.("of") ?? []).map((c) => c.value),
    ["off"],
  );
  assert.deepEqual(
    (effort.getArgumentCompletions?.("h") ?? []).map((c) => c.value),
    ["high"],
  );
  assert.deepEqual(
    (effort.getArgumentCompletions?.("u") ?? []).map((c) => c.value),
    ["ultra"],
  );
  assert.deepEqual(effort.getArgumentCompletions?.("x") ?? [], [], "non-matching prefix → empty");

  // the current level is marked in its item description (a live status readout)
  assert.equal(state.level, "off");
  const off = all.find((c) => c.value === "off");
  assert.match(off?.description ?? "", /\(current\)/);
  const ultra = all.find((c) => c.value === "ultra");
  assert.doesNotMatch(ultra?.description ?? "", /\(current\)/);
});

test("registerEffortCommand: /ultracode argument completions suggest off (and on)", () => {
  const state = createEffortState();
  const ultracode = registerAndCapture(state).get("ultracode") as unknown as CompletionSpec;
  assert.equal(typeof ultracode.getArgumentCompletions, "function", "/ultracode must expose argument completions");

  assert.deepEqual(
    (ultracode.getArgumentCompletions?.("") ?? []).map((c) => c.value),
    ["off", "on"],
  );
  assert.deepEqual(
    (ultracode.getArgumentCompletions?.("of") ?? []).map((c) => c.value),
    ["off"],
  );
  assert.deepEqual(
    (ultracode.getArgumentCompletions?.("o") ?? []).map((c) => c.value),
    ["off", "on"],
  );
  assert.deepEqual(ultracode.getArgumentCompletions?.("x") ?? [], [], "non-matching prefix → empty");
});
