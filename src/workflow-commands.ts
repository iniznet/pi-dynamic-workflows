/**
 * `/workflows` slash command: list, inspect, and control background workflow runs.
 * Shares the extension's single WorkflowManager so background runs are reachable.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createWorktreeRunner, type WorktreeRunner, type WorktreeTask } from "./agent/worktree-runner.js";
import {
  elapsedMs,
  fmtCost,
  fmtFull,
  fmtTokenSegment,
  formatElapsed,
  recomputeWorkflowSnapshot,
  renderWorkflowStatusText,
  renderWorkflowText,
  runStatusWord,
  STATUS_GLYPH,
  tokenFigures,
  type WorkflowSnapshot,
} from "./display.js";
import { type EffortState, effortDirective } from "./effort-command.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { writeJsonFileAtomic } from "./fs-persistence.js";
import type { ExecutionBlueprint } from "./phases/prewalk.js";
import { WorkflowStateManager } from "./phases/state-machine.js";
import { isPlanBig, planSizeMetrics } from "./plan-size.js";
import { type PersistedRunState, saveCheckpoint } from "./run-persistence.js";
import { parametersFromArgs, registerSavedWorkflow } from "./saved-commands.js";
import { parseWorkflowScript } from "./workflow.js";
import { buildForcedWorkflowPrompt, WORKFLOW_TOOL_NAME } from "./workflow-editor.js";
import type { WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";
import { openWorkflowNavigator } from "./workflow-ui.js";
import { createWorktree, gitExec, sweepOrphanWorktrees } from "./worktree.js";

const FINAL_EVENT_STATUS: Record<string, string> = {
  complete: "completed",
  error: "failed",
  stopped: "aborted",
  paused: "paused",
};
const RUN_STATUS_ORDER = ["pending", "running", "paused", "completed", "failed", "aborted"] as const;
const RUN_STATUS_LEGEND = `Legend: ${RUN_STATUS_ORDER.map((s) => `${STATUS_GLYPH[s]} ${s}`).join(" ")}`;

const USAGE =
  "Usage: /workflows [list | ui] | run <prompt> | status <id> | watch <id> | stop <id> | pause <id> | resume <id> | approve <id> | implement <id> | clean | rm <id> | save <name> [runId]";

const RUN_USAGE = "Usage: /workflows run <prompt> — force a dynamic workflow from the prompt";

/** Subcommand vocabulary for `/workflows` completions, mirroring the handler's dispatch. */
const WORKFLOWS_SUBCOMMANDS: ReadonlyArray<{ value: string; description: string }> = [
  { value: "run", description: "<prompt> — start a workflow from a prompt" },
  { value: "ui", description: "open the interactive run navigator" },
  { value: "list", description: "list runs (the default with no args)" },
  { value: "status", description: "<id> — show a run's status" },
  { value: "watch", description: "<id> — live progress in the status bar until it finishes" },
  { value: "stop", description: "<id> — stop a running run" },
  { value: "pause", description: "<id> — pause a running run" },
  { value: "resume", description: "<id> — resume a paused run" },
  { value: "approve", description: "<id> — approve a Phase 2 plan, opening Phase 3 for implement" },
  { value: "implement", description: "<id> — fan out an approved plan's steps into worktrees" },
  { value: "clean", description: "sweep orphan worktrees and temporary pi/wf branches" },
  { value: "rm", description: "<id> — delete a run and its resume journal (destructive)" },
  { value: "save", description: "<name> [runId] — save a run as a reusable /name workflow" },
];

/** Verbs whose next token is a run id (`/workflows <verb> <id>`). */
const WORKFLOWS_ID_VERBS: ReadonlySet<string> = new Set([
  "status",
  "watch",
  "stop",
  "pause",
  "resume",
  "approve",
  "implement",
  "rm",
]);

/** Sanitized agent list from a possibly-corrupt persisted run (M6). */
function persistedAgents(run: PersistedRunState): Array<PersistedRunState["agents"][number]> {
  return Array.isArray(run.agents) ? run.agents : [];
}

function summarizeRun(run: PersistedRunState): string {
  const icon = STATUS_GLYPH[run.status] ?? "?";
  const agents = persistedAgents(run);
  const done = agents.filter((a) => a.status === "done").length;
  const total = agents.length;
  const parts = [`${icon} ${run.runId}  ${run.workflowName} — ${runStatusWord(run.status)}`];
  if (run.currentPhase) parts.push(run.currentPhase);
  parts.push(`${done}/${total} agents`);
  const usage = run.tokenUsage;
  const costInfo = usage?.cost ? ` · ${fmtCost(usage.cost)}` : "";
  const segment = fmtTokenSegment(tokenFigures(usage), fmtFull);
  if (segment || costInfo) parts.push(`${segment}${costInfo}`);
  const elapsed = runElapsed(run);
  if (elapsed) parts.push(elapsed);
  return parts.join(" · ");
}

