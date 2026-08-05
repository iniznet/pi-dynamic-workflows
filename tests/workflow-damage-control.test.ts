/**
 * workflow-damage-control.test.ts — pure-helper unit suite (design §3.2).
 *
 * Every helper is exercised without a manager: normalizeDamageControlInput
 * (schema-level validation), allowedDamageControlActions (the full per-status ×
 * capability verb matrix), summarizeRunDeep (deep status payload), summarizeAgents
 * (live-over-persisted merge), classifyRecoveryAction (the full orphan/crash
 * matrix), reconcileAgentAfterKill (CAS mutate semantics), collectCleanCandidates
 * (dry-run candidate list), and formatDamageControlText.
 *
 * Companion: tests/damage-control-e2e.test.ts (real-disk probes).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkflowSnapshot } from "../src/display.js";
import { WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState, RunLeaseInfo, RunStatus } from "../src/run-persistence.js";
import {
  allowedDamageControlActions,
  classifyRecoveryAction,
  collectCleanCandidates,
  DAMAGE_CONTROL_ACTIONS,
  DAMAGE_CONTROL_READONLY_ACTIONS,
  formatDamageControlText,
  normalizeDamageControlInput,
  reconcileAgentAfterKill,
  summarizeAgents,
  summarizeRunDeep,
} from "../src/workflow-damage-control.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function run(overrides: Partial<PersistedRunState> = {}): PersistedRunState {
  return {
    runId: "dc-unit-1",
    workflowName: "unit audit",
    script: "export const meta = { name: 'unit', description: 'x' }; return await agent('x')",
    status: "running",
    phases: ["Inspect"],
    currentPhase: "Inspect",
    agents: [
      { id: 1, label: "active", prompt: "a", status: "running", tokens: 30, callId: "dc-unit-1:0" },
      { id: 2, label: "spare", prompt: "b", status: "skipped" },
      {
        id: 3,
        label: "failed",
        prompt: "c",
        status: "error",
        error: "boom",
        errorCode: WorkflowErrorCode.AGENT_EXECUTION_ERROR,
      },
      { id: 4, label: "done", prompt: "d", status: "done", tokens: 10 },
      { id: 5, label: "skipped", prompt: "e", status: "skipped" },
    ],
    logs: ["line one", "line two"],
    startedAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:01.000Z",
    tokenUsage: { input: 20, output: 10, total: 30 },
    journal: [{ index: 0, hash: "dc-unit-1:0", result: "first" }],
    checkpoints: [
      { runId: "dc-unit-1", taskId: "checkpoint-1", status: "done", timestamp: "2026-07-14T00:00:00.500Z" },
    ],
    agentRetries: 2,
    ...overrides,
  };
}

function lease(overrides: Partial<RunLeaseInfo> = {}): RunLeaseInfo {
  return {
    runId: "dc-unit-1",
    pid: 4242,
    startedAt: "2026-07-14T00:00:00.000Z",
    alive: false,
    expired: false,
    staleByAge: false,
    reclaimable: true,
    ...overrides,
  };
}

function snapshot(): WorkflowSnapshot {
  return {
    name: "unit audit",
    phases: ["Inspect"],
    currentPhase: "Inspect",
    logs: ["live"],
    // Same callId as the persisted agent 1 so the live-over-persisted merge
    // keys correctly (the merge is by callId, not by id).
    agents: [
      {
        id: 1,
        callId: "dc-unit-1:0",
        label: "active",
        prompt: "a",
        status: "running",
        tokens: 99,
        model: "provider/live",
      },
    ],
    agentCount: 1,
    runningCount: 1,
    doneCount: 0,
    errorCount: 0,
    durationMs: 1234,
    tokenUsage: { input: 90, output: 9, total: 99 },
    runId: "dc-unit-1",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeDamageControlInput
// ─────────────────────────────────────────────────────────────────────────────

test("normalizeDamageControlInput rejects non-object input", () => {
  assert.throws(() => normalizeDamageControlInput(null), /requires an object argument/);
  assert.throws(() => normalizeDamageControlInput("list"), /requires an object argument/);
  assert.throws(() => normalizeDamageControlInput(["list"]), /requires an object argument/);
});

test("normalizeDamageControlInput rejects unknown actions and enforces the 9-verb vocabulary", () => {
  assert.equal(DAMAGE_CONTROL_ACTIONS.length, 9, "exactly the design's nine verbs");
  assert.throws(() => normalizeDamageControlInput({ action: "explode" }), /requires action/);
  assert.throws(() => normalizeDamageControlInput({}), /requires action/);
  for (const action of DAMAGE_CONTROL_ACTIONS) {
    assert.doesNotThrow(
      () =>
        normalizeDamageControlInput({
          action,
          ...(action === "clean" || action === "list" ? {} : { runId: "r-1" }),
          ...(action === "kill-agent" ? { agentId: "1" } : {}),
        }),
      `action ${action} should normalize cleanly`,
    );
  }
});

test("normalizeDamageControlInput enforces per-action key rules (extra keys, runId, agentId)", () => {
  assert.throws(() => normalizeDamageControlInput({ action: "list", runId: "r-1" }), /does not accept runId/);
  assert.throws(
    () => normalizeDamageControlInput({ action: "clean", dryRun: true, runId: "r-1" }),
    /does not accept runId/,
  );
  assert.throws(() => normalizeDamageControlInput({ action: "status" }), /requires runId/);
  assert.throws(() => normalizeDamageControlInput({ action: "pause", runId: "  " }), /requires runId/);
  assert.throws(() => normalizeDamageControlInput({ action: "kill-agent", runId: "r-1" }), /requires agentId/);
  assert.throws(
    () => normalizeDamageControlInput({ action: "kill-agent", runId: "r-1", agentId: "1", script: "x" }),
    /does not accept script/,
  );
  // resume/recover accept script; clean accepts dryRun. Absent keys come back
  // as explicit undefined (the parsed DamageControlInput shape).
  assert.deepEqual(normalizeDamageControlInput({ action: "resume", runId: "r-1", script: "x" }), {
    action: "resume",
    runId: "r-1",
    agentId: undefined,
    dryRun: undefined,
    script: "x",
  });
  assert.deepEqual(normalizeDamageControlInput({ action: "clean", dryRun: false }), {
    action: "clean",
    runId: undefined,
    agentId: undefined,
    dryRun: false,
    script: undefined,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// allowedDamageControlActions — the design §4 matrix
// ─────────────────────────────────────────────────────────────────────────────

test("allowedDamageControlActions matches the design §4 matrix for full capabilities", () => {
  assert.deepEqual(allowedDamageControlActions("running", "full"), [
    "list",
    "status",
    "agents",
    "pause",
    "stop",
    "kill-agent",
    "clean",
  ]);
  assert.deepEqual(allowedDamageControlActions("paused", "full"), [
    "list",
    "status",
    "agents",
    "resume",
    "stop",
    "kill-agent",
    "recover",
    "clean",
  ]);
  assert.deepEqual(allowedDamageControlActions("failed", "full"), [
    "list",
    "status",
    "agents",
    "resume",
    "kill-agent",
    "recover",
    "clean",
  ]);
  assert.deepEqual(allowedDamageControlActions("pending", "full"), [
    "list",
    "status",
    "agents",
    "resume",
    "kill-agent",
    "recover",
    "clean",
  ]);
  assert.deepEqual(allowedDamageControlActions("completed", "full"), ["list", "status", "agents", "clean"]);
  assert.deepEqual(allowedDamageControlActions("aborted", "full"), ["list", "status", "agents", "clean"]);
});

test("readonly capability always returns exactly the readonly verbs, whatever the status", () => {
  for (const status of ["running", "paused", "failed", "pending", "completed", "aborted"] as RunStatus[]) {
    assert.deepEqual(allowedDamageControlActions(status, "readonly"), [...DAMAGE_CONTROL_READONLY_ACTIONS]);
  }
  assert.deepEqual([...DAMAGE_CONTROL_READONLY_ACTIONS], ["list", "status", "agents", "clean"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// summarizeRunDeep
// ─────────────────────────────────────────────────────────────────────────────

test("summarizeRunDeep folds phase, journal, checkpoints, lease, config, counts, tokens, logs, result", () => {
  const summary = summarizeRunDeep(run(), snapshot(), lease());
  assert.equal(summary.runId, "dc-unit-1");
  assert.equal(summary.status, "running");
  assert.equal(summary.phase, "Inspect");
  assert.equal(summary.live, true);
  assert.equal(summary.journal.entries, 1);
  assert.equal(summary.journal.firstIndex, 0);
  assert.equal(summary.journal.lastIndex, 0);
  assert.equal(summary.journal.compacted, false);
  assert.equal(summary.checkpoints.total, 1);
  assert.equal(summary.checkpoints.first, "checkpoint-1");
  assert.ok(summary.lease && summary.lease.reclaimable);
  assert.equal(summary.config.agentRetries, 2);
  assert.equal(summary.logs, 1, "live snapshot logs win over persisted");
  assert.equal(summary.resultPresent, false);
  // Counts come from the LIVE snapshot's agents when one is present.
  assert.deepEqual(summary.counts, { total: 1, done: 0, running: 1, error: 0, skipped: 0 });
  // tokenTotal = max(live fresh+cacheRead, persisted, agent aggregate)
  assert.ok(summary.tokenTotal >= 90, `tokenTotal=${summary.tokenTotal} should reflect the live breakdown`);
});

test("summarizeRunDeep reflects a completed persisted result and null live", () => {
  const summary = summarizeRunDeep(
    run({ status: "completed", result: { ok: true }, journal: [], durationMs: 99 }),
    null,
    null,
  );
  assert.equal(summary.live, false);
  assert.equal(summary.status, "completed");
  assert.equal(summary.lease, null);
  assert.equal(summary.resultPresent, true);
  assert.equal(summary.journal.compacted, false);
  assert.equal(summary.durationMs, 99);
});

// ─────────────────────────────────────────────────────────────────────────────
// summarizeAgents
// ─────────────────────────────────────────────────────────────────────────────

test("summarizeAgents merges live snapshot data over persisted, keyed by callId", () => {
  const agents = summarizeAgents(run(), snapshot());
  const active = agents.find((agent) => agent.id === 1);
  assert.equal(active?.tokens, 99, "live tokens override persisted");
  assert.equal(active?.model, "provider/live", "live model override persisted");
  assert.equal(agents.length, 5);
  assert.equal(agents.find((agent) => agent.id === 4)?.status, "done");
  // The run-level agentRetries surfaces as each agent's retries field.
  for (const agent of agents) assert.equal(agent.retries, 2);
});

test("summarizeAgents filters by numeric id or callId and reports no matches as empty", () => {
  assert.equal(summarizeAgents(run(), null, "2").length, 1);
  assert.equal(summarizeAgents(run(), null, "dc-unit-1:0").length, 1);
  assert.equal(summarizeAgents(run(), null, "missing-agent").length, 0);
});

test("summarizeAgents surfaces the failing-operation one-liner from live or persisted data", () => {
  const withLiveFailure = snapshot();
  withLiveFailure.agents[0]!.failingOperation = { op: "bash", line: 7, outcome: "exit 1" };
  const liveSummary = summarizeAgents(run(), withLiveFailure).find((agent) => agent.id === 1);
  assert.equal(liveSummary?.failingOperation, "bash (line 7): exit 1");
  const persistedFailure = run();
  persistedFailure.agents[1] = {
    ...persistedFailure.agents[1]!,
    failingOperation: { op: "edit", line: 3, outcome: "conflict" },
  };
  const persistedSummary = summarizeAgents(persistedFailure, null).find((agent) => agent.id === 2);
  assert.equal(persistedSummary?.failingOperation, "edit (line 3): conflict");
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyRecoveryAction — the design §5.1 matrix
// ─────────────────────────────────────────────────────────────────────────────

test("classifyRecoveryAction covers the full status × lease × liveness matrix", () => {
  const base = run();

  // running + live in this process → already-running (suggest pause/stop).
  assert.equal(classifyRecoveryAction(base, null, true).kind, "already-running");
  // running + not live + reclaimable lease → orphan-recoverable.
  assert.equal(classifyRecoveryAction(base, lease(), false).kind, "orphan-recoverable");
  // running + not live + missing lease → orphan-recoverable.
  assert.equal(classifyRecoveryAction(base, null, false).kind, "orphan-recoverable");
  // running + not live + alive/valid lease → owned-elsewhere.
  assert.equal(classifyRecoveryAction(base, lease({ alive: true, reclaimable: false }), false).kind, "owned-elsewhere");

  // failed / paused / pending → already-recoverable (journal preserved).
  for (const status of ["failed", "paused", "pending"] as RunStatus[]) {
    assert.equal(classifyRecoveryAction(run({ status }), null, false).kind, "already-recoverable");
  }
  // completed / aborted → not-recoverable.
  for (const status of ["completed", "aborted"] as RunStatus[]) {
    assert.equal(classifyRecoveryAction(run({ status }), null, false).kind, "not-recoverable");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// reconcileAgentAfterKill
// ─────────────────────────────────────────────────────────────────────────────

test("reconcileAgentAfterKill flips a live agent to error/AGENT_KILLED in place (CAS contract)", () => {
  const state = run();
  const outcome = reconcileAgentAfterKill(state, "1");
  assert.deepEqual(outcome, { found: true, alreadyTerminal: false, changed: true });
  const agent = state.agents[0]!;
  assert.equal(agent.status, "error");
  assert.equal(agent.error, "killed via workflow_damage_control");
  assert.equal(agent.errorCode, "AGENT_KILLED");
  assert.equal(agent.recoverable, false);
  assert.ok(agent.endedAt, "the kill stamps endedAt");
});

test("reconcileAgentAfterKill resolves by callId and no-ops on terminal agents", () => {
  const state = run();
  assert.deepEqual(reconcileAgentAfterKill(state, "dc-unit-1:0"), {
    found: true,
    alreadyTerminal: false,
    changed: true,
  });
  // done / error / skipped are already terminal → no-op, no mutation.
  for (const id of ["3", "4", "5"]) {
    const snapshot = JSON.stringify(state);
    assert.deepEqual(reconcileAgentAfterKill(state, id), { found: true, alreadyTerminal: true, changed: false });
    assert.equal(JSON.stringify(state), snapshot, `terminal agent ${id} must be untouched`);
  }
  assert.deepEqual(reconcileAgentAfterKill(state, "nope"), { found: false, alreadyTerminal: false, changed: false });
});

// ─────────────────────────────────────────────────────────────────────────────
// collectCleanCandidates
// ─────────────────────────────────────────────────────────────────────────────

test("collectCleanCandidates lists stale leases, orphan runs, ghost worktrees, tmp branches (dry-run)", () => {
  // A REAL existing directory for the "healthy" worktree — existsSync decides
  // ghost vs alive, so a fake absolute path would always be a ghost.
  const existingWorktree = mkdtempSync(join(tmpdir(), "pi-dw-clean-existing-"));
  try {
    const projectDir = "/repo/.pi/worktrees";
    const candidates = collectCleanCandidates(
      [
        run({ runId: "orphan-1", status: "running" }),
        run({ runId: "lease-1", status: "paused" }),
        run({ runId: "healthy-1", status: "running" }),
      ],
      new Map([
        ["orphan-1", lease()],
        ["lease-1", lease()],
        // healthy-1 absent from the map → no lease → treated as orphan too (design: running + missing lease).
      ]),
      [
        `${projectDir}/orphan-1`, // registered but directory gone → ghost
        existingWorktree, // registered + directory exists → NOT a candidate
        "/other-repo/worktrees/x", // outside the project worktrees dir → ignored
      ],
      projectDir,
      ["pi/wf/tmp-1", "pi/wf/tmp-2"],
    );

    const kinds = candidates.map((candidate) => candidate.kind).sort();
    assert.deepEqual(kinds, [
      "ghost-worktree",
      "orphan-run",
      "orphan-run",
      "stale-lease",
      "stale-lease",
      "tmp-branch",
      "tmp-branch",
    ]);
    const orphanRuns = candidates.filter((candidate) => candidate.kind === "orphan-run");
    assert.deepEqual(orphanRuns.map((candidate) => candidate.runId).sort(), ["healthy-1", "orphan-1"]);
    const ghost = candidates.filter((candidate) => candidate.kind === "ghost-worktree");
    assert.equal(ghost.length, 1);
    assert.equal(ghost[0]!.path, `${projectDir}/orphan-1`);
  } finally {
    rmSync(existingWorktree, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// formatDamageControlText
// ─────────────────────────────────────────────────────────────────────────────

test("formatDamageControlText renders action=.. result=.. key=value pairs and skips undefined", () => {
  const text = formatDamageControlText({
    action: "pause",
    result: "paused",
    runId: "r-1",
    status: "paused",
    skip: undefined,
  });
  assert.equal(text, 'action="pause" result="paused" runId="r-1" status="paused"');
  assert.equal(formatDamageControlText({ action: "list", result: "ok", runs: 3 }), 'action="list" result="ok" runs=3');
});
