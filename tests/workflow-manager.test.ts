import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentUsage, WorkflowAgent } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { DEFAULT_RUN_LEASE_TTL_MS } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { NavigatorModel, NavigatorState, renderNavigator } from "../src/workflow-ui.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { rmForce } from "./helpers/rm-force.js";

/** Agent runner that reports fixed usage so token accounting is exercised. */
function fakeAgent(usage: Partial<AgentUsage> = {}, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  } as unknown as Pick<WorkflowAgent, "run">;
}

/** Agent that stays running until a deferred resolve is called externally. */
function deferredAgent() {
  let deferredResolve: ((value: unknown) => void) | null = null;
  let deferredReject: ((err: Error) => void) | null = null;
  const promise = new Promise((resolve, reject) => {
    deferredResolve = resolve;
    deferredReject = reject;
  });
  return {
    resolve: (value: unknown = "done") => deferredResolve?.(value),
    reject: (err: Error) => deferredReject?.(err),
    runner: {
      async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
        return promise;
      },
    } as unknown as Pick<WorkflowAgent, "run">,
  };
}

function delayedAgent(delayMs: number, result: unknown = "slow") {
  return {
    async run(_prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      options?.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
      });
      return result;
    },
  } as unknown as Pick<WorkflowAgent, "run">;
}

const oneAgentScript = `export const meta = { name: 'tracked_demo', description: 'one agent' }
phase('Work')
const a = await agent('do it', { label: 'a' })
return { a }`;

