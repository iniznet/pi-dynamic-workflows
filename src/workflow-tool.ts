import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { BUILTIN_WORKFLOW_NAMES, resolveWorkflowInvocation } from "./builtin-workflows.js";
import { MAX_AGENT_RETRIES, MAX_AGENTS_PER_RUN, MAX_CONCURRENCY } from "./config.js";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  fmtCost,
  fmtFull,
  fmtTokenSegment,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  tokenFigures,
  type WorkflowSnapshot,
} from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { lazyPeerImport, MissingPeerError, PEER_DEPENDENCIES } from "./peer-deps.js";
import type { PersistedRunState } from "./run-persistence.js";
import { coerceArgs } from "./saved-commands.js";
import {
  type CheckpointGate,
  type PhasePipelineOptions,
  type PhaseStateIntegration,
  parseWorkflowScript,
  type WorkflowMeta,
  type WorkflowRunResult,
} from "./workflow.js";
import { WorkflowManager } from "./workflow-manager.js";
import { createWorkflowStorage, type WorkflowStorage } from "./workflow-saved.js";
import { loadWorkflowSettings } from "./workflow-settings.js";

/** The single always-on gate that authorizes workflow use without forcing it. */
export const WORKFLOW_GATE_GUIDELINE =
  "The `workflow` tool runs multi-agent orchestration — it fans decomposable work out across subagents, and fits tasks shaped like: repo-wide inspection, independent parallel research/checks, multi-perspective review, or fan-out/fan-in synthesis. ONLY call it when the user explicitly opts in — via the workflow trigger word, `/workflows run`, or their own words (e.g. 'run a workflow', 'fan this out', '并行审一遍'). For any other task — even one that would clearly benefit — do not call it; you may briefly offer it (with a rough cost) as an option instead.";

// ─── Lazy peer loading (H4) ─────────────────────────────────────────────────────
// typebox and pi-tui load via top-level await at module evaluation instead of a
// module-scope import, so this module stays importable when a peer is missing or
// incompatible. The diagnostic — a MissingPeerError naming the peer and its
// required range — is raised at the point of use: createWorkflowTool() for
// typebox (the schema cannot exist without it) and the render functions for
// pi-tui (only ever invoked by a TUI host). Both peers are hard dependencies of
// pi-coding-agent in any working pi, so the holders are populated in practice;
// the guards are defense in depth for headless/broken hosts.
let typeboxNamespace: typeof import("typebox") | undefined;
try {
  typeboxNamespace = await lazyPeerImport<typeof import("typebox")>("typebox");
} catch {
  // Deferred to createWorkflowTool().
}
let tuiNamespace: typeof import("@earendil-works/pi-tui") | undefined;
try {
  tuiNamespace = await lazyPeerImport<typeof import("@earendil-works/pi-tui")>("@earendil-works/pi-tui");
} catch {
  // Deferred to the render functions.
}

function requireTuiText(): typeof import("@earendil-works/pi-tui")["Text"] {
  if (!tuiNamespace) throw new MissingPeerError("@earendil-works/pi-tui", PEER_DEPENDENCIES["@earendil-works/pi-tui"]);
  return tuiNamespace.Text;
}

