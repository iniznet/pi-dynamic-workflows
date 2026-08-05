import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SavedWorkflow } from "../src/workflow-saved.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

async function load() {
  return import("../src/saved-commands.js");
}

describe("parseCommandArgs", () => {
  it("parses key=value pairs", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("foo=bar count=42");
    assert.equal(result.foo, "bar");
    assert.equal(result.count, "42");
  });
  it("collects positional args into _", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("hello world");
    assert.equal(result._, "hello world");
  });

  it("handles mixed positional and key=value", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("task=test hello world");
    assert.equal(result.task, "test");
    assert.equal(result._, "hello world");
  });

  it("sets _raw to the trimmed input", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("  foo=bar  ");
    assert.equal(result._raw, "foo=bar");
  });

  it("returns empty when input is empty", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("");
    assert.equal(result._, "");
    assert.equal(result._raw, "");
  });

  it("fills parameter defaults for missing keys", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("foo=bar", {
      foo: { type: "string" },
      limit: { type: "number", default: 10 },
      label: { type: "string", default: "test" },
    });
    assert.equal(result.foo, "bar");
    assert.equal(result.limit, 10);
    assert.equal(result.label, "test");
  });

  it("does NOT override explicit values with defaults", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("limit=5", { limit: { type: "string", default: 10 } });
    assert.equal(result.limit, "5");
  });

  it("handles value-only token as positional", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("hello key=value world");
    assert.equal(result._, "hello world");
    assert.equal(result.key, "value");
  });

  it("handles URLs as positional arguments", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("https://example.com");
    assert.equal(result._, "https://example.com");
  });

  it("coerces provided values to declared types", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("count=42 limit=3.5 verbose=true", {
      count: { type: "integer" },
      limit: { type: "number" },
      verbose: { type: "boolean" },
    });
    assert.equal(result.count, 42, "declared integer should be a number");
    assert.equal(result.limit, 3.5, "declared number should be a number");
    assert.equal(result.verbose, true, "declared boolean should be a boolean");
  });

  it("throws when a required declared argument is missing", async () => {
    const { parseCommandArgs } = await load();
    assert.throws(
      () => parseCommandArgs("foo=bar", { question: { type: "string", required: true } }),
      /Missing required argument: question/,
    );
  });

  it("throws when a declared-typed value fails coercion", async () => {
    const { parseCommandArgs } = await load();
    assert.throws(() => parseCommandArgs("count=abc", { count: { type: "integer" } }), /must be an integer/);
    assert.throws(() => parseCommandArgs("ok=maybe", { ok: { type: "boolean" } }), /must be a boolean/);
  });
});

describe("coerceArgs", () => {
  it("passes undeclared keys through untouched", async () => {
    const { coerceArgs } = await load();
    assert.deepEqual(coerceArgs({ extra: "x" }), { extra: "x" });
  });

  it("fills defaults for missing optional params", async () => {
    const { coerceArgs } = await load();
    const result = coerceArgs({}, { tag: { type: "string", default: "t" }, count: { type: "number", default: 3 } });
    assert.deepEqual(result, { tag: "t", count: 3 });
  });

  it("does not override provided values with defaults", async () => {
    const { coerceArgs } = await load();
    const result = coerceArgs({ tag: "provided" }, { tag: { type: "string", default: "t" } });
    assert.equal(result.tag, "provided");
  });

  it("throws on a missing required param with no default", async () => {
    const { coerceArgs } = await load();
    assert.throws(() => coerceArgs({}, { q: { type: "string", required: true } }), /Missing required argument: q/);
  });

  it("throws on a failed coercion of a provided value", async () => {
    const { coerceArgs } = await load();
    assert.throws(() => coerceArgs({ n: "abc" }, { n: { type: "integer" } }), /args\.n must be an integer/);
    assert.throws(() => coerceArgs({ n: "abc" }, { n: { type: "number" } }), /args\.n must be a number/);
    assert.throws(() => coerceArgs({ n: 5 }, { n: { type: "string" } }), /args\.n must be a string/);
  });

  it("coerces numbers, integers, and booleans", async () => {
    const { coerceArgs } = await load();
    assert.deepEqual(
      coerceArgs(
        { n: "12", i: "7", b: "0" },
        { n: { type: "number" }, i: { type: "integer" }, b: { type: "boolean" } },
      ),
      { n: 12, i: 7, b: false },
    );
    // A non-integer value for an integer param is a hard error, not a truncation.
    assert.throws(() => coerceArgs({ i: "7.5" }, { i: { type: "integer" } }), /args\.i must be an integer/);
  });
});

describe("parametersFromArgs + formatParameterHelp", () => {
  it("derives a parameter schema from a run's args", async () => {
    const { parametersFromArgs } = await load();
    const params = parametersFromArgs({ scope: "src/", retries: 2, verbose: true, ratio: 1.5 });
    assert.equal(params?.scope.type, "string");
    assert.equal(params?.scope.default, "src/");
    assert.equal(params?.retries.type, "integer");
    assert.equal(params?.verbose.type, "boolean");
    assert.equal(params?.ratio.type, "number");
  });

  it("excludes parse artifacts (_ and _raw) and empty args", async () => {
    const { parametersFromArgs } = await load();
    assert.equal(parametersFromArgs({ _: "x", _raw: "x" }), undefined);
    assert.equal(parametersFromArgs(undefined), undefined);
    assert.equal(parametersFromArgs("not-an-object"), undefined);
  });

  it("renders the declared schema as a --help block", async () => {
    const { formatParameterHelp } = await load();
    const help = formatParameterHelp("audit", "run an audit", {
      scope: { type: "string", required: true, description: "what to audit" },
      depth: { type: "integer", default: 3 },
    });
    assert.match(help, /\/audit — run an audit/);
    assert.match(help, /Arguments:/);
    assert.match(help, /scope \(string, required\) — what to audit/);
    assert.match(help, /depth \(integer, optional, default: 3\)/);
  });

  it("renders 'No arguments.' for an empty schema", async () => {
    const { formatParameterHelp } = await load();
    assert.match(formatParameterHelp("plain", "no args"), /No arguments\./);
  });
});

