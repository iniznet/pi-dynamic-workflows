import {
  createCodingTools,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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
import type { CheckpointGate } from "../src/index.js";
import {
  applyEnvSettingsOverride,
  createEffortState,
  createPlannotatorBridge,
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
} from "../src/index.js";
import { isChromeAuthorized } from "../src/subagent/chrome-bridge-client.js";
import {
  createExtensionToolsSupplier,
  getExtensionToolSourceResults,
} from "../src/subagent/extension-tools-capture.js";
import { McpToolsManager } from "../src/subagent/mcp-tools.js";
import { SubagentToolsAssembler } from "../src/subagent/subagent-tools-assembler.js";
import { createVendoredChromeTools } from "../src/subagent/vendored-chrome-tools.js";
import { guardWorktreeWriteConflicts } from "../src/workflow-status.js";

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
    toolsets: {
      "web-research": () => [...createCodingTools(cwd), ...createWebTools()],
    },
    // On top of the always-on workflow/workflow_control denial in subagents
    // (#107), let users block additional recursive-orchestration tools.
    excludeSubagentTools: settings.excludeSubagentTools,
    defaultAgentTimeoutMs: settings.defaultAgentTimeoutMs ?? null,
    defaultTokenBudget: settings.defaultTokenBudget ?? null,
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
    buildCodingTools: () => createCodingTools(cwd),
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
  // shared grant decides whether they are attached to a given assemble (no
  // grant → empty set, degrading gracefully). Every wire action is tagged with
  // the HOST session key + group title so subagent automation joins the main
  // session's tab group.
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
  // (supi-web's web_fetch_md/web_docs_*, pi-codegraph's codegraph_*) captured
  // in-process from the installed packages and executed in the host via the
  // gateway (design: tasks/subagent-extension-tools/DESIGN.md). Gated by
  // `subagentExtensionTools` exactly like chrome: off → undefined → no defs
  // anywhere, including the "extension-tools" toolset.
  const extensionToolsMode = settings.subagentExtensionTools ?? "off";
  const extensionToolsSupplier = createExtensionToolsSupplier(extensionToolsMode);
  const subagentToolsAssembler = new SubagentToolsAssembler({
    mode: settings.subagentTools ?? "all",
    // The host bundle baseline (coding + proxied host + web tools) is owned by
    // the policy above; MCP tools ride on top of it.
    hostTools: () => hostToolsPolicy.defaultTools(),
    mcpTools: mcpToolsManager,
    chromeTools: chromeToolsSupplier,
    extensionTools: extensionToolsSupplier,
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
      // host-tools mode. With subagentChromeTools "off" the supplier is
      // undefined, so this resolves to [] (script intent recorded, no tools).
      "chrome-tools": () => subagentToolsAssembler.chromeToolsOnly(),
      // Captured-extension-tools-only toolset: works in every host-tools
      // mode, including "off". With subagentExtensionTools off the supplier
      // is undefined → [] (script intent recorded, no tools).
      "extension-tools": () => subagentToolsAssembler.extensionToolsOnly(),
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
  const manager = previousRuntime?.manager ?? new WorkflowManager({ cwd, ...gatewayManagerOptions });
  if (previousRuntime) manager.reconfigureAfterReload(gatewayManagerOptions);
  // /effort is independent of the manager implementation and can safely
  // survive an extension-version fallback to a fresh manager.
  const effort = (previousRuntime ?? runtimeClaim.versionMismatch)?.effort ?? createEffortState();
  // G3 wire: lazy plannotator review gate (Phase 2). A run that never calls
  // checkpoint() starts no server — the facade materializes the real bridge on
  // the first gated checkpoint and tracks it for dispose. The bridge's default
  // port (3123) + autoOpenBrowser(true) pop the vendored review page in the
  // human's browser; waitForApproval polls the plan file until the verdict.
  let plannotatorBridge: ReturnType<typeof createPlannotatorBridge> | undefined;
  const checkpointGate: CheckpointGate = {
    async submitPlan(blueprint) {
      plannotatorBridge ??= createPlannotatorBridge({ autoOpenBrowser: true });
      return plannotatorBridge.submitPlan(blueprint);
    },
    waitForApproval(planId, timeoutMs, signal) {
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
  registerToolSafely(() => createWorkflowTool({ cwd, manager, storage, checkpointGate }), "workflow tool");
  registerToolSafely(() => createWorkflowControlTool({ manager }), "workflow_control tool");
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
  // "on" (opt-in): eager start at load for latency-sensitive users. The
  // default "auto" stays lazy — nothing opens until a run needs host tools.
  if (hostToolsPolicy.mode === "on") void hostToolsPolicy.ensureStarted();
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
  registerWorkflowModelsCommand?.(pi);
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
    // Capture the real session manager for the host-tool bridge context (bash's
    // PI_SESSION_ID/PI_SESSION_FILE env). The provider is re-resolved per call,
    // so both already-built and future bundles adopt it immediately;
    // session_start always fires before any workflow run starts.
    if (ctx.sessionManager) hostSessionManager = () => ctx.sessionManager;
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
