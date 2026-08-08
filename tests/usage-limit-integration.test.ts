/**
 * Real-session integration test for issue #26 — provider usage-limit handling.
 *
 * Every other test injects a fake agent runner; this one drives the REAL
 * `WorkflowAgent.run` → `createAgentSession` path and uses the pi SDK's built-in
 * faux stream to end a turn in a "usage limit reached" error (stopReason
 * "error" + errorMessage), exactly as a real provider buries a quota exhaustion.
 * It is the contract guard for the load-bearing SDK assumption behind the fix:
 * a usage limit surfaces as an error-status assistant message, not a thrown error.
 * No network call is made and NO provider quota is consumed.
 *
 * pi >= 0.80.8: sessions stream through a ModelRuntime, and a builtin provider
 * with no overlays bypasses the compat api registry entirely — so the old
 * registerFauxProvider() global-registry hook is invisible to the session.
 * Instead, register the faux core as an extension provider on an explicit
 * ModelRuntime (its streamSimple is closure-scripted, no registry involved)
 * and hand that runtime to the subagent session.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { WorkflowAgent } from "../src/agent.js";
import { WorkflowErrorCode } from "../src/errors.js";
import { ProviderPool } from "../src/gateway/provider-pool.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { rmForce } from "./helpers/rm-force.js";

const USAGE_LIMIT_MSG = "Codex usage limit reached (plus plan). Resets in ~3h.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll a run's status until it reaches `status` or the deadline passes (same pattern as journal-compaction-persist.test.ts). */
async function waitForStatus(
  manager: WorkflowManager,
  runId: string,
  status: string,
  deadlineMs = 3000,
): Promise<string | undefined> {
  const deadline = Date.now() + deadlineMs;
  let current: string | undefined;
  while (Date.now() < deadline) {
    current = manager.getRun(runId)?.status;
    if (current === status) return current;
    await sleep(25);
  }
  return current;
}

/**
 * Run `fn` with an isolated HOME and a scripted faux provider registered on a
 * test-scoped ModelRuntime — no real credentials are touched and no network
 * call can happen; `setResponses` queues the scripted turns.
 */
async function withFauxSession(
  fn: (ctx: {
    cwd: string;
    model: unknown;
    modelRuntime: ModelRuntime;
    setResponses: (msgs: unknown[]) => void;
    fauxAssistantMessage: typeof import("@earendil-works/pi-ai").fauxAssistantMessage;
  }) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-i26-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-i26-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      // Created inside the fake home so every default path stays isolated.
      const modelRuntime = await ModelRuntime.create({
        authPath: join(home, "auth.json"),
        modelsPath: null,
      });
      modelRuntime.registerProvider("fauxtest", {
        name: "Faux Test",
        // Required by custom-model validation; never dialed — streamSimple intercepts.
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: core.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          reasoning: false,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow ?? 128000,
          maxTokens: m.maxTokens ?? 4096,
        })),
      });
      const model = modelRuntime.getModel("fauxtest", "faux-model") ?? core.getModel();
      await fn({
        cwd,
        model,
        modelRuntime,
        setResponses: (msgs) => core.setResponses(msgs as never),
        fauxAssistantMessage,
      });
    });
  } finally {
    await rmForce(home, cwd);
  }
}

test("a real subagent session that hits a usage limit surfaces PROVIDER_USAGE_LIMIT (not SCHEMA_NONCOMPLIANCE/EMPTY)", () =>
  withFauxSession(async ({ cwd, model, modelRuntime, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT_MSG })]);
    const agent = new WorkflowAgent({ cwd, session: { model: model as never, modelRuntime } });
    await assert.rejects(
      () => agent.run("do the task", { label: "probe" }),
      (err: unknown) => {
        const e = err as { code?: string; recoverable?: boolean; message?: string; resetHint?: string };
        assert.equal(e.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, `got ${e.code}`);
        assert.equal(e.recoverable, false, "must halt so the run can checkpoint, not retry-into-the-wall");
        assert.ok(e.message?.includes("usage limit reached"), "carries the real provider message");
        assert.equal(e.resetHint, "Resets in ~3h", "extracts the provider reset hint");
        return true;
      },
    );
  }));

test("a successful real turn whose text merely mentions 'rate limit' is NOT misclassified", () =>
  withFauxSession(async ({ cwd, model, modelRuntime, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("Done. I handled the rate limit gracefully.", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd, session: { model: model as never, modelRuntime } });
    const text = await agent.run("do the task", { label: "ok" });
    assert.ok(typeof text === "string" && text.includes("Done."), `expected normal text, got ${String(text)}`);
  }));

