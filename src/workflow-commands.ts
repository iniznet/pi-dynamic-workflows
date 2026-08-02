/**
 * `/workflows` slash command: list, inspect, and control background workflow runs.
 * Shares the extension's single WorkflowManager so background runs are reachable.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  fmtFull,
  fmtTokenSegment,
  recomputeWorkflowSnapshot,
  renderWorkflowStatusText,
  renderWorkflowText,
  tokenFigures,
  type WorkflowSnapshot,
} from "./display.js";
import { type EffortState, effortDirective } from "./effort-command.js";
import type { PersistedRunState } from "./run-persistence.js";
import { parametersFromArgs, registerSavedWorkflow } from "./saved-commands.js";
import { parseWorkflowScript } from "./workflow.js";
import { buildForcedWorkflowPrompt, WORKFLOW_TOOL_NAME } from "./workflow-editor.js";
import type { WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";
import { openWorkflowNavigator } from "./workflow-ui.js";

const STATUS_ICON: Record<string, string> = {
  pending: "·",
  running: "◆",
  paused: "⏸",
  completed: "✓",
  failed: "✗",
  aborted: "⊘",
};

/**
 * Map a final watchRun event to the run's on-disk status so the printed final
 * snapshot is labeled truthfully (M7): a paused run is "resumable", a stopped
 * run is "stopped", an errored run is "failed" — never "completed".
 */
const FINAL_EVENT_STATUS: Record<string, string> = {
  complete: "completed",
  error: "failed",
  stopped: "aborted",
  paused: "paused",
};

const USAGE =
  "Usage: /workflows [list] | run <prompt> | status <id> | watch <id> | stop <id> | pause <id> | resume <id> | rm <id> | save <name> [runId]";

const RUN_USAGE = "Usage: /workflows run <prompt> — force a dynamic workflow from the prompt";

/** Sanitized agent list from a possibly-corrupt persisted run (M6). */
function persistedAgents(run: PersistedRunState): Array<PersistedRunState["agents"][number]> {
  return Array.isArray(run.agents) ? run.agents : [];
}

function summarizeRun(run: PersistedRunState): string {
  const icon = STATUS_ICON[run.status] ?? "?";
  const agents = persistedAgents(run);
  const done = agents.filter((a) => a.status === "done").length;
  const total = agents.length;
  const segment = fmtTokenSegment(tokenFigures(run.tokenUsage), fmtFull);
  const tokens = segment ? ` · ${segment}` : "";
  return `${icon} ${run.runId}  ${run.workflowName} [${run.status}] ${done}/${total} agents${tokens}`;
}

function oneLineProgress(snapshot: WorkflowSnapshot): string {
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  const total = agents.length;
  const done = agents.filter((a) => a.status === "done").length;
  const running = agents.filter((a) => a.status === "running").length;
  const errs = agents.filter((a) => a.status === "error").length;
  const phase = snapshot.currentPhase ? ` · ${snapshot.currentPhase}` : "";
  return `◆ ${snapshot.name}: ${done}/${total} done${running ? `, ${running} running` : ""}${
    errs ? `, ${errs} err` : ""
  }${phase}`;
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
  const lines = [`${STATUS_ICON[run.status] ?? "?"} ${run.workflowName} (${run.runId}) — ${run.status}`];
  if (run.currentPhase) lines.push(`  phase: ${run.currentPhase}`);
  for (const agent of persistedAgents(run)) {
    const icon =
      agent.status === "done" ? "✓" : agent.status === "error" ? "✗" : agent.status === "running" ? "◆" : "·";
    lines.push(`  ${icon} ${agent.label}`);
  }
  const tokenSegment = fmtTokenSegment(tokenFigures(run.tokenUsage), fmtFull);
  if (tokenSegment) lines.push(`  tokens: ${tokenSegment}`);
  if (run.durationMs) lines.push(`  duration: ${(run.durationMs / 1000).toFixed(1)}s`);
  return lines.join("\n");
}

export interface WorkflowCommandOptions {
  /** Saved-workflow storage, enabling `/workflows save`. */
  storage?: WorkflowStorage;
  /** Working directory for saved workflows registered via `save`. */
  cwd?: string;
  /** Standing effort mode; when high/ultra, `/workflows run` carries its directive too. */
  effort?: EffortState;
}

/** Register the `/workflows` command against the shared manager. Idempotent. */
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
      "Manage workflow runs — no args (opens navigator) | run <prompt> | status/stop/pause/resume <id> | rm <id> | save <name> [runId]",
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
          } catch {
            ctx.ui.notify("Could not start the workflow turn.", "error");
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
            await print("No workflow runs yet. Start one with a background workflow (background: true).");
            return;
          }
          await print(["Workflow runs:", ...runs.map(summarizeRun), "", USAGE].join("\n"));
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
            ctx.ui.notify(`Watching ${id} — live progress in the status bar; result prints when it finishes.`, "info");
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
          ctx.ui.notify(
            manager.stop(id) ? `Stopped ${id}` : `Cannot stop ${id} (not running)`,
            manager.getRun(id) ? "info" : "warning",
          );
          return;
        }
        case "pause": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          ctx.ui.notify(manager.pause(id) ? `Paused ${id}` : `Cannot pause ${id} (not running)`, "info");
          return;
        }
        case "resume": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          const ok = await manager.resume(id);
          ctx.ui.notify(ok ? `Resumed ${id}` : `Resume not available for ${id} yet`, ok ? "info" : "warning");
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
