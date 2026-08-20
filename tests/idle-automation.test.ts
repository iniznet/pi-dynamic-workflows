/**
 * I2 — run-level idle automation (design-final.json §agentIdleAutomation).
 *
 * Verifies the manager-side idle watcher:
 *  1. a stuck agent (no activity for agentIdleTimeoutMs) is aborted via its
 *     per-attempt controller and AUTO-RESUMED through the EXISTING journaled
 *     retry machinery (the abort surfaces as recoverable AGENT_IDLE, the retry
 *     is a positional call with the precomputed hash, and only the FINAL
 *     attempt journals);
 *  2. escalation after the idle-retry budget: once committed idle aborts reach
 *     the budget, the next idle abort routes through the manual-kill channel
 *     as AGENT_IDLE_EXHAUSTED (recoverable, absorbed, never blind-retried)
 *     with a clear deterministic marker;
 *  3. the conditional default budget (agentIdleRetries unset → 1 when the idle
 *     timeout is enabled) gives exactly one idle retry before escalation — and
 *     works with the DOCUMENTED default agentRetries=0 (idle slots are
 *     independent of provider-outage retries);
 *  4. fresh grace per retry: a retried attempt's controller reappearance
 *     re-stamps activity, so a long retryBackoffMs cannot age the stamp into an
 *     immediate second abort (df-2);
 *  5. no abort while output flows: agents stamping message-boundary history
 *     OR the onActivity bridge (tool_execution events and message events —
 *     streaming bash output, one long message) inside the window are never
 *     idle-aborted (df-7 / df-7(a));
 *  6. the stalling hard bound (df-5): an attempt with K consecutive command
 *     idle-kills (recorded under the AGENT label via the production
 *     resolveCommandWatchdogOptions label fn + agentLabelContext) is aborted
 *     even while tool results flow;
 *  7. resume determinism: an idle-killed call journals ONLY its final attempt,
 *     and a resumed run replays it from the journal instead of re-running;
 *  8. disabled by default: no knobs → the watcher never aborts anything.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBashToolDefinition, createCodingTools, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentUsage, WorkflowAgent } from "../src/agent.js";
import { builtinToolsetTools } from "../src/builtin-workflows.js";
import { applyCommandWatchdogToTools, getCommandWatchdogRegistry } from "../src/command-watchdog.js";
import { resolveCommandWatchdogOptions } from "../src/config.js";
import { WorkflowErrorCode } from "../src/errors.js";
import { McpToolsManager } from "../src/subagent/mcp-tools.js";
import { SubagentToolsAssembler } from "../src/subagent/subagent-tools-assembler.js";
import { IDLE_NUDGE } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { rmForce } from "./helpers/rm-force.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run each test with isolated cwd + HOME so workflow state is isolated. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-idle-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-idle-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      await rmForce(cwd, fakeHome);
    }
  };
}

interface IdleMockRunOptions {
  signal?: AbortSignal;
  onUsage?: (u: AgentUsage) => void;
  onHistory?: (history: unknown[]) => void;
  /** I2 activity bridge: throttled full-session activity events (tool_execution / message events). */
  onActivity?: () => void;
}

/** Reject like the SDK does when the attempt's controller aborts. */
function abortRejection(options?: IdleMockRunOptions): Promise<never> {
  return new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new Error("Subagent was aborted")), { once: true });
  });
}

/**
 * Mock agent: attempt 1 hangs until its controller aborts (a stuck agent),
 * every later attempt resolves. Counts attempts per prompt.
 */
function stuckThenResolveAgent(resolveValue = "done-after-idle") {
  let calls = 0;
  const prompts: string[] = [];
  return {
    runner: {
      async run(prompt: string, options?: IdleMockRunOptions): Promise<any> {
        calls++;
        prompts.push(prompt);
        if (calls === 1) return abortRejection(options);
        options?.onUsage?.({
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          cost: 0,
        });
        return prompt === "first" ? "a-done" : resolveValue;
      },
    } as unknown as Pick<WorkflowAgent, "run">,
    get calls() {
      return calls;
    },
    get prompts() {
      return prompts;
    },
  };
}