describe("registerSavedWorkflow", () => {
  it("registers a command with the workflow name", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands } = makeCommandRegistryPi();
    const wf = {
      name: "test-workflow",
      script: "export const meta = { name: 't', description: 't' };",
      description: "A test",
      location: "project" as const,
    };

    registerSavedWorkflow(pi, "/cwd", wf as SavedWorkflow);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, "test-workflow");
  });

  it("is idempotent — second registration is skipped", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands } = makeCommandRegistryPi(["test-workflow"]);
    const wf = {
      name: "test-workflow",
      script: "export const meta = { name: 't', description: 't' };",
      location: "project" as const,
    };

    registerSavedWorkflow(pi, "/cwd", wf as SavedWorkflow);
    assert.equal(commands.length, 0, "should not re-register when already present");
  });

  it("registers multiple saved workflows", async () => {
    const { registerAllSavedWorkflows } = await load();
    const { pi, commands } = makeCommandRegistryPi();
    const storage = {
      list: () => [
        { name: "wf1", script: "export..." },
        { name: "wf2", script: "export..." },
      ],
    };

    registerAllSavedWorkflows(pi, "/cwd", storage as never);
    assert.deepEqual(
      commands.map((c) => c.name),
      ["wf1", "wf2"],
    );
  });

  it("runs through WorkflowManager when provided — without blocking or duplicating delivery (#104)", async () => {
    const { registerSavedWorkflow } = await load();
    let startedBackground = false;
    const manager = {
      startInBackground: (_script: string, _args: unknown) => {
        startedBackground = true;
        // Never resolves: if the handler awaited the run (the old blocking
        // behavior), this test would hang instead of passing.
        return { runId: "test-run", promise: new Promise(() => {}) };
      },
    };

    const { pi, commands, sent } = makeCommandRegistryPi();
    const wf = { name: "run-via-manager", script: "export...", location: "project" as const };
    registerSavedWorkflow(pi, "/cwd", wf as SavedWorkflow, manager as never);

    const { ctx, notified } = makeNotifyCtx();
    await commands[0].handler("", ctx);

    assert.equal(startedBackground, true, "should use startInBackground when manager provided");
    // Result delivery for managed background runs is installResultDelivery's job;
    // the handler sending its own copy too was the double-delivery bug.
    assert.equal(sent.length, 0, "handler must not send its own result message on the manager path");
    assert.equal(notified.length, 1);
    assert.equal(notified[0].type, "info");
    assert.ok(notified[0].message.includes("test-run"), "start notice should include the run id");
  });

  it("falls back to runWorkflow (inline) when no manager is provided", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands, sent } = makeCommandRegistryPi();

    // A script with no agent() calls runs to completion inline without a manager.
    const wf = {
      name: "run-inline",
      script: "export const meta = { name: 't', description: 't' };\nreturn { report: 'done' };",
      location: "project" as const,
    };
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      registerSavedWorkflow(pi, "/cwd", wf as SavedWorkflow); // no manager

      const { ctx } = makeNotifyCtx();
      await withFakeHomeAsync(fakeHome, async () => commands[0].handler("", ctx));
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }

    // The inline fallback ran to completion and delivered the report — proving it
    // did not crash on the missing manager and actually executed runWorkflow().
    assert.equal(sent.length, 1, "fallback should deliver exactly one result message");
    assert.equal(sent[0].customType, "workflow:run-inline");
    assert.ok(sent[0].content?.includes("done"), "delivered content should include the workflow's report");
  });

  it("a deleted workflow's lingering command notifies and does not run", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands, sent } = makeCommandRegistryPi();

    const wf = {
      name: "gone",
      script: "export const meta = { name: 't', description: 't' };\nreturn 1;",
      location: "project" as const,
    };
    // exists() reports the workflow has been deleted from storage.
    registerSavedWorkflow(pi, "/cwd", wf as SavedWorkflow, undefined, () => false);

    const { ctx, notified } = makeNotifyCtx();
    await commands[0].handler("", ctx);

    assert.equal(sent.length, 0, "a deleted workflow should not run or deliver a result");
    assert.equal(notified.length, 1, "the user should be told the command is stale");
    assert.match(notified[0].message, /deleted/i);
  });

  it("--help lists the declared argument schema without starting a run", async () => {
    const { registerSavedWorkflow } = await load();
    let started = 0;
    const manager = {
      startInBackground: () => {
        started++;
        return { runId: "should-not-happen" };
      },
    };

    const { pi, commands, sent } = makeCommandRegistryPi();
    const wf = {
      name: "typed-run",
      script: "export const meta = { name: 't', description: 't' };",
      description: "typed workflow",
      location: "project" as const,
      parameters: { scope: { type: "string", required: true, description: "what to scan" } },
    };
    registerSavedWorkflow(pi, "/cwd", wf as unknown as SavedWorkflow, manager as never);

    const { ctx, notified } = makeNotifyCtx();
    for (const token of ["--help", "help", "-h"]) {
      await commands[0].handler(token, ctx);
    }
    assert.equal(started, 0, "--help must not start a run");
    assert.equal(sent.length, 0, "--help must not deliver a result");
    assert.equal(notified.length, 3, "each help token notifies");
    assert.match(notified[0].message, /\/typed-run — typed workflow/);
    assert.match(notified[0].message, /scope \(string, required\)/);
  });
});