/** Two sequential agents: 'a' finishes, then 'b' starts. */
const twoAgentScript = `export const meta = { name: 'two_agent_demo', description: 'two sequential agents' }
phase('Work')
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

/** Six agents fired in parallel, all resolving instantly — used to exercise a burst of persist ticks. */
const burstAgentScript = `export const meta = { name: 'burst_demo', description: 'six agents in parallel' }
const xs = await parallel(['a','b','c','d','e','f'].map((label) => () => agent(label, { label })))
return xs`;

/**
 * Agent runner for twoAgentScript: 'a' resolves immediately, 'b' hangs forever
 * (until the run is aborted by pause()/stop()). Lets a test observe a run with
 * one done agent and one genuinely still-running agent at the same time.
 */
function firstThenHangAgent() {
  return {
    async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }): Promise<any> {
      options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      if (prompt === "first") {
        // A tiny real delay so 'a' and 'b' get distinguishable (not same-millisecond)
        // start times — proving persisted timestamps are real wall-clock captures,
        // not both stamped with one fabricated value.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "a-done";
      }
      return new Promise(() => {}); // 'second' never resolves on its own
    },
  };
}

/** Run each manager test with isolated cwd and HOME so workflow state is isolated. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-mgr-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      await rmForce(cwd, fakeHome);
    }
  };
}

test(
  "runSync registers the run so /workflows (listRuns) can see it",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ input: 100, output: 40, total: 140 }) });
    const events: string[] = [];
    for (const ev of ["agentStart", "agentEnd", "phase", "complete"]) {
      manager.on(ev, () => events.push(ev));
    }
    let progressCalls = 0;
    const result = await manager.runSync(oneAgentScript, undefined, {
      onProgress: () => {
        progressCalls++;
      },
    });

    assert.equal(result.agentCount, 1);
    assert.ok(progressCalls > 0, "onProgress should fire while the run executes");
    assert.ok(events.includes("agentStart") && events.includes("complete"), "manager emits live events");

    const runs = manager.listRuns();
    assert.equal(runs.length, 1, "the sync run is persisted and listable");
    assert.equal(runs[0].workflowName, "tracked_demo");
    assert.equal(runs[0].status, "completed");
    assert.equal(runs[0].tokenUsage?.total, 140, "token usage is persisted for the navigator");
  }),
);

test(
  "manager defaultAgentTimeoutMs applies when run options omit agentTimeoutMs",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: delayedAgent(25), defaultAgentTimeoutMs: 5 });

    const result = await manager.runSync(oneAgentScript);

    assert.equal((result.result as { a: unknown }).a, null);
    const agent = manager.listRuns()[0]?.agents[0];
    assert.equal(agent?.status, "error");
    assert.match(agent?.error ?? "", /timed out after 5ms/);
    assert.match(agent?.error ?? "", /raise or omit timeoutMs\/agentTimeoutMs/);
  }),
);

test(
  "run option agentTimeoutMs overrides manager defaultAgentTimeoutMs",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: delayedAgent(25), defaultAgentTimeoutMs: 5 });

    const result = await manager.runSync(oneAgentScript, undefined, { agentTimeoutMs: null });

    assert.equal((result.result as { a: unknown }).a, "slow");
    const agent = manager.listRuns()[0]?.agents[0];
    assert.equal(agent?.status, "done");
  }),
);

test(
  "reconfigureAfterReload refreshes defaults without replacing the live manager",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: delayedAgent(25), defaultAgentTimeoutMs: 5 });

    manager.reconfigureAfterReload({ defaultAgentTimeoutMs: 100 });
    const result = await manager.runSync(oneAgentScript);

    assert.equal((result.result as { a: unknown }).a, "slow");
    assert.equal(manager.listRuns()[0]?.agents[0]?.status, "done");
  }),
);

test(
  "an agent timeout aborts the subagent so its session can be released (#109)",
  withTempCwd(async (cwd) => {
    // A subagent whose run() never resolves on its own — only an abort ends it.
    // Before the fix, a timeout rejected the race but left this running in the
    // background with its session (and full messages) retained.
    let sawAbort = false;
    const hangingUntilAborted = {
      async run(_prompt: string, options?: { signal?: AbortSignal }): Promise<any> {
        return new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            sawAbort = true;
            reject(new Error("aborted"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    };
    const manager = new WorkflowManager({ cwd, agent: hangingUntilAborted, defaultAgentTimeoutMs: 20 });

    const result = await manager.runSync(oneAgentScript);

    // Timed out → recoverable, no retry configured, so the agent result is null.
    assert.equal((result.result as { a: unknown }).a, null);
    const agent = manager.listRuns()[0]?.agents[0];
    assert.equal(agent?.status, "error");
    assert.match(agent?.error ?? "", /timed out/);
    // The key #109 property: the timeout aborted the subagent, so run()'s finally
    // disposes its session instead of leaking it while it streams on.
    assert.equal(sawAbort, true, "the timing-out subagent must receive an abort");
  }),
);

test(
  "manager defaultTokenBudget applies when run options omit tokenBudget (#68)",
  withTempCwd(async (cwd) => {
    // Each agent reports 100 tokens against a default budget of 50: the first
    // agent completes (budget checked before start), the second throws.
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ total: 100 }), defaultTokenBudget: 50 });
    // Deliberately NO "error" listener: an unlistened EventEmitter "error" emit
    // throws, which used to abort the catch block mid-way — surfacing as
    // ERR_UNHANDLED_ERROR instead of the real error and leaking the run lease.
    await assert.rejects(manager.runSync(twoAgentScript), (err: unknown) => {
      assert.ok(err instanceof WorkflowError, `expected WorkflowError, got ${(err as Error)?.constructor?.name}`);
      assert.equal(err.code, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED);
      return true;
    });
    // The failure was persisted and the lease released (a fresh save succeeds).
    const run = manager.listRuns()[0];
    assert.equal(run?.status, "failed");
  }),
);

test(
  "run option tokenBudget overrides manager defaultTokenBudget",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ total: 100 }), defaultTokenBudget: 50 });
    // Explicit null = "no budget" beats the configured default.
    const result = await manager.runSync(twoAgentScript, undefined, { tokenBudget: null });
    assert.equal(result.agentCount, 2);
  }),
);

test(
  "resume re-resolves the run's toolset tag and keeps its start-time tokenBudget",
  withTempCwd(async (cwd) => {
    // Agent where 'first' completes (journaling it) and 'second' hangs on its
    // first attempt — so the run can be paused mid-'second' and resumed, at
    // which point attempt 2 resolves immediately.
    let secondAttempts = 0;
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }): Promise<any> {
        options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 100, cost: 0 });
        if (prompt === "second" && ++secondAttempts === 1) return new Promise(() => {});
        return "ok";
      },
    };
    let toolsetResolutions = 0;
    const manager = new WorkflowManager({
      cwd,
      agent,
      defaultTokenBudget: 50,
      toolsets: {
        webby: () => {
          toolsetResolutions++;
          return [];
        },
      },
    });

    // Explicit no-budget + a named toolset. (With the 100-token usage above, the
    // 50-token default would exhaust this two-agent run — so mere completion
    // already proves the explicit null won.)
    const { runId, promise } = manager.startInBackground(twoAgentScript, undefined, {
      tokenBudget: null,
      toolset: "webby",
    });
    promise.catch(() => {}); // pause aborts the in-flight execution — expected
    // Wait until 'second' is in flight, then pause the run.
    for (let i = 0; i < 200 && secondAttempts === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(secondAttempts, 1, "'second' should be in flight before pausing");
    assert.equal(manager.pause(runId), true);
    assert.equal(toolsetResolutions, 1, "toolset resolves for the initial execution");

    const persisted = manager.getPersistence().load(runId);
    assert.equal(persisted?.status, "paused");
    assert.equal(persisted?.tokenBudget, null, "explicit null budget persists (not the 50 default)");
    assert.equal(persisted?.toolset, "webby", "toolset tag persists with the run");
    assert.equal(typeof persisted?.startedAtMs, "number", "the cumulative start clock is persisted with the run");
    assert.ok(
      Number.isFinite(manager.getRun(runId)?.snapshot.startedAtMs as number),
      "the live snapshot carries startedAtMs",
    );

    // Resume: the run must keep its start-time context — no budget (not the
    // manager's current default) and the same re-resolved toolset.
    assert.equal(await manager.resume(runId), true);
    // resume() executes detached — poll until the run leaves "running".
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(toolsetResolutions, 2, "resume re-resolves the toolset tag");
    const resumed = manager.getPersistence().load(runId);
    assert.equal(resumed?.status, "completed", "resume completes without TOKEN_BUDGET_EXHAUSTED");
    assert.equal(resumed?.tokenBudget, null, "resume keeps the start-time budget, not the current default");
    assert.equal(resumed?.toolset, "webby");
    assert.equal(
      resumed?.startedAtMs,
      persisted?.startedAtMs,
      "resume keeps the ORIGINAL start clock instead of resetting it",
    );
  }),
);

test(
  "defaultTools resolves only for untagged runs (explicit tools and toolset tags win)",
  withTempCwd(async (cwd) => {
    // The extension wires defaultTools as the automatic host-tools default for
    // untagged runs (design C); the precedence invariants are: explicit `tools`
    // wins, a named toolset tag wins, and defaultTools fires only for runs with
    // neither.
    let defaultResolutions = 0;
    let tagResolutions = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: fakeAgent(),
      defaultTools: () => {
        defaultResolutions++;
        return [];
      },
      toolsets: {
        webby: () => {
          tagResolutions++;
          return [];
        },
      },
    });

    await manager.runSync(oneAgentScript);
    assert.equal(defaultResolutions, 1, "an untagged run must resolve defaultTools");

    // A named toolset tag resolves the tag factory, never defaultTools.
    await manager.runSync(oneAgentScript, undefined, { toolset: "webby" });
    assert.equal(defaultResolutions, 1, "a tagged run must NOT resolve defaultTools");
    assert.equal(tagResolutions, 1, "the named toolset factory must resolve instead");

    // Explicit tools win outright.
    const explicit = [
      {
        name: "explicit",
        label: "explicit",
        description: "explicit tools",
        parameters: {},
        execute: async () => ({ content: [] }),
      },
    ] as unknown as ToolDefinition[];
    await manager.runSync(oneAgentScript, undefined, { tools: explicit });
    assert.equal(defaultResolutions, 1, "explicit tools must NOT resolve defaultTools");
    assert.equal(tagResolutions, 1, "explicit tools must not touch the toolset either");

    // An unknown tag falls through to the agent's default coding tools
    // (documented manager behavior) — defaultTools is for untagged runs only.
    await manager.runSync(oneAgentScript, undefined, { toolset: "no-such-toolset" });
    assert.equal(defaultResolutions, 1, "an unknown toolset tag must NOT resolve defaultTools");
  }),
);

test(
  "defaultTools may be async and resolves per run",
  withTempCwd(async (cwd) => {
    let defaultResolutions = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: fakeAgent(),
      defaultTools: async () => {
        defaultResolutions++;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return [];
      },
    });

    await manager.runSync(oneAgentScript);
    assert.equal(defaultResolutions, 1, "an async defaultTools factory must be awaited");
    await manager.runSync(oneAgentScript);
    assert.equal(defaultResolutions, 2, "each untagged run re-resolves defaultTools");
  }),
);

test(
  "resume re-resolves defaultTools for an untagged run",
  withTempCwd(async (cwd) => {
    // 'second' hangs on its first attempt (pause point), then resolves on its
    // second attempt — so the run can be paused mid-flight and resumed.
    let secondAttempts = 0;
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }): Promise<any> {
        options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        if (prompt === "second" && ++secondAttempts === 1) return new Promise(() => {});
        return "ok";
      },
    };
    let defaultResolutions = 0;
    const manager = new WorkflowManager({
      cwd,
      agent,
      defaultTools: () => {
        defaultResolutions++;
        return [];
      },
    });

    const { runId, promise } = manager.startInBackground(twoAgentScript, undefined, {});
    promise.catch(() => {}); // pause aborts the in-flight execution — expected
    for (let i = 0; i < 200 && secondAttempts === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(secondAttempts, 1, "'second' should be in flight before pausing");
    assert.equal(manager.pause(runId), true);
    assert.equal(defaultResolutions, 1, "defaultTools resolves for the initial execution");

    assert.equal(await manager.resume(runId), true);
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(defaultResolutions, 2, "resume must re-resolve defaultTools for the untagged run");
    assert.equal(manager.getRun(runId)?.status, "completed");
  }),
);

test(
  "reconfigureAfterReload carries defaultTools into the surviving manager",
  withTempCwd(async (cwd) => {
    let firstDefault = 0;
    let secondDefault = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: fakeAgent(),
      defaultTools: () => {
        firstDefault++;
        return [];
      },
    });

    await manager.runSync(oneAgentScript);
    assert.equal(firstDefault, 1, "the original defaultTools factory must be live");

    // /reload hands the surviving manager the new generation's options; the
    // defaultTools factory must be replaced, not appended.
    manager.reconfigureAfterReload({
      defaultTools: () => {
        secondDefault++;
        return [];
      },
    });
    await manager.runSync(oneAgentScript);
    assert.equal(firstDefault, 1, "the reloaded defaultTools must replace the old factory");
    assert.equal(secondDefault, 1, "the reload-provided defaultTools factory must be used");
  }),
);

test(
  "resume re-resolves the run's maxAgents/agentTimeoutMs and keeps its start-time values (#A1)",
  withTempCwd(async (cwd) => {
    // 'a' hangs on its first invocation (pause point), then on its second
    // invocation (post-resume) resolves slower than the run's OWN frozen
    // agentTimeoutMs (30ms) but well under the manager's defaultAgentTimeoutMs
    // (5000ms) — it only times out if agentTimeoutMs survived resume.
    let aAttempts = 0;
    const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }): Promise<any> {
        if (prompt === "a") {
          aAttempts++;
          if (aAttempts === 1) return new Promise(() => {}); // hang until paused
          await new Promise((resolve) => setTimeout(resolve, 60));
          options?.onUsage?.(zeroUsage);
          return "a-result";
        }
        options?.onUsage?.(zeroUsage);
        return `${prompt}-result`;
      },
    };
    const manager = new WorkflowManager({ cwd, agent, defaultAgentTimeoutMs: 5000 });
    manager.on("error", () => {});

    // Three agents fanned out via parallel() with maxAgents: 3 so the cap is
    // fully consumed by the fan-out itself (each reserves a slot atomically,
    // in call order, before any of them actually run) — a 4th call ('after')
    // then only succeeds if the cap has silently reverted to the ~1000 default.
    const script = `export const meta = { name: 'cap_demo', description: 'agent cap across resume' }
