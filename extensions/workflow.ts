import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createCodingTools,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { builtinToolsetTools } from "../src/builtin-workflows.js";
import { DEFAULT_IDLE_AGENT_MS, formatElapsed, tokenFigures, type WorkflowAgentSnapshot } from "../src/display.js";
import {
  claimWorkflowRuntime,
  discardWorkflowRuntime,
  handoffWorkflowRuntime,
  pauseStrandedWorkflowRuntime,
  WORKFLOW_EXTENSION_VERSION,
  type WorkflowReloadRuntime,
} from "../src/extension-reload.js";
import type { SessionManagerLike, SessionManagerProvider } from "../src/gateway/host-tool-gateway.js";
import { buildMergedHostTools, SubagentHostToolsPolicy } from "../src/gateway/subagent-host-tools.js";
import type { ToolExecutor } from "../src/gateway/types.js";
import type { CheckpointGate, ProviderPool } from "../src/index.js";
import {
  applyEnvSettingsOverride,
  createEffortState,
  createPlannotatorBridge,
  createProviderPoolFromConfig,
  createWebTools,
  createWorkflowControlTool,
  createWorkflowStorage,
  createWorkflowTool,
  HostToolGateway,
  installResultDelivery,
  installTaskPanel,
  installWorkflowKeywordArming,
  loadWorkflowSettings,
  registerAllSavedWorkflows,
  registerBuiltinWorkflows,
  registerEffortCommand,
  registerWorkflowCommands,
  registerWorkflowGatewayCommand,
  registerWorkflowModelsCommand,
  registerWorkflowSettingsCommand,
  registerWorkflowSubagentToolsCommand,
  saveWorkflowSettingsForCwd,
  UsageLimitScheduler,
  WorkflowManager,
  WorkflowStateManager,
} from "../src/index.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS, waitForStatus } from "../src/integrations/plannotator.js";
import { classifyRunPlan, ensurePendingRunPlan } from "../src/plan-size.js";
import { isChromeAuthorized } from "../src/subagent/chrome-bridge-client.js";
import {
  createExtensionToolsSupplier,
  getExtensionToolSourceResults,
} from "../src/subagent/extension-tools-capture.js";
import { McpToolsManager } from "../src/subagent/mcp-tools.js";
import { SubagentToolsAssembler } from "../src/subagent/subagent-tools-assembler.js";
import { createVendoredChromeTools } from "../src/subagent/vendored-chrome-tools.js";
import { guardWorktreeWriteConflicts, type WorktreeWriteGuardOptions } from "../src/workflow-status.js";

/**
 * Lazy handle for the damage-control tool factory (design:
 * tasks/damage-control-recovery/DESIGN.md §3.1/§6.2). Loaded at module scope
 * via a variable-specifier dynamic import so a missing/failed module disables
 * JUST the workflow_damage_control tool with a diagnostic (H4) instead of
 * failing the whole extension at import time — the same lazy-peer boundary
 * workflow-control-tool.ts uses for typebox. The declared surface is the
 * slice-B-relevant subset of the module's public contract (the factory's
 * ToolDefinition is widened to the registerToolSafely surface type).
 */
interface WorkflowDamageControlModule {
  createWorkflowDamageControlTool(options: {
    manager: WorkflowManager;
    cwd?: string;
    capabilities?: "readonly" | "full";
  }): ToolDefinition<any, any, any>;
}

const DAMAGE_CONTROL_MODULE_SPECIFIER = "../src/workflow-damage-control.js";
let createWorkflowDamageControlTool: WorkflowDamageControlModule["createWorkflowDamageControlTool"] | undefined;
try {
  const damageControlModule = (await import(DAMAGE_CONTROL_MODULE_SPECIFIER)) as WorkflowDamageControlModule;
  createWorkflowDamageControlTool = damageControlModule.createWorkflowDamageControlTool;
} catch {
  // Deferred: registerToolSafely reports the diagnostic; the subagent supplier
  // yields no defs. This branch only runs if the module is missing or fails to
  // evaluate — a first-party module, so never in practice.
}

/** One running agent's live stats as surfaced by get_workflow_status. */
export interface WorkflowRunningAgentDetail {
  id: number;
  label: string;
  status: "running";
  elapsedMs?: number;
  lastActiveAtMs?: number;
  idleMs?: number;
  tokens?: number;
}

/**
 * Per-running-agent status lines + idle fact for get_workflow_status.
 * Extracted so the query surface is unit-testable without a live manager (the
 * extension's manager is internal). `idle` renders the raw last-activity
 * staleness ("-" when the snapshot carries no lastActiveAtMs); `idleAgents`
 * counts only agents past {@link DEFAULT_IDLE_AGENT_MS} (imported from
 * display.ts — Slice A owns the canonical constant).
 */
export function buildAgentStatusLines(
  agents: readonly WorkflowAgentSnapshot[],
  now: number,
): { lines: string[]; agents: WorkflowRunningAgentDetail[]; idleAgents: number } {
  const lines: string[] = [];
  const details: WorkflowRunningAgentDetail[] = [];
  let idleAgents = 0;
  for (const a of agents) {
    if (a.status !== "running") continue;
    const elapsedMs =
      typeof a.startedAtMs === "number" && Number.isFinite(a.startedAtMs)
        ? Math.max(0, now - a.startedAtMs)
        : undefined;
    const idleMs =
      typeof a.lastActiveAtMs === "number" && Number.isFinite(a.lastActiveAtMs)
        ? Math.max(0, now - a.lastActiveAtMs)
        : undefined;
    if (idleMs !== undefined && idleMs >= DEFAULT_IDLE_AGENT_MS) idleAgents++;
    const figures = tokenFigures(a.tokenUsage, a.tokens);
    const tokens = figures.fresh + figures.cacheRead;
    const parts = [
      `agent=${a.id}`,
      `label=${JSON.stringify(a.label)}`,
      "status=running",
      `elapsed=${elapsedMs !== undefined ? formatElapsed(elapsedMs) : "-"}`,
      `idle=${idleMs !== undefined ? formatElapsed(idleMs) : "-"}`,
    ];
    if (tokens > 0) parts.push(`tokens=${tokens}`);
    lines.push(parts.join(" "));
    details.push({
      id: a.id,
      label: a.label,
      status: "running",
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(a.lastActiveAtMs !== undefined ? { lastActiveAtMs: a.lastActiveAtMs } : {}),
      ...(idleMs !== undefined ? { idleMs } : {}),
      ...(tokens > 0 ? { tokens } : {}),
    });
  }
  return { lines, agents: details, idleAgents };
}