/** Mock agent whose EVERY attempt hangs until aborted (for escalation tests). */
function alwaysStuckAgent() {
  let calls = 0;
  const aborted = new Set<number>();
  return {
    runner: {
      async run(_prompt: string, options?: IdleMockRunOptions): Promise<any> {
        calls++;
        const attempt = calls;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted.add(attempt);
              reject(new Error("Subagent was aborted"));
            },
            { once: true },
          );
        });
      },
    } as unknown as Pick<WorkflowAgent, "run">,
    get calls() {
      return calls;
    },
    get abortedAttempts() {
      return aborted.size;
    },
  };
}

const oneAgentScript = `export const meta = { name: 'idle_demo', description: 'idle watcher' }
phase('Work')
const a = await agent('do it', { label: 'a' })
return { a }`;

/**
 * Single-agent script whose call is wrapped in parallel() so a recoverable
 * kill is ABSORBED as a null item (the escalation contract) instead of
 * propagating to the script top level (a sequential top-level kill settles
 * the run failed).
 */
const parallelAgentScript = `export const meta = { name: 'idle_esc_demo', description: 'idle escalation' }
phase('Work')
const xs = await parallel([() => agent('do it', { label: 'a' })])
return { a: xs[0] }`;

test(
  "I2: a stuck agent is idle-aborted and auto-resumed via the retry machinery; only the final attempt journals",
  withTempCwd(async (cwd) => {
    const stuck = stuckThenResolveAgent("done-after-idle");
    const manager = new WorkflowManager({ cwd, agent: stuck.runner, idleCheckIntervalMs: 50 });
    const result = await manager.runSync(oneAgentScript, undefined, {
      agentIdleTimeoutMs: 300,
      agentRetries: 1,
      retryBackoffMs: 0,
    });

    assert.equal(stuck.calls, 2, "attempt 1 was aborted for idling, attempt 2 ran to completion");
    assert.equal(
      (result.result as { a?: unknown }).a,
      "done-after-idle",
      "the auto-resumed attempt produced the result",
    );
    // I2 nudge (df-6): the retried attempt runs the ORIGINAL prompt + the fixed
    // deterministic nudge — never a bare re-run.
    assert.ok(stuck.prompts[1]?.includes(IDLE_NUDGE), "the retried attempt's prompt carries the fixed idle nudge");
    assert.ok(
      stuck.prompts[1]?.startsWith("do it"),
      "the nudge APPENDS to the original prompt (deterministic given config)",
    );
    // Only the FINAL attempt journals — the idle kill is a runtime event. A
    // completed run drops its journal from disk, so read the in-memory run.
    const journal = manager.getRun(result.runId as string)?.journal ?? [];
    assert.equal(journal.length, 1, "one journaled call for the single agent()");
    assert.equal(journal[0].result, "done-after-idle", "the journal holds the final attempt's result");
    // The abort is visible on the run's snapshot log (deterministic text —
    // configured threshold, never wall-clock). `result.logs` carries only the
    // script-level log() output; the watcher writes to the snapshot log ring.
    const logs = (manager.getRun(result.runId as string)?.snapshot.logs ?? []).join("\n");
    assert.match(logs, /idle for 300ms/, "the run log names the configured idle threshold");
    assert.match(logs, /idle kill 1\/1/, "the run log names the committed kill counter and budget");
  }),
);