const xs = await parallel(['a','b','c'].map((label) => () => agent(label, { label })))
const after = await agent('after', { label: 'after' })
return { xs, after }`;

    const { runId, promise } = manager.startInBackground(script, undefined, { maxAgents: 3, agentTimeoutMs: 30 });
    promise.catch(() => {});
    // Pause well before 'a's own 30ms agentTimeoutMs would fire on the ORIGINAL
    // execution too (it's frozen for the whole run, not just post-resume) — 5ms
    // is enough for 'b'/'c' (no artificial delay) to complete and journal.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(aAttempts, 1, "'a' should be in flight before pausing");
    assert.equal(manager.pause(runId), true);

    const paused = manager.getPersistence().load(runId);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.maxAgents, 3, "maxAgents persists with the run");
    assert.equal(paused?.agentTimeoutMs, 30, "agentTimeoutMs persists with the run");
    assert.ok((paused?.journal?.length ?? 0) >= 2, "'b' and 'c' should be journaled before pause");

    assert.equal(await manager.resume(runId), true);
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const resumed = manager.getPersistence().load(runId);
    const aAgent = resumed?.agents.find((ag) => ag.label === "a");
    assert.match(
      aAgent?.error ?? "",
      /timed out after 30ms/,
      "agentTimeoutMs must survive resume, not reset to the manager default",
    );
    // The resumed run must still enforce maxAgents: 3 — the 4th call ('after',
    // after a/b/c already reserved a slot each in the fan-out) must throw
    // AGENT_LIMIT_EXCEEDED, failing the run, not silently pass under a
    // reverted-to-default cap of ~1000.
    assert.equal(resumed?.status, "failed", "maxAgents must survive resume, not reset to the 1000 default");
    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.error?.code, WorkflowErrorCode.AGENT_LIMIT_EXCEEDED);
  }),
);

test(
  "resuming a legacy persisted run (no agentTimeoutMs field) falls back to the manager's CURRENT default, not null",
  withTempCwd(async (cwd) => {
    // A run persisted before this fix existed never had an agentTimeoutMs
    // field at all — and its only real timeout, both at its original start
    // AND under pre-fix resume(), was always the manager's default (pre-fix
    // resume never threaded agentTimeoutMs through, so it fell straight to
    // this.defaultAgentTimeoutMs via executeRun's fallback chain). Falling
    // back to null here would silently grant such a run an unbounded timeout
    // it never had. Use a slow agent so only a real 20ms enforcement times it
    // out — an unbounded (null) fallback would let it complete instead.
    const manager = new WorkflowManager({ cwd, agent: delayedAgent(60), defaultAgentTimeoutMs: 20 });
    const pers = manager.getPersistence();
    const runId = "legacy-no-agent-timeout-1";
    pers.save({
      runId,
      workflowName: "legacy",
      script: oneAgentScript,
      args: undefined,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Deliberately no maxAgents/agentTimeoutMs/concurrency/agentRetries —
      // simulates a run persisted by pre-A1 code.
    });

    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const persisted = manager.getPersistence().load(runId);
    assert.equal(
      persisted?.agentTimeoutMs,
      20,
      "resume must apply the manager's current defaultAgentTimeoutMs for a legacy run, not leave it unbounded",
    );
    const agent = persisted?.agents.find((a) => a.label === "a");
    assert.match(agent?.error ?? "", /timed out after 20ms/, "the legacy run's agent must actually time out at 20ms");
  }),
);

test(
  "resume seeds the token-spend counter from the persisted total, so the budget holds cumulatively (#A2)",
  withTempCwd(async (cwd) => {
    // 'first' completes normally (spends 100). 'second' hangs on its first
    // attempt (pause point), then on its second attempt (post-resume) spends
    // 60 more — 100 + 60 = 160, over the 150 budget, but neither half alone
    // would trip it. 'third' only runs if the budget wrongly reset to 0 at
    // resume; it must instead be blocked before it even starts.
    let secondAttempts = 0;
    const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const agent: Pick<WorkflowAgent, "run"> = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }): Promise<any> {
        if (prompt === "first") {
          options?.onUsage?.({ ...zeroUsage, total: 100 });
          return "first-result";
        }
        if (prompt === "second") {
          if (++secondAttempts === 1) return new Promise(() => {}); // hang until paused
          options?.onUsage?.({ ...zeroUsage, total: 60 });
          return "second-result";
        }
        options?.onUsage?.({ ...zeroUsage, total: 1 });
        return "third-result";
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'seed_demo', description: 'three sequential agents' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
const c = await agent('third', { label: 'third' })
return { a, b, c }`;

    const { runId, promise } = manager.startInBackground(script, undefined, { tokenBudget: 150 });
    promise.catch(() => {});
    for (let i = 0; i < 200 && secondAttempts === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(secondAttempts, 1, "'second' should be in flight before pausing");
    assert.equal(manager.pause(runId), true);

    const paused = manager.getPersistence().load(runId);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.tokenUsage?.total, 100, "pre-pause spend (agent 1) is persisted, not lost mid-run");

    assert.equal(await manager.resume(runId), true);
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const resumed = manager.getPersistence().load(runId);
    // The cumulative spend (100 + 60 = 160) must be reflected...
    assert.equal(resumed?.tokenUsage?.total, 160, "final tokenUsage reflects both the pre-pause and post-resume spend");
    // ...and must have tripped the budget once the SUM exceeded it — the run
    // fails with TOKEN_BUDGET_EXHAUSTED on 'third', not a reset-to-zero pass.
    assert.equal(resumed?.status, "failed", "the tokenBudget must hold cumulatively across resume");
    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.error?.code, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED);
  }),
);

test(
  "explicit tokenBudget override on resume wins over the persisted start-time cap",
  withTempCwd(async (cwd) => {
    // 'first' completes (spends 100, journaled). 'second' hangs on its first
    // attempt (pause point), then on its second attempt (post-resume) spends
    // 60. 'third' spends 1. Total 161. Started at tokenBudget 150 — so the
    // PERSISTED cap would block 'third' and fail the run; resuming with an
    // explicit 1000 must let it complete. This is the usage-limit recovery
    // move: a run paused at its cap cannot be resumed without raising it.
    let secondAttempts = 0;
    const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const agent: Pick<WorkflowAgent, "run"> = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }): Promise<any> {
        if (prompt === "first") {
          options?.onUsage?.({ ...zeroUsage, total: 100 });
          return "first-result";
        }
        if (prompt === "second") {
          if (++secondAttempts === 1) return new Promise(() => {}); // hang until paused
          options?.onUsage?.({ ...zeroUsage, total: 60 });
          return "second-result";
        }
        options?.onUsage?.({ ...zeroUsage, total: 1 });
        return "third-result";
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'override_demo', description: 'budget override on resume' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
const c = await agent('third', { label: 'third' })
return { a, b, c }`;

    const { runId, promise } = manager.startInBackground(script, undefined, { tokenBudget: 150 });
    promise.catch(() => {});
    for (let i = 0; i < 200 && secondAttempts === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(secondAttempts, 1, "'second' should be in flight before pausing");
    assert.equal(manager.pause(runId), true);

    const paused = manager.getPersistence().load(runId);
    assert.equal(paused?.tokenBudget, 150, "the start-time cap persists");

    // Explicit override: 1000, not the persisted 150.
    assert.equal(await manager.resume(runId, { tokenBudget: 1000 }), true);
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const resumed = manager.getPersistence().load(runId);
    assert.equal(resumed?.status, "completed", "raised cap lets the run finish (161 < 1000)");
    assert.equal(
      resumed?.tokenBudget,
      1000,
      "the explicit resume override becomes the run's new cap, persisted forward",
    );
  }),
);

test(
  "explicit maxAgents override on resume raises a cap that would otherwise block the next agent",
  withTempCwd(async (cwd) => {
    // 'first' completes (journaled). 'second' hangs on its first attempt
    // (pause point). Start cap maxAgents: 2 — on resume, the replay of
    // 'first' plus the live 'second' reaches 2, so the persisted cap would
    // block 'third' (AGENT_LIMIT_EXCEEDED). Resuming with maxAgents: 3 must
    // let 'third' run and complete.
    let secondAttempts = 0;
    const agent = {
      async run(prompt: string): Promise<any> {
        if (prompt === "second" && ++secondAttempts === 1) return new Promise(() => {});
        return `${prompt}-result`;
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'cap_override_demo', description: 'maxAgents override on resume' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
const c = await agent('third', { label: 'third' })
return { a, b, c }`;

    const { runId, promise } = manager.startInBackground(script, undefined, { maxAgents: 2 });
    promise.catch(() => {});
    for (let i = 0; i < 200 && secondAttempts === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(secondAttempts, 1, "'second' should be in flight before pausing");
    assert.equal(manager.pause(runId), true);

    // Explicit override: 3, not the persisted 2.
    assert.equal(await manager.resume(runId, { maxAgents: 3 }), true);
    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const resumed = manager.getPersistence().load(runId);
    assert.equal(resumed?.status, "completed", "raised maxAgents lets 'third' run");
    assert.equal(resumed?.maxAgents, 3, "the explicit resume override persists forward");
  }),
);