/**
 * Wall-clock elapsed for a persisted run: the recorded duration wins for
 * finished runs (it stops growing), otherwise live elapsed from the run's
 * CUMULATIVE first-start clock (persisted across pause/resume, mirroring the
 * task panel's runStartedAtMs) so a resumed run never resets its readout;
 * legacy runs without either fall back to the ISO stamp. Undefined when no
 * start time is known.
 */
function runElapsed(run: PersistedRunState, now = Date.now()): string | undefined {
  if (run.durationMs) return formatElapsed(run.durationMs);
  const startedMs =
    typeof run.startedAtMs === "number" && Number.isFinite(run.startedAtMs) && run.startedAtMs > 0
      ? run.startedAtMs
      : run.startedAt
        ? Date.parse(run.startedAt)
        : undefined;
  if (typeof startedMs !== "number" || !Number.isFinite(startedMs)) return undefined;
  return formatElapsed(Math.max(0, now - startedMs));
}

/**
 * Canonical one-liner confirming an action's resulting run state, sharing the
 * list row vocabulary (glyph id  name — word · phase · n/m agents · elapsed)
 * so a "Paused run-p1"-style message reads the same as the run's list row.
 * The target status is the action's outcome word (aborted after stop, paused,
 * running after resume), mapped through runStatusWord/STATUS_GLYPH; facts are
 * taken from the run's current persisted state when the manager can resolve
 * it, degrading to a bare `glyph id — word` line otherwise.
 */
function actionConfirm(id: string, status: string, run?: PersistedRunState): string {
  const word = runStatusWord(status);
  const glyph = STATUS_GLYPH[word] ?? STATUS_GLYPH[status] ?? "?";
  const head = run ? `${glyph} ${id}  ${run.workflowName ?? "workflow"} — ${word}` : `${glyph} ${id} — ${word}`;
  if (!run) return head;
  const agents = persistedAgents(run);
  const done = agents.filter((a) => a.status === "done").length;
  const parts = [head];
  if (run.currentPhase) parts.push(run.currentPhase);
  parts.push(`${done}/${agents.length} agents`);
  // tokens/cost segment mirrors summarizeRun (list rows) so confirms and rows
  // never diverge; omitted when the persisted state carries no usage.
  const usage = run.tokenUsage;
  const costInfo = usage?.cost ? ` · ${fmtCost(usage.cost)}` : "";
  const segment = fmtTokenSegment(tokenFigures(usage), fmtFull);
  if (segment || costInfo) parts.push(`${segment}${costInfo}`);
  const elapsed = runElapsed(run);
  if (elapsed) parts.push(elapsed);
  return parts.join(" · ");
}

/** The persisted record for a run id, for action confirmations. */
function persistedRun(manager: WorkflowManager, id: string): PersistedRunState | undefined {
  return manager.listRuns().find((r) => r.runId === id);
}

/** Deterministic, filesystem-safe slug for a blueprint step's worktree name. */
function stepSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "step"
  );
}

/**
 * Read the plan file for one run (`.pi/workflows/plans/<runId>.json`) — the
 * exact path the Phase 1 prewalk stage writes and the Phase 2 gate reads, so
 * `/workflows implement <runId>` fans out the SAME plan a human approved.
 * Returns null for a missing/unreadable plan (caller reports it as an error).
 */
async function loadRunPlan(dir: string, runId: string): Promise<ExecutionBlueprint | null> {
  try {
    const raw = await readFile(join(dir, ".pi", "workflows", "plans", `${runId}.json`), "utf-8");
    return JSON.parse(raw) as ExecutionBlueprint;
  } catch {
    return null;
  }
}

/** Canonical plans-dir path for a run's plan file (`.pi/workflows/plans/<runId>.json`). */
function plansFilePath(dir: string, runId: string): string {
  return join(dir, ".pi", "workflows", "plans", `${runId}.json`);
}

/**
 * Persist an approved plan verdict atomically through the shared
 * {@link writeJsonFileAtomic} (fs-persistence.ts) — the SAME retrying tmp +
 * rename writer the bridge's /approve and the plan pollers use (audit WPA-01),
 * so a concurrent review-page poll never observes a torn file and a Windows
 * EPERM rename (a reader holding the destination open) is retried. A prewalk
 * blueprint carries no status field; deciding adds one alongside the untouched
 * blueprint content, so `/workflows implement` still fans out the SAME steps.
 */
async function decidePlanApproved(dir: string, runId: string, plan: ExecutionBlueprint): Promise<void> {
  const decided: ExecutionBlueprint & { status: "approved"; reviewedAt: string } = {
    ...plan,
    status: "approved",
    reviewedAt: new Date().toISOString(),
  };
  await writeJsonFileAtomic(plansFilePath(dir, runId), decided, { mkdir: true });
}