// Optional-chained so the schema is simply `undefined` (with a deferred
// MissingPeerError at createWorkflowTool) when typebox is missing — never a
// module-evaluation crash that takes the whole extension down with it.
const Type = typeboxNamespace?.Type;
const workflowToolSchema = Type?.Object({
  script: Type.Optional(
    Type.String({
      description: [
        "Raw JavaScript workflow script, with no Markdown fences. Required unless `name` is given.",
        "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Add phases: [{ title: 'Phase' }] only when the workflow has named phases, and declare only phases it will use. With multiple phases, call phase('Exact Title') before each phase's work or set `phase` in the agent options.",
        "Use `await workflow(savedName, childArgs)` to run a saved workflow inline; nesting is limited to one level and shares the parent run's concurrency, agent, and token limits.",
        "Optional quality helpers include verify(), judgePanel(), loopUntilDry(), and completenessCheck().",
        "Optional control helpers include retry() and gate(); budget exposes total, spent(), and remaining(), and phase('Name', { budget: N }) sets a phase token limit.",
        "The optional `agentType` option selects a named user or project definition that can bind tools, a model, and role instructions; use it only when its name and purpose are provided in context. Its bound model overrides `tier`; an explicit `model` overrides both.",
        "Use plain JavaScript only; imports, require(), filesystem modules, Date.now(), Math.random(), and new Date() are unavailable.",
        "Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, cwd, process.cwd(), and budget. The workflow must call agent() at least once.",
        "parallel() requires functions, not promises, and returns results in input order: await parallel(items.map(item => () => agent(...))).",
        "pipeline(items, ...stages) runs stages sequentially for each item while items proceed concurrently; each stage receives (previousValue, originalItem, index).",
        "On failure or pause, resume with resumeFromRunId instead of starting a new run.",
      ].join(" "),
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Run a saved or built-in workflow by name; args go in `args`. " +
        `Built-ins: ${BUILTIN_WORKFLOW_NAMES.join(", ")} — see workflow-patterns skill for their args. ` +
        "A same-named saved workflow wins. Not with resumeFromRunId.",
    }),
  ),
  args: Type.Optional(
    // Must be an explicitly typed object schema, not Type.Any(). Type.Any()
    // compiles to a schema with no "type" keyword at all (just
    // `{ description }`), and at least one MCP/tool-calling bridge observed
    // in the wild does not treat a typeless property as "accept any JSON
    // value" — it coerces/flattens it before the handler ever sees it, so
    // `args.scope` (etc.) arrives as `undefined` and every built-in pattern
    // that requires an args field fails validation regardless of what the
    // caller actually sent. Every built-in pattern's `args` is a JSON object
    // at the top level, so declaring `type: "object"` is lossless and fixes
    // the coercion. Type.Unsafe keeps the emitted schema minimal (no
    // `properties`/`additionalProperties` boilerplate — JSON Schema already
    // allows additional properties by default) to stay inside the
    // provider-visible tool definition's byte budget.
    Type.Unsafe<Record<string, unknown>>({
      type: "object",
      description: "Optional JSON value exposed to the workflow script as global `args`.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Run the workflow in the background. Default: true — the tool returns immediately with a run ID, the turn ends so the user isn't blocked, and the result is delivered back into the conversation when it finishes. Set to false only when you need the result inline in this same turn (the call will block until the workflow completes).",
    }),
  ),
  maxAgents: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: MAX_AGENTS_PER_RUN,
      description:
        "Maximum number of agents allowed in this run. Default: 1000; this is a safety ceiling, not a target. Set a lower limit for dynamic or exploratory fan-out, and reserve large fan-outs for explicit user intent.",
    }),
  ),
  concurrency: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: MAX_CONCURRENCY,
      description:
        "Maximum concurrent agents for this run. Clamped to the runtime maximum. Use when provider/transport stability matters.",
    }),
  ),
  agentRetries: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: MAX_AGENT_RETRIES,
      description:
        "Retry attempts for recoverable agent failures such as timeout, connection failure, or empty assistant output. Default 0 unless configured.",
    }),
  ),
  failOnExhaustedAgent: Type.Optional(
    Type.Boolean({
      description:
        "Strict completion (default true): exhausted agents settle the run FAILED (resumable) instead of completing with silent nulls. Pass false for best-effort runs that report failed agents.",
    }),
  ),
  agentTimeoutMs: Type.Optional(
    Type.Number({
      minimum: 1,
      description:
        "Timeout per agent in milliseconds. Omit to use configured `defaultAgentTimeoutMs`; without one, there is no hard timeout. Set only when the user asks to bound time.",
    }),
  ),
  tokenBudget: Type.Optional(
    Type.Number({
      minimum: 1,
      description:
        "Optional user-requested soft spend gate, not a planning target. Do not set `tokenBudget` unless the user explicitly supplies a cap or asks you to choose one; never infer or invent one from task size. If omitted, the configured `defaultTokenBudget` applies; without one, the run is unlimited. Reaching the gate blocks later `agent()` calls; concurrent in-flight work can overshoot.",
    }),
  ),
  resumeFromRunId: Type.Optional(
    Type.String({
      description: [
        "Resume a prior run (this ID) with an edited `script` instead of starting a new run.",
        "Unchanged agent() calls replay from that run's cache; the first changed/new call onward re-runs.",
        "Calls match by position: keep earlier good calls identical and in order. Always background.",
        "Use for any failed or paused run — never start a new run to recover.",
      ].join(" "),
    }),
  ),
  dryRun: Type.Optional(
    Type.Boolean({
      description:
        "Validate the script (or named workflow) without starting a run: parses and checks the script, then returns immediately with the workflow's meta (name/phases) and launches no subagents. Useful for iterating on a script before committing to a run.",
    }),
  ),
});