test(
  "a retried (failed-then-succeeded) attempt's spend is not lost from the persisted total when the run pauses before completing",
  withTempCwd(async (cwd) => {
    // 'a's first attempt spends 40 tokens then fails with an empty output
    // (recoverable -> retried); its second attempt spends 25 more and
    // succeeds. onAgentEnd only ever reports the FINAL attempt's tokens (25)
    // — the first attempt's 40 would be invisible to a persisted total built
    // purely from onAgentEnd. 'b' then hangs so we can pause() and inspect
    // the persisted state BEFORE the run fully completes (a full completion
    // would paper over the gap via workflow.ts's own final onTokenUsage,
    // which always includes every attempt's spend regardless of this fix).
    let aAttempts = 0;
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }): Promise<any> {
        if (prompt === "a") {
          aAttempts++;
          if (aAttempts === 1) {
            options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 40, cost: 0 });
            return ""; // empty output -> recoverable AGENT_EMPTY_OUTPUT -> retried
          }
          options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 25, cost: 0 });
          return "a-result";
        }
        return new Promise(() => {}); // 'b' hangs until paused
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'retry_spend_demo', description: 'retry spend' }
const a = await agent('a', { label: 'a' })
const b = await agent('b', { label: 'b' })
return { a, b }`;

    const { runId, promise } = manager.startInBackground(script, undefined, { agentRetries: 1, retryBackoffMs: 0 });
    promise.catch(() => {});
    for (let i = 0; i < 200 && aAttempts < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(aAttempts, 2, "'a' should have failed once and be retrying by now");
    // Let 'b' actually start (and begin hanging) before pausing.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(manager.pause(runId), true);

    const paused = manager.getPersistence().load(runId);
    assert.equal(paused?.status, "paused");
    assert.equal(
      paused?.tokenUsage?.total,
      65,
      "the persisted total must include the failed-then-retried attempt's 40 tokens, not just the final attempt's 25",
    );
  }),
);

test(
  "F03: a retry-spend double-count across pause/resume is refunded, so the tokenBudget cap is not tripped early",
  withTempCwd(async (cwd) => {
    // 'a' fails its FIRST attempt of each execution (empty output -> recoverable
    // -> retried, spending 40) and succeeds on its second attempt (spending 25).
    // The pause lands while 'a's second attempt of the FIRST execution hangs, so
    // the pre-pause persisted total (40) has NO journal entry for 'a' — the
    // resume replays nothing for it and re-runs the call live. Without the F03
    // refund the resumed seed would be 40 and the re-run would charge 40+25
    // again (40+40+25+100 = 205) — tripping the 180 budget on 'c'. With the
    // refund the seed is 40-40 = 0, the re-run charges 40+25 once, and the total
    // is 40+25+100+1 = 166 < 180: completed, not TOKEN_BUDGET_EXHAUSTED.
    let aCalls = 0;
    const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const agent: Pick<WorkflowAgent, "run"> = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }): Promise<any> {
        if (prompt === "a") {
          aCalls++;
          if (aCalls === 1) {
            options?.onUsage?.({ ...zeroUsage, total: 40 });
            return ""; // recoverable empty output -> retried
          }
          if (aCalls === 2) return new Promise(() => {}); // first execution's attempt 2 hangs -> pause point
          if (aCalls === 3) {
            options?.onUsage?.({ ...zeroUsage, total: 40 });
            return ""; // resumed execution's attempt 1 fails again -> retried
          }
          options?.onUsage?.({ ...zeroUsage, total: 25 });
          return "a-result";
        }
        if (prompt === "b") {
          options?.onUsage?.({ ...zeroUsage, total: 100 });
          return "b-result";
        }
        options?.onUsage?.({ ...zeroUsage, total: 1 });
        return "c-result";
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'f03_refund_demo', description: 'retry double-count' }
const a = await agent('a', { label: 'a' })
const b = await agent('b', { label: 'b' })
const c = await agent('c', { label: 'c' })
return { a, b, c }`;

    const { runId, promise } = manager.startInBackground(script, undefined, {
      tokenBudget: 180,
      agentRetries: 1,
      retryBackoffMs: 0,
    });
    promise.catch(() => {});
    for (let i = 0; i < 200 && aCalls < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 10)); // let attempt 2 hang
    assert.equal(aCalls, 2, "'a' should have failed once and be hanging on its retry before pausing");
    assert.equal(manager.pause(runId), true);

    const paused = manager.getPersistence().load(runId);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.tokenUsage?.total, 40, "pre-pause retry spend is persisted");
    assert.equal(
      paused?.retryLedger?.[`${runId}:0`]?.total,
      40,
      "the per-call retry ledger records the interrupted call's attempt spend (F03)",
    );

    assert.equal(await manager.resume(runId), true);
    for (let i = 0; i < 400 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const resumed = manager.getPersistence().load(runId);
    assert.equal(
      resumed?.tokenUsage?.total,
      166,
      "the retry spend is charged exactly once across the pause/resume boundary (40+25+100+1)",
    );
    assert.equal(resumed?.status, "completed", "the 180 budget must NOT trip early on the refunded retry spend");
    assert.equal(
      (resumed?.result as { a?: string })?.a,
      "a-result",
      "the re-run of the interrupted call produces its result",
    );
  }),
);