function oneLineProgress(snapshot: WorkflowSnapshot): string {
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  const total = agents.length;
  const done = agents.filter((a) => a.status === "done").length;
  const running = agents.filter((a) => a.status === "running").length;
  const errs = agents.filter((a) => a.status === "error").length;
  const phase = snapshot.currentPhase ? ` · ${snapshot.currentPhase}` : "";
  const elapsed = elapsedMs(snapshot, Date.now());
  const elapsedSegment = elapsed === undefined ? "" : ` · ${formatElapsed(elapsed)}`;
  return `${STATUS_GLYPH.running ?? "◆"} ${snapshot.name}: ${done}/${total} done${running ? `, ${running} running` : ""}${
    errs ? `, ${errs} err` : ""
  }${phase}${elapsedSegment}`;
}

/**
 * Subscribe to a running run's events and stream live progress to the status bar,
 * printing the final snapshot when it finishes. Non-blocking: returns true if the
 * run was active and is now being watched, false otherwise. Listeners clean up on
 * completion so nothing leaks.
 *
 * Listeners are attached BEFORE the liveness check (L17): a run that finishes
 * between a pre-registration status read and the registration would otherwise be
 * missed forever — no final snapshot and a status line that never clears.
 * Attaching first means a completion that lands after registration is caught; one
 * that landed before it shows up as a non-running liveness read and the listeners
 * are detached again.
 */
function watchRun(manager: WorkflowManager, pi: ExtensionAPI, ctx: ExtensionCommandContext, id: string): boolean {
  const key = `wf:${id}`;
  const update = () => {
    const run = manager.getRun(id);
    if (run) ctx.ui.setStatus(key, oneLineProgress(run.snapshot));
  };
  const onEvent = (e: { runId?: string }) => {
    if (!e || e.runId === id) update();
  };
  let settled = false;
  const progressEvents = ["agentStart", "agentEnd", "phase", "log"] as const;
  const finalEvents = ["complete", "error", "stopped", "paused"] as const;
  // Bound per-event so finish() can tell WHICH final event fired (that is the
  // run's real outcome) and cleanup can detach each handler exactly.
  const finalHandlers = new Map<string, (e: { runId?: string }) => void>();
  const finish = (finalEvent: string, e: { runId?: string }) => {
    if (e && e.runId !== id) return;
    if (settled) return;
    settled = true;
    for (const ev of progressEvents) manager.off(ev, onEvent);
    for (const [ev, handler] of finalHandlers) manager.off(ev, handler);
    ctx.ui.setStatus(key, undefined);
    const run = manager.getRun(id);
    if (run) {
      void pi.sendMessage({
        customType: "workflows",
        content: renderWorkflowStatusText(
          recomputeWorkflowSnapshot(run.snapshot),
          FINAL_EVENT_STATUS[finalEvent] ?? "completed",
        ),
        display: true,
      });
    }
  };

  for (const ev of progressEvents) manager.on(ev, onEvent);
  for (const ev of finalEvents) {
    const handler = (e: { runId?: string }) => finish(ev, e);
    finalHandlers.set(ev, handler);
    manager.on(ev, handler);
  }

  const active = manager.getRun(id);
  if (active?.status !== "running") {
    for (const ev of progressEvents) manager.off(ev, onEvent);
    for (const [ev, handler] of finalHandlers) manager.off(ev, handler);
    return false;
  }
  update();
  return true;
}

function renderPersistedStatus(run: PersistedRunState): string {
  const lines = [
    `${STATUS_GLYPH[run.status] ?? "?"} ${run.workflowName} (${run.runId}) — ${runStatusWord(run.status)}`,
  ];
  if (run.currentPhase) lines.push(`  phase: ${run.currentPhase}`);
  for (const agent of persistedAgents(run)) {
    // Agent statuses map onto the canonical run-status glyphs via runStatusWord
    // (done→✓ completed, error→✗ failed, running→◆, pending/skipped→·).
    const icon = STATUS_GLYPH[runStatusWord(agent.status)] ?? "·";
    lines.push(`  ${icon} ${agent.label}`);
  }
  const tokenSegment = fmtTokenSegment(tokenFigures(run.tokenUsage), fmtFull);
  if (tokenSegment) lines.push(`  tokens: ${tokenSegment}`);
  if (run.durationMs) lines.push(`  duration: ${formatElapsed(run.durationMs)}`);
  return lines.join("\n");
}

export interface WorkflowCommandOptions {
  /** Saved-workflow storage, enabling `/workflows save`. */
  storage?: WorkflowStorage;
  /** Working directory for saved workflows registered via `save`. */
  cwd?: string;
  /** Standing effort mode; when high/ultra, `/workflows run` carries its directive too. */
  effort?: EffortState;
  /**
   * Persisted phase-state machine for the `/workflows implement` gate. Defaults to a
   * fresh WorkflowStateManager at `<cwd>/.pi/workflows` — the same active-state.json
   * a PhaseStateIntegration-enabled workflow run writes, so the command reuses the
   * canonical `canSpawnSubagents()` gate (Phase 3 + humanApproved) without plumbing.
   */
  phaseState?: WorkflowStateManager;
  /**
   * Test seam: replaces the real worktree runner so fan-out can be asserted
   * without touching git. Production callers omit it.
   */
  implementRunnerFactory?: () => WorktreeRunner;
}

