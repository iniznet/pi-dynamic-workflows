/**
 * damage-control-e2e.test.ts — real-disk LIVE probes for the
 * workflow_damage_control toolset (design §7 Slice C; modeled on
 * tests/task8-crash-e2e.test.ts).
 *
 * Every probe drives the REAL tool closure (createWorkflowDamageControlTool)
 * against a REAL WorkflowManager over a temp git repo — no mocks on the
 * manager/tool path:
 *
 *  (a) list/status/agents on a real journaled run (deep summary fields).
 *  (b) kill-agent on a 2-agent parallel run — one agent stopped, the other
 *      intact, the run NOT run-fatal (absorbed as null by the fan-out).
 *  (c) crash fixture → recover verb: orphan (running + dead-pid lease)
 *      classified orphan-recoverable, lease reclaimed, flipped to paused,
 *      resume replays the journal prefix (agent 0 NOT re-run).
 *  (d) clean dry-run deletes nothing; dryRun:false acts (stale lease gone,
 *      orphan normalized to paused, ghost worktree + tmp branch pruned) but
 *      NEVER deletes run state files.
 *  (e) subagent exposure: readonly capabilities reject mutating verbs; the
 *      off gate (no supplier) yields no defs anywhere; the full def reaches
 *      the run resolution path.
 *
 * No LLM calls (perCallDeferredAgent), no real network, no data deletion
 * beyond the temp fixture dirs.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkflowAgent } from "../src/agent.js";
import { createRunPersistence } from "../src/run-persistence.js";
import { McpToolsManager } from "../src/subagent/mcp-tools.js";
import { SubagentToolsAssembler } from "../src/subagent/subagent-tools-assembler.js";
import { createWorkflowDamageControlTool, DAMAGE_CONTROL_ACTIONS } from "../src/workflow-damage-control.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createWorktree } from "../src/worktree.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { rmForce } from "./helpers/rm-force.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers (same pattern as task8-crash-e2e.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

const SEQUENTIAL_SCRIPT = `export const meta = { name: 'dc_probe', description: 'dc e2e' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

const PARALLEL_SCRIPT = `export const meta = { name: 'dc_kill', description: 'kill e2e' }
const results = await parallel([() => agent('first', { label: 'a' }), () => agent('second', { label: 'b' })])
return results`;

/** Agent runner with PER-CALL deferred promises (each run() hangs until its own resolve). */
function perCallDeferredAgent() {
  const resolves: Array<(value: unknown) => void> = [];
  let callIdx = 0;
  return {
    started: () => callIdx,
    resolve: (idx: number, value: unknown = "done") => resolves[idx]?.(value),
    runner: {
      async run() {
        const idx = callIdx++;
        return new Promise((resolve) => {
          resolves[idx] = resolve;
        });
      },
    } as unknown as Pick<WorkflowAgent, "run">,
  };
}

/**
 * Deferred agent whose in-flight promise REJECTS when its AbortController
 * fires — how a real subagent session behaves under an abort. kill-agent's
 * live abort only settles the attempt if the runner honors the signal, so the
 * kill probe uses this runner; the others keep perCallDeferredAgent.
 */