test(
  "F03: refunding an interrupted call preserves the journaled spend of an earlier completed sibling",
  withTempCwd(async (cwd) => {
    // 'y' completes first (100, journaled); 'x' then fails its first attempt of
    // each execution (40, recoverable -> retried) and hangs on the second — the
    // pause point. Pre-pause aggregate is 140 (y's 100 + x's 40) with a ledger
    // entry only for x. The F03 refund must subtract ONLY x's interrupted spend
    // (seed 140-40 = 100): y's journaled 100 is preserved (it replays from the
    // journal charging 0), and the resumed run charges x once (40+25) plus z (1)
    // — 166, within the 200 budget. Without the refund the seed would be 140 and
    // x's re-run would push the total to 206, tripping the cap on z.
    let xCalls = 0;
    const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const agent: Pick<WorkflowAgent, "run"> = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }): Promise<any> {
        if (prompt === "y") {
          options?.onUsage?.({ ...zeroUsage, total: 100 });
          return "y-result";
        }
        if (prompt === "x") {
          xCalls++;
          if (xCalls === 1) {
            options?.onUsage?.({ ...zeroUsage, total: 40 });
            return ""; // recoverable empty output -> retried
          }
          if (xCalls === 2) return new Promise(() => {}); // first execution's attempt 2 hangs -> pause point
          if (xCalls === 3) {
            options?.onUsage?.({ ...zeroUsage, total: 40 });
            return ""; // resumed execution's attempt 1 fails again -> retried
          }
          options?.onUsage?.({ ...zeroUsage, total: 25 });
          return "x-result";
        }
        options?.onUsage?.({ ...zeroUsage, total: 1 });
        return "z-result";
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'f03_preserve_demo', description: 'refund keeps journaled spend' }
const y = await agent('y', { label: 'y' })
const x = await agent('x', { label: 'x' })
const z = await agent('z', { label: 'z' })
return { x, y, z }`;

    const { runId, promise } = manager.startInBackground(script, undefined, {
      tokenBudget: 200,
      agentRetries: 1,
      retryBackoffMs: 0,
    });
    promise.catch(() => {});
    for (let i = 0; i < 200 && xCalls < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 10)); // let x's attempt 2 hang
    assert.equal(manager.pause(runId), true);

    const paused = manager.getPersistence().load(runId);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.tokenUsage?.total, 140, "pre-pause aggregate includes y's spend and x's retry spend");
    assert.equal(
      paused?.retryLedger?.[`${runId}:1`]?.total,
      40,
      "only the interrupted call (x, call index 1) has a ledger entry",
    );
    assert.equal(paused?.retryLedger?.[`${runId}:0`], undefined, "the completed sibling y has no ledger entry");

    assert.equal(await manager.resume(runId), true);
    for (let i = 0; i < 400 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const resumed = manager.getPersistence().load(runId);
    assert.equal(resumed?.tokenUsage?.total, 166, "y's journaled 100 survives the refund (100+40+25+1)");
    assert.equal(resumed?.status, "completed", "the 200 budget must not trip on a refunded interrupted call");
  }),
);

test(
  "manager forwards exec concurrency and agentRetries to runtime",
  withTempCwd(async (cwd) => {
    let active = 0;
    let maxActive = 0;
    const callsByPrompt = new Map<string, number>();
    const manager = new WorkflowManager({
      cwd,
      concurrency: 8,
      defaultAgentRetries: 0,
      agent: {
        async run(prompt: string): Promise<any> {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          const calls = (callsByPrompt.get(prompt) ?? 0) + 1;
          callsByPrompt.set(prompt, calls);
          return calls === 1 ? "" : `ok:${prompt}`;
        },
      },
    });
    const script = `export const meta = { name: 'forwarding', description: 'manager controls' }
const xs = await parallel(['a','b'].map((p) => () => agent(p, { label: p })))
return xs`;

    const result = await manager.runSync(script, undefined, { concurrency: 1, agentRetries: 1, retryBackoffMs: 0 });

    assert.deepEqual(result.result, ["ok:a", "ok:b"]);
    assert.equal(maxActive, 1, "exec concurrency should override the manager default");
    assert.deepEqual([...callsByPrompt.values()], [2, 2], "exec agentRetries should be forwarded");
  }),
);

test(
  "manager defaultAgentRetries applies when run options omit agentRetries",
  withTempCwd(async (cwd) => {
    let calls = 0;
    const manager = new WorkflowManager({
      cwd,
      defaultAgentRetries: 1,
      agent: {
        async run(): Promise<any> {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
    });

    const result = await manager.runSync(oneAgentScript, undefined, { retryBackoffMs: 0 });

    assert.equal((result.result as { a: unknown }).a, "ok");
    assert.equal(calls, 2);
  }),
);

test(
  "runSync persists the run immediately (visible while still running)",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    let listedWhileRunning = 0;
    manager.on("agentStart", () => {
      listedWhileRunning = manager.listRuns().filter((r) => r.status === "running").length;
    });
    await manager.runSync(oneAgentScript);
    assert.equal(listedWhileRunning, 1, "the run shows as running in listRuns mid-flight");
  }),
);

test(
  "each agent's model is recorded for /workflows: explicit opts.model, else the main model",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent(), mainModel: "anthropic/claude-opus-4-8" });
    const script = `export const meta = { name: 'model_demo', description: 'per-agent models' }
const a = await agent('explore', { label: 'scan', model: 'openai/gpt-5-mini' })
const b = await agent('reason', { label: 'judge' })
return { a, b }`;
    await manager.runSync(script);

    const run = manager.listRuns().find((r) => r.workflowName === "model_demo");
    const byLabel = Object.fromEntries((run?.agents ?? []).map((a) => [a.label, a.model]));
    assert.equal(byLabel.scan, "openai/gpt-5-mini", "explicit per-agent model is recorded");
    assert.equal(byLabel.judge, "anthropic/claude-opus-4-8", "default agent shows the main model");
  }),
);

test(
  "runSync persists recoverable agent error details for /workflows",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new Error("agent exploded");
        },
      },
    });

    await manager.runSync(oneAgentScript);

    const run = manager.listRuns().find((r) => r.workflowName === "tracked_demo");
    const agent = run?.agents[0];
    assert.equal(agent?.status, "error");
    assert.equal(agent?.error, "agent exploded");
    assert.equal(agent?.errorCode, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(agent?.recoverable, true);
  }),
);

test(
  "runSync stores compact subagent history for /workflows detail",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(_prompt: string, options: { onHistory?: (history: unknown[]) => void }): Promise<any> {
          options.onHistory?.([{ role: "assistant", kind: "text", text: "inspecting files" }]);
          return "ok";
        },
      },
    });

    await manager.runSync(oneAgentScript);

    const run = manager.listRuns().find((r) => r.workflowName === "tracked_demo");
    const agent = run?.agents[0];
    assert.equal(agent?.history?.length, 1);
    assert.equal(agent?.history?.[0]?.text, "inspecting files");
  }),
);

test(
  "runSync retains the full agent result for live and persisted detail views",
  withTempCwd(async (cwd) => {
    const expected = { summary: "complete", findings: [{ path: "src/a.ts", line: 42 }] };
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({}, expected) });

    const result = await manager.runSync(oneAgentScript);
    const live = manager.getRun(result.runId as string)?.snapshot.agents[0];
    const persistedRun = manager.listRuns().find((run) => run.runId === result.runId);
    const persisted = persistedRun?.agents[0];

    assert.deepEqual(live?.result, expected);
    assert.deepEqual(persisted?.result, expected);
    assert.match(live?.resultPreview ?? "", /complete/);
    assert.equal(persistedRun?.journal, undefined, "completed runs do not duplicate full results in the journal");
  }),
);

test(
  "cold persisted resumable runs restore full agent results from the journal",
  withTempCwd(async (cwd) => {
    const expected = {
      summary: "x".repeat(100),
      durableMarker: "FULL_RESULT_FROM_JOURNAL",
    };
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          if (prompt === "first") return expected;
          throw new WorkflowError("quota reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
            recoverable: false,
          });
        },
      } as never,
    });
    const script = `export const meta = { name: 'cold_result', description: 'cold result test' }
phase('Work')
await agent('first', { label: 'first' })
await agent('second', { label: 'second' })`;

    const { runId, promise } = manager.startInBackground(script);
    await promise.catch(() => {});

    const persisted = manager.listRuns().find((run) => run.runId === runId);
    assert.equal(persisted?.status, "paused");
    assert.equal(persisted?.agents[0]?.result, undefined, "resumable agent result is stored only in the journal");
    assert.doesNotMatch(persisted?.agents[0]?.resultPreview ?? "", /FULL_RESULT_FROM_JOURNAL/);
    assert.deepEqual(persisted?.journal?.find((entry) => entry.index === 0)?.result, expected);

    // A fresh manager has no live snapshot, so NavigatorModel must rehydrate the
    // pager's cold-read snapshot from the persisted journal.
    const freshManager = new WorkflowManager({ cwd });
    assert.equal(freshManager.getRun(runId), undefined);
    const model = new NavigatorModel(freshManager);
    assert.deepEqual(model.agentDetail(runId, 1)?.result, expected);

    const state = new NavigatorState();
    assert.equal(state.drill(model), true);
    assert.equal(state.drill(model), true);
    assert.equal(state.drill(model), true);
    state.togglePager();
    assert.match(renderNavigator(state, model, 120, undefined, 30).join("\n"), /FULL_RESULT_FROM_JOURNAL/);
  }),
);

test(
  "startInBackground returns immediately with runId and promise",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    assert.ok(runId, "should generate a run id");
    assert.ok(promise instanceof Promise, "should return a promise");
    const runs = manager.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, runId);
    assert.equal(runs[0].status, "running");
    await promise;
  }),
);

test(
  "startInBackground result resolves on completion",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ total: 50 }) });
    const { promise } = manager.startInBackground(oneAgentScript);
    const result = await promise;
    assert.equal(result.agentCount, 1);
    assert.equal(result.meta.name, "tracked_demo");
  }),
);

test(
  "stop stops a running workflow and transitions to aborted",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    // Suppress the expected unhandled rejection from the aborted run
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    // Wait a tick for the run to start processing
    await new Promise((r) => setTimeout(r, 20));
    const stopped = manager.stop(runId);
    assert.equal(stopped, true);
    const run = manager.getRun(runId);
    assert.equal(run?.status, "aborted", "run should be aborted");
    // Clean up: resolve the deferred agent and catch the expected rejection
    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "stop returns false for nonexistent run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    assert.equal(manager.stop("nonexistent"), false);
  }),
);

test(
  "pause pauses a running workflow",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    const paused = manager.pause(runId);
    assert.equal(paused, true);
    const run = manager.getRun(runId);
    assert.equal(run?.status, "paused", "run should be paused");
    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "pause returns false for nonexistent run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    assert.equal(manager.pause("nonexistent"), false);
  }),
);

test(
  "getRun returns undefined for unknown run id",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const run = manager.getRun("no-such-run");
    assert.equal(run, undefined);
  }),
);

test(
  "getSnapshot returns null for unknown run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const snap = manager.getSnapshot("unknown");
    assert.equal(snap, null);
  }),
);

test(
  "deleteRun removes the run from memory and persistence",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId } = manager.startInBackground(oneAgentScript);
    // Wait for completion first (fast agent)
    await new Promise((r) => setTimeout(r, 30));
    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);
    assert.equal(manager.getRun(runId), undefined);
  }),
);

test(
  "deleteRun returns false for nonexistent run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    assert.equal(manager.deleteRun("nonexistent"), false);
  }),
);

test(
  "setModelRegistry stores the registry and forwards it to subagent runs",
  withTempCwd(async (cwd) => {
    const fakeRegistry = {
      getAvailable: () => [{ provider: "mock", id: "m" }],
      find: () => undefined,
      getAll: () => [],
    } as any;
    const rec = new (class {
      calls: Array<{ options: any }> = [];
      async run(_prompt: string, options: any) {
        this.calls.push({ options });
        options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "ok";
      }
    })();
    const manager = new WorkflowManager({ cwd, agent: rec as unknown as Pick<WorkflowAgent, "run"> });
    manager.setModelRegistry(fakeRegistry);
    await manager.runSync(oneAgentScript);
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].options.modelRegistry, fakeRegistry);
  }),
);

test(
  "setMainModel sets the main model used for default agents",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    manager.setMainModel("anthropic/claude-sonnet-4");
    const script = `export const meta = { name: 'mm_test', description: 'main model test' }
const a = await agent('test', { label: 'a' })
return { a }`;
    await manager.runSync(script);
    const run = manager.listRuns().find((r) => r.workflowName === "mm_test");
    assert.ok(run, "run should exist");
  }),
);

test(
  "getPersistence returns the persistence layer",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const p = manager.getPersistence();
    assert.ok(p, "p should be truthy");
    assert.equal(typeof p.save, "function");
    assert.equal(typeof p.list, "function");
  }),
);

test(
  "runSync emits manager events (agentStart -> agentEnd -> complete)",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const events: string[] = [];
    manager.on("agentStart", () => events.push("agentStart"));
    manager.on("agentEnd", () => events.push("agentEnd"));
    manager.on("complete", () => events.push("complete"));
    await manager.runSync(oneAgentScript);
    assert.deepEqual(events, ["agentStart", "agentEnd", "complete"]);
  }),
);

test(
  "resume returns false when run is already running",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    const resumed = await manager.resume(runId);
    assert.equal(resumed, false);
    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "resume returns false when run doesn't exist",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const resumed = await manager.resume("nonexistent");
    assert.equal(resumed, false);
  }),
);

test(
  "manager emits complete event with runId",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    let capturedId = "";
    manager.on("complete", ({ runId }: { runId: string }) => {
      capturedId = runId;
    });
    await manager.runSync(oneAgentScript);
    assert.ok(capturedId, "should capture runId on complete");
  }),
);

test(
  "stop returns false for completed/aborted run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise; // wait for completion
    const stopped = manager.stop(runId);
    assert.equal(stopped, false, "cannot stop an already completed run");
  }),
);

test(
  "pause returns false for completed run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise; // wait for completion
    const paused = manager.pause(runId);
    assert.equal(paused, false, "cannot pause completed run");
  }),
);

// ─── Abort propagation tests ───────────────────────────────────────────────────

test(
  "abort via externalSignal propagates through workflow execution and yields WorkflowError",
  withTempCwd(async (cwd) => {
    const ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    let errorEmitted = false;
    manager.on("error", () => {
      errorEmitted = true;
    });

    // runSync with externalSignal links the abort controller to the manager
    const runPromise = manager.runSync(oneAgentScript, undefined, {
      externalSignal: ac.signal,
    });

    // Let the agent start (deferred, so it hangs inside agentRunner.run())
    await new Promise((r) => setTimeout(r, 20));

    // Abort from outside — this triggers managed.controller.abort()
    ac.abort();

    // Resolve the deferred agent so the in-flight agent completes,
    // then throwIfAborted() fires and the error propagates.
    da.resolve("done");

    try {
      await runPromise;
      assert.fail("runSync should have thrown on abort");
    } catch (err) {
      assert.ok(err instanceof WorkflowError, "error should be WorkflowError");
      assert.equal(
        (err as WorkflowError).code,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        "error code should be WORKFLOW_ABORTED",
      );
      assert.ok((err as WorkflowError).recoverable, "abort error should be recoverable");
    }

    assert.equal(
      errorEmitted,
      false,
      "manager must NOT emit 'error' for an intentional external abort (core-orchestration:f1)",
    );
    assert.equal(
      manager.listRuns()[0]?.status,
      "aborted",
      "an intentional abort settles the run to 'aborted', not 'failed'",
    );
  }),
);

test(
  "abort via externalSignal does not crash Pi (no uncaught exception)",
  withTempCwd(async (cwd) => {
    const ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let uncaughtFromTest: Error | null = null;
    const errorHandler = (err: Error) => {
      uncaughtFromTest = err;
    };
    process.on("uncaughtException", errorHandler);

    try {
      const runPromise = manager.runSync(oneAgentScript, undefined, {
        externalSignal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 20));
      ac.abort();
      da.resolve("done");

      try {
        await runPromise;
      } catch {
        // Expected — abort throws WorkflowError
      }

      // Give microtasks a chance to settle
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(uncaughtFromTest, null, "abort should NOT produce an uncaught exception");
    } finally {
      process.off("uncaughtException", errorHandler);
    }
  }),
);

test(
  "abort mid-way through multi-agent workflow: remaining agents are skipped",
  withTempCwd(async (cwd) => {
    // Per-call deferred agent: each call to run() gets its own promise.
    const resolves: Array<(v: unknown) => void> = [];
    let callIdx = 0;
    const multiDa = {
      resolve(idx: number, v: unknown = "done") {
        resolves[idx]?.(v);
      },
      runner: {
        async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }): Promise<any> {
          const idx = callIdx++;
          return new Promise((resolve) => {
            resolves[idx] = resolve;
          });
        },
      },
    };

    const manager = new WorkflowManager({ cwd, agent: multiDa.runner });
    manager.on("error", () => {});

    const twoAgentScript = `export const meta = { name: 'two_agent', description: 'two agents test' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Let agent 1 complete (gets journaled)
    multiDa.resolve(0, "first-done");
    // Wait for agent 1's result to be journaled and agent 2 to start
    await new Promise((r) => setTimeout(r, 30));

    // Stop the run while agent 2 is in-flight
    const stopped = manager.stop(runId);
    assert.equal(stopped, true, "stop should succeed");

    // Resolve agent 2 so the abort/throwIfAborted path executes
    multiDa.resolve(1, "second-done");
    await promise.catch(() => {});

    // Verify the run is aborted
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "run should be aborted after stop");

    // Verify the error is a WorkflowError
    const managedRun = manager.getRun(runId);
    assert.ok(managedRun?.error instanceof WorkflowError, "error should be instance of WorkflowError");
    assert.equal((managedRun.error as WorkflowError).code, WorkflowErrorCode.WORKFLOW_ABORTED);
  }),
);