test(
  "I2: escalation after the idle budget — the next idle abort settles AGENT_IDLE_EXHAUSTED with a clear marker",
  withTempCwd(async (cwd) => {
    const stuck = alwaysStuckAgent();
    const manager = new WorkflowManager({ cwd, agent: stuck.runner, idleCheckIntervalMs: 50 });
    manager.on("error", () => {});
    const result = await manager.runSync(parallelAgentScript, undefined, {
      agentIdleTimeoutMs: 300,
      agentIdleRetries: 1, // one in-budget retry, then escalation
      agentRetries: 1, // maxAttempts includes the idle slot — the retry slot exists independently
      retryBackoffMs: 0,
    });

    assert.equal(stuck.calls, 2, "attempt 1 idle-retried, attempt 2 escalated (no blind third attempt)");
    assert.equal(stuck.abortedAttempts, 2, "both attempts were aborted by the watcher");
    assert.equal((result.result as { a?: unknown }).a, null, "the escalated call settles as an absorbed null item");
    // The escalated call settles AGENT_IDLE_EXHAUSTED on its snapshot row (the
    // escalation throws before the failedAgents record is built, so the row +
    // log are the surface for an idle escalation).
    const run = manager.getRun(result.runId as string);
    const escalated = run?.snapshot.agents.find((a) => a.label === "a");
    assert.equal(
      escalated?.errorCode,
      WorkflowErrorCode.AGENT_IDLE_EXHAUSTED,
      "escalation routes through the manual-kill channel with the idle-specific code",
    );
    assert.equal(escalated?.recoverable, true, "the escalated item stays recoverable (absorbed, never run-fatal)");
    // The snapshot row carries the deterministic escalation marker.
    assert.match(escalated?.error ?? "", /exhausted its idle budget/, "the agent row names the reason + knobs");
    const logs = (run?.snapshot.logs ?? []).join("\n");
    assert.match(logs, /exhausted its idle budget/, "the run log carries the escalation marker");
  }),
);

test(
  "I2: unset agentIdleRetries resolves the conditional default (1 when the idle timeout is enabled)",
  withTempCwd(async (cwd) => {
    const stuck = alwaysStuckAgent();
    const manager = new WorkflowManager({ cwd, agent: stuck.runner, idleCheckIntervalMs: 50 });
    manager.on("error", () => {});
    const result = await manager.runSync(parallelAgentScript, undefined, {
      agentIdleTimeoutMs: 300,
      // agentIdleRetries omitted → conditional default 1 (idle-retries-conditional-default)
      agentRetries: 1,
      retryBackoffMs: 0,
    });

    assert.equal(stuck.calls, 2, "exactly one idle retry before escalation (budget defaults to 1 when enabled)");
    assert.equal(
      (result.result as { a?: unknown }).a,
      null,
      "the second idle abort escalates (AGENT_IDLE_EXHAUSTED, absorbed)",
    );
  }),
);

test(
  "I2: the documented default config (agentIdleRetries unset + agentRetries 0) still auto-resumes an idle abort exactly once",
  withTempCwd(async (cwd) => {
    // The README-documented default: agentRetries left at its default 0 and
    // agentIdleRetries unset — idle slots must be INDEPENDENT of the
    // provider-outage budget, so an idle abort still gets its one retry.
    const stuck = alwaysStuckAgent();
    const manager = new WorkflowManager({ cwd, agent: stuck.runner, idleCheckIntervalMs: 50 });
    manager.on("error", () => {});
    const result = await manager.runSync(parallelAgentScript, undefined, {
      agentIdleTimeoutMs: 300,
      agentRetries: 0, // the real default — no provider-outage retries at all
      retryBackoffMs: 0,
    });

    assert.equal(stuck.calls, 2, "attempt 1 idle-retried on an IDLE slot, attempt 2 escalated");
    assert.equal(
      (result.result as { a?: unknown }).a,
      null,
      "the escalated call settles as an absorbed null item (never run-fatal)",
    );
    const run = manager.getRun(result.runId as string);
    const escalated = run?.snapshot.agents.find((a) => a.label === "a");
    assert.equal(
      escalated?.errorCode,
      WorkflowErrorCode.AGENT_IDLE_EXHAUSTED,
      "the second idle abort escalated with the idle-specific code",
    );
  }),
);