/**
 * Enumerate every registered git worktree under `repoRoot` via `git worktree
 * list --porcelain`. Best-effort: a non-repo/odd repo yields an empty list so
 * the clean sweep has nothing to protect and nothing to reclaim.
 */
async function listRegisteredWorktrees(repoRoot: string): Promise<string[]> {
  try {
    const out = await gitExec(["-C", repoRoot, "worktree", "list", "--porcelain"]);
    const paths: string[] = [];
    for (const record of out.split(/\n\s*\n/)) {
      const line = record.split("\n").find((l) => l.startsWith("worktree "));
      if (line) paths.push(line.slice("worktree ".length).trim());
    }
    return paths;
  } catch {
    return [];
  }
}

/**
 * Delete leftover `pi/wf/*` temporary branches in `repoRoot` (best-effort per
 * branch; a branch checked out in a live worktree is left for later). Returns
 * how many were removed so the clean command can report a real count.
 */
async function deleteTemporaryWorktreeBranches(repoRoot: string): Promise<number> {
  let refs: string;
  try {
    refs = await gitExec(["-C", repoRoot, "for-each-ref", "--format=%(refname:short)", "refs/heads/pi/wf"]);
  } catch {
    return 0; // refs missing / not a git repo — nothing to delete
  }
  let deleted = 0;
  for (const line of refs.split("\n")) {
    const branch = line.trim();
    if (!branch) continue;
    try {
      await gitExec(["-C", repoRoot, "branch", "-D", branch]);
      deleted++;
    } catch {
      // checked out elsewhere or already gone — leave it for the next sweep
    }
  }
  return deleted;
}

function normalizeWorktreePath(path: string): string {
  return path.replace(/[\\/]+$/, "").replace(/\\/g, "/");
}

/**
 * Register the `/workflows` command against the shared manager. Idempotent.
 */
