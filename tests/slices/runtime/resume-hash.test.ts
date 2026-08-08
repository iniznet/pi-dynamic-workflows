import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { JournalEntry } from "../../../src/workflow.js";
import { runWorkflow } from "../../../src/workflow.js";

const RUN_ID = "hash-run";
const SCRIPT = `export const meta = { name: 'hash_demo', description: 'resume identity' }
return await agent('same prompt', { label: 'x' })`;
const TIER_SCRIPT = `export const meta = { name: 'hash_tier', description: 'tier identity' }
return await agent('tiered', { label: 'x', tier: 'small' })`;

function makeJournal(): Map<string, JournalEntry> {
  const journal = new Map<string, JournalEntry>();
  return journal;
}

// core-08: a minimal ModelRegistry projection — listAvailableModels only needs
// getAvailable() to derive {spec, costOutput, contextWindow} (see src/agent.ts).
function mockRegistry(
  models: Array<{ provider: string; id: string; costOutput?: number; contextWindow?: number }>,
): ModelRegistry {
  return {
    getAvailable: () =>
      models.map((m) => ({
        provider: m.provider,
        id: m.id,
        cost: m.costOutput === undefined ? undefined : { output: m.costOutput },
        contextWindow: m.contextWindow,
      })),
    find: () => undefined,
    getAll: () => [],
  } as unknown as ModelRegistry;
}

test("M5: changing the session default model invalidates an UNTAGGED call's cached replay", async () => {
  let calls = 0;
  const agent = {
    async run() {
      calls++;
      return "ok";
    },
  };
  const journal = makeJournal();
  const options = (mainModel: string) => ({
    agent,
    persistLogs: false,
    runId: RUN_ID,
    mainModel,
    // Deterministic: no model-tiers config on disk, so an untagged agent with
    // no phase route resolves purely to the session default (defaultModel).
    loadTierConfig: () => null,
    onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry),
  });

  await runWorkflow(SCRIPT, options("prov/m1"));
  assert.equal(calls, 1, "first run executes live");

  await runWorkflow(SCRIPT, { ...options("prov/m1"), resumeJournal: journal });
  assert.equal(calls, 1, "same default model replays from cache");

  await runWorkflow(SCRIPT, { ...options("prov/m2"), resumeJournal: journal });
  assert.equal(calls, 2, "a default-model change invalidates the cached replay of an untagged call (M5)");
});

test("M5: isolation participates in the resume hash — adding isolation invalidates the cache", async () => {
  let calls = 0;
  const agent = {
    async run() {
      calls++;
      return "ok";
    },
  };
  const journal = makeJournal();
  const base = {
    agent,
    persistLogs: false,
    runId: RUN_ID,
    mainModel: "prov/m1",
    loadTierConfig: () => null,
    onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry),
  };

  await runWorkflow(SCRIPT, base);
  await runWorkflow(SCRIPT, { ...base, resumeJournal: journal });
  assert.equal(calls, 1, "unchanged identity replays from cache");

  // The isolation is hashed even though this cwd is not a git repo — the hash
  // is computed at call time, before createWorktree's (logged) fallback.
  const isolatedScript = `export const meta = { name: 'hash_demo', description: 'resume identity' }
return await agent('same prompt', { label: 'x', isolation: 'worktree' })`;
  await runWorkflow(isolatedScript, { ...base, resumeJournal: journal });
  assert.equal(calls, 2, "adding isolation invalidates the cached replay (M5)");
});

test("M5: a tiered call's hash is unaffected by mainModel changes (tierModel already encodes it)", async () => {
  let calls = 0;
  const agent = {
    async run() {
      calls++;
      return "ok";
    },
  };
  const journal = makeJournal();
  const tierScript = `export const meta = { name: 'hash_tier', description: 'tier identity' }
return await agent('tiered', { label: 'x', tier: 'small' })`;
  const tierConfig = () => ({ tiers: { small: "prov/small-model" } });
  const options = (mainModel: string) => ({
    agent,
    persistLogs: false,
    runId: RUN_ID,
    mainModel,
    loadTierConfig: tierConfig,
    onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry),
  });

  await runWorkflow(tierScript, options("prov/m1"));
  await runWorkflow(tierScript, { ...options("prov/m1"), resumeJournal: journal });
  assert.equal(calls, 1, "tiered call replays with the same tier config");
  await runWorkflow(tierScript, { ...options("prov/m2"), resumeJournal: journal });
  assert.equal(calls, 1, "mainModel is not double-encoded for tiered calls");
});