// ─── Stop tests ────────────────────────────────────────────────────────────────

test(
  "stop on paused run transitions to aborted",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause first
    const paused = manager.pause(runId);
    assert.equal(paused, true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Then stop the paused run
    const stopped = manager.stop(runId);
    assert.equal(stopped, true);
    assert.equal(manager.getRun(runId)?.status, "aborted", "paused run should become aborted after stop");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "stop emits 'stopped' event with runId",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let stoppedEvent: { runId: string } | null = null;
    manager.on("stopped", (ev: { runId: string }) => {
      stoppedEvent = ev;
    });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.stop(runId);

    assert.ok(stoppedEvent, "stopped event should fire");
    assert.equal((stoppedEvent as { runId: string } | null)?.runId, runId);

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "stop returns false for already-stopped run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.stop(runId);
    const secondStop = manager.stop(runId);
    assert.equal(secondStop, false, "second stop on same run should return false");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Pause tests ───────────────────────────────────────────────────────────────

test(
  "pause emits 'paused' event with runId",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let pausedEvent: { runId: string } | null = null;
    manager.on("paused", (ev: { runId: string }) => {
      pausedEvent = ev;
    });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    manager.pause(runId);

    assert.ok(pausedEvent, "paused event should fire");
    assert.equal((pausedEvent as { runId: string } | null)?.runId, runId);

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "pause returns false for already-stopped run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.stop(runId);
    const paused = manager.pause(runId);
    assert.equal(paused, false, "cannot pause an already stopped/aborted run");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "pause returns false for already-paused run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    manager.pause(runId);
    const secondPause = manager.pause(runId);
    assert.equal(secondPause, false, "second pause on same run should return false");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Resume tests ──────────────────────────────────────────────────────────────

test(
  "resume full cycle: pause then resume then complete",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause while the deferred agent is in-flight
    const paused = manager.pause(runId);
    assert.equal(paused, true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Resume — replays journal (empty for single-agent that never completed) and
    // re-runs the live agent with a fresh (non-aborted) controller.
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true, "resume should succeed");

    // The resumed run should be running
    assert.equal(manager.getRun(runId)?.status, "running", "resumed run should be running");

    // Resolve the deferred agent so the resumed run's agent completes
    da.resolve("resumed-done");

    // The original promise will reject (its controller was aborted). Suppress it.
    await origPromise.catch(() => {});

    // Wait for the resumed run to complete
    await new Promise((r) => setTimeout(r, 50));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed run should complete successfully");
    assert.equal(
      (finalRun?.result?.result as { a: unknown } | undefined)?.a,
      "resumed-done",
      "resumed run should have the agent result",
    );

    // The run should also appear in listRuns as completed
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "completed");
  }),
);