test(
  "I2: explicit agentIdleRetries 0 exhausts on the FIRST idle abort",
  withTempCwd(async (cwd) => {
    const stuck = alwaysStuckAgent();
    const manager = new WorkflowManager({ cwd, agent: stuck.runner, idleCheckIntervalMs: 50 });
    manager.on("error", () => {});
    const result = await manager.runSync(parallelAgentScript, undefined, {
      agentIdleTimeoutMs: 300,
      agentIdleRetries: 0,
      agentRetries: 1, // would otherwise allow a retry — the budget must gate it
      retryBackoffMs: 0,
    });

    assert.equal(stuck.calls, 1, "a 0 budget escalates on the first idle abort (no retry slot consumed)");
    assert.equal((result.result as { a?: unknown }).a, null, "the escalated call settles as an absorbed null item");
    const run = manager.getRun(result.runId as string);
    const escalated = run?.snapshot.agents.find((a) => a.label === "a");
    assert.equal(
      escalated?.errorCode,
      WorkflowErrorCode.AGENT_IDLE_EXHAUSTED,
      "exhaustion routes through the kill channel with the idle-specific code (recoverable, absorbed)",
    );
  }),
);

test(
  "I2: a retried attempt gets fresh grace — a long retryBackoffMs cannot age the stamp into an immediate second abort",
  withTempCwd(async (cwd) => {
    // attempt 1 hangs (idle-aborted); attempt 2 does real work for 200ms then
    // resolves. The 400ms backoff sleeps between the retry decision and attempt
    // 2's start — without the per-attempt-start re-stamp (df-2), attempt 2
    // would look idle (~400ms old stamp) and be aborted immediately.
    let calls = 0;
    const agent = {
      async run(_prompt: string, options?: IdleMockRunOptions): Promise<any> {
        calls++;
        if (calls === 1) return abortRejection(options);
        await sleep(200);
        return "grace-ok";
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent, idleCheckIntervalMs: 50 });
    const result = await manager.runSync(oneAgentScript, undefined, {
      agentIdleTimeoutMs: 300,
      agentRetries: 1,
      retryBackoffMs: 400,
    });

    assert.equal(calls, 2, "attempt 2 ran its full grace window instead of being aborted early");
    assert.equal((result.result as { a?: unknown }).a, "grace-ok", "the retried attempt completed");
  }),
);

test(
  "I2: no abort while output flows — message-boundary history stamps keep the agent alive",
  withTempCwd(async (cwd) => {
    let calls = 0;
    const aborted = false;
    const agent = {
      async run(_prompt: string, options?: IdleMockRunOptions): Promise<any> {
        calls++;
        // Stream history every 50ms for 600ms (well past the 200ms window),
        // then resolve — an actively-working agent must never be idle-aborted.
        for (let i = 0; i < 12 && !aborted; i++) {
          options?.onHistory?.([{ role: "assistant", content: `chunk ${i}` }]);
          await sleep(50);
        }
        return "streamed-ok";
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent, idleCheckIntervalMs: 50 });
    const result = await manager.runSync(oneAgentScript, undefined, {
      agentIdleTimeoutMs: 200,
      agentRetries: 1,
      retryBackoffMs: 0,
    });

    assert.equal(calls, 1, "the streaming agent was never idle-aborted");
    assert.equal((result.result as { a?: unknown }).a, "streamed-ok", "the streaming agent completed normally");
  }),
);

test(
  "I2: df-7(a) — streaming bash output (onActivity from tool_execution events) never idle-kills a working agent",
  withTempCwd(async (cwd) => {
    let calls = 0;
    const agent = {
      async run(_prompt: string, options?: IdleMockRunOptions): Promise<any> {
        calls++;
        // Simulate the session's activity bridge: a bash command streaming
        // output emits tool_execution_update events → the runner's throttled
        // onActivity. 12 stamps over 600ms (well past the 200ms window) — an
        // actively-streaming agent must never be idle-aborted.
        for (let i = 0; i < 12; i++) {
          options?.onActivity?.();
          await sleep(50);
        }
        return "streamed-bash-ok";
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent, idleCheckIntervalMs: 50 });
    const result = await manager.runSync(oneAgentScript, undefined, {
      agentIdleTimeoutMs: 200,
      agentRetries: 1,
      retryBackoffMs: 0,
    });

    assert.equal(calls, 1, "the streaming-bash agent was never idle-aborted");
    assert.equal((result.result as { a?: unknown }).a, "streamed-bash-ok", "the agent completed normally");
  }),
);

