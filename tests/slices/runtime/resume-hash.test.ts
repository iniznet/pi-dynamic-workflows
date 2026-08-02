import assert from "node:assert/strict";
import test from "node:test";
import type { JournalEntry } from "../../../src/workflow.js";
import { runWorkflow } from "../../../src/workflow.js";

const RUN_ID = "hash-run";
const SCRIPT = `export const meta = { name: 'hash_demo', description: 'resume identity' }
return await agent('same prompt', { label: 'x' })`;

function makeJournal(): Map<string, JournalEntry> {
  const journal = new Map<string, JournalEntry>();
  return journal;
}

test("M5: changing the session default model invalidates an UNTAGGED call's cached replay", async () => {
  let calls = 0;
  const agent = {
    async run() {
      calls++;
      return "ok";
    },
  };
  const journal = makeJournal(RUN_ID);
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
  const journal = makeJournal(RUN_ID);
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
  const journal = makeJournal(RUN_ID);
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
