/**
 * V2-P10 — recorded-replay simulation harness: unit tests.
 *
 * Covers: fixture generation from a real recorded journal (canonical +
 * round-trip), byte-identical replay over cached results (zero tokens, zero
 * launches), loud REPLAY_MISS on an edited/diverged script, inline fixture
 * validation, and fixture generation from a persisted run on disk.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildReplayFixture,
  buildReplayFixtureFromRun,
  createReplayAgent,
  createReplayResumeJournal,
  isReplayMiss,
  parseReplayFixture,
  REPLAY_FIXTURE_SCHEMA_VERSION,
  type ReplayFixture,
  replayFixtureToJournalEntries,
  replaySignature,
  replayWorkflow,
  replayWorkflowFromJournal,
  stringifyReplaySignature,
} from "../src/replay-harness.js";
import { createRunPersistence } from "../src/run-persistence.js";
import type { JournalEntry, WorkflowRunResult } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { rmForce } from "./helpers/rm-force.js";

const SCRIPT = `export const meta = { name: 'replay_me', description: 'replay fixture test' }
const a = await agent('first task', { label: 'one' })
const b = await agent('second task', { label: 'two' })
const c = await agent('third task', { label: 'three' })
return { a, b, c, count: 3 }`;

/** Record a real run with a deterministic mock runner, capturing its journal. */
async function recordWorkflow(
  script: string,
  options: { args?: unknown } = {},
): Promise<{
  result: WorkflowRunResult;
  journal: JournalEntry[];
  runnerCalls: number;
}> {
  const journal: JournalEntry[] = [];
  let runnerCalls = 0;
  const runner = {
    async run(prompt: string) {
      runnerCalls += 1;
      return { echo: prompt.slice(0, 10), seq: runnerCalls };
    },
  };
  const result = await runWorkflow(script, {
    agent: runner as never,
    persistLogs: false,
    args: options.args,
    onAgentJournal: (entry) => journal.push(entry),
  });
  return { result, journal, runnerCalls };
}

function fixtureFrom(recorded: { result: WorkflowRunResult; journal: JournalEntry[] }, args?: unknown): ReplayFixture {
  return buildReplayFixture({
    runId: recorded.result.runId ?? "run-record",
    name: recorded.result.meta.name,
    description: recorded.result.meta.description,
    args,
    journal: recorded.journal,
  });
}

// ─── fixture generation ───────────────────────────────────────────────────────

test("buildReplayFixture produces a canonical, round-trippable fixture from a real journal", async () => {
  const recorded = await recordWorkflow(SCRIPT);
  assert.equal(recorded.journal.length, 3, "the record must journal all three calls");
  const fixture = fixtureFrom(recorded);

  assert.equal(fixture.schemaVersion, REPLAY_FIXTURE_SCHEMA_VERSION);
  assert.equal(fixture.name, "replay_me");
  assert.equal(fixture.runId, recorded.result.runId);
  assert.equal(fixture.entries.length, 3);
  // Entries are sorted by index and carry hash + result.
  assert.deepEqual(
    fixture.entries.map((e) => e.index),
    [0, 1, 2],
  );
  for (const entry of fixture.entries) {
    assert.equal(typeof entry.hash, "string");
    assert.ok(entry.hash.length > 0, "hash must be present");
    const expectedEcho = ["first task", "second task", "third task"][entry.index].slice(0, 10);
    assert.deepEqual(entry.result, { echo: expectedEcho, seq: entry.index + 1 });
  }

  // Round-trip: fixture → JournalEntry[] → resume map → keys match the journal's.
  const entries = replayFixtureToJournalEntries(fixture);
  assert.deepEqual(
    entries.map((e) => e.index),
    [0, 1, 2],
  );
  const resumeMap = createReplayResumeJournal(fixture);
  assert.equal(resumeMap.size, 3);
  assert.ok(resumeMap.has(`${fixture.runId}:1`), "top-level entry keyed by fixture runId + index");
});

test("buildReplayFixture is deterministic — the same journal builds byte-identical fixtures", async () => {
  const recorded = await recordWorkflow(SCRIPT);
  const a = fixtureFrom(recorded);
  const b = fixtureFrom(recorded);
  assert.equal(JSON.stringify(a), JSON.stringify(b), "rebuilding the same journal must yield identical bytes");
});

