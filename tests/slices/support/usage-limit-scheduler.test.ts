/**
 * Slice W — usage-limit scheduler hardening (M8, L11).
 *
 * Covers: consecutive-refusal give-up with backoff (never re-arms forever),
 * and day/week reset-hint parsing.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { PersistedRunState, RunPersistence } from "../../../src/run-persistence.js";
import {
  parseResetHintMs,
  type SchedulableWorkflowManager,
  UsageLimitScheduler,
} from "../../../src/usage-limit-scheduler.js";

// ---- test doubles (same pattern as tests/usage-limit-scheduler.test.ts) -------

function createFakeClock(startMs = 0) {
  const current = startMs;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  return {
    now: () => current,
    setTimer: (fn: () => void, ms: number): number => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id: unknown): void => {
      pending.delete(id as number);
    },
    fireAll(): void {
      const toFire = [...pending.entries()].sort((a, b) => a[0] - b[0]);
      pending.clear();
      for (const [, { fn }] of toFire) fn();
    },
    pendingCount: () => pending.size,
    pendingDelays: (): number[] => [...pending.values()].map((p) => p.ms),
  };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

class FakePersistence {
  private runs = new Map<string, PersistedRunState>();

  seed(run: PersistedRunState): void {
    this.runs.set(run.runId, run);
  }

  get(runId: string): PersistedRunState | undefined {
    return this.runs.get(runId);
  }

  list(): PersistedRunState[] {
    return [...this.runs.values()];
  }

  asRunPersistence(): RunPersistence {
    return {
      save: (state: PersistedRunState) => {
        this.runs.set(state.runId, { ...state, updatedAt: new Date().toISOString() });
      },
      load: (runId: string) => this.runs.get(runId) ?? null,
      list: () => [...this.runs.values()],
      delete: (runId: string) => this.runs.delete(runId),
      acquireRunLease: () => null,
      releaseRunLease: () => {},
      getRunsDir: () => "/fake-runs",
    };
  }
}

class FakeManager extends EventEmitter implements SchedulableWorkflowManager {
  readonly persistence = new FakePersistence();
  resumeImpl: (runId: string) => Promise<boolean> = async () => false;

  listAllRuns(): PersistedRunState[] {
    return this.persistence.list();
  }

  resume(runId: string): Promise<boolean> {
    return this.resumeImpl(runId);
  }

  getPersistence(): RunPersistence {
    return this.persistence.asRunPersistence();
  }
}

function makeRun(overrides: Partial<PersistedRunState> = {}): PersistedRunState {
  return {
    runId: "run-1",
    workflowName: "test_workflow",
    script: "export const meta = { name: 'test_workflow', description: 'd' }",
    status: "paused",
    phases: [],
    agents: [],
    logs: [],
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

// ---- M8: consecutive-refusal give-up + backoff ---------------------------------

test("gives up after maxConsecutiveRefusals refused resume() calls, with backoff (M8)", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ resetHint: "resets in 10m" }));
  const clock = createFakeClock();
  let resumeCalls = 0;
  const diagnostics: string[] = [];
  manager.resumeImpl = async () => {
    resumeCalls++;
    return false; // transient lease/state contention
  };

  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onDiagnostic: (m) => diagnostics.push(m),
    maxAttempts: 3,
    maxConsecutiveRefusals: 2,
    minDelayMs: 60_000,
    fallbackDelayMs: 300_000,
    maxDelayMs: 3_600_000,
  });

  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  assert.deepEqual(clock.pendingDelays(), [10 * 60_000], "attempt 1 arms at the reset-hint delay");

  clock.fireAll();
  await flush();
  assert.equal(resumeCalls, 1);
  assert.deepEqual(clock.pendingDelays(), [60_000], "first refusal re-arms at the floor, no attempt consumed");
  assert.equal(scheduler.getAttemptCount("run-1"), 1, "a refusal never consumes a pause-attempt");

  clock.fireAll();
  await flush();
  assert.equal(resumeCalls, 2);
  assert.deepEqual(clock.pendingDelays(), [120_000], "second refusal backs off exponentially (2x floor)");

  clock.fireAll();
  await flush();
  assert.equal(resumeCalls, 3);
  assert.equal(clock.pendingCount(), 0, "no further timer armed once the refusal cap is crossed");
  assert.equal(scheduler.hasArmedTimer("run-1"), false);
  assert.ok(
    diagnostics.some((m) => m.includes("giving up") && m.includes("refused")),
    "a refusal give-up diagnostic is logged",
  );
  assert.equal(
    diagnostics.filter((m) => m.includes("giving up")).length,
    1,
    "the give-up diagnostic logs exactly once",
  );
  assert.equal(scheduler.getAttemptCount("run-1"), 4, "the persisted counter freezes at maxAttempts+1");

  scheduler.dispose();
});

test("a manual resume resets the refusal-given-up state so a later pause retries (M8)", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ resetHint: "resets in 10m" }));
  const clock = createFakeClock();
  const diagnostics: string[] = [];
  manager.resumeImpl = async () => false;

  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onDiagnostic: (m) => diagnostics.push(m),
    maxAttempts: 3,
    maxConsecutiveRefusals: 1,
    minDelayMs: 60_000,
    fallbackDelayMs: 300_000,
    maxDelayMs: 3_600_000,
  });

  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  clock.fireAll();
  await flush();
  assert.equal(clock.pendingCount(), 1, "first refusal (cap 1) still re-arms — the cap is exceeded, not reached");
  clock.fireAll();
  await flush();
  assert.equal(clock.pendingCount(), 0, "second consecutive refusal exceeds the cap and gives up");

  // Human resumes via /workflows → the manager emits "resumed" (not our timer).
  manager.emit("resumed", { runId: "run-1" });
  await flush();
  assert.equal(scheduler.getAttemptCount("run-1"), undefined, "in-memory given-up state cleared");

  // A later pause re-enters the normal cycle.
  manager.emit("paused", { runId: "run-1", reason: "usage_limit", resetHint: "resets in 10m" });
  assert.equal(scheduler.hasArmedTimer("run-1"), true, "a fresh attempt is armed after the manual resume");
  scheduler.dispose();
});

// ---- L11: day/week reset hints -------------------------------------------------

test("parseResetHintMs parses day and week units (L11)", () => {
  assert.equal(parseResetHintMs("resets in 2 days"), 2 * 86_400_000);
  assert.equal(parseResetHintMs("resets in 2d"), 2 * 86_400_000);
  assert.equal(parseResetHintMs("resets in 1 week"), 7 * 86_400_000);
  assert.equal(parseResetHintMs("resets in 1w"), 7 * 86_400_000);
  assert.equal(parseResetHintMs("resets in 1w2d"), 7 * 86_400_000 + 2 * 86_400_000);
});

test("parseResetHintMs does not misread day words as bare units (L11)", () => {
  // "days"/"weeks" must parse as whole words; a bare "d"/"w" followed by a
  // letter must not match (the negative lookahead).
  assert.equal(parseResetHintMs("resets in 1day"), 86_400_000);
  assert.equal(parseResetHintMs("resets in 3days"), 3 * 86_400_000);
  assert.equal(parseResetHintMs("in 2 weeks time"), 2 * 7 * 86_400_000);
});

// ---- provider_overloaded pauses (503/504 outages) -----------------------------

test("provider_overloaded pause arms at the reset-hint delay, like usage_limit (500-path)", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({ resetHint: "resets in 30m" }));
  const clock = createFakeClock();
  manager.resumeImpl = async () => true;

  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    maxAttempts: 3,
    maxConsecutiveRefusals: 2,
    minDelayMs: 60_000,
    fallbackDelayMs: 300_000,
    maxDelayMs: 3_600_000,
  });

  manager.emit("paused", { runId: "run-1", reason: "provider_overloaded", resetHint: "resets in 30m" });
  assert.deepEqual(
    clock.pendingDelays(),
    [30 * 60_000],
    "a provider-overloaded pause arms at the reset-hint delay, not the floor",
  );
  scheduler.dispose();
});

test("provider_overloaded pause without a reset hint arms at the fallback delay (500-path)", async () => {
  const manager = new FakeManager();
  manager.persistence.seed(makeRun({}));
  const clock = createFakeClock();
  manager.resumeImpl = async () => false;

  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    maxAttempts: 3,
    maxConsecutiveRefusals: 2,
    minDelayMs: 60_000,
    fallbackDelayMs: 300_000,
    maxDelayMs: 3_600_000,
  });

  manager.emit("paused", { runId: "run-1", reason: "provider_overloaded" });
  assert.deepEqual(
    clock.pendingDelays(),
    [300_000],
    "no reset hint → the fallback delay is used for the provider-outage arm",
  );
  scheduler.dispose();
});

test("cold start re-arms a provider_overloaded paused run left by a previous process (500-path)", async () => {
  const manager = new FakeManager();
  // A run the previous process paused on a 503 outage, persisted with autoResume on.
  manager.persistence.seed(makeRun({ autoResume: true, pauseReason: "provider_overloaded", autoResumeAttempts: 1 }));
  const clock = createFakeClock(0);
  let resumeCalls = 0;
  manager.resumeImpl = async () => {
    resumeCalls++;
    return true;
  };

  const scheduler = new UsageLimitScheduler(manager, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    maxAttempts: 3,
    maxConsecutiveRefusals: 2,
    minDelayMs: 60_000,
    fallbackDelayMs: 300_000,
    maxDelayMs: 3_600_000,
  });

  assert.equal(scheduler.hasArmedTimer("run-1"), true, "cold start arms the stalled provider-overloaded run");
  assert.equal(scheduler.getAttemptCount("run-1"), 2, "attempts continue from the persisted counter");

  clock.fireAll();
  await flush();
  assert.equal(resumeCalls, 1, "the cold-start timer fires a resume for the stalled run");
  scheduler.dispose();
});