test("through the manager: a usage limit pauses the run (not fails) and resume replays the journal", () =>
  withFauxSession(async ({ cwd, model, modelRuntime, setResponses, fauxAssistantMessage }) => {
    const managerAgent = new WorkflowAgent({ cwd, session: { model: model as never, modelRuntime } });
    const manager = new WorkflowManager({ cwd, agent: managerAgent });
    const pausedReasons: Array<string | undefined> = [];
    manager.on("paused", (e: { reason?: string }) => pausedReasons.push(e.reason));
    manager.on("error", () => {});

    const twoAgentScript = `export const meta = { name: 'i26_integration', description: 'two agents' }
const a = await agent('first step', { label: 'first' })
const b = await agent('second step', { label: 'second' })
return { a, b }`;

    // Agent 1 succeeds (journaled); agent 2 hits the usage limit.
    setResponses([
      fauxAssistantMessage("first-result-text", { stopReason: "stop" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT_MSG }),
    ]);
    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await promise.catch(() => {});

    assert.equal(manager.getRun(runId)?.status, "paused", "run is checkpointed as paused, not failed");
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.pauseReason, "usage_limit");
    assert.equal(persisted?.resetHint, "Resets in ~3h");
    assert.ok((persisted?.journal?.length ?? 0) >= 1, "agent 1's result is journaled");
    assert.ok(pausedReasons.includes("usage_limit"), "a usage_limit 'paused' event fired");

    // Budget refills: agent 2 now succeeds. Resume replays agent 1 from the journal.
    setResponses([fauxAssistantMessage("second-result-text", { stopReason: "stop" })]);
    assert.equal(await manager.resume(runId), true, "the paused run is resumable");

    // Resume triggers background replay; poll instead of sleeping so slow machines
    // don't race the completion assert.
    const status = await waitForStatus(manager, runId, "completed");
    assert.equal(status, "completed", "resumed run completes once the limit clears");
    const done = manager.getRun(runId);
    assert.equal((done?.result?.result as { a?: string })?.a, "first-result-text", "agent 1 replayed from journal");
    assert.equal((done?.result?.result as { b?: string })?.b, "second-result-text", "agent 2 ran live after refill");
  }));

test("D1/D8: through the manager, whole-pool saturation checkpoints the run as paused (not failed)", () =>
  withFauxSession(async ({ cwd, model, modelRuntime }) => {
    // A REAL pool in "fail" mode whose single provider is TPM-capped from the
    // start: every acquire deterministically throws whole-pool
    // PROVIDER_SATURATED (recoverable:false) BEFORE any session work — the
    // pool is consulted at each agent()'s model-resolution step (the manager
    // now forwards its pool into the run, see setProviderPool).
    const pool = new ProviderPool(
      {
        enabled: true,
        whenSaturated: "fail",
        saturationWaitTimeoutMs: 0,
        defaultTpmWindowMs: 60_000,
        models: {
          "faux-model": {
            fauxtest: { provider: "fauxtest", modelId: "faux-model", concurrency: 4, weight: 1, tpm: 100 },
          },
        },
      },
      {
        find: () => ({ provider: "fauxtest", modelId: "faux-model" }),
        hasConfiguredAuth: () => true,
        getAll: () => [{ provider: "fauxtest", modelId: "faux-model" }],
      } as never,
    );
    // Cap the TPM window immediately — placement is impossible from the very
    // first acquire, so the run deterministically lands on PROVIDER_SATURATED.
    pool.recordSpend("fauxtest", 100);

    const managerAgent = new WorkflowAgent({ cwd, session: { model: model as never, modelRuntime } });
    const manager = new WorkflowManager({ cwd, agent: managerAgent });
    manager.setProviderPool(pool);
    const pausedReasons: Array<string | undefined> = [];
    manager.on("paused", (e: { reason?: string }) => pausedReasons.push(e.reason));
    manager.on("error", () => {});

    const script = `export const meta = { name: 'sat_integration', description: 'saturation' }
const a = await agent('work', { label: 'a', model: 'faux-model' })
return { a }`;
    const { runId, promise } = manager.startInBackground(script);
    await promise.catch(() => {});

    assert.equal(
      manager.getRun(runId)?.status,
      "paused",
      "whole-pool saturation checkpoints the run as paused, not failed",
    );
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.pauseReason, "provider_saturated", "the pause reason is recorded for the navigator");
    assert.ok(pausedReasons.includes("provider_saturated"), "a provider_saturated 'paused' event fired");
  }));
