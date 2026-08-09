/**
 * Entry-contract gate: verifies that `src/index.ts` still exports the public
 * API surface this package documents and depends on.
 *
 * The extension entry (`extensions/workflow.ts`), the README's library API,
 * and the test suites all import from `src/index.js`. A rename or accidental
 * removal of any of those names would only surface at runtime inside a pi
 * session — this script turns that into a fast, deterministic CI failure by
 * resolving the module's ACTUAL exports with the TypeScript checker and
 * diffing them against the frozen contract below.
 *
 * Contract policy:
 *  - Every name in ENTRY_CONTRACT must be exported (missing → exit 1).
 *  - Exports NOT in the contract are reported as warnings (exit 0): the
 *    contract should grow with the public API, so keep it current when you
 *    add an export — but a new export must never silently break the gate.
 *
 * Run: `npm run check:entry-contract` (wired into `npm run check` → CI).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY_FILE = join(REPO_ROOT, "src", "index.ts");

/**
 * Frozen public entry contract, keyed by export name with the reason the name
 * is contractual. Curated from: the extension entry's imports
 * (extensions/workflow.ts), README-documented library API, and the test suites
 * that import from src/index.js.
 */
const ENTRY_CONTRACT: Record<string, string> = {
  // ── extension entry (extensions/workflow.ts) — every import must resolve ──
  createEffortState: "extension entry imports it",
  createGatewayProxiedTools: "extension entry imports it",
  createWebTools: "extension entry imports it",
  createWorkflowControlTool: "extension entry imports it",
  createWorkflowStorage: "extension entry imports it",
  createWorkflowTool: "extension entry imports it",
  HostToolGateway: "extension entry imports it",
  hostToolsFromDefinitions: "library API (HostToolGateway family; tests import it)",
  installResultDelivery: "extension entry imports it",
  installTaskPanel: "extension entry imports it",
  installWorkflowKeywordArming: "extension entry imports it",
  loadWorkflowSettings: "extension entry imports it",
  registerAllSavedWorkflows: "extension entry imports it",
  registerBuiltinWorkflows: "extension entry imports it",
  registerEffortCommand: "extension entry imports it",
  registerWorkflowCommands: "extension entry imports it",
  registerWorkflowGatewayCommand: "extension entry imports it",
  registerWorkflowModelsCommand: "extension entry imports it",
  registerWorkflowSettingsCommand: "extension entry imports it",
  registerWorkflowSubagentToolsCommand: "extension entry imports it",
  buildSubagentToolRows: "subagent-tools listing command (renderer, tests import it)",
  classifyToolSource: "subagent-tools listing command (renderer, tests import it)",
  renderSubagentToolsListing: "subagent-tools listing command (renderer, tests import it)",
  SubagentToolRow: "subagent-tools listing command (type)",
  SubagentToolSource: "subagent-tools listing command (type)",
  SubagentToolStatus: "subagent-tools listing command (type)",
  SubagentToolsListingInput: "subagent-tools listing command (type)",
  SubagentToolsMode: "subagent-tools listing command (type)",
  WorkflowSubagentToolsCommandOptions: "subagent-tools listing command (type)",
  saveWorkflowSettingsForCwd: "extension entry imports it",
  UsageLimitScheduler: "extension entry imports it",
  WorkflowManager: "extension entry imports it",
  // ── README-documented library API / headless override layer ──
  applyEnvSettingsOverride: "config env override layer (entry-config:i2)",
  workflowSettingsFromEnv: "config env override layer (entry-config:i2)",
  WORKFLOW_ENV_PREFIX: "config env override layer (entry-config:i2)",
  WORKFLOW_ENV_VARS: "config env override layer (entry-config:i2)",
  runWorkflow: "README + runtime test suites",
  parseWorkflowScript: "public script parsing API",
  generateDeepResearchWorkflow: "builtin /deep-research",
  generateCodeReviewWorkflow: "builtin /code-review",
  MAX_DIFF_CHARS: "builtin /code-review",
  diffShard: "builtin /code-review diff sharding",
  CODE_REVIEW_ANGLES: "builtin /code-review diff sharding",
  generateAdversarialReviewWorkflow: "builtin adversarial review",
  generateMultiPerspectiveWorkflow: "builtin multi-perspective",
  generateCodebaseAuditWorkflow: "builtin codebase audit",
  generatePlanThenExecuteWorkflow: "builtin plan-then-execute",
  orderStepsByDependencies: "builtin plan-then-execute step ordering",
  PLAN_THEN_EXECUTE_MAX_PLAN_ATTEMPTS: "builtin plan-then-execute constant",
  PLAN_THEN_EXECUTE_MAX_REWORK_ATTEMPTS: "builtin plan-then-execute constant",
  PLAN_THEN_EXECUTE_NUMERIC_ARGS: "builtin plan-then-execute constant",
  generateSpecGenerationWorkflow: "builtin spec-generation",
  normalizeSpecArtifact: "builtin spec-generation artifact normalization",
  SPEC_GENERATION_DEFAULT_FORMAT: "builtin spec-generation constant",
  SPEC_GENERATION_FORMATS: "builtin spec-generation constant",
  // ── config constants (export * from ./config.js) ──
  MAX_AGENTS_PER_RUN: "config constant",
  DEFAULT_AGENT_TIMEOUT_MS: "config constant",
  DRAIN_ABORT_TIMEOUT_MS: "config constant",
  MAX_CONCURRENCY: "config constant",
  MAX_NESTED_WORKFLOW_DEPTH: "config constant",
  MAX_AGENT_RETRIES: "config constant",
  // T2-03/T2-04/T2-05/T2-11 routing-economics constants (slice C).
  UNTAGGED_TIER_ECONOMY: "config constant (T2-03 economy default sentinel)",
  UNTAGGED_TIER_INHERIT_MAIN: "config constant (T2-03 opt-out sentinel)",
  DEFAULT_UNTAGGED_TIER: "config constant (T2-03 run default)",
  ROUTING_POLICY_VERSION: "config constant (T2-03/05/11 resume-hash policy version)",
  DEFAULT_HELPER_TIER: "config constant (T2-04 quality-helper vote tier)",
  DEFAULT_TOKEN_BUDGET: "config constant",
  WORKFLOW_RUNS_DIR: "config constant",
  WORKFLOW_SAVED_DIR: "config constant",
  USER_WORKFLOW_SAVED_DIR: "config constant",
  MODEL_TIERS_FILE: "config constant",
  WORKFLOW_SETTINGS_FILE: "config constant",
  DEFAULT_KEYWORD_TRIGGER_WORD: "config constant",
  normalizeKeywordTriggerWord: "config helper",
  AGENTS_DIR: "config constant",
  DEFAULT_RETRY_BACKOFF_MS: "config constant (run retry backoff)",
  MAX_RETRY_BACKOFF_MS: "config constant (run retry backoff)",
  // ── errors / gate codes (callers switch on these) ──
  WorkflowError: "public error type",
  WorkflowErrorCode: "public error-code enum",
  isWorkflowError: "public guard",
  isAbortError: "public guard",
  isTimeoutError: "public guard",
  wrapError: "public helper",
  APPROVAL_REQUIRED: "phase gate code (phases-machinery)",
  PHASE_TRANSITION_INVALID: "phase gate code (phases-machinery)",
  SUBAGENT_SPAWN_BLOCKED: "phase gate code (phases-machinery)",
  WorkflowStateManager: "phases machinery",
  // ── agent / runtime machinery ──
  WorkflowAgent: "agent runner",
  applyToolPolicy: "agent registry surface",
  compactAgentHistory: "agent history",
  listAgentTypes: "agent registry surface",
  loadAgentRegistry: "agent registry surface",
  resolveAgentType: "agent registry surface",
  listAvailableModels: "agent registry surface",
  listAvailableModelSpecs: "agent registry surface",
  createWorktreeRunner: "worktree isolation",
  executeTask: "worktree isolation",
  implementProtocol: "worktree isolation",
  MCPProxyClient: "proxied tools",
  createProxiedTools: "proxied tools",
  MCPBridge: "host-tool gateway bridge",
  // ── provider pool (per-provider concurrency + run-sticky routing) ──
  ProviderPool: "provider pool service",
  createProviderPoolFromConfig: "provider pool factory",
  ProviderPoolConfig: "provider pool config type",
  ProviderPoolOptions: "provider pool options type",
  ProviderPoolEntry: "provider pool entry type",
  ProviderPoolSnapshot: "provider pool snapshot type",
  ProviderPoolSnapshotEntry: "provider pool snapshot entry type",
  ProviderChoice: "provider pool choice type",
  ProviderPoolEntryInput: "provider pool settings input type",
  ProviderPoolModelInput: "provider pool settings model input type",
  ProviderPoolSettingsInput: "provider pool settings input type",
  normalizeProviderPoolConfig: "provider pool config normalization",
  parseProviderPoolEnvJson: "provider pool env JSON parser",
  providerPoolFromEnv: "provider pool env override reader",
  DEFAULT_WHEN_SATURATED: "provider pool default",
  DEFAULT_SATURATION_WAIT_TIMEOUT_MS: "provider pool default",
  DEFAULT_TPM_WINDOW_MS: "provider pool default",
  DEFAULT_COOLDOWN_MS: "provider pool default",
  PROVIDER_POOL_ENV_VAR: "provider pool env var name",
  createPlannotatorBridge: "plan review bridge",

  getPlanStatus: "plan review bridge",
  submitPlan: "plan review bridge",
  waitForApproval: "plan review bridge",
  createWorkflowLogger: "logger factory",
  createRunPersistence: "persistence factory",
  createRunState: "persistence",
  generateRunId: "persistence",
  listActiveRuns: "persistence",
  loadRunState: "persistence",
  resumeRun: "persistence (resume)",
  saveCheckpoint: "persistence (checkpoint)",
  cleanupRun: "persistence",
  // settings loading / saving
  saveWorkflowSettings: "settings saving",
  // ── workflows-settings field registry (settings surface) ──
  FIELD_REGISTRY: "workflows-settings field registry",
  FIELD_GROUPS: "workflows-settings field registry",
  SettingsFormModel: "workflows-settings form state",
  fieldDisplayValue: "workflows-settings field display",
  getEnvLockedKeys: "workflows-settings env locks",
  getField: "workflows-settings field lookup",
  parseFieldInput: "workflows-settings input validation",
  SharedStore: "shared store",
  createStructuredOutputTool: "structured output",
  createWebFetchTool: "web tools",
  createWebSearchTool: "web tools",
  createWorktree: "worktree lifecycle",
  removeWorktree: "worktree lifecycle",
  // ── display / TUI ──
  createWorkflowSnapshot: "display",
  recomputeWorkflowSnapshot: "display",
  renderWorkflowLines: "display",
  renderWorkflowText: "display",
  preview: "display",
  createToolUpdateWorkflowDisplay: "display",
  createWidgetWorkflowDisplay: "display",
  deliverText: "result delivery",
  openWorkflowNavigator: "workflow UI",
  renderNavigator: "workflow UI",
  NavigatorModel: "workflow UI",
  NavigatorState: "workflow UI",
  keyToAction: "workflow UI",
  // ── effort / arming ──
  effortDirective: "effort machinery",
  isSubstantive: "effort machinery",
  buildArmedWorkflowPrompt: "keyword arming",
  buildForcedWorkflowPrompt: "keyword arming",
  endsWithTrigger: "keyword arming",
  hasTrigger: "keyword arming",
  registerWorkflowProgressCommands: "keyword arming",
  registerWorkflowTriggerCommand: "keyword arming",
  // ── gateway error constants (stable, callers compare against them) ──
  CONNECTION_CLOSED: "gateway constant",
  INTERNAL_ERROR: "gateway constant",
  INVALID_PARAMS: "gateway constant",
  INVALID_REQUEST: "gateway constant",
  METHOD_NOT_FOUND: "gateway constant",
  PARSE_ERROR: "gateway constant",
  TOOL_EXECUTION_ERROR: "gateway constant",
  TOOL_NOT_FOUND: "gateway constant",
  TOOL_TIMEOUT: "gateway constant",
  GATEWAY_NOT_RUNNING_MESSAGE: "gateway message",
  // ── usage-limit scheduler ──
  computeAutoResumeDelayMs: "usage-limit scheduler",
  parseResetHintMs: "usage-limit scheduler",
  // ── model routing / tiers ──
  classifyTask: "model routing",
  TaskClassification: "model routing",
  tierNameForTask: "model routing",
  tierNameForClassification: "model routing",
  parseModelRoutingFromMeta: "model routing",
  resolveModelForPhase: "model routing",
  canonicalModelSpec: "model specs",
  formatModelSpecWithThinking: "model specs",
  isThinkingLevel: "model specs",
  resolveModelSpecWithThinking: "model specs",
  splitModelSpecThinking: "model specs",
  THINKING_LEVELS: "model specs",
  buildDefaultTierConfig: "model tier config",
  formatTierFallbackNotice: "model tier config",
  getModelTierConfigPath: "model tier config",
  loadModelTierConfig: "model tier config",
  resolveTierModel: "model tier config",
  saveModelTierConfig: "model tier config",
  sortedTierNames: "model tier config",
  // ── phases / wayfinder ──
  generateBlueprint: "phases prewalk",
  loadBlueprint: "phases prewalk",
  saveBlueprint: "phases prewalk",
  validateBlueprint: "phases prewalk",
  assessPrompt: "wayfinder",
  beginSession: "wayfinder",
  blockTicket: "wayfinder",
  buildResearchPrompt: "wayfinder",
  createDecisionMap: "wayfinder",
  dispatchTicketResearch: "wayfinder",
  getNextAction: "wayfinder",
  getSessionTicket: "wayfinder",
  loadDecisionMap: "wayfinder",
  renderMarkdownMap: "wayfinder",
  resolveTicket: "wayfinder",
  saveDecisionMap: "wayfinder",
  unblockTicket: "wayfinder",
  // ── saved commands ──
  parseCommandArgs: "saved commands",
  registerSavedWorkflow: "saved commands",
  assertSafeSavedWorkflowName: "saved-workflow safety",
  isSafeSavedWorkflowName: "saved-workflow safety",
  // ── workflow status / locking ──
  acquireFileLock: "workflow status",
  checkFileConflict: "workflow status",
  createWorktreeWriteClaimer: "workflow status (B3 live claimer)",
  getWorkflowStatus: "workflow status",
  listRunningWorkflows: "workflow status",
  releaseFileLock: "workflow status",
  WorktreeWriteClaimer: "workflow status (B3 live claimer)",
  WorktreeWriteClaimerOptions: "workflow status (B3 live claimer)",
  // ── workflow paths ──
  WORKFLOW_HOME_RELATIVE_DIR: "workflow paths",
  WORKFLOW_PROJECTS_SUBDIR: "workflow paths",
  workflowHomeDir: "workflow paths",
  workflowProjectKey: "workflow paths",
  workflowProjectPaths: "workflow paths",
  workflowUserSavedDir: "workflow paths",
  getWorkflowProjectSettingsPath: "settings paths",
  getWorkflowSettingsPath: "settings paths",
  // ── workflow tool ──
  backgroundStartedText: "workflow tool",
  formatCompletedResultText: "workflow tool (M18 completed-run text)",
  // ── workflow damage-control toolset (extension lazy-loads it; unit + e2e suites) ──
  createWorkflowDamageControlTool: "damage-control tool factory (extension lazy-load, e2e suite)",
  DAMAGE_CONTROL_ACTIONS: "damage-control verb matrix",
  DAMAGE_CONTROL_READONLY_ACTIONS: "damage-control readonly verb matrix",
  allowedDamageControlActions: "damage-control verb matrix helper",
  classifyRecoveryAction: "damage-control recovery classification",
  collectCleanCandidates: "damage-control clean candidates",
  formatDamageControlText: "damage-control text rendering",
  normalizeDamageControlInput: "damage-control input validation",
  reconcileAgentAfterKill: "damage-control kill reconcile",
  summarizeAgents: "damage-control agent summary",
  summarizeRunDeep: "damage-control deep run summary",
  AgentSummary: "damage-control type",
  CleanCandidate: "damage-control type",
  CleanReport: "damage-control type",
  DamageControlAction: "damage-control type",
  DamageControlCapabilities: "damage-control type",
  DamageControlInput: "damage-control type",
  DeepRunSummary: "damage-control type",
  KillAgentResult: "damage-control type",
  RecoveryClassification: "damage-control type",
  RecoveryOutcome: "damage-control type",
  WorkflowDamageControlToolOptions: "damage-control tool type",
  // ── lazy peer dependencies (H4) ──
  MissingPeerError: "lazy peer diagnostics",
  isMissingPeerError: "lazy peer diagnostics",
  PEER_DEPENDENCIES: "lazy peer diagnostics",
  lazyPeerImport: "lazy peer diagnostics",
  probePeerAvailability: "lazy peer diagnostics",
  // ── capability contract ──
  defineWorkflowCapabilityContract: "capability contract",
  WORKFLOW_CAPABILITY_CONTRACT: "capability contract",
  WORKFLOW_CAPABILITY_DEFINITION: "capability contract",
  CapabilityClassification: "capability contract",
  CapabilityOrigin: "capability contract",
  CapabilitySupport: "capability contract",
  DiagnosticSeverity: "capability contract",
  DiscoveryPlacement: "capability contract",
  WorkflowCapabilityContractError: "capability contract",
  // ── public types (renames break consumer type imports) ──
  WorkflowSettings: "settings type",
  WorkflowSettingsOptions: "settings type",
  WorkflowSettingsStore: "settings type",
  FormResult: "workflows-settings form type",
  SettingsScope: "workflows-settings scope type",
  WorkflowSettingsField: "workflows-settings field type",
  WorkflowSettingsFieldGroup: "workflows-settings field type",
  WorkflowSettingsFieldType: "workflows-settings field type",
  WorkflowToolInput: "workflow tool type",
  WorkflowToolOptions: "workflow tool type",
  WorkflowControlInput: "workflow control tool type",
  WorkflowControlRunDetails: "workflow control tool type",
  WorkflowControlToolOptions: "workflow control tool type",
  WorkflowManagerOptions: "workflow manager type",
  ManagedRun: "workflow manager type",
  WorkflowRunOptions: "workflow run type",
  WorkflowRunResult: "workflow run type",
  WorkflowMeta: "workflow meta type",
  WorkflowMetaPhase: "workflow meta phase type",
  AgentOptions: "agent options type",
  AgentRunOptions: "agent run options type",
  AgentRunResult: "agent run result type",
  WorkflowAgentOptions: "agent options type",
  RunResult: "worktree runner type",
  WorktreeRunner: "worktree runner type",
  WorktreeRunnerConfig: "worktree runner type",
  WorktreeTask: "worktree runner type",
  Worktree: "worktree type",
  PlannotatorBridge: "plannotator type",
  PlannotatorConfig: "plannotator type",
  ReviewPlan: "plannotator type",
  PersistedRunState: "persistence type",
  RunCheckpoint: "persistence type",
  RunCheckpointState: "persistence type",
  RunLeaseInfo: "persistence type",
  RunPersistence: "persistence type",
  RunStatus: "persistence type",
  SavedWorkflow: "saved workflow type",
  WorkflowStorage: "saved workflow type",
  WorkflowStatus: "status type",
  FileLock: "status type",
  JournalEntry: "journal type",
  PhaseOptions: "phase type",
  PhaseStateIntegration: "phase type",
  PhaseState: "phase type",
  SharedRuntime: "runtime type",
  CheckpointGate: "checkpoint type",
  WorkflowDisplay: "display type",
  WorkflowDisplayOptions: "display type",
  WorkflowSnapshot: "display type",
  WorkflowAgentSnapshot: "display type",
  WorkflowAgentStatus: "display type",
  TaskPanelOptions: "task panel type",
  AutoResumeDelayParams: "usage-limit scheduler type",
  SchedulableWorkflowManager: "usage-limit scheduler type",
  TimerHandle: "usage-limit scheduler type",
  UsageLimitSchedulerOptions: "usage-limit scheduler type",
  EffortLevel: "effort type",
  EffortState: "effort type",
  ArmReason: "arming type",
  InstallWorkflowKeywordArmingOptions: "arming type",
  WorkflowModeState: "arming type",
  NavAction: "UI type",
  ViewKind: "UI type",
  WorkflowLogger: "logger type",
  WorkflowLoggerOptions: "logger type",
  StructuredOutputCapture: "structured output type",
  StructuredOutputToolOptions: "structured output type",
  HostToolsBundle: "gateway type",
  SessionManagerLike: "gateway type",
  SessionManagerProvider: "gateway type",
  WorkflowGatewayCommandOptions: "gateway type",
  MCPBridgeOptions: "gateway type",
  MCPProxyClientOptions: "gateway type",
  ProxiedToolDef: "gateway type",
  ToolCallResult: "gateway type",
  ToolExecutor: "gateway type",
  ModelRoute: "model routing type",
  ModelRoutingConfig: "model routing type",
  ModelThinkingLevel: "model spec type",
  ResolvedModelSpec: "model spec type",
  ModelTierConfig: "model tier type",
  RankableModel: "model tier type",
  BlueprintStep: "prewalk type",
  ExecutionBlueprint: "prewalk type",
  ClaimSource: "wayfinder type",
  CreateDecisionMapOptions: "wayfinder type",
  DecisionMap: "wayfinder type",
  DecisionTicket: "wayfinder type",
  FogAssessment: "wayfinder type",
  FrontierMappedTicket: "wayfinder type",
  FrontierMapper: "wayfinder type",
  FrontierMapping: "wayfinder type",
  ResearchDispatch: "wayfinder type",
  StatableQuestion: "wayfinder type",
  TicketClaim: "wayfinder type",
  TicketStatus: "wayfinder type",
  TicketType: "wayfinder type",
  WayfinderRuntime: "wayfinder type",
  WorkflowProjectPaths: "paths type",
  AgentDefinition: "agent registry type",
  AgentRegistry: "agent registry type",
  AgentHistoryEntry: "agent history type",
  AgentHistoryKind: "agent history type",
  AgentHistoryRole: "agent history type",
  AdversarialReviewConfig: "builtin config type",
  DeepResearchConfig: "builtin config type",
  CodeReviewAngle: "builtin code-review angle type",
  PlanThenExecuteConfig: "builtin plan-then-execute config type",
  PlanStep: "builtin plan-then-execute step type",
  StepsOrderingOutcome: "builtin plan-then-execute ordering type",
  SpecArtifact: "builtin spec-generation artifact type",
  SpecGenerationConfig: "builtin spec-generation config type",
  SpecGenerationFormat: "builtin spec-generation format type",
  SpecRequirement: "builtin spec-generation requirement type",
  AlignmentEvidence: "capability contract type",
  CapabilityDescriptor: "capability contract type",
  CapabilityDiagnostic: "capability contract type",
  DynamicReferenceDescriptor: "capability contract type",
  OptionDescriptor: "capability contract type",
  OptionShape: "capability contract type",
  PresentAtVersion: "capability contract type",
  RuntimeBindingAssembly: "capability contract type",
  StaticCapabilityFact: "capability contract type",
  WorkflowCapabilityContract: "capability contract type",
  WorkflowCapabilityDefinition: "capability contract type",
  WorkflowRuntimeImplementations: "capability contract type",
};