// ─── core-08: registry fingerprint in the replay hash ────────────────────────
// The no-config prompt-aware tier fallback (tier set, no model-tiers.json)
// ranks the model registry via buildDefaultTierConfig, so a registry change
// between a live run and its resume must invalidate the cached journaled
// result. The fingerprint is included ONLY on that path; when no registry is
// supplied (or a config exists), the hash keeps its pre-fix encoding so legacy
// journals replay unchanged.

test("core-08: a registry change invalidates the cached replay of a no-config tiered call", async () => {
  let calls = 0;
  const agent = {
    async run() {
      calls++;
      return "ok";
    },
  };
  const journal = makeJournal();
  const options = (registry: ModelRegistry) => ({
    agent,
    persistLogs: false,
    runId: RUN_ID,
    mainModel: "prov/main",
    // No model-tiers.json: a tiered call resolves through the prompt-aware
    // fallback, which ranks exactly this registry.
    loadTierConfig: () => null,
    modelRegistry: registry,
    onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry),
  });

  const registryA = mockRegistry([
    { provider: "prov", id: "cheap-1", costOutput: 1, contextWindow: 8000 },
    { provider: "prov", id: "capable-1", costOutput: 20, contextWindow: 128000 },
  ]);
  await runWorkflow(TIER_SCRIPT, options(registryA));
  assert.equal(calls, 1, "first run executes live");

  await runWorkflow(TIER_SCRIPT, { ...options(registryA), resumeJournal: journal });
  assert.equal(calls, 1, "the same registry replays from cache");

  // The registry changed (a cheaper model appeared / ranking shifted): the
  // no-config fallback would resolve to a different model now, so the cached
  // result must NOT replay (core-08).
  const registryB = mockRegistry([
    { provider: "prov", id: "cheap-2", costOutput: 1, contextWindow: 8000 },
    { provider: "prov", id: "capable-1", costOutput: 20, contextWindow: 128000 },
  ]);
  await runWorkflow(TIER_SCRIPT, { ...options(registryB), resumeJournal: journal });
  assert.equal(calls, 2, "a registry change invalidates the cached replay of a no-config tiered call");
});

test("core-08: no explicit registry keeps the legacy encoding — tiered no-config calls replay stably", async () => {
  let calls = 0;
  const agent = {
    async run() {
      calls++;
      return "ok";
    },
  };
  const journal = makeJournal();
  const options = () => ({
    agent,
    persistLogs: false,
    runId: RUN_ID,
    mainModel: "prov/main",
    loadTierConfig: () => null,
    // No modelRegistry anywhere: the fingerprint is absent, so the hash is
    // byte-identical to the pre-fix encoding — journals persisted before the
    // fingerprint existed (or by a registry-less run) replay without a miss.
    onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry),
  });

  await runWorkflow(TIER_SCRIPT, options());
  await runWorkflow(TIER_SCRIPT, { ...options(), resumeJournal: journal });
  assert.equal(calls, 1, "registry-less no-config tiered call replays from cache (legacy encoding)");
});

test("core-08: a configured-tier call is unaffected by a registry change (tierModel already encodes the config)", async () => {
  let calls = 0;
  const agent = {
    async run() {
      calls++;
      return "ok";
    },
  };
  const journal = makeJournal();
  const tierConfig = () => ({ tiers: { small: "prov/small-model" } });
  const options = (registry: ModelRegistry | undefined) => ({
    agent,
    persistLogs: false,
    runId: RUN_ID,
    mainModel: "prov/main",
    loadTierConfig: tierConfig,
    modelRegistry: registry,
    onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry),
  });

  const registryA = mockRegistry([{ provider: "prov", id: "cheap-1", costOutput: 1, contextWindow: 8000 }]);
  await runWorkflow(TIER_SCRIPT, options(registryA));
  assert.equal(calls, 1, "first run executes live");

  await runWorkflow(TIER_SCRIPT, { ...options(registryA), resumeJournal: journal });
  assert.equal(calls, 1, "same registry + same config replays from cache");

  // A registry change must NOT invalidate a configured-tier call: the model is
  // resolved from model-tiers.json (already encoded in tierModel), so the
  // registry fingerprint is not part of this hash.
  const registryB = mockRegistry([{ provider: "prov", id: "cheap-2", costOutput: 1, contextWindow: 8000 }]);
  await runWorkflow(TIER_SCRIPT, { ...options(registryB), resumeJournal: journal });
  assert.equal(calls, 1, "a configured-tier call replays despite a registry change");
});