function abortableDeferredAgent() {
  const resolves: Array<(value: unknown) => void> = [];
  const rejects: Array<(error: unknown) => void> = [];
  let callIdx = 0;
  return {
    started: () => callIdx,
    resolve: (idx: number, value: unknown = "done") => resolves[idx]?.(value),
    runner: {
      async run(_prompt: string, opts?: { signal?: AbortSignal }) {
        const idx = callIdx++;
        return new Promise((resolve, reject) => {
          resolves[idx] = resolve;
          rejects[idx] = reject;
          opts?.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted by damage control");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      },
    } as unknown as Pick<WorkflowAgent, "run">,
  };
}

/** Wait for a run to leave the live statuses (settled failed/aborted/completed). */
async function untilSettled(
  rp: { load(runId: string): { status?: string } | null },
  runId: string,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  await until(
    () => {
      const status = rp.load(runId)?.status;
      return status === "completed" || status === "failed" || status === "aborted";
    },
    message,
    timeoutMs,
  );
}

async function until(probe: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

/** A temp git repo with one committed file (worktrees + clean need it). */
function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pi-dw-dc-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "dc@test.local");
  git("config", "user.name", "dc");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
}

/** Execute a damage-control tool and return its text result. */
async function dc(manager: WorkflowManager, params: Record<string, unknown>, capabilities?: "readonly" | "full") {
  const tool = createWorkflowDamageControlTool({ manager, cwd: manager.getProjectCwd(), capabilities });
  const out = await tool.execute("", params, undefined, undefined, {} as never);
  const text = (out.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return { text, details: out.details as Record<string, unknown> };
}

/**
 * Match tool text regardless of the renderer's quoting: success lines are
 * hand-built (`action=list result=ok`), error lines go through
 * formatDamageControlText which JSON-quotes strings (`action="list"`).
 */
function plain(text: string): string {
  return text.replace(/"/g, "");
}

/** Fabricate a crashed owner: dead-pid lease lock (the pid no live host can own). */
function writeDeadLease(runsDir: string, runId: string): string {
  const lockPath = join(runsDir, `${runId}.lock`);
  writeFileSync(
    lockPath,
    JSON.stringify(
      {
        runId,
        runPath: join(runsDir, `${runId}.json`),
        pid: 2_147_483_647,
        startedAt: new Date().toISOString(),
        token: "crashed-owner-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
  return lockPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Probe (a): list / status / agents on a real journaled run
// ─────────────────────────────────────────────────────────────────────────────

test("probe (a): list/status/agents surface a real journaled run", async () => {
  const repo = initRepo();
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-dc-home-a-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const da = perCallDeferredAgent();
      const manager = new WorkflowManager({ cwd: repo, agent: da.runner });
      manager.on("error", () => {});
      const rp = manager.getPersistence();
      const { runId } = manager.startInBackground(SEQUENTIAL_SCRIPT);

      await until(() => da.started() >= 1, `agent 0 of ${runId} never started`);
      da.resolve(0, "first-result");
      await until(
        () => (rp.load(runId)?.journal?.length ?? 0) >= 1 && rp.load(runId)?.status === "running",
        `journal for ${runId} never persisted while running`,
      );

      const listed = await dc(manager, { action: "list" });
      assert.match(plain(listed.text), /action=list result=ok runs=1/, `list text: ${listed.text}`);
      assert.match(listed.text, new RegExp(runId), "list names the live run");

      const status = await dc(manager, { action: "status", runId });
      assert.match(plain(status.text), /action=status result=ok/, `status text: ${status.text}`);
      assert.match(status.text, /status=running/, "status shows running");
      assert.match(status.text, /journal=1/, "status folds the journal count");
      const summary = status.details.run as { counts: { total: number }; journal: { entries: number }; config: object };
      assert.equal(summary.counts.total, 2, "both agents are counted");
      assert.equal(summary.journal.entries, 1, "the completed prefix is journaled");
      assert.ok(summary.config, "config block present");

      const agents = await dc(manager, { action: "agents", runId });
      assert.match(plain(agents.text), /action=agents result=ok/, `agents text: ${agents.text}`);
      assert.match(agents.text, /agents=2/, "both agents are listed");
      assert.match(agents.text, /callId=/, "callIds are surfaced");

      // agentId filter resolves the numeric id (agents[].id starts at 1).
      const one = await dc(manager, { action: "agents", runId, agentId: "1" });
      assert.match(plain(one.text), /action=agents result=ok/, `filtered agents text: ${one.text}`);
      assert.match(one.text, /agents=1/, "the filter narrows to one agent");

      // A mutating verb on the live run works through the tool: pause → resume.
      const paused = await dc(manager, { action: "pause", runId });
      assert.match(plain(paused.text), /result=paused/, `pause text: ${paused.text}`);
      assert.equal(rp.load(runId)?.status, "paused");
      const resumed = await dc(manager, { action: "resume", runId });
      assert.match(plain(resumed.text), /result=resumed/, `resume text: ${resumed.text}`);

      // Wind down so no live run outlives the temp repo: finish the tail.
      // The resumed run re-runs agent 1 LIVE as a fresh runner call (journal
      // replay only covers the completed prefix), so resolve the NEW post-resume
      // call, not the stale pre-pause one.
      await until(() => da.started() >= 3, `agent 1 of ${runId} never re-started after resume`);
      da.resolve(da.started() - 1, "second-result");
      await untilSettled(rp, runId, `run ${runId} never completed after the tail`);
    });
  } finally {
    await rmForce(repo, fakeHome);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Probe (b): kill-agent on a 2-agent parallel run — one stopped, other intact
// ─────────────────────────────────────────────────────────────────────────────

test("probe (b): kill-agent stops ONE agent; the fan-out absorbs it and the run completes", async () => {
  const repo = initRepo();
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-dc-home-b-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const da = abortableDeferredAgent();
      const manager = new WorkflowManager({ cwd: repo, agent: da.runner });
      manager.on("error", () => {});
      const rp = manager.getPersistence();
      const { runId } = manager.startInBackground(PARALLEL_SCRIPT);

      // Both agents reach the runner (controllers registered) before the kill.
      await until(() => da.started() >= 2, `agents of ${runId} never both started`);

      const killed = await dc(manager, { action: "kill-agent", runId, agentId: `${runId}:0` });
      assert.match(plain(killed.text), /result=ok/, `kill text: ${killed.text}`);
      const kill = killed.details.kill as { liveAborted: boolean; reconciled: boolean; snapshotUpdated: boolean };
      assert.equal(kill.liveAborted, true, "the in-flight controller was aborted");
      assert.equal(kill.reconciled, true, "persisted agents[] was reconciled via CAS");
      assert.equal(kill.snapshotUpdated, true, "the live snapshot agent was marked");

      // The OTHER agent is untouched: resolve it and the run completes.
      da.resolve(1, "second-result");
      await until(() => rp.load(runId)?.status === "completed", `run ${runId} never completed after the kill`);

      const finished = rp.load(runId);
      const body = finished?.result as Array<unknown> | undefined;
      assert.deepEqual(
        body,
        [null, "second-result"],
        "the killed agent's item is absorbed as null; the survivor returns its result",
      );
      const agent0 = finished?.agents.find((agent) => agent.callId === `${runId}:0`);
      assert.ok(agent0, "agent 0 still present in the persisted inventory");
      assert.equal(agent0.status, "error", "the killed agent is recorded as error, not done");
      assert.equal(agent0.errorCode, "AGENT_KILLED", "the kill code is recorded");
      assert.equal(finished?.status, "completed", "a killed agent is never run-fatal by itself");
    });
  } finally {
    await rmForce(repo, fakeHome);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Probe (c): crash fixture → recover verb (orphan → paused → journal replay)
// ─────────────────────────────────────────────────────────────────────────────

test("probe (c): recover reclaims a crashed orphan, flips it to paused, and resumes from the journal prefix", async () => {
  const repo = initRepo();
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-dc-home-c-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      // ── 1. A real journaled run, abandoned mid-flight (agent 1 hangs) ──
      const da = perCallDeferredAgent();
      const managerA = new WorkflowManager({ cwd: repo, agent: da.runner });
      managerA.on("error", () => {});
      const { runId } = managerA.startInBackground(SEQUENTIAL_SCRIPT);
      const rp = createRunPersistence(repo);
      const runsDir = managerA.getPersistence().getRunsDir();

      await until(() => da.started() >= 1, `agent 0 of ${runId} never started`);
      da.resolve(0, "first-result");
      await until(
        () => (rp.load(runId)?.journal?.length ?? 0) >= 1 && rp.load(runId)?.status === "running",
        `journal for ${runId} never persisted while running`,
      );
      // Crash artifact: dead-pid lease lock + leave status running.
      writeDeadLease(runsDir, runId);

      // ── 2. Fresh manager — its startup sweep is allowed to classify, but we
      // re-create the crash artifact after it so the RECOVER verb itself is the
      // one performing the orphan reclaim (the sweep must not pre-empt it).
      const bRunnerPrompts: string[] = [];
      const managerB = new WorkflowManager({
        cwd: repo,
        agent: {
          async run(prompt: string) {
            bRunnerPrompts.push(prompt);
            return "done";
          },
        } as unknown as Pick<WorkflowAgent, "run">,
      });
      managerB.on("error", () => {});
      const current = rp.load(runId);
      assert.ok(current, "the crashed run persisted");
      rp.save({ ...current, status: "running", updatedAt: new Date().toISOString() });
      writeDeadLease(runsDir, runId);

      // ── 3. The recover verb performs the full recovery ─────────────────
      const recovered = await dc(managerB, { action: "recover", runId });
      assert.match(plain(recovered.text), /action=recover result=ok/, `recover text: ${recovered.text}`);
      assert.match(plain(recovered.text), /classification=orphan-recoverable/, "classified as a crash orphan");
      assert.match(plain(recovered.text), /leaseAction=reclaimed/, "the stale lease was reclaimed");
      assert.match(plain(recovered.text), /statusBefore=running/, "recover starts from the orphan's running state");
      assert.match(plain(recovered.text), /statusAfter=paused/, "the orphan is normalized to paused, never failed");
      assert.equal((recovered.details.recovery as { leaseAction?: string }).leaseAction, "reclaimed");

      await until(() => rp.load(runId)?.status === "completed", `recovered run ${runId} never completed`);

      const finished = rp.load(runId);
      const body = finished?.result as { a?: unknown; b?: unknown } | undefined;
      assert.equal(body?.a, "first-result", "agent 0's ORIGINAL journaled result returned (replayed, not re-run)");
      assert.equal(body?.b, "done", "agent 1 ran live after the replay");
      assert.deepEqual(
        bRunnerPrompts,
        ["second"],
        "the recover resumed from the journal prefix: agent 0 never re-ran, only the live tail executed",
      );
      assert.ok(!existsSync(join(runsDir, `${runId}.lock`)), "no lease lock is left behind after recover");
    });
  } finally {
    await rmForce(repo, fakeHome);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Probe (d): clean dry-run deletes nothing; dryRun:false acts, never deletes run state
// ─────────────────────────────────────────────────────────────────────────────

test("probe (d): clean dry-runs by default; force acts but never deletes run state", async () => {
  const repo = initRepo();
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-dc-home-d-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({
        cwd: repo,
        agent: {
          async run() {
            return "done";
          },
        } as unknown as Pick<WorkflowAgent, "run">,
      });
      manager.on("error", () => {});
      const rp = manager.getPersistence();
      const runsDir = rp.getRunsDir();
      const orphanId = "dc-orphan-clean";

      // Fabricate the damage: an orphaned run (running + dead-pid lease), a
      // leftover isolated worktree + tmp branch, and a run file that must
      // survive everything.
      rp.save({
        runId: orphanId,
        workflowName: "orphan",
        script: "export const meta = { name: 'orphan', description: 'x' }; return await agent('x')",
        status: "running",
        phases: [],
        agents: [],
        logs: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tokenUsage: { input: 0, output: 0, total: 0 },
      });
      const lockPath = writeDeadLease(runsDir, orphanId);
      const leftover = await createWorktree(repo, orphanId);
      assert.ok(leftover.cwd && leftover.branch, "the leftover worktree + branch exist");
      const runFilePath = join(runsDir, `${orphanId}.json`);
      assert.ok(existsSync(runFilePath), "the orphan run file exists before cleaning");

      // ── Dry run (default): reports candidates, touches nothing ────────
      const dry = await dc(manager, { action: "clean" });
      assert.match(plain(dry.text), /action=clean result=ok/, `dry text: ${dry.text}`);
      assert.match(plain(dry.text), /dryRun=true/, "clean defaults to dry-run");
      const dryReport = dry.details.report as { candidates: Array<{ kind: string }> };
      const kinds = dryReport.candidates.map((candidate) => candidate.kind).sort();
      assert.ok(kinds.includes("stale-lease"), `stale lease candidate: ${kinds.join(",")}`);
      assert.ok(kinds.includes("orphan-run"), `orphan candidate: ${kinds.join(",")}`);
      assert.ok(
        kinds.includes("ghost-worktree") || kinds.includes("tmp-branch"),
        `worktree/branch candidate: ${kinds.join(",")}`,
      );
      assert.ok(existsSync(lockPath), "dry run leaves the stale lease lock alone");
      assert.equal(rp.load(orphanId)?.status, "running", "dry run leaves the orphan running");
      assert.ok(leftover.cwd && existsSync(leftover.cwd), "dry run leaves the ghost worktree directory alone");
      assert.ok(existsSync(runFilePath), "dry run leaves the run file alone");

      // ── Force (dryRun:false): acts, but run state is never deleted ─────
      const force = await dc(manager, { action: "clean", dryRun: false });
      assert.match(plain(force.text), /action=clean result=ok/, `force text: ${force.text}`);
      assert.match(plain(force.text), /dryRun=false/, "force clean reports dryRun=false");
      assert.ok(!existsSync(lockPath), "the stale lease lock is reclaimed and released");
      assert.equal(rp.load(orphanId)?.status, "paused", "the orphan is normalized to paused, never deleted");
      assert.ok(leftover.cwd && !existsSync(leftover.cwd), "the ghost worktree directory is pruned");
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      assert.equal(git("branch", "--list", "pi/wf/*").trim(), "", "the tmp pi/wf branch is deleted");
      assert.ok(existsSync(runFilePath), "the run state file SURVIVES force clean (never deleted)");
    });
  } finally {
    await rmForce(repo, fakeHome);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Probe (e): subagent exposure — off gate, readonly rejection, full reach
// ─────────────────────────────────────────────────────────────────────────────

test("probe (e): off gate yields no defs; readonly rejects mutating verbs; full reaches the run", async () => {
  const repo = initRepo();
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-dc-home-e-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      // ── off (default): no supplier → no defs anywhere ──────────────────
      const offAssembler = new SubagentToolsAssembler({
        mode: "all",
        hostTools: () => [],
        mcpTools: new McpToolsManager({ config: [] }),
        // damageControlTools deliberately absent — the "off" gate.
      });
      const offBundle = await offAssembler.assemble();
      assert.equal(
        offBundle.some((def) => def.name === "workflow_damage_control"),
        false,
        "off ⇒ no workflow_damage_control in the merged bundle",
      );
      assert.deepEqual(await offAssembler.damageControlToolsOnly(), [], "off ⇒ the named toolset is empty");

      // ── readonly: the def exists but mutating verbs are rejected ───────
      const da = abortableDeferredAgent();
      const manager = new WorkflowManager({ cwd: repo, agent: da.runner });
      manager.on("error", () => {});
      const rp = manager.getPersistence();
      const { runId } = manager.startInBackground(SEQUENTIAL_SCRIPT);
      await until(() => da.started() >= 1, `agent 0 of ${runId} never started`);

      const readonlyTool = createWorkflowDamageControlTool({ manager, capabilities: "readonly" });
      const rejected = await readonlyTool.execute(
        "",
        { action: "kill-agent", runId, agentId: `${runId}:0` },
        undefined,
        undefined,
        {} as never,
      );
      const rejectedText = (rejected.content as Array<{ text: string }>)[0]?.text ?? "";
      assert.match(plain(rejectedText), /result=error/, `readonly kill text: ${rejectedText}`);
      assert.match(plain(rejectedText), /not permitted in readonly mode/, "readonly rejects the kill verb");
      const allowed = (rejected.details as { allowedActions?: string[] }).allowedActions ?? [];
      assert.deepEqual(
        [...allowed].sort(),
        ["agents", "list", "status"],
        "readonly allowed list is the inspection verbs",
      );

      const okReadonly = await readonlyTool.execute("", { action: "status", runId }, undefined, undefined, {} as never);
      assert.match(
        plain((okReadonly.content as Array<{ text: string }>)[0]?.text ?? ""),
        /action=status result=ok/,
        "readonly inspection still works",
      );

      // ── full: every verb is present and reaches the run resolution path ─
      const fullTool = createWorkflowDamageControlTool({ manager });
      const fullSchema = fullTool.parameters as {
        properties?: { action?: { anyOf?: Array<{ const?: string }> } };
      };
      // The schema is ONE Type.Object (design §2.3) — the verb union nests
      // under properties.action.anyOf, never at the top level.
      const actionUnion = fullSchema.properties?.action?.anyOf;
      const verbNames = new Set((actionUnion ?? []).map((entry) => entry.const).filter(Boolean));
      assert.ok(actionUnion, "full schema exposes the action verb union");
      assert.equal(verbNames.size, DAMAGE_CONTROL_ACTIONS.length, "verb union size matches the 9-verb vocabulary");
      for (const verb of DAMAGE_CONTROL_ACTIONS) {
        assert.ok(verbNames.has(verb), `full schema includes verb ${verb}`);
      }
      const reached = await fullTool.execute(
        "",
        { action: "kill-agent", runId, agentId: `${runId}:0` },
        undefined,
        undefined,
        {} as never,
      );
      assert.match(
        plain((reached.content as Array<{ text: string }>)[0]?.text ?? ""),
        /result=ok/,
        "full capabilities reach the kill path (not the capability error)",
      );

      // Wind down: the killed agent's promise rejected on the abort (abortable
      // runner) — the sequential run settles failed (resumable), then the temp
      // repo is safe to remove.
      await untilSettled(rp, runId, `run ${runId} never settled after the kill`);
    });
  } finally {
    await rmForce(repo, fakeHome);
  }
});