test(
  "I2: df-7(a) — one long assistant message (message_update stream via onActivity) never idle-kills the agent",
  withTempCwd(async (cwd) => {
    let calls = 0;
    const agent = {
      async run(_prompt: string, options?: IdleMockRunOptions): Promise<any> {
        calls++;
        // A single long message: the model streams one assistant message for
        // 600ms (message_update events → onActivity at the runner's throttle),
        // then answers. Message boundaries never fire mid-message — only the
        // activity bridge keeps the watcher's stamp fresh.
        for (let i = 0; i < 12; i++) {
          options?.onActivity?.();
          await sleep(50);
        }
        return "long-message-ok";
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent, idleCheckIntervalMs: 50 });
    const result = await manager.runSync(oneAgentScript, undefined, {
      agentIdleTimeoutMs: 200,
      agentRetries: 1,
      retryBackoffMs: 0,
    });

    assert.equal(calls, 1, "the long-message agent was never idle-aborted");
    assert.equal((result.result as { a?: unknown }).a, "long-message-ok", "the agent completed normally");
  }),
);

test(
  "I2: the stalling hard bound fires through PRODUCTION wiring — command idle-kills recorded under the agent label escalate (df-5)",
  withTempCwd(async (cwd) => {
    // Production wiring, no manual registry seeding: the toolset is built with
    // the same functions the extension uses (resolveCommandWatchdogOptions →
    // applyCommandWatchdogToTools), and the workflow layer's agentLabelContext
    // (set around every agentRunner.run) makes the watchdog record the kills
    // under the AGENT label — the exact key the manager's isStalling checks.
    const label = `stall-probe-${Date.now()}`;
    const registry = getCommandWatchdogRegistry();
    const wrappedToolset = applyCommandWatchdogToTools(
      [createBashToolDefinition(cwd)] as ToolDefinition[],
      cwd,
      resolveCommandWatchdogOptions({ commandIdleTimeoutMs: 80, commandHardTimeoutMs: 0 }),
    );
    const bashExecute = wrappedToolset.find((d) => d.name === "bash")?.execute;
    assert.ok(bashExecute, "the production toolset carries a watchdog-wrapped bash def");
    // Loose call signature for the test: the SDK's execute takes an ExtensionContext
    // (unused by the wrapped local backend) which is awkward to fabricate.
    const runBash = bashExecute as unknown as (
      toolCallId: string,
      args: { command: string; timeout?: number },
      signal?: AbortSignal,
      onUpdate?: () => void,
    ) => Promise<unknown>;
    try {
      let aborted = false;
      const agent = {
        async run(_prompt: string, options?: IdleMockRunOptions): Promise<any> {
          // 3 real command executions, each idle-killed by the watchdog after
          // 80ms (the node command emits nothing). The kill marker returns as a
          // normal tool result; activity keeps flowing (onHistory) so ONLY the
          // stalling bound can abort this attempt.
          for (let i = 0; i < 3; i++) {
            options?.onHistory?.([{ role: "assistant", content: `command ${i} killed` }]);
            await runBash("1", { command: 'node -e "setTimeout(()=>{},5000)"' }, undefined, () => {});
          }
          // Hang so a watcher tick can observe isStalling and abort.
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("Subagent was aborted"));
              },
              { once: true },
            );
          });
        },
      } as unknown as Pick<WorkflowAgent, "run">;
      const manager = new WorkflowManager({ cwd, agent, idleCheckIntervalMs: 50 });
      manager.on("error", () => {});
      const script = `export const meta = { name: 'stall_demo', description: 'stalling bound' }
phase('Work')
const xs = await parallel([() => agent('x', { label: '${label}' })])
return { a: xs[0] }`;
      const result = await manager.runSync(script, undefined, {
        agentIdleTimeoutMs: 10_000, // the idle window alone would never fire
        agentIdleRetries: 0, // escalate on the first stalling observation
        agentRetries: 0,
        retryBackoffMs: 0,
      });

      assert.equal(aborted, true, "the stalling attempt was aborted despite continuous activity");
      assert.equal((result.result as { a?: unknown }).a, null, "the escalated call settles as an absorbed null item");
      // Production wiring proof: the kills accumulated under the AGENT label in
      // the SHARED registry (the manager's isStalling read the same key).
      const entry = registry.getEntry(label);
      assert.ok(entry, "the shared registry recorded the agent label");
      assert.ok(
        (entry?.consecutiveIdleKills ?? 0) >= 3,
        "three consecutive idle-kills were recorded under the agent label",
      );
      assert.equal(registry.isStalling(label), true, "isStalling flips at the bound");
    } finally {
      registry.resetAttempt(label);
    }
  }),
);