export type WorkflowToolInput = {
  script?: string;
  name?: string;
  args?: Record<string, unknown>;
  background?: boolean;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number;
  /**
   * Strict completion (default true): exhausted agents settle the run failed +
   * resumable instead of completing with silent nulls.
   */
  failOnExhaustedAgent?: boolean;
  tokenBudget?: number;
  resumeFromRunId?: string;
  dryRun?: boolean;
};

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  /** Shared manager so background runs are reachable from the `/workflows` command. */
  manager?: WorkflowManager;
  /** Shared saved-workflow storage. */
  storage?: WorkflowStorage;
  /** Default per-agent timeout for runs created by this tool. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
  /** Default max concurrent agents when no tool-level concurrency is passed. */
  defaultConcurrency?: number;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
  /**
   * Optional visual approve/deny gate for checkpoint(); threaded into every
   * run this tool starts. Absent → checkpoint() keeps its default headless
   * behavior (declared default or inline confirm).
   */
  checkpointGate?: CheckpointGate;
  /**
   * Opt-in Phase 0/1 pipeline wiring (wayfinder -> prewalk) threaded into every
   * run this tool starts. Absent → the run behaves exactly as before (no
   * wayfinder/prewalk stages fire). See PhasePipelineOptions in workflow.ts.
   */
  pipeline?: PhasePipelineOptions;
  /**
   * Opt-in PhaseGuard phase-state integration (persisted state machine) threaded
   * into every run this tool starts. Absent → agent() calls are ungated. See
   * PhaseStateIntegration in workflow.ts.
   */
  phaseState?: PhaseStateIntegration;
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<TSchema, unknown> {
  // typebox is required to even describe the tool; fail with a named diagnostic
  // (peer + required range) rather than a schema-less tool.
  if (!workflowToolSchema) throw new MissingPeerError("typebox", PEER_DEPENDENCIES.typebox);
  const storage = options.storage ?? createWorkflowStorage(options.cwd ?? process.cwd());
  const cwd = options.cwd ?? process.cwd();
  const defaults = resolveWorkflowToolDefaults(options, cwd);
  const manager =
    options.manager ??
    new WorkflowManager({
      cwd: options.cwd,
      concurrency: defaults.concurrency,
      loadSavedWorkflow: (name: string) => storage.load(name)?.script,
      defaultAgentTimeoutMs: defaults.agentTimeoutMs,
      defaultAgentRetries: defaults.agentRetries,
    });

  return defineTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Run a JavaScript workflow that delegates work to subagents with agent(), optionally composing calls with parallel() and pipeline().",
    promptSnippet:
      "Delegate substantive independent or staged work to subagents with a JavaScript workflow, optionally composing agent calls with parallel(), pipeline(), or both",
    get promptGuidelines() {
      return [WORKFLOW_GATE_GUIDELINE];
    },
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // `name` resolves through the same registry the built-in slash commands
      // and saved-workflow commands use (see builtin-workflows.ts /
      // workflow-saved.ts): a project/user saved workflow of that name wins on
      // a collision, else one of the 5 curated built-in patterns. This lets the
      // model reach a curated pattern by name instead of having to author an
      // equivalent script from scratch (and, for patterns that need it, the
      // right exec context — e.g. deep-research's web tools — travels with it).
      let invocationTools: ToolDefinition[] | undefined;
      let invocationToolset: string | undefined;
      let script: string;
      let runArgs: Record<string, unknown> | undefined = params.args;
      if (params.name) {
        if (params.resumeFromRunId) {
          throw new Error(
            "workflow: `name` cannot be combined with `resumeFromRunId` — resume with an edited `script` instead.",
          );
        }
        if (params.script) {
          throw new Error(
            "workflow: `name` cannot be combined with `script` — provide either a saved/built-in `name` or a raw `script`, not both.",
          );
        }
        const resolved = resolveWorkflowInvocation(params.name, params.args, { storage, cwd });
        if (!resolved) {
          throw new Error(
            `workflow: no saved or built-in workflow named "${params.name}". Built-in names: ${BUILTIN_WORKFLOW_NAMES.join(", ")}.`,
          );
        }
        // A saved workflow declares an argument schema (SavedWorkflow.parameters);
        // coerce + validate the caller's args against it before launching, so a
        // mistyped or missing arg fails here with a descriptive error instead of
        // reaching the script as an undefined/raw value.
        const saved = storage.load(params.name);
        if (saved?.parameters) runArgs = coerceArgs(params.args, saved.parameters);
        script = normalizeWorkflowScript(resolved.script);
        invocationTools = resolved.tools;
        invocationToolset = resolved.toolset;
      } else {
        if (!params.script) throw new Error("workflow requires either `script` or `name`");
        script = normalizeWorkflowScript(params.script);
      }
      const parsed = parseWorkflowScript(script);

      // dryRun: validate the script/name and return its meta without launching
      // a run (no manager activity, no subagents, no persisted run).
      if (params.dryRun) {
        if (params.resumeFromRunId) {
          throw new Error(
            "workflow: `dryRun` cannot be combined with `resumeFromRunId` — resume launches a run by definition.",
          );
        }
        return dryRunResult(parsed.meta);
      }

      // Iteration / cached-prefix reuse: resume a prior run with THIS (edited)
      // script instead of creating a brand-new run. Unchanged agent() calls
      // replay from the prior run's journal; the first edited/new call and
      // everything after it re-run live. Always background (the resumed run is
      // detached and its result is delivered back into the conversation).
      if (params.resumeFromRunId) {
        const runId = params.resumeFromRunId;
        const resumed = await manager.resume(runId, {
          script,
          args: runArgs,
          checkpointGate: options.checkpointGate,
          pipeline: options.pipeline,
          phaseState: options.phaseState,
        });
        if (!resumed) {
          throw new Error(resumeFailureText(manager, runId));
        }
        return {
          content: [{ type: "text", text: resumedText(parsed.meta.name, runId) }],
          details: { runId, background: true, resumedFrom: runId },
        };
      }

      // checkpoint() reaches the human only on a UI-bearing foreground run; a
      // background run is detached, so checkpoint() falls back to its headless
      // default. Map a checkpoint to ctx.ui.confirm (a yes/no gate) when available.
      const uiCtx = ctx as
        | { hasUI?: boolean; ui?: { confirm?(title: string, message: string): Promise<boolean> } }
        | undefined;
      const uiConfirm = uiCtx?.hasUI ? uiCtx.ui?.confirm : undefined;
      const confirm = uiConfirm
        ? (promptText: string) => uiConfirm.call(uiCtx?.ui, "Workflow checkpoint", promptText)
        : undefined;

      // Background execution is the default: return immediately so the turn ends
      // and the user isn't blocked. The result is delivered back into the
      // conversation when the run finishes (see installResultDelivery). Only an
      // explicit `background: false` blocks for the result inline.
      if (params.background ?? true) {
        const { runId } = manager.startInBackground(script, runArgs, {
          maxAgents: params.maxAgents,
          concurrency: params.concurrency,
          agentRetries: params.agentRetries,
          failOnExhaustedAgent: params.failOnExhaustedAgent ?? true,
          agentTimeoutMs: params.agentTimeoutMs,
          tokenBudget: params.tokenBudget,
          tools: invocationTools,
          toolset: invocationToolset,
          checkpointGate: options.checkpointGate,
          pipeline: options.pipeline,
          phaseState: options.phaseState,
        });
        return {
          content: [{ type: "text", text: backgroundStartedText(parsed.meta.name, runId) }],
          details: { runId, background: true },
        };
      }

      // Synchronous execution (blocking) — but routed through the manager so the
      // run shows up live in the /workflows navigator and the task panel while it
      // runs, then stays in history afterwards. We still block on the result and
      // return it inline, so the model gets the full output in the same turn.
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, {
        key: "workflow",
        streamToolUpdates: true,
        maxAgents: 4,
        showResultPreviews: false,
      });

      let result: WorkflowRunResult;
      try {
        result = await manager.runSync(script, runArgs, {
          maxAgents: params.maxAgents,
          concurrency: params.concurrency,
          agentRetries: params.agentRetries,
          failOnExhaustedAgent: params.failOnExhaustedAgent ?? true,
          agentTimeoutMs: params.agentTimeoutMs,
          tokenBudget: params.tokenBudget,
          tools: invocationTools,
          toolset: invocationToolset,
          confirm,
          checkpointGate: options.checkpointGate,
          pipeline: options.pipeline,
          phaseState: options.phaseState,
          externalSignal: signal,
          onProgress(live) {
            snapshot = recomputeWorkflowSnapshot(live);
            display.update(snapshot);
          },
        });
      } catch (error) {
        if (signal?.aborted || (error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED)) {
          for (const agent of snapshot.agents) {
            if (agent.status === "running") {
              agent.status = "skipped";
              agent.error = "aborted";
            }
          }
          snapshot = recomputeWorkflowSnapshot(snapshot);
          display.complete(snapshot);
          throw new Error("Workflow was aborted");
        }
        // A run that settled failed/paused is resumable via resumeFromRunId with
        // an edited script; completed/aborted runs are not. Offer the resume path
        // only when the run landed in a resumable state (M18) — never from a
        // completed run's own text.
        throw withResumeHint(error, resumableRunId(manager, parsed.meta.name));
      }

      if (result.agentCount === 0) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);

      return {
        content: [
          {
            type: "text",
            text: formatCompletedResultText(result),
          },
        ],
        details: {
          ...snapshot,
          meta: result.meta,
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          durationMs: result.durationMs,
          tokenUsage: result.tokenUsage,
          runId: result.runId,
        },
      };
    },
    renderCall(_args, theme) {
      const Text = requireTuiText();
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const Text = requireTuiText();
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, !isPartial), 0, 0);
      }
      // Fallback: strip markdown syntax so the TUI doesn't display raw asterisks/hashes.
      // The `content` field is for the LLM (where markdown is preserved), but the TUI
      // renderer (Text component) shows text literally — so we strip markdown here.
      const text = result.content?.[0];
      const raw = text?.type === "text" ? text.text : theme.fg("muted", "workflow");
      const clean = raw
        .replace(/\*\*/g, "")
        .replace(/```[a-z]*\n/g, "")
        .replace(/```/g, "")
        .replace(/^##+\s*/gm, "")
        .trim();
      return new Text(clean || theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

/**
 * The tool result text for a COMPLETED run. Deliberately carries no resume
 * hint: a completed run cannot be resumed (its journal is dropped on
 * completion), so advertising resumeFromRunId here would mislead the model
 * (M18). Paused/failed runs get the hint from their own paths.
 */
export function formatCompletedResultText(result: WorkflowRunResult): string {
  // Format token usage (include cost when the provider reports it)
  const tokenSegment = fmtTokenSegment(tokenFigures(result.tokenUsage), fmtFull);
  const tokenInfo = tokenSegment
    ? `\n\nToken usage: ${tokenSegment}${result.tokenUsage?.cost ? ` (${fmtCost(result.tokenUsage.cost)})` : ""}`
    : "";

  // Failures are VISIBLE even on a lenient run (failOnExhaustedAgent: false):
  // an incomplete result must never be mistaken for a clean success. On a
  // strict run this section never appears — the run settles failed instead and
  // the failure path's resume hint applies. Completed runs still carry no
  // resume hint (M18); the directive below is re-run guidance, not a promise
  // that this run is resumable.
  const failures = result.failedAgents?.length
    ? `\n\n## ⚠ Agent failures (${result.failedAgents.length}/${result.agentCount})\n` +
      result.failedAgents
        .map((f) => `- **${f.label}**${f.nested ? ` (nested in ${f.nested})` : ""}: ${f.errorCode} — ${f.error}`)
        .join("\n") +
      "\n\nThese agents did not produce results. Do NOT treat this output as complete: edit the workflow (e.g. raise agentRetries, shorten the failing agent's prompt, or use a larger-context model) and re-run, or pass failOnExhaustedAgent to have the run fail resumable instead of completing silently."
    : "";

  const formattedResult =
    result.result !== undefined ? `\n\`\`\`json\n${JSON.stringify(result.result, null, 2)}\n\`\`\`` : "";

  return `Workflow **${result.meta.name}** completed with **${result.agentCount}** agent(s).${tokenInfo}${failures}\n\n## Result${formattedResult}`;
}

/**
 * The tool result returned for a dryRun: the script (or named workflow) was
 * parsed and validated but no run was launched — no manager activity, no
 * subagents, nothing persisted.
 */
function dryRunResult(meta: WorkflowMeta): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const phases = meta.phases?.map((p) => p.title) ?? [];
  const phaseInfo = phases.length ? ` Phases: ${phases.join(", ")}.` : "";
  return {
    content: [
      {
        type: "text",
        text: `Workflow **${meta.name}** validated — the script parses and its meta is well-formed. No run was started.${phaseInfo}`,
      },
    ],
    details: { dryRun: true, name: meta.name, description: meta.description, phases },
  };
}

function resolveWorkflowToolDefaults(
  options: WorkflowToolOptions,
  cwd: string,
): { agentTimeoutMs: number | null; concurrency?: number; agentRetries: number } {
  const settings = loadWorkflowSettings({ cwd });
  return {
    agentTimeoutMs:
      options.defaultAgentTimeoutMs !== undefined
        ? options.defaultAgentTimeoutMs
        : (settings.defaultAgentTimeoutMs ?? null),
    concurrency: options.defaultConcurrency ?? options.concurrency ?? settings.defaultConcurrency,
    agentRetries: options.defaultAgentRetries ?? settings.defaultAgentRetries ?? 0,
  };
}

/**
 * The tool result returned when a workflow starts in the background. It both
 * informs the model and tells it to reassure the user: the run continues on its
 * own and the conversation will resume automatically when it finishes, so the
 * user can just wait here (or go do something else).
 */
export function backgroundStartedText(name: string, runId: string): string {
  return [
    `Workflow "${name}" started in the background.`,
    `Run ID: ${runId}`,
    "It keeps running on its own. When it finishes, the result is delivered back",
    "here and the conversation continues automatically — the user does not need to",
    "do anything. Tell the user they can simply wait here for it to finish (it will",
    "resume the conversation by itself), or keep chatting / working on other things",
    "in the meantime; either way the result will come back to this conversation.",
    `They can also track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
    // Deliberately no resume hint here: the run is still "running" at this point,
    // and resume() only accepts paused/failed runs (M18). The failed/paused
    // paths carry the hint instead.
  ].join("\n");
}

/**
 * One-line hint telling the model it can iterate on a PAUSED or FAILED run by
 * resuming it with an edited script instead of re-running the whole workflow.
 * Unchanged agent() calls replay from the journal (cache); only edited/new ones
 * re-run. Deliberately never emitted for completed or running runs: resume()
 * refuses those (a completed run's journal is dropped on completion). Omitted
 * when there is no runId to reference.
 */
export function reviseHint(runId: string | undefined): string {
  if (!runId) return "";
  return `To revise without re-running everything: re-call workflow with resumeFromRunId="${runId}" and an edited script — unchanged agent() calls replay from cache, only edited/new ones re-run.`;
}

/**
 * The tool result returned when the model resumes a run with an edited script.
 * The resumed run is always background, so its result is delivered back later.
 */
export function resumedText(name: string, runId: string): string {
  return [
    `Workflow "${name}" resumed from run ${runId} with your edited script.`,
    "Unchanged agent() calls replay from that run's journal (cache); the first",
    "edited or newly inserted agent() call — and everything after it — re-runs live.",
    "It runs in the background; the result is delivered back here when it finishes,",
    "and the conversation continues automatically. The user can wait or keep working.",
    `Track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
  ].join("\n");
}

/**
 * Explain why a resumeFromRunId could not be resumed, so the model gets a clear
 * tool error instead of a silent failure. Inspects live + persisted state to
 * name the concrete reason (not found / running / completed / stopped).
 */
export function resumeFailureText(manager: WorkflowManager, runId: string): string {
  const active = manager.getRun(runId);
  if (active?.status === "running") {
    return `Cannot resume workflow run "${runId}": it is still running. Wait for it to finish (or /workflows stop ${runId}) before resuming with an edited script.`;
  }
  const persisted = manager.getPersistence().load(runId);
  if (!persisted) {
    return `Cannot resume workflow run "${runId}": no run with that ID was found. Use the runId from a prior workflow result, or omit resumeFromRunId to start a new run.`;
  }
  if (persisted.status === "completed") {
    return `Cannot resume workflow run "${runId}": it already completed. Start a new run instead (omit resumeFromRunId).`;
  }
  if (persisted.status === "aborted" || active?.status === "aborted") {
    return `Cannot resume workflow run "${runId}": it was stopped/aborted and is not resumable. Start a new run instead (omit resumeFromRunId).`;
  }
  if (!persisted.script) {
    return `Cannot resume workflow run "${runId}": it has no persisted script to resume. Start a new run instead (omit resumeFromRunId).`;
  }
  return `Cannot resume workflow run "${runId}": it is not currently resumable (it may be busy under another process). Try again shortly, or start a new run.`;
}

/**
 * Append the resume hint to an error thrown by a run that settled into a
 * resumable state. Non-WorkflowError failures (e.g. lease acquisition) are
 * rethrown untouched when no resumable run could be identified.
 */
function withResumeHint(error: unknown, runId: string | undefined): unknown {
  if (!runId) return error;
  const hint = reviseHint(runId);
  if (error instanceof WorkflowError) {
    return new WorkflowError(`${error.message}\n\n${hint}`, error.code, {
      recoverable: error.recoverable,
      agentLabel: error.agentLabel,
      details: error.details,
      resetHint: error.resetHint,
    });
  }
  if (error instanceof Error) return new Error(`${error.message}\n\n${hint}`, { cause: error });
  return error;
}

/** Minimal manager surface the resumable-run lookup needs (testable via stub). */
interface ResumableRunLookup {
  listRuns(): Array<Pick<PersistedRunState, "runId" | "status" | "workflowName" | "startedAt">>;
}

/**
 * The most recently settled failed/paused run for `workflowName`, if any.
 * Only paused/failed runs are resumable — completed/aborted runs drop their
 * journal on settlement — so the lookup is the gate that keeps the resume hint
 * off every other run text (M18).
 */
function resumableRunId(manager: ResumableRunLookup, workflowName: string): string | undefined {
  return manager
    .listRuns()
    .filter((run) => (run.status === "failed" || run.status === "paused") && run.workflowName === workflowName)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1)?.runId;
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object")
    throw new Error("workflow requires an object argument with a `script` string or a `name`");
  const value = args as Record<string, unknown>;
  // `name` resolves a saved/built-in workflow at execute() time, so `script` is
  // optional here — but if `script` is present at all it must still be a
  // string (same requirement as the script-only path below), so a caller
  // passing a malformed `script` alongside `name` gets a clear error instead
  // of it being silently dropped.
  if (typeof value.name === "string" && value.name.trim()) {
    if (value.script !== undefined && typeof value.script !== "string") {
      throw new Error("workflow's `script` must be a string when provided alongside `name`");
    }
    return {
      ...value,
      name: value.name.trim(),
      script: typeof value.script === "string" ? normalizeWorkflowScript(value.script) : undefined,
    } as WorkflowToolInput;
  }
  if (typeof value.script !== "string") throw new Error("workflow requires either `script` or `name` to be a string");
  return { ...value, script: normalizeWorkflowScript(value.script) } as WorkflowToolInput;
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function _isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}