test("buildReplayFixture JSON-normalizes and drops undefined artifact fields", async () => {
  const recorded = await recordWorkflow(SCRIPT);
  const fixture = fixtureFrom(recorded);
  // The record's mock runner reported no usage and made no tool calls — those
  // optional artifact fields must be absent (JSON-dropped), keeping the
  // fixture canonical. (`model` IS legitimately recorded: the runtime seeds it
  // with the call's resolved display model even for a mock runner.)
  for (const entry of fixture.entries) {
    assert.ok(!("tokenUsage" in entry), "no tokenUsage artifact on a usage-less call");
    assert.ok(!("tokens" in entry), "no tokens artifact on a usage-less call");
    assert.ok(!("operations" in entry), "no operations artifact on a tool-less call");
    assert.ok(!("storeDelta" in entry), "no storeDelta artifact on a store-less call");
  }
});

test("buildReplayFixtureFromRun reads a persisted run's journal from disk; unknown id → null", async () => {
  await withFakeHomeAsync(mkdtempSync(join(tmpdir(), "replay-home-")), async () => {
    const cwd = mkdtempSync(join(tmpdir(), "replay-cwd-"));
    try {
      const recorded = await recordWorkflow(SCRIPT);
      const rp = createRunPersistence(cwd);
      rp.save({
        runId: recorded.result.runId ?? "persisted-run",
        workflowName: recorded.result.meta.name,
        script: SCRIPT,
        status: "paused",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        journal: recorded.journal,
      });
      const fixture = await buildReplayFixtureFromRun(recorded.result.runId ?? "persisted-run", { cwd });
      assert.ok(fixture, "a persisted run must yield a fixture");
      assert.equal(fixture.name, "replay_me");
      assert.equal(fixture.entries.length, 3);
      assert.equal(await buildReplayFixtureFromRun("no-such-run", { cwd }), null);
    } finally {
      rmForce(cwd);
    }
  });
});

// ─── replay over cached results ───────────────────────────────────────────────

test("replayWorkflow replays byte-identically over cached results — zero launches, zero tokens", async () => {
  const recorded = await recordWorkflow(SCRIPT);
  const fixture = fixtureFrom(recorded);

  const misses: unknown[] = [];
  const replayed = await replayWorkflow(SCRIPT, fixture, {
    agent: createReplayAgent({ fixture, onMiss: (miss) => misses.push(miss) }),
  });

  // The script body executed fully: same result, same phases, same agent count.
  assert.equal(
    JSON.stringify(replayed.result),
    JSON.stringify(recorded.result.result),
    "result must be byte-identical",
  );
  assert.deepEqual(replayed.phases, recorded.result.phases);
  assert.equal(replayed.agentCount, 3);
  assert.equal(misses.length, 0, "a byte-identical replay must never invoke the live runner");
  assert.equal(replayed.tokenUsage?.total ?? 0, 0, "replayed calls charge zero tokens");
  // The deterministic golden-master signature matches the record's semantic output.
  assert.equal(stringifyReplaySignature(replayed), stringifyReplaySignature(recorded.result));
});

test("replayWorkflowFromJournal replays directly from a raw recorded journal", async () => {
  const recorded = await recordWorkflow(SCRIPT);
  const replayed = await replayWorkflowFromJournal(SCRIPT, {
    runId: recorded.result.runId ?? "run-record",
    name: recorded.result.meta.name,
    journal: recorded.journal,
  });
  assert.equal(JSON.stringify(replayed.result), JSON.stringify(recorded.result.result));
  assert.equal(replayed.agentCount, 3);
});

test("replayWorkflow forces the recorded runId and defaults args from the fixture", async () => {
  const argsScript = `export const meta = { name: 'arg_replay', description: 'args default' }
const a = await agent('task ' + (args && args.value), { label: 'a' })
return a`;
  const recorded = await recordWorkflow(argsScript, { args: { value: "seed" } });
  const fixture = fixtureFrom(recorded, { value: "seed" });
  const replayed = await replayWorkflow(argsScript, fixture);
  assert.equal(replayed.runId, fixture.runId, "replay must execute under the recorded runId");
  assert.equal(JSON.stringify(replayed.result), JSON.stringify(recorded.result.result));
});