/** Fallback session identity for in-process coding tools run under the guard (host-tool-gateway's FALLBACK_SESSION_MANAGER analog). */
const IN_PROCESS_FALLBACK_SESSION_MANAGER: SessionManagerLike = {
  getSessionId: () => "workflow-coding-tools",
  getSessionFile: () => undefined,
};

/** Options for {@link guardCodingToolDefinitions}: the worktree guard knobs plus an optional session-manager source for the wrapped executors (SDK 0.83.0's bash reads ctx.sessionManager). */
export interface GuardCodingToolDefinitionsOptions extends WorktreeWriteGuardOptions {
  /** Per-call session manager (object or provider); falls back to a stable shim. */
  sessionManager?: SessionManagerLike | SessionManagerProvider;
}

/**
 * B3 (CF-4 extension half): decide the AUTO-MODE tool winner and make subagent
 * edits actually guarded. The merged default toolset resolves coding tools
 * FIRST (SubagentHostToolsPolicy.defaultTools) and SubagentToolsAssembler
 * dedupes first-wins by name — so the IN-PROCESS coding defs win over the
 * proxied/guarded host defs, which is why the guard on the proxied bundle
 * alone never covered auto-mode subagent edits. This wraps the in-process
 * coding defs with the SAME guardWorktreeWriteConflicts (workflow-status.ts)
 * the proxied bundle carries: an edit/write targeting a file claimed by an
 * active worktree queues behind the holder (bounded) or blocks with the
 * structured FILE_LOCKED_BY_WORKTREE error.
 *
 * The round-trip goes through the guard's executor shape (HostToolsBundle.tools)
 * and back: non-write tools pass through untouched (executor reference
 * unchanged), write tools (edit/write) get the guarded executor re-wrapped
 * into a ToolDefinition.execute. The inner executors run with a minimal
 * context mirroring hostToolsFromDefinitions (session manager resolved per
 * call, model undefined), so guarded in-process calls match the proxied path.
 */
export function guardCodingToolDefinitions(
  definitions: ToolDefinition[],
  options: GuardCodingToolDefinitionsOptions = {},
): ToolDefinition[] {
  const resolveSessionManager = (): SessionManagerLike => {
    const candidate = typeof options.sessionManager === "function" ? options.sessionManager() : options.sessionManager;
    return candidate ?? IN_PROCESS_FALLBACK_SESSION_MANAGER;
  };
  const tools = new Map<string, ToolExecutor>();
  for (const def of definitions) {
    tools.set(def.name, async (args, signal) => {
      const minimalCtx = {
        model: undefined,
        sessionManager: resolveSessionManager(),
      } as unknown as ExtensionContext;
      try {
        const result = await def.execute(randomUUID(), (args ?? {}) as never, signal, undefined, minimalCtx);
        const text = result.content
          .filter((part) => part.type === "text")
          .map((part) => (part as { type: "text"; text: string }).text)
          .join("\n");
        return { content: text, isError: false, details: result.details };
      } catch (error) {
        return {
          content: `Host tool error: ${error instanceof Error ? error.message : "Unknown error"}`,
          isError: true,
          details: undefined,
        };
      }
    });
  }
  const guarded = guardWorktreeWriteConflicts({ tools, toolDefs: [] }, options);
  return definitions.map((def) => {
    const executor = guarded.tools.get(def.name);
    const original = tools.get(def.name);
    if (!executor || executor === original) return def;
    return {
      ...def,
      async execute(_toolCallId, params, signal, _timeout, _ctx) {
        const result = await executor((params ?? {}) as Record<string, unknown>, signal);
        // isError rides along exactly like the proxied host defs
        // (createGatewayProxiedTools) so a blocked edit surfaces as a tool
        // error to the subagent runtime, not a successful edit.
        return {
          content: [{ type: "text", text: result.content }],
          details: result.details,
          isError: result.isError,
        };
      },
    };
  });
}

/**
 * Resolve the plannotator review port for the extension's bridge. Env-overridable
 * (PI_WORKFLOW_PLANNOTATOR_PORT, validated 1..65535) so tests and containers can
 * relocate the review server off the shared 3123 default — the same pattern as
 * the chrome bridge's PI_CHROME_BRIDGE_PORT (audit D-06 hardening). Invalid/missing
 * values fall back to the plannotator default (3123).
 */
function plannotatorPort(): number {
  const raw = process.env.PI_WORKFLOW_PLANNOTATOR_PORT;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  }
  return 3123;
}

