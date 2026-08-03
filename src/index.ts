export type { AdversarialReviewConfig } from "./adversarial-review.js";
export { generateAdversarialReviewWorkflow, generateMultiPerspectiveWorkflow } from "./adversarial-review.js";
export { createProxiedTools, MCPProxyClient } from "./agent/mcp-proxy-client.js";
export type { RunResult, WorktreeRunner, WorktreeRunnerConfig, WorktreeTask } from "./agent/worktree-runner.js";
export { createWorktreeRunner, executeTask, implementProtocol } from "./agent/worktree-runner.js";
export type { AgentRunOptions, AgentRunResult, WorkflowAgentOptions } from "./agent.js";
export { listAvailableModelSpecs, listAvailableModels, WorkflowAgent } from "./agent.js";
export type { AgentHistoryEntry, AgentHistoryKind, AgentHistoryRole } from "./agent-history.js";
export { compactAgentHistory } from "./agent-history.js";
export type { AgentDefinition, AgentRegistry } from "./agent-registry.js";
export { applyToolPolicy, listAgentTypes, loadAgentRegistry, resolveAgentType } from "./agent-registry.js";
export { registerBuiltinWorkflows } from "./builtin-commands.js";
export type { CodeReviewAngle } from "./code-review.js";
export { CODE_REVIEW_ANGLES, diffShard, generateCodeReviewWorkflow, MAX_DIFF_CHARS } from "./code-review.js";
export * from "./config.js";
export type { DeepResearchConfig } from "./deep-research.js";
export { generateCodebaseAuditWorkflow, generateDeepResearchWorkflow } from "./deep-research.js";
export type {
  WorkflowAgentSnapshot,
  WorkflowAgentStatus,
  WorkflowDisplay,
  WorkflowDisplayOptions,
  WorkflowSnapshot,
} from "./display.js";
export {
  createToolUpdateWorkflowDisplay,
  createWidgetWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowLines,
  renderWorkflowText,
} from "./display.js";
export {
  createEffortState,
  type EffortLevel,
  type EffortState,
  effortDirective,
  isSubstantive,
  registerEffortCommand,
} from "./effort-command.js";
export {
  isAbortError,
  isTimeoutError,
  isWorkflowError,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "./errors.js";
export type {
  HostToolsBundle,
  SessionManagerLike,
  SessionManagerProvider,
  WorkflowGatewayCommandOptions,
} from "./gateway/host-tool-gateway.js";
export {
  createGatewayProxiedTools,
  GATEWAY_NOT_RUNNING_MESSAGE,
  HostToolGateway,
  hostToolsFromDefinitions,
  registerWorkflowGatewayCommand,
} from "./gateway/host-tool-gateway.js";
// ─── Universal Host Tool IPC Gateway (Task 1) ──────────────────────────────
export { MCPBridge } from "./gateway/mcp-bridge.js";
export type {
  MCPBridgeOptions,
  MCPProxyClientOptions,
  ProxiedToolDef,
  ToolCallResult,
  ToolExecutor,
} from "./gateway/types.js";
export {
  CONNECTION_CLOSED,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  TOOL_EXECUTION_ERROR,
  TOOL_NOT_FOUND,
  TOOL_TIMEOUT,
} from "./gateway/types.js";
export type { PlannotatorBridge, PlannotatorConfig, ReviewPlan } from "./integrations/plannotator.js";
export { createPlannotatorBridge, getPlanStatus, submitPlan, waitForApproval } from "./integrations/plannotator.js";
export type { WorkflowLogger, WorkflowLoggerOptions } from "./logger.js";
export { createWorkflowLogger } from "./logger.js";
export type { ModelRoute, ModelRoutingConfig } from "./model-routing.js";
export {
  classifyTask,
  parseModelRoutingFromMeta,
  resolveModelForPhase,
  TaskClassification,
  tierNameForClassification,
  tierNameForTask,
} from "./model-routing.js";
export type { ModelThinkingLevel, ResolvedModelSpec } from "./model-spec.js";
export {
  canonicalModelSpec,
  formatModelSpecWithThinking,
  isThinkingLevel,
  resolveModelSpecWithThinking,
  splitModelSpecThinking,
  THINKING_LEVELS,
} from "./model-spec.js";
export type { ModelTierConfig, RankableModel } from "./model-tier-config.js";
export {
  buildDefaultTierConfig,
  formatTierFallbackNotice,
  getModelTierConfigPath,
  loadModelTierConfig,
  resolveTierModel,
  saveModelTierConfig,
  sortedTierNames,
} from "./model-tier-config.js";
export {
  isMissingPeerError,
  lazyPeerImport,
  MissingPeerError,
  PEER_DEPENDENCIES,
  probePeerAvailability,
} from "./peer-deps.js";
// The TUI-facing value exports below come from a headless-safe facade: their
// modules import @earendil-works/pi-tui at module scope, so loading them through
// the facade (guarded top-level await) keeps this entrypoint importable when
// pi-tui is absent/incompatible. The values are `undefined` in that case; the
// extension null-guards and notifies instead of failing the whole load.
export {
  deliverText,
  installResultDelivery,
  installTaskPanel,
  keyToAction,
  NavigatorModel,
  NavigatorState,
  openWorkflowNavigator,
  registerWorkflowCommands,
  registerWorkflowModelsCommand,
  registerWorkflowSettingsCommand,
  renderNavigator,
} from "./peer-facades.js";
export type { BlueprintStep, ExecutionBlueprint } from "./phases/prewalk.js";
export { generateBlueprint, loadBlueprint, saveBlueprint, validateBlueprint } from "./phases/prewalk.js";
export type { PhaseState } from "./phases/state-machine.js";
export {
  APPROVAL_REQUIRED,
  PHASE_TRANSITION_INVALID,
  PhaseGuard,
  SUBAGENT_SPAWN_BLOCKED,
  WorkflowStateManager,
} from "./phases/state-machine.js";
export type {
  ClaimSource,
  CreateDecisionMapOptions,
  DecisionMap,
  DecisionTicket,
  FogAssessment,
  FrontierMappedTicket,
  FrontierMapper,
  FrontierMapping,
  ResearchDispatch,
  StatableQuestion,
  TicketClaim,
  TicketStatus,
  TicketType,
  WayfinderRuntime,
} from "./phases/wayfinder.js";
export {
  assessPrompt,
  beginSession,
  blockTicket,
  buildResearchPrompt,
  createDecisionMap,
  dispatchTicketResearch,
  getNextAction,
  getSessionTicket,
  loadDecisionMap,
  renderMarkdownMap,
  resolveTicket,
  saveDecisionMap,
  unblockTicket,
} from "./phases/wayfinder.js";
export type { PlanStep, PlanThenExecuteConfig, StepsOrderingOutcome } from "./plan-then-execute.js";
export {
  generatePlanThenExecuteWorkflow,
  orderStepsByDependencies,
  PLAN_THEN_EXECUTE_MAX_PLAN_ATTEMPTS,
  PLAN_THEN_EXECUTE_MAX_REWORK_ATTEMPTS,
  PLAN_THEN_EXECUTE_NUMERIC_ARGS,
} from "./plan-then-execute.js";
export type {
  PersistedRunState,
  RunCheckpoint,
  RunCheckpointState,
  RunPersistence,
  RunStatus,
} from "./run-persistence.js";
export {
  cleanupRun,
  createRunPersistence,
  createRunState,
  generateRunId,
  listActiveRuns,
  loadRunState,
  resumeRun,
  saveCheckpoint,
} from "./run-persistence.js";
export {
  parseCommandArgs,
  registerAllSavedWorkflows,
  registerSavedWorkflow,
} from "./saved-commands.js";
export { SharedStore } from "./shared-store.js";
export type { SpecArtifact, SpecGenerationConfig, SpecGenerationFormat, SpecRequirement } from "./spec-generation.js";
export {
  generateSpecGenerationWorkflow,
  normalizeSpecArtifact,
  SPEC_GENERATION_DEFAULT_FORMAT,
  SPEC_GENERATION_FORMATS,
} from "./spec-generation.js";
export type { StructuredOutputCapture, StructuredOutputToolOptions } from "./structured-output.js";
export { createStructuredOutputTool } from "./structured-output.js";
export type { TaskPanelOptions } from "./task-panel.js";
export type {
  AutoResumeDelayParams,
  SchedulableWorkflowManager,
  TimerHandle,
  UsageLimitSchedulerOptions,
} from "./usage-limit-scheduler.js";
export { computeAutoResumeDelayMs, parseResetHintMs, UsageLimitScheduler } from "./usage-limit-scheduler.js";
export { createWebFetchTool, createWebSearchTool, createWebTools } from "./web-tools.js";
export type {
  AgentOptions,
  CheckpointGate,
  JournalEntry,
  PhaseOptions,
  PhaseStateIntegration,
  SharedRuntime,
  WorkflowMeta,
  WorkflowMetaPhase,
  WorkflowRunOptions,
  WorkflowRunResult,
} from "./workflow.js";
export { parseWorkflowScript, runWorkflow } from "./workflow.js";
export type {
  AlignmentEvidence,
  CapabilityDescriptor,
  CapabilityDiagnostic,
  DynamicReferenceDescriptor,
  OptionDescriptor,
  OptionShape,
  PresentAtVersion,
  RuntimeBindingAssembly,
  StaticCapabilityFact,
  WorkflowCapabilityContract,
  WorkflowCapabilityDefinition,
  WorkflowRuntimeImplementations,
} from "./workflow-capability-contract.js";
export {
  CapabilityClassification,
  CapabilityOrigin,
  CapabilitySupport,
  DiagnosticSeverity,
  DiscoveryPlacement,
  defineWorkflowCapabilityContract,
  WORKFLOW_CAPABILITY_CONTRACT,
  WORKFLOW_CAPABILITY_DEFINITION,
  WorkflowCapabilityContractError,
} from "./workflow-capability-contract.js";
export type {
  WorkflowControlInput,
  WorkflowControlRunDetails,
  WorkflowControlToolOptions,
} from "./workflow-control-tool.js";

export { createWorkflowControlTool } from "./workflow-control-tool.js";
export {
  type ArmReason,
  buildArmedWorkflowPrompt,
  buildForcedWorkflowPrompt,
  endsWithTrigger,
  hasTrigger,
  type InstallWorkflowKeywordArmingOptions,
  installWorkflowKeywordArming,
  registerWorkflowProgressCommands,
  registerWorkflowTriggerCommand,
  type WorkflowModeState,
} from "./workflow-editor.js";
export type { ManagedRun, WorkflowManagerOptions } from "./workflow-manager.js";
export { WorkflowManager } from "./workflow-manager.js";
export type { WorkflowProjectPaths } from "./workflow-paths.js";
export {
  WORKFLOW_HOME_RELATIVE_DIR,
  WORKFLOW_PROJECTS_SUBDIR,
  workflowHomeDir,
  workflowProjectKey,
  workflowProjectPaths,
  workflowUserSavedDir,
} from "./workflow-paths.js";
export type { SavedWorkflow, WorkflowStorage } from "./workflow-saved.js";
export { assertSafeSavedWorkflowName, createWorkflowStorage, isSafeSavedWorkflowName } from "./workflow-saved.js";
export type { WorkflowSettings, WorkflowSettingsOptions, WorkflowSettingsStore } from "./workflow-settings.js";
export {
  getWorkflowProjectSettingsPath,
  getWorkflowSettingsPath,
  loadWorkflowSettings,
  saveWorkflowSettings,
  saveWorkflowSettingsForCwd,
} from "./workflow-settings.js";
export type {
  FormResult,
  SettingsScope,
  WorkflowSettingsField,
  WorkflowSettingsFieldGroup,
  WorkflowSettingsFieldType,
} from "./workflow-settings-fields.js";
export {
  FIELD_GROUPS,
  FIELD_REGISTRY,
  fieldDisplayValue,
  getEnvLockedKeys,
  getField,
  parseFieldInput,
  SettingsFormModel,
} from "./workflow-settings-fields.js";
export type { FileLock, WorkflowStatus } from "./workflow-status.js";
export {
  acquireFileLock,
  checkFileConflict,
  getWorkflowStatus,
  listRunningWorkflows,
  releaseFileLock,
} from "./workflow-status.js";
export type { WorkflowToolInput, WorkflowToolOptions } from "./workflow-tool.js";
export { backgroundStartedText, createWorkflowTool, formatCompletedResultText } from "./workflow-tool.js";
export type { NavAction, ViewKind } from "./workflow-ui.js";
export type { Worktree } from "./worktree.js";
export { createWorktree, removeWorktree } from "./worktree.js";