export function registerWorkflowCommands(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  opts: WorkflowCommandOptions = {},
): void {
  try {
    const taken = (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === "workflows");
    if (taken) return;
  } catch {
    // getCommands may be unavailable in some hosts; fall through and try to register.
  }

  pi.registerCommand("workflows", {
    description:
      "Manage workflow runs — no args (opens navigator) | run <prompt> | status/stop/pause/resume/approve/implement <id> | clean | rm <id> | save <name> [runId]",
    getArgumentCompletions: (prefix: string) => {
      // The host hands over the raw text after the first space, untrimmed — so
      // a trailing space means the token being typed is empty and sits one
      // position past the committed tokens (contract report §d.2).
      const trimmed = prefix.trim();
      const tokens = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
      const endsWithSpace = /\s$/.test(prefix);
      const currentIndex = endsWithSpace ? tokens.length : Math.max(0, tokens.length - 1);
      const current = currentIndex < tokens.length ? tokens[currentIndex] : "";

      if (currentIndex === 0) {
        return WORKFLOWS_SUBCOMMANDS.filter((c) => c.value.startsWith(current)).map((c) => ({
          value: c.value,
          label: c.value,
          description: c.description,
        }));
      }

      const verb = tokens[0].toLowerCase();
      const runs = manager.listRuns();
      // pi-tui swaps the WHOLE argument span for the item value on selection,
      // so multi-token completions must carry the committed prefix text too.
      const runCompletions = (prefixText: string) =>
        runs
          .filter((r) => r.runId.startsWith(current))
          .map((r) => ({
            value: `${prefixText}${prefixText ? " " : ""}${r.runId}`,
            label: `${r.runId} — ${r.workflowName ?? "workflow"} (${r.status})`,
            description: r.currentPhase,
          }));

      if (WORKFLOWS_ID_VERBS.has(verb) && currentIndex === 1) {
        return runCompletions(verb);
      }
      if (verb === "save") {
        if (currentIndex === 1) {
          const savedNames = (opts.storage?.list?.() ?? []).map((w) => w.name);
          return [
            ...savedNames.map((name) => ({
              value: `save ${name}`,
              label: `${name} (saved)`,
              description: "saved workflow",
            })),
            ...runs.map((r) => ({
              value: `save ${r.runId}`,
              label: `${r.runId} (run)`,
              description: r.workflowName ?? "workflow",
            })),
          ].filter((c) => c.value.slice("save ".length).startsWith(current));
        }
        if (currentIndex === 2) {
          return runs
            .filter((r) => r.runId.startsWith(current))
            .map((r) => ({
              value: `save ${tokens[1]} ${r.runId}`,
              label: r.runId,
              description: r.workflowName ?? "workflow",
            }));
        }
      }
      // `run <prompt>` is free text, `clean`/`list`/`ui` take nothing more, and
      // anything past the run-id slot has no vocabulary — suppress the popup.
      return null;
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "list").toLowerCase();
      const id = parts[1];
      const print = (text: string) => pi.sendMessage({ customType: "workflows", content: text, display: true });

      switch (sub) {
        case "run": {
          const prompt = args
            .trim()
            .slice(parts[0]?.length ?? 0)
            .trim();
          if (!prompt) {
            ctx.ui.notify(RUN_USAGE, "warning");
            return;
          }

          // Best-effort: ensure the workflow tool is active (session_start usually has).
          // Add-only so this does not interfere with the keyword hook's save/restore state.
          try {
            const active = pi.getActiveTools?.() ?? [];
            if (!active.includes(WORKFLOW_TOOL_NAME)) pi.setActiveTools?.([...active, WORKFLOW_TOOL_NAME]);
          } catch {
            // ignore — the forced directive is the real forcing primitive
          }

          const effort = opts.effort;
          const extra = effort && effort.level !== "off" ? effortDirective(effort.level) : undefined;
          // `/workflows run` is an explicit, maximal-intent command — use the
          // forcing directive (no "if it's a question just answer" escape),
          // distinct from the heuristic keyword/effort arming.
          const armed = buildForcedWorkflowPrompt(prompt, extra);
          ctx.ui.notify(`Running workflow: ${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}`, "info");
          try {
            await pi.sendMessage(
              { customType: "workflow-run", content: armed, display: true },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          } catch (error) {
            ctx.ui.notify(
              `Could not start the workflow turn: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          }
          return;
        }
        case "ui":
        case "list": {
          // `/workflows ui` is an explicit request for the interactive navigator:
          // in a host without a dialog-capable TUI, say so (L24) instead of
          // silently dumping the plain-text list the user did not ask for.
          if (sub === "ui" && !ctx.hasUI) {
            await print(
              "The /workflows navigator needs an interactive TUI. This host has no UI — " +
                "use /workflows list, status <id>, stop <id>, pause <id>, or rm <id>.",
            );
            return;
          }
          // Interactive navigator when a UI is available; plain text otherwise
          // (print/RPC mode) or when the user explicitly asks for `list`.
          if (sub !== "list" && ctx.hasUI) {
            await openWorkflowNavigator(pi, manager, ctx.ui, { storage: opts.storage, cwd: opts.cwd });
            return;
          }
          if (parts.length === 0 && ctx.hasUI) {
            await openWorkflowNavigator(pi, manager, ctx.ui, { storage: opts.storage, cwd: opts.cwd });
            return;
          }
          const runs = manager.listRuns();
          if (!runs.length) {
            // F54a: plain language, no tool-schema syntax (background: true).
            await print("No workflow runs yet. Start one with /workflows run <prompt> or mention 'workflow'.");
            return;
          }
          // F53: the bare `/workflows` command (no args) and an explicit `list`
          // both print runs + the one-line status legend — the legend replaces
          // the 11-verb usage block so the surface stays scannable (subcommand
          // help still lives in the unknown/partial warnings).
          const listLines = ["Workflow runs:", ...runs.map(summarizeRun), RUN_STATUS_LEGEND];
          await print(listLines.join("\n"));
          return;
        }
        case "watch":
        case "status": {
          if (!id) {
            ctx.ui.notify(USAGE, "warning");
            return;
          }
          // A running run streams live progress to the status bar and prints the
          // final snapshot when it finishes — no need to re-run the command.
          if (watchRun(manager, pi, ctx, id)) {
            ctx.ui.notify(
              `${STATUS_GLYPH.running ?? "◆"} ${id} — watching (live progress in the status bar; result prints when it finishes)`,
              "info",
            );
            return;
          }
          const live = manager.getSnapshot(id);
          if (live) {
            await print(renderWorkflowText(recomputeWorkflowSnapshot(live), false));
            return;
          }
          const run = manager.listRuns().find((r) => r.runId === id);
          if (!run) {
            ctx.ui.notify(`No workflow run "${id}"`, "error");
            return;
          }
          await print(renderPersistedStatus(run));
          return;
        }
        case "stop": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          if (manager.stop(id)) {
            ctx.ui.notify(actionConfirm(id, "aborted", persistedRun(manager, id)), "info");
            return;
          }
          const run = persistedRun(manager, id);
          ctx.ui.notify(
            `✗ Cannot stop ${id}${run ? ` — ${runStatusWord(run.status)} (not running)` : " (not running)"}`,
            "warning",
          );
          return;
        }
        case "pause": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          if (manager.pause(id)) {
            ctx.ui.notify(actionConfirm(id, "paused", persistedRun(manager, id)), "info");
            return;
          }
          const run = persistedRun(manager, id);
          ctx.ui.notify(
            `✗ Cannot pause ${id}${run ? ` — ${runStatusWord(run.status)} (not running)` : " (not running)"}`,
            "info",
          );
          return;
        }
        case "resume": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          const ok = await manager.resume(id);
          if (ok) {
            ctx.ui.notify(actionConfirm(id, "running", persistedRun(manager, id)), "info");
            return;
          }
          const run = persistedRun(manager, id);
          ctx.ui.notify(
            `✗ Resume not available for ${id} yet${run ? ` — ${runStatusWord(run.status)}` : ""}`,
            "warning",
          );
          return;
        }
        case "approve": {
          if (!id) return ctx.ui.notify("Usage: /workflows approve <runId>", "warning");
          const run = manager.getRun(id);
          if (!run) {
            ctx.ui.notify(`No workflow run "${id}"`, "error");
            return;
          }
          const cwd = opts.cwd ?? process.cwd();
          // Same persisted machine the run's Phase 0/1 pipeline advanced to
          // Phase 2 and `/workflows implement` later gates on. Production
          // registers without opts.phaseState (extensions/workflow.ts), so
          // each verb reads the canonical active-state.json fresh from disk.
          const phaseState = opts.phaseState ?? new WorkflowStateManager(join(cwd, ".pi", "workflows"));
          const state = await phaseState.getState();
          // Validation ladder mirrors the bridge's POST /approve before any
          // mutation: the plan file must exist, must be undecided, and the
          // machine must sit at Phase 2 (the only phase where approvePlan is
          // valid — a phase mismatch is the 409 the bridge answers with).
          const plan = await loadRunPlan(cwd, id);
          if (!plan) {
            ctx.ui.notify(`No plan found for run ${id} — run a Phase 1 prewalk first.`, "error");
            return;
          }
          // A prewalk blueprint has no status field (still pending); a
          // bridge-submitted ReviewPlan carries one. Any decided status is
          // refused (409 semantics) — approval is a one-shot transition.
          const planStatus = (plan as unknown as { status?: string }).status;
          if (planStatus === "approved" || planStatus === "rejected") {
            ctx.ui.notify(`Plan for run ${id} is already ${planStatus} — nothing to approve.`, "warning");
            return;
          }
          // Size-route enforcement: a plan the size rule classifies LARGE must be
          // reviewed in the plannotator browser UI — the CLI cannot substitute a
          // human verdict for it. Refuse BEFORE any write (no decidePlanApproved,
          // no state-machine mutation) so the plan stays pending and the bridge
          // path stays authoritative; only small plans keep CLI approval.
          const size = planSizeMetrics(plan);
          if (isPlanBig(plan)) {
            ctx.ui.notify(
              `approve refused for ${id}: the plan is classified large (${size.steps} execution steps / ${size.bytes} bytes) — large plans require browser review through the workflow approval gate; nothing was written and the plan stays pending.`,
              "warning",
            );
            return;
          }
          if (state.activePhase !== 2) {
            ctx.ui.notify(
              `approve refused for ${id}: plan approval is only valid in Phase 2 (current phase: ${state.activePhase}).`,
              "warning",
            );
            return;
          }
          try {
            // Verdict first (the bridge's /approve order): the plan file flips
            // to approved before any state-machine write, so a concurrent poll
            // observes the decision exactly once.
            await decidePlanApproved(cwd, id, plan);
            // The default ungated pipeline never produces plannotatorSubmitted
            // (only a checkpoint gate does, workflow.ts recordGateVerdict) — CLI
            // approval records the submission itself, then humanApproved, so
            // both Phase 3 prerequisites hold and the enforced transition opens
            // the subagent gate for /workflows implement.
            await phaseState.setState({ plannotatorSubmitted: true });
            await phaseState.approvePlan();
            await phaseState.transitionTo(3, { enforcePrerequisites: true });
          } catch (error) {
            // The run itself may have won the race: its recordGateVerdict
            // (bridge/browser or in-run gate) already approved the plan and
            // advanced the machine to Phase 3 while this CLI verb was in
            // flight. approvePlan is Phase-2-only, so the re-record threw
            // APPROVAL_REQUIRED — but the end state is the one the user asked
            // for. Read the machine fresh: when Phase 3 + humanApproved already
            // hold, report success and KEEP the plan file's verdict (do not
            // roll back an approval that actually happened). Only a genuine
            // Phase-2 violation (humanApproved still false) falls through to
            // the refusal + rollback below.
            if (error instanceof WorkflowError && error.code === WorkflowErrorCode.APPROVAL_REQUIRED) {
              const latest = await phaseState.getState();
              if (latest.activePhase >= 3 && latest.humanApproved) {
                ctx.ui.notify(
                  `Plan for ${id} was already approved by the run itself — Phase 3 open; subagent fan-out unlocked via /workflows implement ${id}`,
                  "info",
                );
                return;
              }
            }
            let rolledBack = true;
            try {
              await writeJsonFileAtomic(plansFilePath(cwd, id), plan, { mkdir: true });
            } catch {
              rolledBack = false;
            }
            const approvalBlocked =
              error instanceof WorkflowError && error.code === WorkflowErrorCode.APPROVAL_REQUIRED;
            const failure = approvalBlocked
              ? `approve refused for ${id}: plan approval is only valid in Phase 2.`
              : `approve failed for ${id}: ${error instanceof Error ? error.message : String(error)}`;
            ctx.ui.notify(
              rolledBack
                ? failure
                : `${failure} ⚠ rollback also failed: the plan may stay "approved" at Phase 2, wedging /workflows implement and re-approve — restore the pending plan file (or use the approval bridge) before retrying.`,
              "warning",
            );
            return;
          }
          ctx.ui.notify(
            `Approved plan for ${id} — Phase 3 open; subagent fan-out unlocked via /workflows implement ${id}`,
            "info",
          );
          return;
        }
        case "implement": {
          if (!id) return ctx.ui.notify("Usage: /workflows implement <runId>", "warning");
          const run = manager.getRun(id);
          if (!run) {
            ctx.ui.notify(`No workflow run "${id}"`, "error");
            return;
          }
          const cwd = opts.cwd ?? process.cwd();
          // Phase 3 fan-out gate (G1): reuse the persisted phase machine's
          // canSpawnSubagents() — Phase 3 active AND humanApproved. The state
          // file is the same one a PhaseStateIntegration run writes, so an
          // unapproved run is refused here exactly as the gate would refuse it
          // inside agent(). No state file → defaults (phase 0) → refused.
          const phaseState = opts.phaseState ?? new WorkflowStateManager(join(cwd, ".pi", "workflows"));
          await phaseState.getState();
          if (!phaseState.canSpawnSubagents()) {
            ctx.ui.notify(
              `implement blocked for ${id}: subagent fan-out requires Phase 3 with human approval (approve the plan in Phase 2 first).`,
              "warning",
            );
            return;
          }
          const blueprint = await loadRunPlan(cwd, id);
          if (!blueprint) {
            ctx.ui.notify(`No plan found for run ${id} — run a Phase 1 prewalk first.`, "error");
            return;
          }
          if (!blueprint.executionSteps?.length) {
            ctx.ui.notify(`Blueprint "${blueprint.title}" has no execution steps to implement`, "error");
            return;
          }
          // One isolated worktree per blueprint execution step, then fan out
          // through the shared runner. Prose-only steps carry no authored spec,
          // so their protocol honestly reports what it cannot mechanically do.
          const tasks: WorktreeTask[] = [];
          for (const [index, step] of blueprint.executionSteps.entries()) {
            const wt = await createWorktree(cwd, `${id}-${index}-${stepSlug(step.action)}`);
            // Isolation is a hard prerequisite for fan-out (C-02): createWorktree
            // returns {isolated:false, cwd: baseCwd} when it could not create a
            // worktree, and running the protocol there would commit the agent's
            // edits to the MAIN branch. Refuse the whole fan-out (never a
            // degraded shared-tree run) and surface the reason instead.
            if (!wt.isolated) {
              const detail = wt.reason ?? "worktree isolation unavailable";
              const stray = (wt as { error?: unknown }).error;
              const strayDetail =
                stray instanceof Error ? ` (${stray.message})` : stray === undefined ? "" : ` (${String(stray)})`;
              ctx.ui.notify(
                `implement refused for ${id}: could not create an isolated worktree for step ${index} — ${detail}${strayDetail}. Refusing fan-out rather than committing to the main branch.`,
                "error",
              );
              return;
            }
            tasks.push({
              id: `${id}-${index}`,
              description: `${step.description} — ${step.action}`,
              branch: wt.branch ?? `pi/wf/${id}-${index}`,
              worktreePath: wt.cwd,
              repoRoot: wt.repoRoot ?? cwd,
              status: "pending",
            });
          }
          const checkpointWarnings: string[] = [];
          const runner = opts.implementRunnerFactory
            ? opts.implementRunnerFactory()
            : createWorktreeRunner({
                // G5: persist an atomic per-subagent checkpoint (tmp+rename via
                // the run-persistence layer) the instant each task's protocol
                // settles, so /workflows resume skips exactly the tasks already
                // recorded on disk. A failed write must never flip an
                // already-landed protocol result — it is surfaced in the summary.
                onTaskComplete: async (task, result) => {
                  try {
                    await saveCheckpoint(
                      id,
                      {
                        runId: id,
                        taskId: task.id,
                        status: result.success ? "completed" : "failed",
                        worktreePath: task.worktreePath,
                        branch: task.branch,
                        output: result.output.slice(0, 512),
                        timestamp: new Date().toISOString(),
                      },
                      cwd,
                    );
                  } catch (error) {
                    checkpointWarnings.push(`${task.id}: ${error instanceof Error ? error.message : String(error)}`);
                  }
                },
              });
          const results = await runner.executeTasks(tasks);
          await print(
            [
              `Implement ${id}: ${results.length} task(s) from "${blueprint.title}"`,
              ...results.map((r) =>
                r.success
                  ? `✓ ${r.taskId} — verified commit in ${r.duration}ms`
                  : `✗ ${r.taskId} — failed: ${r.output.slice(0, 240)}`,
              ),
              ...(checkpointWarnings.length
                ? ["", "checkpoint warnings:", ...checkpointWarnings.map((w) => `  ⚠ ${w}`)]
                : []),
            ].join("\n"),
          );
          return;
        }
        case "clean": {
          const cwd = opts.cwd ?? process.cwd();
          let repoRoot: string;
          try {
            repoRoot = (await gitExec(["-C", cwd, "rev-parse", "--show-toplevel"])).trim();
          } catch {
            ctx.ui.notify("clean: not inside a git repository — nothing to sweep", "warning");
            return;
          }
          // Safety handbrake: a running/paused run owns live worktrees — clean
          // must not reclaim them out from under it.
          const activeRuns = manager.listRuns().filter((r) => r.status === "running" || r.status === "paused");
          if (activeRuns.length > 0) {
            ctx.ui.notify(
              `clean refused: ${activeRuns.length} run(s) still active (running/paused) — stop or remove them first`,
              "warning",
            );
            return;
          }
          // Sweep ONLY the worktrees this project owns (under <root>/.pi/worktrees):
          // every other registered worktree is treated as someone else's and kept.
          const projectDir = join(repoRoot, ".pi", "worktrees");
          const kept: string[] = [];
          for (const path of await listRegisteredWorktrees(repoRoot)) {
            if (!normalizeWorktreePath(path).startsWith(normalizeWorktreePath(projectDir))) kept.push(path);
          }
          await sweepOrphanWorktrees(repoRoot, kept);
          const branches = await deleteTemporaryWorktreeBranches(repoRoot);
          ctx.ui.notify(
            `Clean ${repoRoot}: project worktrees pruned; ${branches} temporary pi/wf branch(es) removed`,
            "info",
          );
          return;
        }
        case "rm": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          // Destructive (L20): deleting removes the persisted state and the resume
          // journal, so require explicit confirmation in a dialog-capable host. A
          // headless host has no confirm surface — proceed (there is no user to ask).
          const confirmed = ctx.ui.confirm
            ? await ctx.ui.confirm(
                "Delete workflow run",
                `Delete run ${id}? This removes its state and resume journal.`,
              )
            : true;
          if (!confirmed) {
            ctx.ui.notify("Deletion cancelled", "info");
            return;
          }
          ctx.ui.notify(manager.deleteRun(id) ? `Removed ${id}` : `No run ${id}`, "info");
          return;
        }
        case "save": {
          const name = id;
          if (!name) return ctx.ui.notify("Usage: /workflows save <name> [runId]", "warning");
          if (!opts.storage) return ctx.ui.notify("Saving is not available (no storage configured)", "error");
          const storage = opts.storage;
          const runs = manager.listRuns();
          const runIdArg = parts[2];
          // Pick the named run, else the most recent run that still has its script.
          const run = runIdArg ? runs.find((r) => r.runId === runIdArg) : runs.find((r) => r.script);
          if (!run?.script) {
            ctx.ui.notify(runIdArg ? `No run ${runIdArg} with a script` : "No saved run to save", "error");
            return;
          }
          // Validate the run's script before persisting it as a reusable
          // workflow — a malformed script should surface here (a named error,
          // not at every future /name invocation), and this handler must not
          // block on execution.
          try {
            parseWorkflowScript(run.script);
          } catch (error) {
            ctx.ui.notify(
              `Cannot save ${run.runId}: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
            return;
          }
          // Overwrite protection (M13): a saved workflow under this name already
          // exists — require explicit confirmation before replacing it. The load
          // guard is optional-chained because tests/storage mocks may omit it.
          const existing = storage.load?.(name) ?? null;
          if (existing && ctx.ui.confirm) {
            const confirmed = await ctx.ui.confirm(
              "Overwrite saved workflow",
              `/${name} already exists — overwrite it?`,
            );
            if (!confirmed) {
              ctx.ui.notify(`Save cancelled — /${name} left unchanged`, "info");
              return;
            }
          }
          let saved: ReturnType<WorkflowStorage["save"]>;
          try {
            saved = storage.save({
              name,
              description: run.workflowName,
              script: run.script,
              // Derive the saved workflow's declared arg schema from the run's
              // args: each arg becomes a parameter with its value as the
              // default, so /name replays the same invocation by default.
              parameters: parametersFromArgs(run.args),
              location: "project",
            });
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            return;
          }
          // Wire the new /name command through the SHARED manager for full
          // background-execution parity (task panel, /workflows tracking, result
          // delivery) instead of the no-manager inline blocking fallback.
          registerSavedWorkflow(pi, opts.cwd ?? process.cwd(), saved, manager, () =>
            storage.list().some((w) => w.name === saved.name),
          );
          ctx.ui.notify(`Saved /${name} (from ${run.runId})`, "info");
          return;
        }
        default:
          ctx.ui.notify(`Unknown subcommand "${sub}". ${USAGE}`, "warning");
      }
    },
  });
}