export default function extension(pi: ExtensionAPI) {
  // Single manager shared by the workflow tool and /workflows command. Pi loads
  // a fresh extension factory for /reload, so explicitly claim the old live
  // manager when session_shutdown staged one; otherwise in-flight promises,
  // controls, event delivery, and live UI updates would stay on an unreachable
  // manager even though their persisted snapshots remained visible on disk.
  const cwd = process.cwd();
  const storage = createWorkflowStorage(cwd);
  // PI_WORKFLOW_* env vars override settings.json (and the project override)
  // per key — the headless/CI/containerized channel. Every settings reader in
  // this generation goes through this single merged view so the extension
  // cannot drift between the manager options, the result-delivery reader, the
  // task panel, and keyword arming.
  const loadSettings = () => applyEnvSettingsOverride(loadWorkflowSettings({ cwd }));
  const settings = loadSettings();
  const managerOptions = {
    loadSavedWorkflow: (name: string) => storage.load(name)?.script,
    // Named toolsets survive on the persisted run (the tag, not the functions),
    // so a resumed run re-resolves the tools it started with — e.g. a paused
    // /deep-research keeps web access instead of degrading to coding tools.
    // The builtin-pattern tags (T2-06) resolve the same task-fit subsets the
    // registry hands the first execution, so a resumed run keeps the exact
    // toolset (not the full default bundle).
    toolsets: {
      "web-research": () => [...createCodingTools(cwd), ...createWebTools()],
      "code-review": () => builtinToolsetTools(cwd, "code-review"),
      "spec-generation": () => builtinToolsetTools(cwd, "spec-generation"),
      "adversarial-review": () => builtinToolsetTools(cwd, "adversarial-review"),
      "codebase-audit": () => builtinToolsetTools(cwd, "codebase-audit"),
      "plan-then-execute": () => builtinToolsetTools(cwd, "plan-then-execute"),
      "multi-perspective": () => builtinToolsetTools(cwd, "multi-perspective"),
    },
    // On top of the always-on workflow/workflow_control denial in subagents
    // (#107), let users block additional recursive-orchestration tools.
    excludeSubagentTools: settings.excludeSubagentTools,
    defaultAgentTimeoutMs: settings.defaultAgentTimeoutMs ?? null,
    defaultTokenBudget: settings.defaultTokenBudget ?? null,
    // T1-01: budget-gate knob. Default true keeps the legacy full-spend budget
    // (cacheRead counts); false gates on fresh spend (input+output only).
    defaultTokenBudgetCountsCacheRead: settings.tokenBudgetCountsCacheRead ?? true,
    concurrency: settings.defaultConcurrency,
    defaultAgentRetries: settings.defaultAgentRetries,
    persistAgentSessions: settings.persistAgentSessions,
  };
  // P2-1 WIRE: lazily-started host tool gateway. Constructing it opens nothing;
  // the bridge only comes up when a run needs host tools (design C: automatic
  // default) or a user runs /workflows-gateway start. The policy below is the
  // single owner of that decision: in "auto" (default) untagged runs get
  // merged coding + proxied host tools and the gateway starts on first need;
  // "on" also starts it eagerly at load; "off" restores the legacy opt-in
  // behavior (manual start + toolset "host-tools" only).
  const hostToolGateway = new HostToolGateway();
  // The real host session manager, captured at session_start and re-resolved
  // by the bridge per tool call (provider form). Host-side bash calls (0.83.0
  // reads ctx.sessionManager.getSessionId()) get the genuine session identity
  // the moment it exists; before that, hostToolsFromDefinitions' stable shim
  // keeps them working (eager "on" mode starts the gateway at load).
  let hostSessionManager: SessionManagerProvider = () => undefined;
  const hostToolsPolicy = new SubagentHostToolsPolicy({
    gateway: hostToolGateway,
    mode: settings.subagentHostTools ?? "auto",
    // Merged bundle (extension-only, no pi source changes): the executable
    // builtin suite (read/bash/edit/write + grep/find/ls via public SDK
    // factories) metadata-synced against the host's public getAllTools(), plus
    // web tools, minus the subagent-hostile exclusions (workflow/workflow_control
    // + settings.excludeSubagentTools). A future SDK's getAllToolDefinitions()
    // would merge extension-registered tools automatically; on 0.83.0 it is
    // absent, so MCP tools are metadata-only and never advertised (logged).
    // G7: the host write-tool seam — wrap the merged bundle so a main-session
    // (or proxied) edit targeting a file claimed by an active worktree queues
    // or blocks with a structured JSON tool error; read-only ops pass through.
    buildHostTools: () =>
      guardWorktreeWriteConflicts(
        buildMergedHostTools(pi, {
          cwd,
          sessionManager: () => hostSessionManager(),
          excludeSubagentTools: settings.excludeSubagentTools,
        }),
      ),
    buildCodingTools: () => guardCodingToolDefinitions(createCodingTools(cwd), { sessionManager: hostSessionManager }),
  });
  // SUBAGENT MCP WIRE: the extension-owned MCP client reads the user's
  // ~/.pi/agent/mcp.json (the same file the pi host consumes) and exposes every
  // reachable HTTP server's tools as mcp_<server>_<tool> defs. The assembler
  // merges them into the default subagent toolset per settings.subagentTools
  // ("all" | allowlist | []); on 0.83.0 this is the ONLY channel that gets MCP
  // tools into subagent sessions — the host's own mcp_* tool stays metadata-only.
  // Construction opens nothing; servers are contacted lazily on the first
  // assemble()/mcpToolsOnly() and cached (5 min TTL), unreachable servers warn
  // once and contribute nothing (self-healing on the next run).
  const mcpToolsManager = new McpToolsManager();
  // SUBAGENT CHROME WIRE: vendored pi-chrome chrome_* defs executed against the
  // host session's shared bridge + /chrome authorize grant (design:
  // tasks/subagent-chrome-tools/DESIGN.md). The supplier is gated twice: the
  // `subagentChromeTools` setting decides whether chrome tools exist at all
  // (off → no defs anywhere, including the "chrome-tools" toolset), and the
  // shared grant decides whether a chromeToolsOnly() resolve yields the set
  // (no grant → empty set, degrading gracefully). T1-09: chrome defs are
  // PER-TASK ONLY — they attach via the explicit "chrome-tools" toolset tag
  // (scripts/agentTypes opt in), never through the default merged toolset, so
  // untagged runs never pay the ~5.5 ktok/turn chrome defs. Every wire action
  // is tagged with the HOST session key + group title so subagent automation
  // joins the main session's tab group.
  const vendoredChromeTools = () =>
    createVendoredChromeTools({
      sessionKey: () => {
        const manager = hostSessionManager();
        const id = manager?.getSessionId();
        return id ? `session:${id}` : undefined;
      },
      sessionGroupTitle: () => {
        const manager = hostSessionManager() as
          | (SessionManagerLike & { getSessionName?: () => string | undefined })
          | undefined;
        const sessionName = manager?.getSessionName?.();
        const sessionId = manager?.getSessionId?.();
        // Before session_start the host session id/name is undefined: return
        // undefined so createVendoredChromeTools skips group-title tagging for
        // tab.new/tab.group and the page.* joinSessionGroup wire (its guards
        // run on `sessionTitle !== undefined`), instead of stranding early
        // subagent tabs in a "Pi Session: unknown" group that is never regrouped.
        return (sessionName ?? sessionId) ? `Pi Session: ${sessionName ?? sessionId}` : undefined;
      },
    });
  const chromeToolsSupplier =
    settings.subagentChromeTools === "on" ? () => (isChromeAuthorized() ? vendoredChromeTools() : []) : undefined;
  // SUBAGENT EXTENSION TOOLS: host-captured third-party extension tools
  // (supi-web's web_fetch_md/web_docs_*, pi-codegraph's codegraph_*,
  // pi-vision-handoff's describe_image) captured in-process from the installed
  // packages/checkouts and executed in the host via the gateway (design:
  // tasks/subagent-extension-tools/DESIGN.md). Gated by
  // `subagentExtensionTools` exactly like chrome: off → undefined → no defs
  // anywhere, including the "extension-tools" toolset.
  const extensionToolsMode = settings.subagentExtensionTools ?? "off";
  const extensionToolsSupplier = createExtensionToolsSupplier(extensionToolsMode);
  // SUBAGENT DAMAGE-CONTROL TOOLS: the workflow_damage_control toolset
  // (design: tasks/damage-control-recovery/DESIGN.md §6). Gated by
  // `subagentDamageControlTools` exactly like chrome/extension: "off" →
  // undefined supplier → NO defs anywhere, including the
  // "damage-control-tools" named toolset (zero cost, lazy guarantee intact).
  // "readonly" gives subagents the inspection verbs only (list/status/agents/
  // clean); "on" gives the full verb set. The def closes over the LIVE manager
  // created below, so subagent calls act on the CURRENT ACTIVE run — which is
  // why this cannot ride the extension-tools capture pipeline (capture binds
  // static entry defs, not a live manager). A missing module (H4) yields no
  // defs and never throws out of assemble().
  const damageControlMode = settings.subagentDamageControlTools ?? "off";
  // Explicit return type breaks the inference cycle: the arrow closes over
  // `manager` (declared below), and `manager`'s options reference the
  // assembler that consumes this supplier — without the annotation TS infers
  // implicit-any straight through the loop (TS7022/7023/7024).
  const damageControlSupplier: (() => ToolDefinition[] | Promise<ToolDefinition[]>) | undefined =
    damageControlMode === "off"
      ? undefined
      : () => {
          if (!createWorkflowDamageControlTool) return Promise.resolve([]);
          return Promise.resolve([
            createWorkflowDamageControlTool({
              manager,
              cwd,
              capabilities: damageControlMode === "readonly" ? "readonly" : "full",
            }),
          ]);
        };
  const subagentToolsAssembler = new SubagentToolsAssembler({
    mode: settings.subagentTools ?? "all",
    // The host bundle baseline (coding + proxied host + web tools) is owned by
    // the policy above; MCP tools ride on top of it.
    hostTools: () => hostToolsPolicy.defaultTools(),
    mcpTools: mcpToolsManager,
    chromeTools: chromeToolsSupplier,
    extensionTools: extensionToolsSupplier,
    damageControlTools: damageControlSupplier,
    excludeTools: settings.excludeSubagentTools,
  });
  const gatewayManagerOptions = {
    ...managerOptions,
    // Untagged runs resolve the merged default toolset (host bundle + MCP
    // tools per settings.subagentTools) only when the host-tools policy is
    // enabled; "off" keeps the exact legacy fallback (agent coding tools) and
    // never auto-starts the gateway — MCP tools stay reachable there via the
    // explicit "mcp-tools" toolset below.
    defaultTools: hostToolsPolicy.isEnabled() ? () => subagentToolsAssembler.assemble() : undefined,
    toolsets: {
      ...managerOptions.toolsets,
      // The explicit opt-in toolset now auto-starts first (fixing the
      // silent-empty result a never-started gateway used to produce); in
      // "off" mode ensureStarted is a no-op so manual start remains required.
      "host-tools": () => hostToolsPolicy.hostToolsToolset(),
      // MCP-only toolset: works in every host-tools mode, including "off", so
      // a script can explicitly opt in to MCP-backed tools without the host
      // bundle (toolset: "mcp-tools").
      "mcp-tools": () => subagentToolsAssembler.mcpToolsOnly(),
      // Chrome-only toolset: vendored chrome defs (auth-gated by the shared
      // /chrome authorize grant; empty until one is held). Works in every
      // host-tools mode. This is the ONLY channel chrome defs attach through
      // (T1-09) — they are never merged into the default toolset. With
      // subagentChromeTools "off" the supplier is undefined, so this resolves
      // to [] (script intent recorded, no tools).
      "chrome-tools": () => subagentToolsAssembler.chromeToolsOnly(),
      // Captured-extension-tools-only toolset: works in every host-tools
      // mode, including "off". With subagentExtensionTools off the supplier
      // is undefined → [] (script intent recorded, no tools).
      "extension-tools": () => subagentToolsAssembler.extensionToolsOnly(),
      // Damage-control-only toolset: the workflow_damage_control def
      // (mode-gated: readonly/full capabilities). Works in every host-tools
      // mode, including "off". With subagentDamageControlTools off the
      // supplier is undefined → [] (script intent recorded, no tools).
      "damage-control-tools": () => subagentToolsAssembler.damageControlToolsOnly(),
    },
  };
  // The gateway is created per extension generation; a /reload hands the old
  // bridge no continuation, so stop it on shutdown to release the socket.
  const stopHostToolGateway = () => {
    if (hostToolGateway.isRunning()) void hostToolGateway.stop().catch(() => {});
  };
  const runtimeClaim = claimWorkflowRuntime(cwd);
  const previousRuntime = runtimeClaim.compatible;
  const pausedForVersionChange = runtimeClaim.versionMismatch
    ? pauseStrandedWorkflowRuntime(runtimeClaim.versionMismatch)
    : 0;
  const manager: WorkflowManager = previousRuntime?.manager ?? new WorkflowManager({ cwd, ...gatewayManagerOptions });
  if (previousRuntime) manager.reconfigureAfterReload(gatewayManagerOptions);
  // /effort is independent of the manager implementation and can safely
  // survive an extension-version fallback to a fresh manager.
  const effort = (previousRuntime ?? runtimeClaim.versionMismatch)?.effort ?? createEffortState();
  // G3 wire: lazy plannotator review gate (Phase 2), SIZE-ROUTED
  // (tasks/approval-size-routing/design.md). A SMALL plan (execution steps
  // within the limit AND compact bytes within the limit) never materializes
  // the bridge — each checkpoint's plan is addressed at its OWN per-checkpoint
  // path the CLI approve verb reads (.pi/workflows/plans/<runId>-c<callIndex>.json,
  // D-02: one CLI verdict never rubber-stamps a later checkpoint), and
  // waitForApproval polls that file for the human verdict (CLI approve flips
  // status via decidePlanApproved). A BIG plan forces the bridge: it
  // materializes on the first big submitPlan (the existing lazy semantics),
  // auto-opens the vendored review page, and the CLI /workflows approve REFUSES
  // big plans. An ungated OR small run starts no server — port 3123 is never
  // bound (unless PI_WORKFLOW_PLANNOTATOR_PORT relocates it).
  const plansDir = join(cwd, ".pi", "workflows", "plans");
  // RunIds routed to the small path this generation (per-generation memory:
  // the plan files are the durable address; this set only dispatches waits).
  // B9: FIFO-capped at SMALL_PLAN_IDS_MAX, and a runId whose verdict is still
  // pending (waitingRunCounts > 0) is NEVER pruned.
  const SMALL_PLAN_IDS_MAX = 1024;
  const smallPlanIds = new Set<string>();
  // Per-checkpoint small-path plan ids (`<runId>-c<callIndex>`) → owning runId.
  // D-02: each checkpoint of a run is addressed at its OWN file, so the wait
  // dispatch stays runId-keyed while the poll targets the specific checkpoint.
  const checkpointPlanIds = new Map<string, string>();
  // runId → number of un-settled submit→wait cycles (B9 "never prunes a
  // still-waiting runId": the submit→wait gap is covered by the counter).
  const waitingRunCounts = new Map<string, number>();
  const rememberSmallRun = (runId: string) => {
    // Re-adding moves the runId to the newest end of the FIFO order.
    smallPlanIds.delete(runId);
    smallPlanIds.add(runId);
    // FIFO cap: evict the OLDEST entries that are NOT still awaiting a verdict.
    let excess = smallPlanIds.size - SMALL_PLAN_IDS_MAX;
    for (const candidate of smallPlanIds) {
      if (excess <= 0) break;
      if ((waitingRunCounts.get(candidate) ?? 0) > 0) continue;
      smallPlanIds.delete(candidate);
      for (const [planId, owner] of checkpointPlanIds) {
        if (owner === candidate) checkpointPlanIds.delete(planId);
      }
      excess--;
    }
  };
  let plannotatorBridge: ReturnType<typeof createPlannotatorBridge> | undefined;
  const checkpointGate: CheckpointGate = {
    async submitPlan(blueprint) {
      const payload = blueprint as { runId?: unknown; callIndex?: unknown } | null | undefined;
      const runId = typeof payload?.runId === "string" ? payload.runId : undefined;
      const callIndex = typeof payload?.callIndex === "number" ? payload.callIndex : undefined;
      const checkpoint = callIndex !== undefined ? { callIndex } : undefined;
      if (runId) {
        // The prewalk ExecutionBlueprint (when present) wins over the payload
        // — that is the plan a human reviews, and the file the CLI approve
        // reads. A per-checkpoint file (a prior submission of the SAME
        // checkpoint) wins over the run-level blueprint (D-02: each checkpoint
        // is addressed at `<runId>-c<callIndex>.json`). Small →
        // CLI-addressable, no bridge, no HTTP server.
        const classified = await classifyRunPlan({ dir: plansDir, runId, blueprint, checkpoint });
        if (!classified.big) {
          const ensured = await ensurePendingRunPlan(plansDir, runId, classified.plan, checkpoint);
          // The runId is remembered as small-routed; the checkpoint plan id
          // (when the payload carried a callIndex) maps back to it for the
          // runId-keyed wait dispatch.
          rememberSmallRun(runId);
          if (ensured.id !== runId) checkpointPlanIds.set(ensured.id, runId);
          return { id: ensured.id };
        }
      }
      // BIG (or runId-less — a direct-SDK submitPlan has no CLI-addressable
      // file, so the bridge is the only channel): browser review is mandatory.
      // Materializing here keeps the existing first-submitPlan lazy semantics;
      // autoOpenBrowser pops the review page, and a browser that cannot open
      // attaches the manual review URL (plan.note) to the result.
      plannotatorBridge ??= createPlannotatorBridge({ autoOpenBrowser: true, port: plannotatorPort() });
      const plan = await plannotatorBridge.submitPlan(blueprint);
      return { id: plan.id, ...(plan.note !== undefined ? { reviewUrl: plan.note } : {}) };
    },
    waitForApproval(planId, timeoutMs, signal) {
      const runId = checkpointPlanIds.get(planId) ?? planId;
      if (smallPlanIds.has(runId)) {
        // Small path: no bridge exists — poll the SPECIFIC plan file (the
        // per-checkpoint `<runId>-c<callIndex>.json`, or the run-level file
        // for a runId-addressed plan) for the CLI-approve verdict, honoring
        // the run's timeout + abort. Track the un-settled cycle so the FIFO
        // cap can never prune this run's dispatch while it waits (B9).
        const wait = waitForStatus(plansDir, planId, {
          timeoutMs: timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
          signal,
        });
        waitingRunCounts.set(runId, (waitingRunCounts.get(runId) ?? 0) + 1);
        const settle = () => {
          const remaining = (waitingRunCounts.get(runId) ?? 1) - 1;
          if (remaining <= 0) waitingRunCounts.delete(runId);
          else waitingRunCounts.set(runId, remaining);
        };
        void wait.then(settle, settle);
        return wait;
      }
      if (!plannotatorBridge) {
        return Promise.reject(new Error("plannotator gate is not materialized (submitPlan must run first)"));
      }
      return plannotatorBridge.waitForApproval(planId, timeoutMs, signal);
    },
    onStatusChange(callback) {
      if (!plannotatorBridge) {
        // Subscribed before any checkpoint (no bridge yet): safe no-op. Real
        // usage subscribes only after submitPlan, so the bridge exists.
        return () => {};
      }
      return plannotatorBridge.onStatusChange?.(callback) ?? (() => {});
    },
  };
  const runtime: WorkflowReloadRuntime = {
    cwd,
    extensionVersion: WORKFLOW_EXTENSION_VERSION,
    manager,
    effort,
    // Deterministic reload dispose fanout (runs exactly once per generation,
    // via extension-reload's stage/discard/expiry paths). Every step is
    // idempotent. The live manager is deliberately NOT disposed here — a
    // compatible reload claims it and reconfigures it.
    dispose: () => {
      // Clear the usage-limit scheduler's re-arm timers so a paused run can't
      // resurrect itself from a dead generation's scheduler.
      usageLimitScheduler.dispose();
      // End the MCP bridge socket and null the gateway client (stop() is
      // idempotent and drops its bridge reference).
      stopHostToolGateway();
      // Drop the MCP client's cached sessions (no sockets to close — stateless
      // HTTP transport, only cached session ids and tool lists are forgotten).
      mcpToolsManager.disconnectAll();
      // G3 gate: close the lazily-materialized plannotator review bridge (if
      // this generation ever created one). close() is idempotent — it ends the
      // tracked SSE responses, settles pending waits, and closes the review
      // server + its sockets — so a reload handoff leaves no orphaned port.
      plannotatorBridge?.close();
      plannotatorBridge = undefined;
    },
  };
  // Refresh the delivery holder immediately after claiming the manager. On a
  // reload handoff its listener survives, but Pi invalidates the old ExtensionAPI
  // before loading this generation. The TUI surface may be absent in a headless
  // host (pi-tui missing) — the barrel facade yields undefined there, so skip
  // rather than crash.
  if (installResultDelivery) installResultDelivery(pi, manager, { loadSettings });

  // Per-cwd persisted phase state machine — the single persistence root for
  // BOTH the Phase 0/1 pipeline (wayfinder → prewalk, audit action 1) and the
  // PhaseGuard agent()-gate integration (audit action 2). Sharing one manager
  // across the two option surfaces is what makes the wayfinder/prewalk stages
  // and the phase()/checkpoint() transitions record into the SAME
  // active-state.json under .pi/workflows (validated end-to-end by
  // tests/prd-runtime-activation.test.ts suites 1+3). The constructor is
  // side-effect free — nothing is written until a run actually transitions.
  const workflowStateManager = new WorkflowStateManager(join(cwd, ".pi", "workflows"));

  // Register the two tools defensively: a missing/incompatible peer (typebox for
  // the schemas) must disable JUST those tools with a clear diagnostic, not take
  // the whole extension down — manager, storage, scheduler, and the slash-command
  // surface keep working headless (H4).
  const disabledPieces: string[] = [];
  const registeredToolNames: string[] = [];
  // Both tool factories return different TDetails instantiations (unknown vs
  // Record<string, unknown>); the registration helper is the one boundary where
  // the two must share a type, so it widens to the tool-definition surface type.
  const registerToolSafely = (create: () => ToolDefinition<any, any, any> | undefined, label: string) => {
    try {
      const tool = create();
      if (tool) {
        pi.registerTool(tool);
        registeredToolNames.push(tool.name);
      }
    } catch (error) {
      disabledPieces.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  registerToolSafely(
    () =>
      createWorkflowTool({
        cwd,
        manager,
        storage,
        checkpointGate,
        // Phase 0/1 wiring (audit actions 1+3): the per-cwd persisted state
        // machine becomes the pipeline's persistence root, so wayfinder →
        // prewalk fire on EVERY top-level run with the zero-model stub mapper
        // and persist map.md + plans/<runId>.json — the plan file that makes
        // /workflows implement reachable (workflow-commands.ts:416 loadRunPlan).
        pipeline: { stateManager: workflowStateManager },
        // PhaseGuard wiring (audit action 2): the same machine records
        // phase()/checkpoint() transitions, but gateAgentCalls stays false so
        // DEFAULT runs keep the pre-wiring ungated agent() behavior — the gate
        // is consulted, never applied (wire-cleanup.md §3 coordination note; a
        // default run left gated would throw SUBAGENT_SPAWN_BLOCKED at the
        // first agent(), since the machine parks at Phase 2 after prewalk).
        phaseState: { stateManager: workflowStateManager, gateAgentCalls: false },
      }),
    "workflow tool",
  );
  registerToolSafely(() => createWorkflowControlTool({ manager }), "workflow_control tool");
  // Audit action 5: the PRD-named get_workflow_status tool — a thin snapshot
  // reader over the manager's public surface (status enum from the persisted
  // run record, live counts from the in-memory snapshot). Lifecycle verbs stay
  // on workflow_control; this is query-only, so it never mutates a run.
  registerToolSafely(
    () =>
      defineTool({
        name: "get_workflow_status",
        label: "Get Workflow Status",
        description:
          "Get the status of a workflow run by canonical run ID: persisted status, phase, agent counts, token usage, and result. Query-only — use workflow_control for lifecycle verbs (pause/resume/stop).",
        promptSnippet: "Check the status of a workflow run by ID.",
        parameters: Type.Object({
          runId: Type.String({ description: "Canonical workflow run ID." }),
        }),
        async execute(_toolCallId, params) {
          const persisted = manager.listRuns().find((run) => run.runId === params.runId);
          const snapshot = manager.getSnapshot(params.runId);
          const details = {
            runId: params.runId,
            found: persisted !== undefined || snapshot !== null,
            status: persisted?.status,
            currentPhase: persisted?.currentPhase ?? snapshot?.currentPhase,
            agentCount: snapshot?.agentCount ?? persisted?.agents.length ?? 0,
          };
          if (!details.found) {
            return {
              content: [{ type: "text", text: `get_workflow_status: run not found: ${params.runId}` }],
              details,
            };
          }
          const lines = [`run=${params.runId} name=${persisted?.workflowName ?? snapshot?.name ?? "?"}`];
          if (persisted) {
            lines.push(
              `status=${persisted.status}`,
              `phase=${persisted.currentPhase ?? "-"}`,
              `agents=${persisted.agents.length} started=${persisted.startedAt} updated=${persisted.updatedAt}`,
            );
            if (persisted.durationMs !== undefined) lines.push(`durationMs=${persisted.durationMs}`);
            if (persisted.tokenUsage?.total !== undefined) lines.push(`tokens=${persisted.tokenUsage.total}`);
          }
          if (snapshot) {
            lines.push(
              `liveAgentCount=${snapshot.agentCount} done=${snapshot.doneCount} running=${snapshot.runningCount} error=${snapshot.errorCount}`,
              `currentPhase=${snapshot.currentPhase ?? "-"}`,
            );
            // Per-running-agent live stats (elapsed, last-activity idle, live
            // final-attempt tokens) + the idleAgents fact — only when a live
            // snapshot shows running agents, so cold runs keep today's output.
            if (snapshot.runningCount > 0) {
              const agentStatus = buildAgentStatusLines(snapshot.agents, Date.now());
              lines.push(...agentStatus.lines);
              lines.push(`idleAgents=${agentStatus.idleAgents}`);
              (details as { agents?: WorkflowRunningAgentDetail[] }).agents = agentStatus.agents;
            }
          }
          if (persisted?.result !== undefined) {
            lines.push(`result=${JSON.stringify(persisted.result).slice(0, 200)}`);
          }
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details,
          };
        },
      }),
    "get_workflow_status tool",
  );
  // Audit: workflow_damage_control — the damage-control + recovery toolset
  // (design: tasks/damage-control-recovery/DESIGN.md): list/status/agents/
  // pause/resume/stop/kill-agent/recover/clean with session-scoped mutating
  // verbs, dry-run-default clean, and journal-prefix recovery. Registered
  // through the same defensive registerToolSafely boundary as the tools above
  // so a missing/failed module disables JUST this tool with a diagnostic (H4)
  // — manager, storage, scheduler, and the slash-command surface keep working.
  registerToolSafely(
    () => (createWorkflowDamageControlTool ? createWorkflowDamageControlTool({ manager, cwd }) : undefined),
    "workflow_damage_control tool",
  );
  // P2-1 WIRE: lazy gateway command — starts MCPBridge on demand only. Tool
  // definitions are built at start time so the extension load stays side-effect
  // free and the automatic default (host tools in untagged runs, design C) is
  // stated in the command copy; the "off" escape hatch gets the legacy
  // opt-in-only phrasing.
  registerWorkflowGatewayCommand(pi, hostToolGateway, {
    // Same G7 guard as the policy bundle above — the /workflows-gateway start
    // path must not bypass the write-conflict interceptor.
    buildHostTools: () =>
      guardWorktreeWriteConflicts(
        buildMergedHostTools(pi, {
          cwd,
          sessionManager: () => hostSessionManager(),
          excludeSubagentTools: settings.excludeSubagentTools,
        }),
      ),
    hostToolsAutomatic: hostToolsPolicy.isEnabled(),
  });
  // "on" (opt-in): the eager start happens at the first session_start below,
  // NOT at load — action methods (getAllTools inside buildMergedHostTools)
  // throw "Extension runtime not initialized" until the host binds the
  // runtime after loading, so a load-time start always failed. The default
  // "auto" stays lazy — nothing opens until a run needs host tools.
  // Auto-resume runs that paused on a provider usage limit once the quota is
  // likely refilled. Standalone: only consumes the manager's public surface, so
  // it stays decoupled from manager/persistence internals. Its constructor also
  // re-arms any run that was already paused-on-usage_limit before this process
  // started (cold start), so restarting pi doesn't strand a paused run.
  const usageLimitScheduler = new UsageLimitScheduler(manager);
  pi.on("session_shutdown", (event?: { reason?: string }) => {
    // Resources owned by this generation are disposed inside the runtime's
    // dispose hook: handoff/discard run it deterministically (at most once)
    // on both the reload and non-reload shutdown paths.
    if (event?.reason === "reload") {
      handoffWorkflowRuntime(runtime);
    } else {
      discardWorkflowRuntime(cwd, runtime);
    }
  });
  // Standing /effort opt-in (off|high|ultra): auto-arms a workflow for substantive
  // messages, like CC's ultracode. Shared with the editor's input hook below and
  // with the explicit /workflows run <prompt> manual trigger. It is part of the
  // reload handoff so /reload does not silently turn the selected effort off.
  registerWorkflowCommands?.(pi, manager, { storage, cwd, effort });
  registerWorkflowModelsCommand?.(pi, { getProviderPool: () => manager.getProviderPool()?.snapshot() });
  registerWorkflowSettingsCommand?.(pi);
  // Effective-subagent-toolset listing: per-tool source + allow status, MCP
  // servers, and the host tools that cannot reach subagents on 0.83.0
  // (metadata-only ExtensionAPI). Reads the live settings + the assembler the
  // runs actually use, so the listing can never drift from the wiring.
  registerWorkflowSubagentToolsCommand(pi, {
    loadSettings,
    getHostToolInfos: () => pi.getAllTools(),
    assembleDefaultTools: () => subagentToolsAssembler.assemble(),
    listMcpServers: () => mcpToolsManager.serverNames(),
    getChromeGranted: () => isChromeAuthorized(),
    getExtensionToolSources: () => getExtensionToolSourceResults(settings.subagentExtensionTools ?? "off"),
  });
  registerBuiltinWorkflows(pi, { cwd, manager, storage });
  registerAllSavedWorkflows(pi, cwd, storage, manager);
  registerEffortCommand(pi, effort);
  // "Workflows mode": type `workflow(s)` to arm a forced workflow at submit
  // time. Installed once (guarded below) inside session_start alongside the
  // other per-session installers.
  let armingInstalled = false;
  // One-line startup notice for an active provider pool, logged at most once
  // per extension activation (session_start can re-fire on session switch).
  let providerPoolNoticeShown = false;

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    if (pausedForVersionChange > 0) {
      ctx.ui.notify(
        `Workflow extension updated during /reload; paused ${pausedForVersionChange} active workflow(s) for safe resume.`,
        "warning",
      );
    }
    // Tell the manager the session's main model so "explore" agents auto-tier
    // down to a lighter same-family sibling (e.g. Claude → Haiku).
    manager.setMainModel(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
    // Share the host session's model registry so tier/phase routing resolves
    // extension-registered providers (e.g. ollama-cloud) consistently. Set it
    // before activating the tool: the tool's promptGuidelines read the
    // manager's registry lazily, so tool-registry refreshes from here on
    // advertise the shared registry's models.
    manager.setModelRegistry(ctx.modelRegistry);
    // Build the shared provider pool (settings + this session's registry) and
    // hand it to the manager so subagent runs route through it (design:
    // tasks/provider-load-balance/design.md). Re-attached on every
    // session_start: /reload keeps the manager but re-fires session_start with
    // a fresh registry, so the pool follows the current session's models. The
    // pool has no shutdown method — pending waiters abort via the per-run
    // acquire signal (agent.ts) — so there is nothing to tear down at
    // session_shutdown. ctx.signal (per-turn, aborts at turn end) is NOT wired
    // here: a pool built with a dead turn signal would reject every later
    // acquire as "shut down".
    const pool: ProviderPool | undefined = settings.providerPool
      ? createProviderPoolFromConfig(settings.providerPool, ctx.modelRegistry)
      : undefined;
    if (pool) {
      manager.setProviderPool(pool);
      if (!providerPoolNoticeShown) {
        const snapshot = pool.snapshot();
        const providerCount = new Set(snapshot.entries.map((entry) => entry.provider)).size;
        console.warn(
          `[workflow] Provider pool active: ${snapshot.entries.length} endpoint(s) across ${providerCount} provider(s), saturation=${snapshot.whenSaturated}, waitTimeoutMs=${snapshot.saturationWaitTimeoutMs}`,
        );
        providerPoolNoticeShown = true;
      }
    } else {
      manager.setProviderPool(undefined);
    }
    // Capture the real session manager for the host-tool bridge context (bash's
    // PI_SESSION_ID/PI_SESSION_FILE env). The provider is re-resolved per call,
    // so both already-built and future bundles adopt it immediately;
    // session_start always fires before any workflow run starts.
    if (ctx.sessionManager) hostSessionManager = () => ctx.sessionManager;
    // "on" (opt-in): eager start deferred to the first session_start — the
    // runtime is bound by then (action methods throw during load), and the
    // real session manager is captured just above so the bundle is built with
    // it. ensureStarted is idempotent (running-guard + shared in-flight
    // start), so re-fires on session switch are safe; a transient failure is
    // logged once and retried by the next run's lazy path.
    if (hostToolsPolicy.mode === "on") void hostToolsPolicy.ensureStarted();
    const active = pi.getActiveTools();
    const workflowTools = registeredToolNames;
    const missing = workflowTools.filter((name) => !active.includes(name));
    if (missing.length) pi.setActiveTools([...active, ...missing]);
    // Scope the /workflows history to this session: runs persist on disk across
    // sessions, but the navigator/task panel show only the current session's runs.
    // Switching back to a previous session re-shows that session's runs.
    try {
      manager.setSessionId(ctx.sessionManager?.getSessionId());
    } catch {
      // sessionManager may be unavailable in some contexts — fall back to global history.
    }
    // Live "workflows running" panel below the input (focus + enter to open).
    // Pass a live settings loader so /workflows-progress (compact|detailed) takes
    // effect without a restart.
    if (installTaskPanel && ctx.ui) {
      installTaskPanel(pi, manager, ctx.ui, { storage, cwd, loadSettings });
    } else {
      // Headless host: no task panel, no crash. notify() may itself be absent.
      ctx.ui?.notify?.(
        "Workflow task panel unavailable: @earendil-works/pi-tui is missing or incompatible (required: >=0.80.6).",
        "warning",
      );
    }
    if (disabledPieces.length) {
      ctx.ui?.notify?.(`Workflow extension partially loaded: ${disabledPieces.join("; ")}`, "warning");
    }
    if (!armingInstalled) {
      installWorkflowKeywordArming(pi, effort, {
        settingsStore: {
          load: loadSettings,
          save: (nextSettings) => saveWorkflowSettingsForCwd(nextSettings, cwd),
        },
      });
      armingInstalled = true;
    }
  });
}