test(
  "I2: resume replays an idle-killed call's journaled final attempt instead of re-running it",
  withTempCwd(async (cwd) => {
    let aCalls = 0;
    let bCalls = 0;
    const agent = {
      async run(prompt: string, options?: IdleMockRunOptions): Promise<any> {
        // The retried 'a' attempt carries the ORIGINAL prompt + the idle nudge,
        // so match on the prefix (never the exact string).
        if (prompt.startsWith("first")) {
          aCalls++;
          if (aCalls === 1) return abortRejection(options); // idle-aborted on attempt 1
          return "a-done";
        }
        bCalls++;
        if (bCalls === 1) return new Promise(() => {}); // 'b' hangs in the first execution → pause point
        return "b-done"; // the resumed execution resolves it
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent, idleCheckIntervalMs: 50 });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'idle_resume_demo', description: 'resume after idle kill' }
phase('Work')
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

    const { runId, promise } = manager.startInBackground(script, undefined, {
      agentIdleTimeoutMs: 300,
      agentRetries: 1,
      retryBackoffMs: 0,
    });
    promise.catch(() => {});
    // Wait for 'a' to settle (aborted + retried) and 'b' to start hanging.
    for (let i = 0; i < 400 && (aCalls < 2 || bCalls < 1); i++) {
      await sleep(20);
    }
    assert.equal(aCalls, 2, "'a' was idle-aborted once and retried to completion");
    assert.equal(bCalls, 1, "'b' is hanging");

    assert.equal(manager.pause(runId), true);
    const paused = manager.getPersistence().load(runId);
    assert.equal(paused?.status, "paused");
    assert.equal((paused?.journal ?? []).length, 1, "the idle-killed call journaled only its final attempt");
    assert.equal(paused?.journal?.[0].result, "a-done", "the journal holds 'a's retried result");
    assert.equal(paused?.agentIdleTimeoutMs, 300, "the idle threshold is frozen on the run and persisted for resume");

    assert.equal(await manager.resume(runId), true);
    for (let i = 0; i < 400 && manager.getRun(runId)?.status === "running"; i++) {
      await sleep(20);
    }
    const resumed = manager.getPersistence().load(runId);
    assert.equal(resumed?.status, "completed", "the resumed run completed");
    assert.equal(aCalls, 2, "'a' REPLAYED from the journal on resume — never re-run");
    assert.equal(bCalls, 2, "'b' (unsettled at pause) re-ran live and completed");
    assert.deepEqual(resumed?.result, { a: "a-done", b: "b-done" }, "the final result combines replay + live work");
  }),
);