const contractNames = new Set(Object.keys(ENTRY_CONTRACT));

/** Resolve the real export names of src/index.ts via the TypeScript checker. */
function resolveExportedNames(): Set<string> {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    forceConsistentCasingInFileNames: true,
    noEmit: true,
  };
  const program = ts.createProgram([ENTRY_FILE], options);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(ENTRY_FILE);
  if (!sourceFile) {
    throw new Error(`Entry file not found: ${ENTRY_FILE}`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    throw new Error(`Could not resolve the module symbol for ${ENTRY_FILE}`);
  }
  const names = new Set<string>();
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    names.add(exported.name);
  }
  return names;
}

function main(): void {
  const exported = resolveExportedNames();

  const missing = [...contractNames].filter((name) => !exported.has(name)).sort();
  const undocumented = [...exported].filter((name) => !contractNames.has(name)).sort();

  if (missing.length > 0) {
    console.error(`✗ ENTRY CONTRACT BROKEN — ${missing.length} documented export(s) missing from src/index.ts:`);
    for (const name of missing) {
      console.error(`  - ${name} (${ENTRY_CONTRACT[name]})`);
    }
    console.error(
      "\nRe-export the name from src/index.ts (or, if the removal is intentional, remove it from ENTRY_CONTRACT in scripts/check-entry-contract.ts).",
    );
    process.exitCode = 1;
  } else {
    console.log(`✔ entry contract OK — all ${contractNames.size} documented exports resolve from src/index.ts.`);
  }

  if (undocumented.length > 0) {
    console.warn(`\n⚠ ${undocumented.length} export(s) not in the entry contract (gate still passes):`);
    for (const name of undocumented) {
      console.warn(`  - ${name}`);
    }
    console.warn(
      "\nAdd new public exports to ENTRY_CONTRACT in scripts/check-entry-contract.ts to keep the contract current.",
    );
  }
}

main();