test(
  "resume with journal replay replays completed agents and runs remaining live",
  withTempCwd(async (cwd) => {
    // Use a multi-agent workflow: agent 1 completes before pause (gets journaled),
    // agent 2 runs live after resume.
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const twoAgentScript = `export const meta = { name: 'two_agent', description: 'two agents test' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

    const { runId, promise: origPromise } = manager.startInBackground(twoAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Let agent 1 complete
    da.resolve("first-result");
    await new Promise((r) => setTimeout(r, 30));

    // Agent 1 should have completed and been journaled. Pause.
    const paused = manager.pause(runId);
    const statusAtPause = manager.getRun(runId)?.status;

    if (paused) {
      assert.equal(statusAtPause, "paused");

      // Journal should have at least agent 1's entry
      const persisted = manager.listRuns().find((r) => r.runId === runId);
      assert.ok(persisted?.journal && persisted.journal.length >= 1, "journal should have at least one entry");

      // Resume
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true);

      // Wait for resumed run to complete (agent 1 replayed from journal, agent 2 live)
      await new Promise((r) => setTimeout(r, 50));

      const finalRun = manager.getRun(runId);
      assert.equal(finalRun?.status, "completed", "resumed multi-agent run should complete");
      assert.equal((finalRun?.result?.result as { a: unknown } | undefined)?.a, "first-result");
    }

    await origPromise.catch(() => {});
  }),
);

test(
  "a provider usage limit pauses the run (not failed) and is resumable, replaying the journal",
  withTempCwd(async (cwd) => {
    let limitActive = true;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string): Promise<any> {
          if (prompt.includes("second") && limitActive) {
            throw new WorkflowError(
              "Codex usage limit reached (plus plan). Resets in ~3h.",
              WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
              { recoverable: false, resetHint: "Resets in ~3h" },
            );
          }
          return prompt.includes("first") ? "first-result" : "second-result";
        },
      },
    });
    const pausedEvents: Array<{ runId: string; reason?: string; resetHint?: string }> = [];
    manager.on("paused", (e: { runId: string; reason?: string; resetHint?: string }) => pausedEvents.push(e));

    const twoAgentScript = `export const meta = { name: 'quota_demo', description: 'two agents' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await promise.catch(() => {}); // settles: rejects with PROVIDER_USAGE_LIMIT

    // The run is checkpointed as paused, not failed.
    assert.equal(manager.getRun(runId)?.status, "paused");
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "paused");
    assert.equal(persisted?.pauseReason, "usage_limit");
    assert.equal(persisted?.resetHint, "Resets in ~3h");
    assert.ok((persisted?.journal?.length ?? 0) >= 1, "agent 1's result should be journaled");

    // A 'paused' event with reason usage_limit fired (not 'error').
    assert.equal(pausedEvents.length, 1);
    assert.equal(pausedEvents[0].reason, "usage_limit");
    assert.equal(pausedEvents[0].resetHint, "Resets in ~3h");

    // After the budget refills, resume replays agent 1 and runs agent 2 live to completion.
    limitActive = false;
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    await new Promise((r) => setTimeout(r, 50));
    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed run completes once the limit clears");
    assert.equal((finalRun?.result?.result as { a: unknown } | undefined)?.a, "first-result");
    assert.equal((finalRun?.result?.result as { b: unknown } | undefined)?.b, "second-result");
  }),
);

test(
  "a non-quota non-recoverable agent error still fails the run (control)",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new WorkflowError("schema bad", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
        },
      },
    });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "failed");
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.pauseReason, undefined, "a real failure carries no usage-limit pause reason");
  }),
);

// ─── persistRun: honest per-agent timestamps + throttled progress persists ────

test(
  "persisted per-agent timestamps are real, not fabricated from the run's startedAt/now",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: firstThenHangAgent() });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(twoAgentScript);

    // Wait until 'a' has finished and 'b' has started (and is hanging) so both
    // a terminal and a still-running agent coexist in the snapshot.
    await new Promise((resolve) => {
      manager.on("agentStart", (event) => {
        if ((event as { label?: string }).label === "b") resolve(undefined);
      });
    });

    // pause() forces a synchronous flush (see the "safety net" tests below), so
    // this reads the true current state without any arbitrary wait.
    manager.pause(runId);

    const persisted = manager.listRuns().find((r) => r.runId === runId);
    const agentA = persisted?.agents.find((a) => a.label === "a");
    const agentB = persisted?.agents.find((a) => a.label === "b");

    assert.equal(agentA?.status, "done");
    assert.ok(agentA?.startedAt, "finished agent has a real startedAt");
    assert.ok(agentA?.endedAt, "finished agent has a real endedAt");

    assert.equal(agentB?.status, "running");
    assert.ok(agentB?.startedAt, "running agent has a real startedAt too");
    assert.equal(agentB?.endedAt, undefined, "a still-running agent must NOT get a fabricated endedAt");

    assert.notEqual(
      agentA?.startedAt,
      agentB?.startedAt,
      "agents must not all share one fabricated run-start timestamp",
    );

    // firstThenHangAgent's 'second' call never resolves on its own (only pause()
    // marks the run as aborted in bookkeeping — the in-flight call has no timeout
    // to race against), so don't await it; just avoid an unhandled rejection.
    promise.catch(() => {});
  }),
);

test(
  "a burst of agent completions coalesces to a small, bounded number of disk writes",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent(), concurrency: 8 });
    const persistence = manager.getPersistence();
    let saveCount = 0;
    const originalSave = persistence.save.bind(persistence);
    persistence.save = ((...args: Parameters<typeof persistence.save>) => {
      saveCount++;
      return originalSave(...args);
    }) as typeof persistence.save;

    const result = await manager.runSync(burstAgentScript);

    assert.equal((result.result as unknown[]).length, 6);
    // Unthrottled, each of the 6 near-simultaneous agent completions would persist
    // on its own: 1 (initial) + 6 (one per agent) + 1 (final) = 8 writes. Throttled,
    // the whole burst coalesces into at most one trailing write, so the total stays
    // small regardless of agent count.
    assert.ok(saveCount <= 3, `expected a coalesced write count (<=3), got ${saveCount}`);
  }),
);

test(
  "pause() flushes a pending throttled progress persist synchronously — no stale read",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: firstThenHangAgent() });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(twoAgentScript);

    // 'a' finishing schedules a throttled (trailing-edge) write via onAgentJournal
    // that would normally not hit disk for hundreds of ms.
    await new Promise((resolve) => {
      manager.on("agentStart", (event) => {
        if ((event as { label?: string }).label === "b") resolve(undefined);
      });
    });

    manager.pause(runId);

    // Read persisted state immediately — no sleep/setTimeout. If pause() didn't
    // flush the pending write first (and write the current, final state), this
    // would race a stale read or a delayed write clobbering the paused status.
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "paused", "terminal status must be visible immediately, with no wait");
    const agentA = persisted?.agents.find((a) => a.label === "a");
    assert.equal(agentA?.status, "done", "the already-completed agent's state is flushed synchronously too");
    assert.ok(agentA?.endedAt, "flushed agent state carries its real endedAt, not stale/missing data");

    // 'second' never resolves on its own; don't await it, just avoid an unhandled rejection.
    promise.catch(() => {});
  }),
);

test(
  "stop() flushes a pending throttled progress persist synchronously — no stale read",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: firstThenHangAgent() });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(twoAgentScript);

    await new Promise((resolve) => {
      manager.on("agentStart", (event) => {
        if ((event as { label?: string }).label === "b") resolve(undefined);
      });
    });

    manager.stop(runId);

    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "terminal status must be visible immediately, with no wait");
    const agentA = persisted?.agents.find((a) => a.label === "a");
    assert.equal(agentA?.status, "done");
    assert.ok(agentA?.endedAt, "flushed agent state carries its real endedAt, not stale/missing data");

    // 'second' never resolves on its own; don't await it, just avoid an unhandled rejection.
    promise.catch(() => {});
  }),
);

test(
  "resume returns false for completed run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { promise } = manager.startInBackground(oneAgentScript);
    await promise; // wait for completion

    const runs = manager.listRuns();
    const runId = runs[0]?.runId;
    if (runId) {
      const resumed = await manager.resume(runId);
      assert.equal(resumed, false, "cannot resume a completed run");
    }
  }),
);

// ─── Cold-start resume tests ────────────────────────────────────────────────────
// These tests manually persist runs via the persistence layer (as though the
// process was restarted) and then resume them from disk — no in-memory state.

test(
  "cold-start resume: persisted run can be resumed from disk",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const pers = manager.getPersistence();
    const runId = "cold-start-ok-1";

    // Manually save a persisted run — cold-start scenario, no in-memory state
    pers.save({
      runId,
      workflowName: "cold_start",
      script: oneAgentScript,
      args: undefined,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // No in-memory run exists at this point; resume loads from persistence
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true, "resume should succeed for cold-start persisted run");

    // Wait for the background execution (fake agent resolves instantly)
    await new Promise((r) => setTimeout(r, 100));

    const run = manager.getRun(runId);
    assert.ok(run, "run should be in memory after resume");
    assert.equal(run?.status, "completed", "cold-start resumed run should complete");
    assert.equal((run?.result?.result as { a: unknown } | undefined)?.a, "ok", "agent result should be present");

    // Verify persistence was updated to completed
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "completed", "persistence should reflect completed status");
  }),
);