test(
  "I2: disabled by default — no knobs, the watcher never aborts a hanging agent",
  withTempCwd(async (cwd) => {
    let calls = 0;
    const agent = {
      async run(_prompt: string, _options?: IdleMockRunOptions): Promise<any> {
        calls++;
        return new Promise(() => {}); // hangs forever
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent, idleCheckIntervalMs: 50 });
    const { runId, promise } = manager.startInBackground(oneAgentScript, undefined);
    promise.catch(() => {});
    // The agent would have been aborted within ~300ms had a watcher been armed.
    await sleep(600);
    assert.equal(calls, 1, "the hanging agent was never aborted by an idle watcher");
    assert.equal(manager.getRun(runId)?.status, "running", "the run is still executing");
    manager.stop(runId);
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// MF-6 — bash-injection wiring: every subagent bash path carries the
// watchdog-wrapped execute when the knobs are active (and third-party bash is
// never rebind to the local backend).
// ═══════════════════════════════════════════════════════════════════════════

function thirdPartyBashDef(name = "bash"): ToolDefinition {
  return {
    name,
    label: name,
    description: "Third-party remote bash",
    parameters: Type.Object({ command: Type.String() }),
    async execute() {
      return { content: [{ type: "text", text: "remote" }], details: undefined };
    },
  };
}

function assertBashWrapped(toolset: ToolDefinition[], originalExecute: ToolDefinition["execute"]): void {
  const bash = toolset.find((d) => d.name === "bash");
  assert.ok(bash, "toolset carries a bash def");
  assert.notEqual(
    bash?.execute,
    originalExecute,
    "the host-origin bash execute was rebound to the watchdog-wrapped backend",
  );
}

test(
  "MF-6: the default assembler toolset wraps the HOST bash but never a third-party/MCP bash def",
  withTempCwd(async (cwd) => {
    const hostBash = createCodingTools(cwd).find((d) => d.name === "bash");
    assert.ok(hostBash, "the host coding bundle has a bash def");
    // A remote server's bash tool survives the name dedupe under its mcp_ prefix
    // and must keep its OWN execute — never rebound to the local backend.
    const remoteBash = thirdPartyBashDef("mcp_remote_bash");
    const assembler = new SubagentToolsAssembler({
      mode: "all",
      cwd,
      hostTools: () => [...createCodingTools(cwd)],
      mcpTools: new McpToolsManager(),
      extensionTools: () => [remoteBash],
      commandWatchdog: () => resolveCommandWatchdogOptions({ commandIdleTimeoutMs: 1000, commandHardTimeoutMs: 0 }),
    });
    const toolset = await assembler.assemble();
    // Host bash wrapped; the third-party (mcp-prefixed) bash untouched.
    assertBashWrapped(toolset, hostBash?.execute);
    const remoteInMerged = toolset.find((d) => d.name === "mcp_remote_bash");
    assert.equal(
      remoteInMerged?.execute,
      remoteBash.execute,
      "the third-party remote bash def was NOT rebound to the local backend",
    );
  }),
);

test(
  "MF-6: a builtin pattern toolset's bash def is watchdog-wrapped via the shared supplier",
  withTempCwd(async (cwd) => {
    const hostBash = createCodingTools(cwd).find((d) => d.name === "bash");
    assert.ok(hostBash);
    const toolset = await builtinToolsetTools(
      cwd,
      "plan-then-execute", // carries bash
      undefined,
      () => resolveCommandWatchdogOptions({ commandIdleTimeoutMs: 1000, commandHardTimeoutMs: 0 }),
    );
    assertBashWrapped(toolset, hostBash?.execute);
  }),
);

test(
  "MF-6: the agent runner wraps its own raw default coding tools ('off'-mode / direct-embed path)",
  withTempCwd(async (cwd) => {
    const rawBash = createCodingTools(cwd).find((d) => d.name === "bash");
    assert.ok(rawBash);
    const agent = new WorkflowAgent({
      cwd,
      commandWatchdog: () => resolveCommandWatchdogOptions({ commandIdleTimeoutMs: 1000, commandHardTimeoutMs: 0 }),
    }) as unknown as { baseTools: ToolDefinition[] };
    assertBashWrapped(agent.baseTools, rawBash?.execute);
    // Caller-supplied tools (already wrapped at the assembly choke point) are
    // never double-wrapped by the constructor.
    const callerTools = [...createCodingTools(cwd)];
    const explicitAgent = new WorkflowAgent({
      cwd,
      tools: callerTools,
      commandWatchdog: () => resolveCommandWatchdogOptions({ commandIdleTimeoutMs: 1000, commandHardTimeoutMs: 0 }),
    }) as unknown as { baseTools: ToolDefinition[] };
    assert.equal(explicitAgent.baseTools, callerTools, "explicit tools are used as-is (no double wrap)");
  }),
);