test("an edited script replays its unchanged prefix then misses loudly on the first changed call", async () => {
  const recorded = await recordWorkflow(SCRIPT);
  const fixture = fixtureFrom(recorded);
  // First call unchanged, second call's prompt edited → hash mismatch.
  const edited = SCRIPT.replace("second task", "second task EDITED");
  const misses: Array<{ label?: string }> = [];
  await assert.rejects(
    () =>
      replayWorkflow(edited, fixture, {
        agent: createReplayAgent({ fixture, onMiss: (miss) => misses.push(miss) }),
      }),
    (error: unknown) => {
      assert.ok(isReplayMiss(error), "the diverged call must throw REPLAY_MISS");
      assert.match((error as Error).message, /replay miss/);
      return true;
    },
  );
  assert.equal(misses.length, 1, "exactly one live call was refused — the edited one");
  assert.equal(misses[0]?.label, "two");
});

test("a script with a NEW agent() call misses on the unrecorded index", async () => {
  const recorded = await recordWorkflow(SCRIPT);
  const fixture = fixtureFrom(recorded);
  const extended = `${SCRIPT.replace("return { a, b, c, count: 3 }", "")}
const d = await agent('fourth task', { label: 'four' })
return { a, b, c, d, count: 4 }`;
  await assert.rejects(
    () => replayWorkflow(extended, fixture),
    (error: unknown) => isReplayMiss(error),
  );
});

test("a fixture missing an entry for a call the script makes misses", async () => {
  const recorded = await recordWorkflow(SCRIPT);
  const fixture = fixtureFrom(recorded);
  fixture.entries = fixture.entries.filter((e) => e.index !== 2);
  const twoCallScript = `export const meta = { name: 'replay_me', description: 'replay fixture test' }
const a = await agent('first task', { label: 'one' })
const b = await agent('second task', { label: 'two' })
return { a, b, count: 2 }`;
  // Call 1 matches (index 1 is in the fixture), call 0 matches, but index 2 is
  // MISSING even though the script only calls indices 0 and 1 — the missing
  // entry is irrelevant (index 2 is never called). Instead verify the inverse:
  // a fixture whose entry 0 was removed makes call index 0 miss.
  fixture.entries = recorded.journal
    .filter((e) => e.index !== 0)
    .map((e) => ({ index: e.index, hash: e.hash, result: e.result }));
  await assert.rejects(
    () => replayWorkflow(twoCallScript, fixture),
    (error: unknown) => isReplayMiss(error),
  );
});

// ─── inline fixture validation ────────────────────────────────────────────────

test("parseReplayFixture accepts a well-formed inline fixture and rejects malformed ones", async () => {
  const recorded = await recordWorkflow(SCRIPT);
  const fixture = fixtureFrom(recorded);
  const parsed = parseReplayFixture(JSON.parse(JSON.stringify(fixture)));
  assert.equal(parsed.entries.length, 3);

  const malformed = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
  malformed.schemaVersion = 99;
  assert.throws(() => parseReplayFixture(malformed), /schemaVersion/);

  const noHash = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
  (noHash.entries as Array<Record<string, unknown>>)[0] = { index: 0, result: "x" };
  assert.throws(() => parseReplayFixture(noHash), /hash/);

  assert.throws(() => parseReplayFixture("not-an-object"), /must be a JSON object/);
});

// ─── golden-master signature ──────────────────────────────────────────────────

test("replaySignature is the deterministic value surface (no wall-clock/usage/logs)", async () => {
  const recorded = await recordWorkflow(SCRIPT);
  const fixture = fixtureFrom(recorded);
  const replayed = await replayWorkflow(SCRIPT, fixture);
  const signature = replaySignature(replayed);
  assert.deepEqual(Object.keys(signature).sort(), ["agentCount", "failedAgents", "phases", "result"]);
  assert.equal(signature.agentCount, 3);
  assert.deepEqual(signature.phases, []);
  assert.equal(signature.failedAgents, undefined);
});
