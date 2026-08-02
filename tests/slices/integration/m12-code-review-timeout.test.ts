/**
 * Slice V2 (test-suite) — M12 coverage gap: no slice shipped a test for the
 * /code-review diff-exec timeout (report §6 "M12: /code-review timeout test —
 * hung `gh` stub ⇒ timeout error, not hang").
 *
 * src/builtin-commands.ts captures `execFileAsync = promisify(execFile)` at
 * module scope, and Node's named-export bindings for CJS builtins are
 * snapshots — so `mock.method` on child_process cannot reach it. Instead a
 * resolve hook (the same mechanism import-survival.test.ts uses) redirects
 * ONLY the `node:child_process` import made by builtin-commands to a
 * controllable double. That lets tests assert the M12 wiring (the timeout /
 * SIGKILL / maxBuffer options actually passed to the child) and drive the
 * hung-process ETIMEDOUT path without spawning a real process. The companion
 * file m12-code-review-real-git.test.ts covers the success flow against the
 * real git binary.
 */
import { registerHooks } from "node:module";

const mockUrl = new URL("./mocks/child-process-mock.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    // Surgical: only the /code-review diff exec gets the double. Everything
    // else (node internals, other modules) keeps the real child_process.
    if (specifier === "node:child_process" && context.parentURL?.includes("builtin-commands")) {
      return { url: mockUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseWorkflowScript } from "../../../src/workflow.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "../../helpers/mock-pi.js";
import * as execMock from "./mocks/child-process-mock.mjs";

let registerBuiltinWorkflows: (pi: ExtensionAPI, opts: { cwd: string; manager: unknown }) => void;

before(async () => {
  const mod = await import("../../../src/builtin-commands.js");
  registerBuiltinWorkflows = mod.registerBuiltinWorkflows;
});

/** Fake manager recording background starts (same shape as the builtin-commands tests). */
function makeFakeManager() {
  const started: Array<{ script: string; args: Record<string, unknown>; exec: Record<string, unknown> }> = [];
  const manager = {
    startInBackground(script: string, args?: unknown, exec: Record<string, unknown> = {}) {
      started.push({ script, args: (args ?? {}) as Record<string, unknown>, exec });
      return { runId: `run-m12-${started.length}`, promise: new Promise(() => {}) };
    },
  };
  return { manager, started };
}

/** Register /code-review and return its handler + capture sinks. */
function registerCodeReview() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-m12-"));
  const { pi, commands } = makeCommandRegistryPi();
  const { ctx, notified } = makeNotifyCtx();
  const { manager, started } = makeFakeManager();
  registerBuiltinWorkflows(pi, { cwd, manager });
  const command = commands.find((c) => c.name === "code-review");
  assert.ok(command, "code-review must be registered");
  const handler = command.handler as (args: string, c: ExtensionCommandContext) => Promise<void>;
  return { handler, ctx, notified, started, cwd };
}

test("M12: /code-review passes a hard timeout + SIGKILL to the diff exec and notifies before it runs", async () => {
  execMock.calls.length = 0;
  // Real execFile's callback is (err, stdout, stderr) — promisify resolves
  // { stdout, stderr } only when BOTH values are passed; a single value would
  // resolve a bare string and leave the handler's `stdout` destructure empty.
  execMock.setResponder((_cmd, _args, _options, callback) => callback(null, "diff --git a/x.ts b/x.ts\n+line\n", ""));

  const { handler, ctx, notified, started, cwd } = registerCodeReview();
  try {
    await handler("", ctx);

    // The exec received the M12 wiring: hard deadline, uncatchable kill, the
    // raised capture buffer, all scoped to the handler's cwd.
    assert.equal(execMock.calls.length, 1, "exactly one diff exec for an empty /code-review");
    assert.equal(execMock.calls[0].cmd, "git");
    assert.deepEqual(execMock.calls[0].args, ["diff", "HEAD"]);
    assert.equal(execMock.calls[0].options.timeout, 60_000, "a hung gh/git must be killed after 60s (M12)");
    assert.equal(execMock.calls[0].options.killSignal, "SIGKILL", "the kill signal must be uncatchable (M12)");
    assert.equal(execMock.calls[0].options.maxBuffer, 64 * 1024 * 1024);
    assert.equal(execMock.calls[0].options.cwd, cwd);

    // Pre-exec progress feedback (M12: the fetch used to be silent).
    assert.ok(
      notified.some((n) => n.message.includes("Fetching diff from git diff HEAD")),
      `pre-exec notify must name the source; got: ${JSON.stringify(notified)}`,
    );

    // The fetched diff flows into the review run.
    assert.equal(started.length, 1, "the review starts after a successful diff fetch");
    assert.equal(started[0].args.diff, "diff --git a/x.ts b/x.ts\n+line\n");
    assert.equal(started[0].args.diffSource, "git diff HEAD");
    assert.equal(started[0].args.diffTruncated, false);
    const { meta } = parseWorkflowScript(started[0].script);
    assert.equal(meta.name, "code_review");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("M12: a hung diff exec surfaces a timeout error — no hang, no started run", async () => {
  execMock.calls.length = 0;
  execMock.setResponder((_cmd, _args, _options, callback) => callback(execMock.etimedout("spawn gh ETIMEDOUT"), ""));

  const { handler, ctx, notified, started, cwd } = registerCodeReview();
  try {
    // Numeric input routes to `gh pr diff <n>` — the hung-gh scenario M12 guards.
    await handler("4821", ctx);

    assert.equal(execMock.calls.length, 1);
    assert.equal(execMock.calls[0].cmd, "gh");
    assert.deepEqual(execMock.calls[0].args, ["pr", "diff", "4821"]);
    assert.equal(started.length, 0, "a timed-out diff must never start the review");
    assert.ok(
      notified.some(
        (n) => n.type === "error" && /timed out after 60s/.test(n.message) && n.message.includes("gh pr diff 4821"),
      ),
      `the timeout must be surfaced with the source and deadline; got: ${JSON.stringify(notified)}`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("M12: a diff source that fails to run is surfaced as an error notify, not swallowed", async () => {
  execMock.calls.length = 0;
  const failure = new Error("fatal: not a git repository") as Error & { code?: string };
  failure.code = "128";
  execMock.setResponder((_cmd, _args, _options, callback) => callback(failure, ""));

  const { handler, ctx, notified, started, cwd } = registerCodeReview();
  try {
    await handler("src/a.ts", ctx);
    assert.equal(execMock.calls[0].cmd, "git");
    assert.equal(started.length, 0, "a failed diff fetch must not start the review");
    assert.ok(
      notified.some((n) => n.type === "error" && /Failed to get diff/.test(n.message)),
      `the fetch failure must be reported; got: ${JSON.stringify(notified)}`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