test(
  "cold-start resume: completed run cannot be resumed",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const pers = manager.getPersistence();
    const runId = "cold-start-completed-1";

    pers.save({
      runId,
      workflowName: "completed_test",
      script: oneAgentScript,
      args: undefined,
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "completed persisted run cannot be resumed");
  }),
);

test(
  "cold-start resume: persisted run with empty script cannot be resumed",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const pers = manager.getPersistence();
    const runId = "cold-start-noscript-1";

    pers.save({
      runId,
      workflowName: "no_script_test",
      script: "",
      args: undefined,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "persisted run with empty script cannot be resumed");
  }),
);

test(
  "cold-start resume: a second manager cannot resume a run while another manager owns the lease",
  withTempCwd(async (cwd) => {
    const ownerAgent = deferredAgent();
    const owner = new WorkflowManager({ cwd, agent: ownerAgent.runner });
    owner.on("error", () => {});
    const runId = "cold-start-leased-1";
    owner.getPersistence().save({
      runId,
      workflowName: "leased",
      script: oneAgentScript,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.equal(await owner.resume(runId), true, "first manager should acquire the lease and start");
    await new Promise((r) => setTimeout(r, 20));

    const contender = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          assert.fail("second manager must not run an agent without the lease");
        },
      },
    });
    assert.equal(await contender.resume(runId), false, "second manager should be refused by the live lease");

    ownerAgent.resolve("done");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(owner.getRun(runId)?.status, "completed", "leased owner should still finish");
  }),
);

test(
  "cold-start recovery leaves a live leased running run untouched",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const pers = manager.getPersistence();
    const runId = "live-running-lease";
    pers.save({
      runId,
      workflowName: "live",
      script: oneAgentScript,
      status: "running",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const lease = pers.acquireRunLease(runId);
    assert.ok(lease, "test setup should acquire the live lease");

    try {
      new WorkflowManager({ cwd });
      assert.equal(pers.load(runId)?.status, "running", "live leased run is not recovered to paused");
    } finally {
      pers.releaseRunLease(lease);
    }
  }),
);

test(
  "cold-start resume releases the lease after failure so another manager can retry",
  withTempCwd(async (cwd) => {
    const failing = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new WorkflowError("boom", WorkflowErrorCode.UNKNOWN, { recoverable: false });
        },
      },
    });
    failing.on("error", () => {});
    const runId = "failed-lease-retry";
    failing.getPersistence().save({
      runId,
      workflowName: "failed_once",
      script: oneAgentScript,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.equal(await failing.resume(runId), true, "first resume starts");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(failing.getRun(runId)?.status, "failed", "first resume failed");

    const retry = new WorkflowManager({ cwd, agent: fakeAgent() });
    assert.equal(await retry.resume(runId), true, "failed run can be resumed after lease release");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(retry.getRun(runId)?.status, "completed", "retry manager completed the run");
  }),
);

test(
  "cold-start stop: a persisted paused run not in this.runs can be stopped from disk",
  withTempCwd(async (cwd) => {
    // Simulate a prior pi session: a run persisted as "paused" (e.g. by
    // recoverStaleRuns() flipping a stale "running" run on a previous cold
    // start) that this fresh manager never loaded into its in-memory map.
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const pers = manager.getPersistence();
    const runId = "cold-start-stop-paused-1";

    pers.save({
      runId,
      workflowName: "cold_start_stop",
      script: oneAgentScript,
      args: undefined,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.equal(manager.getRun(runId), undefined, "run is not in memory (cold-start simulation)");

    const stopped = manager.stop(runId);
    assert.equal(stopped, true, "stop should succeed for a cold-start persisted paused run");

    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "persisted status should become aborted");
  }),
);

test(
  "cold-start stop: a persisted running run not in this.runs can be stopped from disk",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const pers = manager.getPersistence();
    const runId = "cold-start-stop-running-1";

    pers.save({
      runId,
      workflowName: "cold_start_stop_running",
      script: oneAgentScript,
      args: undefined,
      status: "running",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const stopped = manager.stop(runId);
    assert.equal(stopped, true, "stop should succeed for a cold-start persisted running run");

    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "persisted status should become aborted");
  }),
);

test(
  "cold-start stop: a persisted completed run cannot be stopped",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const pers = manager.getPersistence();
    const runId = "cold-start-stop-completed-1";

    pers.save({
      runId,
      workflowName: "cold_start_stop_completed",
      script: oneAgentScript,
      args: undefined,
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    assert.equal(manager.stop(runId), false, "completed persisted run cannot be stopped");
  }),
);

test(
  "cold-start stop: an unknown run ID returns false",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    assert.equal(manager.stop("does-not-exist"), false);
  }),
);

test(
  "F01: a running execution renews its lease heartbeat so a run outliving the TTL is never evicted",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner, leaseRenewIntervalMs: 5 });
    const pers = manager.getPersistence();

    const { runId, promise } = manager.startInBackground(oneAgentScript, undefined);
    promise.catch(() => {});
    const lockPath = join(pers.getRunsDir(), `${runId}.lock`);

    // Wait until the execution owns its lock file.
    for (let i = 0; i < 200 && !existsSync(lockPath); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(existsSync(lockPath), "the running execution holds its lease lock");
    const initialExpiry = Date.parse((JSON.parse(readFileSync(lockPath, "utf-8")) as { expiresAt: string }).expiresAt);

    // Let several heartbeat ticks fire (5ms interval) and assert the expiry was
    // pushed forward past the original TTL window — without the heartbeat the
    // lock's expiresAt never moves.
    await new Promise((r) => setTimeout(r, 35));
    const renewedExpiry = Date.parse((JSON.parse(readFileSync(lockPath, "utf-8")) as { expiresAt: string }).expiresAt);
    assert.ok(
      renewedExpiry > initialExpiry,
      "the heartbeat pushed the lease expiry forward (without it, the lock never changes)",
    );
    assert.ok(
      renewedExpiry > Date.now() + DEFAULT_RUN_LEASE_TTL_MS - 1_000,
      "renewal resets the expiry to a full fresh TTL from the renewal instant",
    );

    // The run is still alive and owned; it completes normally once the agent
    // resolves, and the settle releases the lease.
    assert.equal(manager.getRun(runId)?.status, "running", "the heartbeating run is still executing");
    da.resolve("done");
    const result = await promise;
    assert.equal(result.runId, runId, "the run completed");
    assert.equal(manager.getRun(runId)?.status, "completed", "the run settled completed after the agent resolved");
    assert.equal(existsSync(lockPath), false, "the lease is released when the execution settles");
  }),
);

test(
  "F02: stop's persisted fallback re-validates status UNDER the lease — a concurrent completion is never flipped back to aborted",
  withTempCwd(async (cwd) => {
    // A run persisted as "running" that this fresh manager never loaded into
    // memory (cold-start simulation, same setup as the other cold-start stop
    // tests).
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const pers = manager.getPersistence();
    const runId = "cold-start-stop-toctou-1";
    pers.save({
      runId,
      workflowName: "cold_start_stop_toctou",
      script: oneAgentScript,
      args: undefined,
      status: "running",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Simulate the TOCTOU: stop()'s first (advisory) load sees "running", but
    // a "concurrent process" completes the run before the post-lease
    // re-validation — the second load must see "completed" and refuse,
    // releasing the lease, without overwriting the freshest state.
    const originalLoad = pers.load.bind(pers);
    let loads = 0;
    pers.load = (id: string) => {
      loads++;
      const state = originalLoad(id);
      if (loads >= 2 && state) return { ...state, status: "completed" as const };
      return state;
    };

    let stoppedEvent = false;
    manager.on("stopped", () => {
      stoppedEvent = true;
    });

    assert.equal(manager.stop(runId), false, "stop refuses once the post-lease state is completed");
    assert.equal(stoppedEvent, false, "no 'stopped' event fired for the refused stop");
    assert.ok(loads >= 2, "stop re-loaded the state under the lease (F02)");

    // The lease acquired during the refused stop was released again.
    const lease = pers.acquireRunLease(runId);
    assert.ok(lease, "the refused stop released its lease");
    if (lease) pers.releaseRunLease(lease);

    // The on-disk state is untouched (still the originally-written "running" —
    // our simulated completion was only visible to stop's re-load, not written).
    assert.equal(originalLoad(runId)?.status, "running", "the freshest on-disk state is unchanged");
  }),
);
