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
import {
  applyEnvSettingsOverride,
  createEffortState,
  createGatewayProxiedTools,
  createWebTools,
  createWorkflowControlTool,
  createWorkflowStorage,
  createWorkflowTool,
  HostToolGateway,
  hostToolsFromDefinitions,
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
  saveWorkflowSettingsForCwd,
  UsageLimitScheduler,
  WorkflowManager,
} from "../src/index.js";

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
  // the bridge only comes up when a user runs /workflows-gateway start. The
  // host-tools toolset below is the explicit opt-in: a run that names
  // toolset "host-tools" receives proxied host tools, everything else keeps the
  // README-documented default of no host tools in subagents.
  const hostToolGateway = new HostToolGateway();
  const gatewayManagerOptions = {
    ...managerOptions,
    toolsets: {
      ...managerOptions.toolsets,
      "host-tools": () => createGatewayProxiedTools(hostToolGateway),
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
      // Cross-slice handoff: an on-demand plannotator review bridge (if this
      // generation ever creates one) is closed here via its close() — it ends
      // the tracked SSE responses, settles pending waits, and closes the
      // review server. The current extension generation owns no bridge
      // instance, so there is nothing to close today.
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
  registerToolSafely(() => createWorkflowTool({ cwd, manager, storage }), "workflow tool");
  registerToolSafely(() => createWorkflowControlTool({ manager }), "workflow_control tool");
  // P2-1 WIRE: lazy gateway command — starts MCPBridge on demand only. Tool
  // definitions are built at start time so the extension load stays side-effect
  // free and the default (no host tools in subagents) is untouched until a user
  // explicitly enables the bridge.
  registerWorkflowGatewayCommand(pi, hostToolGateway, {
    buildHostTools: () => hostToolsFromDefinitions([...createCodingTools(cwd), ...createWebTools()]),
  });
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
