import packageJson from "../package.json" with { type: "json" };
import {
  CapabilityClassification,
  CapabilityOrigin,
  CapabilitySupport,
  DiagnosticSeverity,
  DiscoveryPlacement,
} from "./enums.js";
import { WorkflowCapabilityContractError } from "./errors.js";

/** Re-exported capability domains used by contract consumers. */
export {
  CapabilityClassification,
  CapabilityOrigin,
  CapabilitySupport,
  DiagnosticSeverity,
  DiscoveryPlacement,
} from "./enums.js";

/** Version marker for behavior present at or after a release. */
export interface PresentAtVersion {
  kind: "present-at";
  version: string;
}

/** One named option and the facts safe to publish about it. */
export interface OptionDescriptor {
  name: string;
  type: string;
  optional: boolean;
  default: string | null;
  constraints: readonly string[];
  dynamicReference: "model-routes" | "agent-types" | null;
}

/** Reusable option group referenced by capability descriptors. */
export interface OptionShape {
  id:
    | "agent-options"
    | "checkpoint-options"
    | "phase-options"
    | "verify-options"
    | "judge-panel-options"
    | "loop-until-dry-options"
    | "fan-out-options"
    | "retry-options"
    | "gate-options"
    | "test-gate-options"
    | "chunked-options"
    | "route-options"
    | "timeboxed-options"
    | "consensus-options"
    | "supervised-run-options";
  options: readonly OptionDescriptor[];
}

/** Authoritative declaration of one workflow capability and its evidence. */
export interface CapabilityDescriptor {
  id: `workflow.${string}`;
  label: string;
  classification: CapabilityClassification;
  support: CapabilitySupport;
  discovery: DiscoveryPlacement;
  origin: CapabilityOrigin;
  lifecycle: PresentAtVersion;
  signature: string | null;
  optionShape: OptionShape["id"] | null;
  constraints: readonly string[];
  enforcementOwner: string;
  runtimeBinding: { global: string; implementation: string; allowsUndefined?: true } | null;
  behaviorEvidence: readonly string[];
  staticReference: { path: string; anchor: string } | null;
  dynamicReference: "model-routes" | "agent-types" | null;
}

/** Ownership and item shape for a live catalogue that static docs must not embed. */
export interface DynamicReferenceDescriptor {
  id: "model-routes" | "agent-types";
  owner: "model-tier-config" | "agent-registry";
  itemShape: string;
  connection: string;
  items?: never;
}

/** Versioned plain-data source for runtime assembly and generated documentation. */
export interface WorkflowCapabilityDefinition {
  versions: {
    extension: string;
    format: PresentAtVersion;
    content: PresentAtVersion;
  };
  optionShapes: readonly OptionShape[];
  capabilities: readonly CapabilityDescriptor[];
  dynamicReferences: readonly DynamicReferenceDescriptor[];
}

/** Machine-readable disagreement between the contract and an observed surface. */
export interface CapabilityDiagnostic {
  code:
    | "MISSING_RUNTIME_IMPLEMENTATION"
    | "UNDECLARED_RUNTIME_IMPLEMENTATION"
    | "DECLARED_GLOBAL_UNOBSERVED"
    | "OBSERVED_GLOBAL_UNDECLARED"
    | "INVALID_CAPABILITY_DEFINITION";
  severity: DiagnosticSeverity;
  subject: string;
  message: string;
}

/** Re-exported contract failure type retained for existing consumers. */
export { WorkflowCapabilityContractError } from "./errors.js";

/** Runtime globals assembled from declared implementations plus non-fatal diagnostics. */
export interface RuntimeBindingAssembly {
  globals: Readonly<Record<string, unknown>>;
  diagnostics: readonly CapabilityDiagnostic[];
}

/** Project-owned implementations required to assemble the workflow VM context. */
export interface WorkflowRuntimeImplementations {
  agent: unknown;
  parallel: unknown;
  pipeline: unknown;
  workflow: unknown;
  verify: unknown;
  judgePanel: unknown;
  loopUntilDry: unknown;
  completenessCheck: unknown;
  chunked: unknown;
  route: unknown;
  timeboxed: unknown;
  elapsedMs: unknown;
  ctx: unknown;
  consensus: unknown;
  retry: unknown;
  gate: unknown;
  testGate: unknown;
  checkpoint: unknown;
  log: unknown;
  phase: unknown;
  args: unknown;
  cwd: unknown;
  process: unknown;
  budget: unknown;
  console: unknown;
  subagentTools: unknown;
  durableStore: unknown;
  supervisedRun: unknown;
}

/** Exact static projection of one capability for generated references. */
export interface StaticCapabilityFact {
  id: string;
  label: string;
  classification: CapabilityClassification;
  support: CapabilitySupport;
  signature: string | null;
  options: OptionShape | null;
  constraints: readonly string[];
  reference: string | null;
  dynamicReference: DynamicReferenceDescriptor | null;
}

/** Runtime implementations or observed globals used for drift diagnostics. */
export interface AlignmentEvidence {
  suppliedImplementations?: Readonly<Record<string, unknown>>;
  observedProjectGlobals?: readonly string[];
}

/** Validated capability contract with runtime, publication, and alignment projections. */
export interface WorkflowCapabilityContract {
  readonly definition: WorkflowCapabilityDefinition;
  assembleRuntimeBindings(implementations: Readonly<Record<string, unknown>>): RuntimeBindingAssembly;
  projectStaticReferenceFacts(): readonly StaticCapabilityFact[];
  diagnoseAlignment(evidence: AlignmentEvidence): readonly CapabilityDiagnostic[];
}

const REFERENCE_PATH = "skills/workflow-authoring/references/capability-details.md";
const PRESENT_AT: PresentAtVersion = { kind: "present-at", version: packageJson.version };
const noOptions = [] as const;

const option = (
  name: string,
  type: string,
  optional: boolean,
  defaultValue: string | null = null,
  constraints: readonly string[] = noOptions,
  dynamicReference: OptionDescriptor["dynamicReference"] = null,
): OptionDescriptor => ({ name, type, optional, default: defaultValue, constraints, dynamicReference });

/**
 * The closed standard vocabulary the `tier` option's contract declares (PRD
 * Task 3). The runtime ALSO honors user-configured routes from the user's
 * model-tiers.json (the "model-routes" dynamic reference), so this is the
 * contract's standard subset — not a runtime validation gate.
 * `isStandardTierName` is the contract's rejection predicate: a name outside
 * this set is rejected as a STANDARD tier even though the permissive runtime
 * may still resolve it when the user configured that route.
 */
export const STANDARD_TIER_NAMES = ["small", "medium", "big"] as const;

/**
 * Whether a tier name belongs to the contract's closed standard vocabulary.
 * Returns false for invented or typo'd names ("tiny", "smal") — the contract
 * rejects them as standard tiers, so authors must only use names the
 * model-routes dynamic reference (or the context) supplies.
 */
export function isStandardTierName(tier: string): boolean {
  return (STANDARD_TIER_NAMES as readonly string[]).includes(tier);
}

const AGENT_OPTIONS: OptionShape = {
  id: "agent-options",
  options: [
    option("label", "string", true, "derived from phase and call count"),
    option("phase", "string", true, "current phase"),
    option("schema", "plain JSON Schema", true),
    option("model", "string", true, null, ["highest-priority exact model selector"]),
    option(
      "tier",
      '"small" | "medium" | "big"',
      true,
      null,
      [
        "standard vocabulary is the closed union 'small' | 'medium' | 'big'; a user-configured route outside it is honored only when context supplies its name and purpose",
      ],
      "model-routes",
    ),
    option("isolation", '"worktree"', true),
    option("agentType", "string", true, null, ["must come from provided context"], "agent-types"),
    option("toolNames", "string[]", true, "full toolset", [
      "restrict this agent's coding tools to these names; an empty array restricts to the schema/structured_output tool only (auto-added)",
    ]),
    option("timeoutMs", "number | null", true, "run timeout; null disables"),
    option("retries", "number", true, "run retry count", ["finite values are floored and clamped to 0..3"]),
    option("retryOnlyIfSpendUnder", "number", true, "run-level default", [
      "skip auto-retry when the failed attempt's recorded spend exceeds this many tokens; the agent settles exhausted instead",
    ]),
  ],
};
const CHECKPOINT_OPTIONS: OptionShape = {
  id: "checkpoint-options",
  options: [
    option("default", "unknown", true, "true when no UI and omitted"),
    option("headless", '"default" | "abort"', true, '"default"'),
    option("kind", '"confirm" | "input" | "select"', true, '"confirm"'),
    option("choices", "string[]", true),
    option("timeoutMs", "number", true),
  ],
};
const PHASE_OPTIONS: OptionShape = {
  id: "phase-options",
  options: [
    option("budget", "number", true, null, ["positive soft pre-call token gate"]),
    option("stage", "0 | 1 | 2 | 3", true, null, [
      "drives the persisted phase state machine when configured; forward-only (backward declarations fail at the next flush point)",
    ]),
  ],
};
const VERIFY_OPTIONS: OptionShape = {
  id: "verify-options",
  options: [
    option("reviewers", "number", true, "2", ["authors should provide a finite integer; runtime clamps below 1"]),
    option("threshold", "number", true, "0.5"),
    option("lens", "string | string[]", true),
    option("maxChars", "number", true, "4000", [
      "embedded claim payload cap (ellipsis marker + log line when trimmed)",
    ]),
    option("tier", '"small" | "medium" | "big"', true, '"small"', [
      "standard vocabulary is the closed union 'small' | 'medium' | 'big'",
    ]),
    option("distinctModel", "string", true, null, [
      "P09: second-logical-model cross-check spec (provider/modelId); a judge pass on disagreement is pinned to this model",
      "the cross-check is a direct ModelRuntime call outside the run's agent accounting; the judge pass is one agent() call on the distinct model (hashAgentCall model/tierModel fields)",
      "an unavailable second model degrades gracefully to the primary verdict (logged, never silent)",
      "the judge prompt embeds the live cross-check verdict: a resumed run whose re-ask differs re-executes the judge call and everything downstream live (documented first-miss semantics)",
    ]),
  ],
};
const JUDGE_PANEL_OPTIONS: OptionShape = {
  id: "judge-panel-options",
  options: [
    option("judges", "number", true, "3", ["authors should provide a finite integer; runtime clamps below 1"]),
    option("rubric", "string", true, '"overall quality and correctness"'),
    option("distinctModel", "string", true, null, [
      "P09: second-logical-model cross-check of the panel's winning pick (provider/modelId); a top-2 judge pass on disagreement may override the winner",
      "active only when at least two candidates were scored; unavailable second model degrades gracefully to the panel's pick",
    ]),
  ],
};
const LOOP_UNTIL_DRY_OPTIONS: OptionShape = {
  id: "loop-until-dry-options",
  options: [
    option("round", "(roundIndex: number) => unknown[] | Promise<unknown[]>", false),
    option("key", "(item: unknown) => string", true, "JSON.stringify"),
    option("consecutiveEmpty", "number", true, "2", [
      "authors should provide a finite integer; runtime clamps below 1",
    ]),
    option("maxRounds", "number", true, "50", ["authors should provide a finite positive integer"]),
    option("maxRoundCost", "number", true, "no cap", [
      "N03: a zero-new-items round whose recorded spend exceeds the cap terminates the loop costSaturated",
      "round spend is the run-wide shared.spent delta across the awaited round (journaled facts, deterministic)",
      "a round that produced new items never saturates; non-finite values throw a TypeError",
    ]),
  ],
};
/** N05/P12: shared option bag for parallel()/pipeline(). */
const FAN_OUT_OPTIONS: OptionShape = {
  id: "fan-out-options",
  options: [
    option("concurrency", "number", true, "16 (MAX_CONCURRENCY)", [
      "scheduling-only: bounds how many thunks are invoked at once; the run limiter (max 16) still caps real agent parallelism",
      "NEVER part of an agent() call's resume identity — a resumed run replays cached calls identically",
      "finite values are floored; absent/non-finite/below 1 fall back to MAX_CONCURRENCY",
    ]),
    option("autoApproved", "boolean", true, "false", [
      "P12: skips the large fan-out approval gate (TUI pause / headless abort) for deliberate headless automations",
      "small fan-outs (at or under the threshold) never pause regardless of this flag",
    ]),
  ],
};
const RETRY_OPTIONS: OptionShape = {
  id: "retry-options",
  options: [
    option("attempts", "number", true, "3", [
      "authors must provide a finite integer; runtime clamps values below 1 to 1",
    ]),
    option("until", "(result: unknown) => boolean", true, "accept first result when omitted", [
      "must be synchronous; use gate for asynchronous validation",
    ]),
  ],
};
const GATE_OPTIONS: OptionShape = {
  id: "gate-options",
  options: [
    option("attempts", "number", true, "3", [
      "authors must provide a finite integer; runtime clamps values below 1 to 1",
    ]),
  ],
};
const TEST_GATE_OPTIONS: OptionShape = {
  id: "test-gate-options",
  options: [
    option(
      "tests",
      "Array<{ command: string; assert?: { exitCode?: number; outputContains?: string; outputMatches?: string; fileContains?: string } }>",
      false,
      null,
      [
        "required and non-empty: every test runs as one subagent step (bash/grep tool) whose structured capture is machine-validated",
        "assert predicates are machine-checked pure-JS over the captured output, never an LLM verdict; an absent assert defaults to { exitCode: 0 }",
        "fileContains checks the captured output (cat/grep), the vm-safe way to assert file content without host fs access",
        "assert.exitCode requires the bash tool (the grep tool reports matches, not an exit status)",
      ],
    ),
    option("postconditions", "string[]", true, null, [
      "prose descriptions of the required postconditions, embedded into rework feedback",
    ]),
    option("attempts", "number", true, "3", [
      "bounded rework mirroring gate(): authors must provide a finite integer; runtime clamps values below 1 to 1",
    ]),
    option("tool", '"bash" | "grep"', true, '"bash"'),
  ],
};
const CHUNKED_OPTIONS: OptionShape = {
  id: "chunked-options",
  options: [
    option("chunkSize", "number", false, null, ["finite values are floored and clamped to at least 1"]),
    option("mapper", "(chunk: unknown[], chunkIndex: number) => unknown | Promise<unknown>", false),
    option("synthesizer", "(results, meta) => unknown | Promise<unknown>", true),
  ],
};
const ROUTE_OPTIONS: OptionShape = {
  id: "route-options",
  options: [
    option(
      "cases",
      "Array<{ key: string; when?: (value) => boolean | Promise<boolean>; run: (value) => unknown | Promise<unknown> }",
      false,
      null,
      ["keys must be nonblank and unique"],
    ),
    option("fallback", "(value, context) => unknown | Promise<unknown>", false),
  ],
};
const TIMEBOXED_OPTIONS: OptionShape = {
  id: "timeboxed-options",
  options: [option("maxElapsedMs", "number", false, null, ["finite values are floored and clamped to at least 0"])],
};
const CONSENSUS_OPTIONS: OptionShape = {
  id: "consensus-options",
  options: [
    option("panelists", "number", true, "3", ["finite values are floored and clamped to at least 1"]),
    option("rounds", "number", true, "2", ["finite values are floored and clamped to at least 1"]),
    option("agreeThreshold", "number", true, "0.66", ["finite values are clamped to [0, 1]"]),
    option("arbitrator", "(context) => unknown | Promise<unknown>", true),
    option("distinctModel", "string", true, null, [
      "P09: second-logical-model cross-check of the panel's final side (provider/modelId); a judge pass on disagreement adjudicates the split (agreed becomes true with the judge's ruling)",
      "the primary side compared is the agreed verdict, else the arbitrator's boolean ruling, else the last round's majority; no valid votes → no cross-check",
      "unavailable second model degrades gracefully to the panel's outcome (logged)",
    ]),
  ],
};
/** P02: supervisedRun() option bag (run-scoped supervisor). */
const SUPERVISED_RUN_OPTIONS: OptionShape = {
  id: "supervised-run-options",
  options: [
    option("task", "string", false, null, [
      "required; the work to complete (fed to the task agent and every supervisor prompt)",
    ]),
    option("criterion", "string", false, null, [
      "required; the concrete measurable completion criterion the supervisor verifies against",
    ]),
    option("maxRounds", "number", true, "5", [
      "bounded supervisor turns; finite values are floored and clamped to 1..12",
    ]),
    option("taskLabel", "string", true, '"task"'),
    option("taskTier", "string", true, "run default"),
    option("taskPhase", "string", true, "current phase"),
    option("supervisorTier", "string", true, '"small" (economy helper tier)'),
    option("supervisorTools", "string[]", true, "[] (pure-reasoning)", [
      "an empty array restricts the supervisor vote to the schema/structured_output tool only; read-only tools (read/grep) are opt-in",
    ]),
    option("correctionTier", "string", true, "taskTier, else run default"),
  ],
};

interface RuntimeDescriptorOptions {
  signature?: string;
  discovery?: DiscoveryPlacement;
  support?: CapabilitySupport;
  optionShape?: OptionShape["id"];
  constraints?: readonly string[];
  evidence?: readonly string[];
  allowsUndefined?: true;
}

const runtimeGlobal = (name: string, options: RuntimeDescriptorOptions = {}): CapabilityDescriptor => ({
  id: `workflow.runtime.${name}`,
  label: name,
  classification: CapabilityClassification.RUNTIME_GLOBAL,
  support: options.support ?? CapabilitySupport.SUPPORTED,
  discovery: options.discovery ?? DiscoveryPlacement.COMPACT_GUIDANCE,
  origin: CapabilityOrigin.PROJECT,
  lifecycle: PRESENT_AT,
  signature: options.signature ?? name,
  optionShape: options.optionShape ?? null,
  constraints: options.constraints ?? noOptions,
  enforcementOwner: "runWorkflow context assembly",
  runtimeBinding: {
    global: name,
    implementation: name,
    ...(options.allowsUndefined ? { allowsUndefined: true as const } : {}),
  },
  behaviorEvidence: options.evidence ?? ["tests/workflow-runtime.test.ts"],
  staticReference: { path: REFERENCE_PATH, anchor: name.toLowerCase() },
  dynamicReference: null,
});

const toolInput = (
  name: string,
  signature: string,
  constraints: readonly string[] = noOptions,
): CapabilityDescriptor => ({
  id: `workflow.tool-input.${name}`,
  label: name,
  classification: CapabilityClassification.WORKFLOW_TOOL_INPUT,
  support: CapabilitySupport.SUPPORTED,
  discovery: DiscoveryPlacement.COMPACT_GUIDANCE,
  origin: CapabilityOrigin.TOOL_ADAPTER,
  lifecycle: PRESENT_AT,
  signature,
  optionShape: null,
  constraints,
  enforcementOwner: "workflowToolSchema and createWorkflowTool",
  runtimeBinding: null,
  behaviorEvidence: ["tests/workflow-tool.test.ts"],
  staticReference: { path: REFERENCE_PATH, anchor: `tool-input-${name.toLowerCase()}` },
  dynamicReference: null,
});

const capabilities: readonly CapabilityDescriptor[] = [
  runtimeGlobal("agent", {
    signature: "agent(prompt, options?) => Promise<string | structured value | null>",
    optionShape: "agent-options",
    constraints: [
      "recoverable failures return null after retries; nonrecoverable failures throw",
      "schema noncompliance after bounded structured-output repair is nonrecoverable and bypasses agent retries",
      "per-agent retries override invocation retries; retries are floored and clamped to 0..3",
      "resume replays only the longest unchanged prefix; the first miss and every later call execute live",
      "selector priority is explicit model > agentType model > tier > phase model > metadata model > implicit medium > session default",
      "an explicit model, agentType model, tier, or phase model that resolves to an unavailable model throws MODEL_NOT_FOUND naming the source (e.g. the tier and what it resolved to) instead of falling back",
      "only the implicit default medium tier (no explicit model, tier, agentType, or phase model requested) degrades to the session default when unavailable, logging a one-time run-visible warning instead of throwing",
      "worktree isolation is best-effort; failure logs that isolation was ignored and continues without an isolated working directory",
    ],
    evidence: ["tests/workflow-runtime.test.ts", "tests/agent-registry.test.ts", "tests/structured-output.test.ts"],
  }),
  runtimeGlobal("parallel", {
    signature: "parallel(thunks, options?) => Promise<Array<unknown | null>>",
    optionShape: "fan-out-options",
    constraints: [
      "requires functions rather than promises",
      "result order matches input order",
      "recoverable thunk failures become null; nonrecoverable failures throw",
      "concurrency bounds how many thunks are invoked at once (scheduling-only; the run limiter still caps real parallelism) and is NEVER part of any agent() call's resume identity",
      "fan-outs beyond the configured approval threshold pause for human approval (TUI confirm / checkpointGate) or abort headless with WORKFLOW_ABORTED unless autoApproved: true (P12)",
    ],
  }),
  runtimeGlobal("pipeline", {
    signature: "pipeline(items, ...stages[, options]) => Promise<Array<unknown | null>>",
    optionShape: "fan-out-options",
    constraints: [
      "items run concurrently while stages per item run sequentially",
      "each stage receives previousValue, originalItem, and zero-based index",
      "a null stage result is passed to the next stage; authors must guard missing coverage explicitly",
      "recoverable stage failures become null; nonrecoverable failures throw",
      "a trailing plain object is the options bag ({ concurrency, autoApproved }); concurrency is scheduling-only and never part of any agent() call's resume identity",
      "fan-outs beyond the configured approval threshold pause for human approval (TUI confirm / checkpointGate) or abort headless with WORKFLOW_ABORTED unless autoApproved: true (P12)",
    ],
  }),
  runtimeGlobal("subagentTools", {
    signature:
      "subagentTools.search(query?) / describe(name) / select(capability) / capabilities() => capability discovery over the run's captured subagent tool registry",
    constraints: [
      "queries the run's captured registry (host bundle + MCP + captured extension + chrome + damage control) — NOT getAllTools(), which is metadata-only on 0.83.0",
      "select() returns only names the current run's toolset can actually resolve, so agent({ toolNames }) never silently drops a selected tool; non-resolvable registry tools are reported as missing",
      "results are a deterministic pure function of the captured defs + the run's resolved tool names; suppliers materialize lazily once per run frame",
      "settings gates still decide what the run CAN resolve: subagentTools / subagentHostTools / subagentExtensionTools (extension-tools, chrome-tools, mcp-tools toolsets apply per-task)",
    ],
    evidence: [
      "tests/discovery.test.ts",
      "tests/subagent/subagent-tools-assembler.test.ts",
      "tests/workflow-runtime.test.ts",
    ],
  }),
  runtimeGlobal("durableStore", {
    signature:
      "durableStore.get(key) / has(key) / keys() / put(key, value) / putOnce(id, key, value) / compareAndSwap(key, expected, next) / record(entry) / snapshot() => cross-run project-scoped KV + provenance ledger (async writes; await them)",
    constraints: [
      "survives run end/restart: persisted under getAgentDir()/durable-store/<projectKey>.json with atomic write + lock (mesh-lite cross-run memory)",
      "replay-idempotent: put is a no-op on an unchanged value, putOnce dedupes by id, compareAndSwap never re-writes after its original write, record dedupes by id/content — cached-prefix replay leaves the store byte-identical",
      "deterministic timestamps: ledger timestamps are injected (constant epoch + write seq), never the wall clock",
      "NEVER part of an agent() call's resume identity: durableStore is excluded from hashAgentCall by contract",
      "the store is a data plane — script control flow branching on a write result is subject to the same determinism rules as the rest of the script",
    ],
    evidence: ["tests/durable-store.test.ts", "tests/run-report.test.ts"],
  }),
  runtimeGlobal("supervisedRun", {
    signature:
      "supervisedRun({ task, criterion, maxRounds?, taskLabel?, taskTier?, taskPhase?, supervisorTier?, supervisorTools?, correctionTier? }) => Promise<{ result, supervisor: { rounds, declaredDone, termination, finalVerdict, verdicts, corrections, observations } }>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "supervised-run-options",
    constraints: [
      "run-scoped supervisor (P02): after the task agent settles, an ECONOMY supervisor agent (pure-reasoning toolNames:[] + structured verdict schema, tier 'small') checks progress against the concrete measurable completion criterion using the run's own settle events (onAgentStart/onAgentEnd with phase/result/error)",
      "on drift/stall it injects EXACTLY ONE corrective agent per continue-with-correction turn; on a 'done' verdict it declares completion and stops — bounded by maxRounds",
      "every supervisor turn and corrective agent is a journaled POSITIONAL agent() call; the supervisor prompt is a pure function of (task, criterion, deterministic observations), so cached-prefix resume replays every turn identically (RUN RESUME INVARIANT: no new AgentOptions fields, hashAgentCall untouched)",
      "supervisor turns count against the run token budget like any agent(); when the budget is spent the loop stops with termination 'budget-exhausted' (budget knob is read-only, never mutated)",
      "the supervisor prompt embeds only deterministic observation fields (call/label/phase/result/error) — tokens and model labels are recorded but never embedded, so live and replayed settles hash identically",
      "a supervisor vote failing SCHEMA_NONCOMPLIANCE / AGENT_EXECUTION_ERROR degrades to an empty continue round (logged); budget/limit/abort still fail the run",
      "v1 is in-run only: durable cross-process residency would need an RpcClient-spawned pi child (feasibility gap on 0.83.0)",
    ],
    evidence: ["tests/supervisor.test.ts"],
  }),
  runtimeGlobal("workflow", {
    signature: "workflow(savedName, childArgs?) => Promise<unknown>",
    constraints: [
      "one nested level",
      "shares limiter, counters, token accounting, and store",
      "nested workflows do not reuse the parent resume journal",
    ],
    evidence: ["tests/workflow-saved.test.ts", "tests/shared-store.test.ts"],
  }),
  runtimeGlobal("verify", {
    signature:
      "verify(item: unknown, options?: { reviewers?: number; threshold?: number; lens?: string | string[]; maxChars?: number; tier?: string; distinctModel?: string }) => Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real: boolean; reason?: string }>; crossCheck?: { model: string; verdict: boolean; agreement: boolean; judged: boolean; judge?: { verdict: boolean; reason?: string } } }>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "verify-options",
    constraints: [
      "reviewer failures are omitted; successful votes form the denominator in realCount / total",
      "threshold comparison is inclusive and real is false when no reviewer succeeds",
      "multiple lenses cycle across reviewers",
      "distinctModel cross-checks the primary verdict on a SECOND logical model: the cross-check is a direct ModelRuntime call outside the run's agent accounting (no agent slot, no token charge — the economy-tier primary votes are never double-charged), and on disagreement a judge pass (one agent() call pinned to the distinct model) adjudicates — its verdict becomes real and crossCheck.judged is true",
      "an unavailable second model degrades gracefully to the primary verdict with a logged skip (never silent), and the crossCheck block is absent entirely",
      "the judge pass carries the distinct model in its resume identity (hashAgentCall model/tierModel fields); its prompt embeds the live cross-check verdict, so a resumed run whose re-ask differs re-executes the judge call and everything downstream live (documented first-miss semantics)",
    ],
    evidence: ["tests/quality-stdlib.test.ts", "tests/slices/helpers/model-crosscheck.test.ts"],
  }),
  runtimeGlobal("judgePanel", {
    signature:
      "judgePanel(attempts: unknown[], options?: { judges?: number; rubric?: string; distinctModel?: string }) => Promise<{ index: number; attempt: unknown; score: number; judgments: Array<{ score: number; reason?: string }>; crossCheck?: { model: string; verdict: boolean; agreement: boolean; judged: boolean; judge?: { verdict: boolean; reason?: string } } } | undefined>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "judge-panel-options",
    constraints: [
      "failed judgments are omitted and each candidate score averages successful judgments only",
      "a candidate with no successful judgments scores 0",
      "highest mean score wins with stable input index as the tie-break; empty input returns undefined",
      "distinctModel cross-checks the panel's winning pick on a second logical model (direct ModelRuntime call, outside the run's accounting) and, on disagreement, a top-2 judge pass on the distinct model may override the winner (crossCheck.judged true; judge.verdict false means the alternative won)",
      "active only when at least two candidates were scored; an unavailable second model degrades gracefully to the panel's pick",
    ],
    evidence: ["tests/quality-stdlib.test.ts", "tests/slices/helpers/model-crosscheck.test.ts"],
  }),
  runtimeGlobal("gate", {
    signature:
      "gate(thunk: (feedback: string | undefined, attempt: number) => unknown | Promise<unknown>, validator: (value: unknown) => { ok: boolean; feedback?: string } | Promise<{ ok: boolean; feedback?: string }>, options?: { attempts?: number }) => Promise<{ ok: boolean; value: unknown; attempts: number }>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "gate-options",
    constraints: [
      "feedback is undefined on the first thunk call and then receives the previous validator feedback string",
      "attempt is zero-based for the thunk while the returned attempts count is one-based",
      "a value is accepted when the validator returns an object with a truthy ok property; a bare boolean is not accepted",
      "exhaustion returns ok false with the last value and the bounded attempts count",
      "authors must supply a finite attempts bound when overriding the default",
    ],
    evidence: ["tests/quality-stdlib.test.ts"],
  }),
  runtimeGlobal("testGate", {
    signature:
      "testGate(thunk: (feedback: string | undefined, attempt: number) => unknown | Promise<unknown>, options: { tests: Array<{ command: string; assert?: { exitCode?: number; outputContains?: string; outputMatches?: string; fileContains?: string } }>; postconditions?: string[]; attempts?: number; tool?: 'bash' | 'grep' }) => Promise<{ ok: boolean; value: unknown; attempts: number; tests: Array<{ command: string; passed: boolean; detail: string; exitCode: number | null; output: string }> }>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "test-gate-options",
    constraints: [
      "machine-checked postcondition gate: each test runs as a SUBAGENT STEP (agent({ toolNames: ['bash'] | ['grep'], schema })) whose structured capture is machine-validated by pure-JS predicates — acceptance is evidence-backed machine-validated subagent evidence, never an LLM verdict",
      "the vm context injects no host fs/exec, so machine postconditions cannot run host-side from a vm global; file content is asserted through the captured command output (cat/grep), the vm-safe mechanism",
      "feedback is undefined on the first thunk call and then receives the previous attempt's machine failure details plus the postconditions prose; every failure is logged (never silent)",
      "exhaustion fails CLOSED with ok false and the captured per-test evidence (exitCode/output/detail); an absent assert defaults to { exitCode: 0 }",
      "tests are required and non-empty; malformed commands/asserts throw a TypeError (loud script bug, never silent)",
      "resume-safe: every test is a real agent() call under a stable callSeq whose toolNames + schema are hashAgentCall fields, so completed attempts replay from the journal like gate()'s",
    ],
    evidence: ["tests/slices/helpers/test-gate.test.ts"],
  }),
  runtimeGlobal("loopUntilDry", {
    signature:
      'loopUntilDry(options: { round: (roundIndex: number) => unknown[] | Promise<unknown[]>; key?: (item: unknown) => string; consecutiveEmpty?: number; maxRounds?: number; maxRoundCost?: number }) => Promise<{ items: unknown[]; termination: "dry" | "maxRounds" | "capacity" | "failed" | "costSaturated"; failedRounds: number }>',
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "loop-until-dry-options",
    constraints: [
      "roundIndex is zero-based; only a successful round that yields no fresh items counts as dry",
      'a round returning null/undefined is a FAILED round (termination: "failed", failedRounds incremented), never dry',
      'token-budget or agent-limit capacity exhaustion returns the accumulated partial items with termination: "capacity"',
      'a zero-new-items round whose recorded spend (the run-wide shared.spent delta across the awaited round) exceeds maxRoundCost terminates with "costSaturated" instead of grinding to maxRounds/consecutiveEmpty',
      "the result reports its termination reason (dry | maxRounds | capacity | failed | costSaturated) and the failed-round count",
      "non-finite maxRounds/consecutiveEmpty/maxRoundCost throw a TypeError; finite values are floored and clamped to at least 1",
      "maxRoundCost is loop control only — NEVER part of any agent() call's resume identity (replayed rounds bill zero spend, the same replay-is-free divergence the run budget documents)",
    ],
    evidence: ["tests/quality-stdlib.test.ts", "tests/slices/runtime/w1-fanout-concurrency-approval.test.ts"],
  }),
  runtimeGlobal("completenessCheck", {
    signature:
      "completenessCheck(taskArgs: unknown, results: unknown) => Promise<{ complete: boolean; missing?: string[] } | null>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    constraints: [
      "only the first 4,000 characters of serialized result evidence are sent to the critic",
      "missing is optional and recoverable critic failure returns null",
      "large evidence sets must be chunked or summarized before relying on the advisory verdict",
    ],
    evidence: ["tests/quality-stdlib.test.ts"],
  }),
  runtimeGlobal("chunked", {
    signature:
      "chunked(items: unknown[], options: { chunkSize: number; mapper: (chunk: unknown[], chunkIndex: number) => unknown | Promise<unknown>; synthesizer?: (results: Array<unknown | null>, meta: { failed: Array<{ index: number; chunk: unknown[] }>; chunkCount: number; items: unknown[] }) => unknown | Promise<unknown> }) => Promise<{ results: Array<unknown | null>; failed: Array<{ index: number; chunk: unknown[] }>; chunkCount: number } | unknown>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "chunked-options",
    constraints: [
      "chunk boundaries depend only on item order and chunkSize, so agent() calls inside mapper keep stable resume hashes when the prompt embeds chunk content + chunkIndex",
      "a recoverable-null chunk result stays null in results and is recorded in failed with its stable index and chunk",
      "non-recoverable failures (token budget, agent limit, abort) and plain mapper errors rethrow",
      "with synthesizer the helper returns the synthesizer output; else it returns { results, failed, chunkCount }",
    ],
    evidence: ["tests/slices/helpers/chunked.test.ts"],
  }),
  runtimeGlobal("route", {
    signature:
      'route(value: unknown, options: { cases: Array<{ key: string; when?: (value: unknown) => boolean | Promise<boolean>; run: (value: unknown) => unknown | Promise<unknown> }>; fallback: (value: unknown, context: { reason: "no-eligible-case" | "classification-failed" | "unknown"; classification: string | null }) => unknown | Promise<unknown> }) => Promise<{ key: string | null; result: unknown; fallback: boolean; reason: "none" | "no-eligible-case" | "classification-failed" | "unknown" }>',
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "route-options",
    constraints: [
      "one schema'd classification agent picks among the enum of eligible case keys; the classification prompt embeds the value and the eligible key list, so the resume hash is stable per value + case list",
      "a case whose when(value) guard fails never reaches the classification enum; when no case is eligible the fallback runs with reason no-eligible-case and no agent() is called",
      "a recoverable-null classification routes to fallback with reason classification-failed; an out-of-enum key routes to fallback with reason unknown",
      "the matched case's run(value) executes in pure JavaScript and may call agent()",
      "budget, agent-limit, and abort failures rethrow",
    ],
    evidence: ["tests/slices/helpers/route.test.ts"],
  }),
  runtimeGlobal("timeboxed", {
    signature:
      "timeboxed(fn: (context: { elapsed(): number; remaining(): number; expired(): boolean }) => unknown | Promise<unknown>, options: { maxElapsedMs: number }) => Promise<{ result: unknown; timedOut: boolean; elapsedMs: number; maxElapsedMs: number }>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "timeboxed-options",
    constraints: [
      "cooperative: fn must check context.expired()/remaining() at its own decision points and return early with partial results; timeboxed never interrupts a running fn",
      "after fn settles, timedOut reports whether the deadline was exceeded",
      "elapsedMs() and context.elapsed() are wall-clock values that must NEVER appear in prompts or hashes — use an args-seeded counter instead (the determinism prelude blocks clocks; a resumed run replays cached calls fast and observes different elapsed values)",
      "non-finite maxElapsedMs throws a TypeError; finite values are floored and clamped to at least 0",
    ],
    evidence: ["tests/slices/helpers/timeboxed.test.ts"],
  }),
  runtimeGlobal("elapsedMs", {
    signature: "elapsedMs() => number",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    constraints: [
      "monotonic non-negative milliseconds since the top-level run start, shared across nested workflow() frames",
      "NEVER inside prompts or hashes: wall-clock values are not resume-stable; use a counter seeded from args",
    ],
    evidence: ["tests/slices/helpers/timeboxed.test.ts"],
  }),
  runtimeGlobal("ctx", {
    signature: "ctx(sharedText: string | unknown) => string",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    constraints: [
      "registers sharedText ONCE per run (written to the run's shared store) and returns a compact pointer to embed in agent() prompts instead of re-embedding the full text into every fan-out call",
      "repeated ctx() with the same text returns the same pointer without re-storing — one blob per run (dedupe guarantee)",
      "the full blob text is emitted into the FIRST agent's instructions once per run; every later agent gets a store-key note — agents whose prompts reference a pointer can read the text with store_get (injected into every agent)",
      "the blob fingerprint is a resume-hash identity input: editing the shared text invalidates cached replays of calls downstream of the ctx() registration",
      "empty/absent text returns '' (no-op); non-string values are JSON-stringified; an oversized blob or the distinct-blob cap degrades to returning the raw text",
    ],
    evidence: ["tests/slices/runtime/shared-context.test.ts"],
  }),
  runtimeGlobal("consensus", {
    signature:
      "consensus(question: string, options?: { panelists?: number; rounds?: number; agreeThreshold?: number; arbitrator?: (context: { question: string; votes: Array<{ verdict: boolean; reasoning?: string } | null>; rounds: number }) => unknown | Promise<unknown> }) => Promise<{ agreed: boolean; verdict: boolean | null; count: number; total: number; votes: Array<{ verdict: boolean; reasoning?: string } | null>; rounds: number; omitted: number; arbitration?: unknown }>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "consensus-options",
    constraints: [
      "each round polls panelists independently with a structured verdict schema; per-vote recoverable nulls are omitted and shrink the denominator (logged)",
      "the pairwise agreement gate passes when the largest mutually-agreeing group covers at least agreeThreshold of valid votes",
      "rounds are bounded; after the budget an optional arbitrator (typically one structured agent() call) decides, else the disagreement is returned with agreed false",
      "non-finite panelists/rounds throw a TypeError; finite values are floored and clamped to at least 1; agreeThreshold is clamped to [0, 1]",
    ],
    evidence: ["tests/slices/helpers/consensus.test.ts"],
  }),
  runtimeGlobal("retry", {
    signature:
      "retry(thunk: (attempt: number) => unknown | Promise<unknown>, options?: { attempts?: number; until?: (result: unknown) => boolean }) => Promise<unknown>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "retry-options",
    constraints: [
      "attempt is zero-based and attempts counts total thunk calls",
      "until is synchronous; returning a Promise is truthy and accepts the first result",
      "omitting until accepts the first result regardless of attempts",
      "stops when until(result) is true; exhaustion returns only the last result without attempt metadata",
      "authors must supply a finite attempts bound when overriding the default",
    ],
    evidence: ["tests/quality-stdlib.test.ts"],
  }),
  runtimeGlobal("checkpoint", {
    signature: "checkpoint(prompt, options?) => Promise<unknown>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "checkpoint-options",
    constraints: [
      "foreground confirm, headless behavior, and the visual approve/deny gate (checkpointGate) are implemented",
      "input/select resolve through the visual gate's approve/deny verdict when a gate is configured, else they take the declared default headless",
      "consumes one agent slot and no tokens",
      "journaled answers replay only within an unchanged resume prefix",
    ],
    evidence: ["tests/checkpoint.test.ts"],
  }),
  runtimeGlobal("log", { signature: "log(message) => void" }),
  runtimeGlobal("phase", {
    signature: "phase(title, options?) => void",
    optionShape: "phase-options",
    constraints: ["phase budgets are soft pre-call gates"],
  }),
  runtimeGlobal("args", { signature: "args: unknown", allowsUndefined: true }),
  runtimeGlobal("cwd", { signature: "cwd: string" }),
  runtimeGlobal("process", { signature: "process: { cwd(): string }" }),
  runtimeGlobal("budget", {
    signature: "budget: { total, spent(), remaining(), wouldExceed(estimatedTokens) }",
    constraints: [
      "frozen view over shared soft token accounting",
      "spend accrues after agents finish, so in-flight work can overshoot",
      "nested workflows share the same accounting",
      "wouldExceed(estimatedTokens) is advisory: true when the estimated extra spend would trip the ceiling — use it to gate cheap/optional work before spawning agents",
    ],
  }),
  runtimeGlobal("console", {
    signature: "console: { log, info, warn, error }",
    support: CapabilitySupport.COMPATIBILITY,
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    constraints: ["new workflows should use log()"],
  }),
  toolInput("script", "script?: string", [
    "required raw JavaScript workflow source unless `name` or `scriptPath` is given",
  ]),
  toolInput("scriptPath", "scriptPath?: string", [
    "path to a file whose content is used exactly as if passed inline as `script`",
    "resolved against the workflow tool's cwd when not absolute",
    "read by the extension process (not the script runtime), so authoring to a file avoids inline quote/backtick escaping",
    "mutually exclusive with `script` and `name`",
  ]),
  toolInput("name", "name?: string", [
    "resolves a project/user saved workflow first, then one of the 10 built-in patterns",
    "mutually exclusive with resumeFromRunId",
  ]),
  toolInput("args", "args?: unknown"),
  toolInput("background", "background?: boolean = true", [
    "background workflows are headless; use background false when checkpoint must show foreground confirmation",
  ]),
  toolInput("maxAgents", "maxAgents?: number = 1000", ["default, not a hard product maximum"]),
  toolInput("concurrency", "concurrency?: number", ["runtime clamps to 1..16"]),
  toolInput("agentRetries", "agentRetries?: number = configured value or 0", [
    "floored and clamped to 0..3",
    "a subagent that still fails after retries is exhausted",
  ]),
  toolInput("retryOnlyIfSpendUnder", "retryOnlyIfSpendUnder?: number", [
    "run-level default for the per-agent retry spend guard: skip auto-retry when the failed attempt already burned more than this many tokens",
    "skipped retries settle the agent exhausted (AGENT_EXHAUSTED) exactly like retry exhaustion — failOnExhaustedAgent semantics unchanged",
    "opt-in; absent preserves current retry behavior",
  ]),
  toolInput("agentTimeoutMs", "agentTimeoutMs?: number = configured default or unbounded"),
  toolInput("failOnExhaustedAgent", "failOnExhaustedAgent?: boolean = true", [
    "strict completion: an exhausted subagent (retries exhausted, context-window overflow) settles the run FAILED",
    "a failed run is resumable via resumeFromRunId; completed agents replay from cache, only the failed call re-runs",
    "false = best-effort: the run completes and reports failed agents in the result instead of failing",
  ]),
  toolInput("tokenBudget", "tokenBudget?: number = configured default or unlimited", [
    "soft pre-call gate; in-flight work can overshoot",
  ]),
  toolInput("resumeFromRunId", "resumeFromRunId?: string", [
    "resumes a prior incomplete run with an edited script",
    "unchanged positional agent calls replay from cache until the first changed or inserted call",
    "always runs in the background",
    "use for any failed or paused run (retries exhausted, context overflow, provider limit) — never start a new run to recover",
  ]),
  toolInput("dryRun", "dryRun?: boolean = false", [
    "validates the script or named workflow without launching a run",
    "parses and checks the script, then returns its meta with no subagents launched",
    "mutually exclusive with resumeFromRunId",
  ]),
  {
    id: "workflow.script.metadata",
    label: "export const meta",
    classification: CapabilityClassification.SCRIPT_CONTRACT,
    support: CapabilitySupport.SUPPORTED,
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    origin: CapabilityOrigin.PROJECT,
    lifecycle: PRESENT_AT,
    signature:
      'export const meta = { name: string, description: string, phases?: Array<{ title: string; detail?: string; model?: string }>, gate?: "approve", model?: string }',
    optionShape: null,
    constraints: [
      "must be the first statement",
      "name and description must be nonblank strings",
      "metadata must use literal values; expressions such as string concatenation and template interpolation are rejected",
      'meta.gate: "approve" publishes the plan to the plannotator bridge and pauses the run for a human verdict before any agent work (the shipped plan-then-execute builtin declares it)',
      "the meta declaration is the only legal export because the remaining body executes inside an async function",
    ],
    enforcementOwner: "parseWorkflowScript",
    runtimeBinding: null,
    behaviorEvidence: ["tests/workflow-parser.test.ts"],
    staticReference: { path: REFERENCE_PATH, anchor: "metadata" },
    dynamicReference: null,
  },
  {
    id: "workflow.script.return-value",
    label: "workflow return value",
    classification: CapabilityClassification.SCRIPT_CONTRACT,
    support: CapabilitySupport.SUPPORTED,
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    origin: CapabilityOrigin.PROJECT,
    lifecycle: PRESENT_AT,
    signature: "return JSON-serializable data",
    optionShape: null,
    constraints: ["do not return functions, promises, cyclic objects, BigInt, or runtime handles"],
    enforcementOwner: "workflow tool result boundary",
    runtimeBinding: null,
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-tool.test.ts"],
    staticReference: { path: REFERENCE_PATH, anchor: "return-value" },
    dynamicReference: null,
  },
  {
    id: "workflow.script.determinism",
    label: "deterministic script execution",
    classification: CapabilityClassification.SCRIPT_CONTRACT,
    support: CapabilitySupport.SUPPORTED,
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    origin: CapabilityOrigin.PROJECT,
    lifecycle: PRESENT_AT,
    signature: null,
    optionShape: null,
    constraints: [
      "Date.now(), Math.random(), and no-argument new Date() are unavailable",
      "pass timestamps and randomness through args",
    ],
    enforcementOwner: "parseWorkflowScript and VM determinism prelude",
    runtimeBinding: null,
    behaviorEvidence: ["tests/workflow-parser.test.ts", "tests/workflow-runtime.test.ts"],
    staticReference: { path: REFERENCE_PATH, anchor: "determinism" },
    dynamicReference: null,
  },
  {
    id: "workflow.compat.markdown-fences",
    label: "whole-script Markdown fence stripping",
    classification: CapabilityClassification.COMPATIBILITY_BEHAVIOR,
    support: CapabilitySupport.COMPATIBILITY,
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    origin: CapabilityOrigin.TOOL_ADAPTER,
    lifecycle: PRESENT_AT,
    signature: null,
    optionShape: null,
    constraints: ["accepted for compatibility but not recommended"],
    enforcementOwner: "normalizeWorkflowScript",
    runtimeBinding: null,
    behaviorEvidence: ["tests/workflow-tool.test.ts"],
    staticReference: { path: REFERENCE_PATH, anchor: "compatibility" },
    dynamicReference: null,
  },
  {
    id: "workflow.vm.realm-substrate",
    label: "VM realm JavaScript substrate",
    classification: CapabilityClassification.INTERNAL_SUBSTRATE,
    support: CapabilitySupport.INTERNAL,
    discovery: DiscoveryPlacement.NONE,
    origin: CapabilityOrigin.VM_REALM,
    lifecycle: PRESENT_AT,
    signature: null,
    optionShape: null,
    constraints: ["Node-version-dependent globals are not project-owned workflow API", "VM is not a security sandbox"],
    enforcementOwner: "node:vm",
    runtimeBinding: null,
    behaviorEvidence: ["tests/workflow-runtime.test.ts"],
    staticReference: null,
    dynamicReference: null,
  },
  {
    id: "workflow.dynamic.model-routes",
    label: "model routes",
    classification: CapabilityClassification.DYNAMIC_REFERENCE,
    support: CapabilitySupport.SUPPORTED,
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    origin: CapabilityOrigin.LIVE_CONFIGURATION,
    lifecycle: PRESENT_AT,
    signature: null,
    optionShape: null,
    constraints: ["live values must not be copied into static contract data"],
    enforcementOwner: "model-tier-config",
    runtimeBinding: null,
    behaviorEvidence: ["tests/workflows-models-command.test.ts"],
    staticReference: { path: REFERENCE_PATH, anchor: "model-routes" },
    dynamicReference: "model-routes",
  },
  {
    id: "workflow.dynamic.agent-types",
    label: "agent types",
    classification: CapabilityClassification.DYNAMIC_REFERENCE,
    support: CapabilitySupport.SUPPORTED,
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    origin: CapabilityOrigin.LIVE_CONFIGURATION,
    lifecycle: PRESENT_AT,
    signature: null,
    optionShape: null,
    constraints: ["live values must not be copied into static contract data"],
    enforcementOwner: "agent-registry",
    runtimeBinding: null,
    behaviorEvidence: ["tests/agent-registry.test.ts"],
    staticReference: { path: REFERENCE_PATH, anchor: "agent-types" },
    dynamicReference: "agent-types",
  },
];

/** Authoritative versioned inventory used by runtime assembly and every static projection. */
export const WORKFLOW_CAPABILITY_DEFINITION: WorkflowCapabilityDefinition = {
  versions: {
    extension: packageJson.version,
    format: { kind: "present-at", version: "1.0.0" },
    content: PRESENT_AT,
  },
  optionShapes: [
    AGENT_OPTIONS,
    CHECKPOINT_OPTIONS,
    PHASE_OPTIONS,
    VERIFY_OPTIONS,
    JUDGE_PANEL_OPTIONS,
    LOOP_UNTIL_DRY_OPTIONS,
    FAN_OUT_OPTIONS,
    RETRY_OPTIONS,
    GATE_OPTIONS,
    TEST_GATE_OPTIONS,
    CHUNKED_OPTIONS,
    ROUTE_OPTIONS,
    TIMEBOXED_OPTIONS,
    CONSENSUS_OPTIONS,
    SUPERVISED_RUN_OPTIONS,
  ],
  capabilities,
  dynamicReferences: [
    {
      id: "model-routes",
      owner: "model-tier-config",
      itemShape: "{ name: string; description?: string }",
      connection: "loadModelTierConfig",
    },
    {
      id: "agent-types",
      owner: "agent-registry",
      itemShape: "{ name: string; description?: string }",
      connection: "loadAgentRegistry",
    },
  ],
};

/** Validate and freeze a definition, throwing with diagnostics when its identities or references conflict. */
export function defineWorkflowCapabilityContract(definition: WorkflowCapabilityDefinition): WorkflowCapabilityContract {
  deepFreeze(definition);
  const definitionDiagnostics = validateDefinition(definition);
  if (definitionDiagnostics.length > 0) {
    throw new WorkflowCapabilityContractError("invalid workflow capability definition", definitionDiagnostics);
  }

  const optionShapes = new Map(definition.optionShapes.map((shape) => [shape.id, shape]));
  const dynamicReferences = new Map(definition.dynamicReferences.map((reference) => [reference.id, reference]));
  const bindings = definition.capabilities.flatMap((capability) =>
    capability.runtimeBinding ? [{ ...capability.runtimeBinding }] : [],
  );
  const implementations = new Set(bindings.map((binding) => binding.implementation));
  const globals = new Set(bindings.map((binding) => binding.global));

  const diagnoseAlignment = (evidence: AlignmentEvidence): readonly CapabilityDiagnostic[] => {
    const diagnostics: CapabilityDiagnostic[] = [];
    if (evidence.suppliedImplementations) {
      for (const binding of bindings) {
        if (
          !Object.hasOwn(evidence.suppliedImplementations, binding.implementation) ||
          (evidence.suppliedImplementations[binding.implementation] === undefined && !binding.allowsUndefined)
        ) {
          diagnostics.push({
            code: "MISSING_RUNTIME_IMPLEMENTATION",
            severity: DiagnosticSeverity.ERROR,
            subject: binding.implementation,
            message: `Declared workflow global "${binding.global}" has no supplied implementation "${binding.implementation}".`,
          });
        }
      }
      for (const name of Object.keys(evidence.suppliedImplementations)) {
        if (!implementations.has(name)) {
          diagnostics.push({
            code: "UNDECLARED_RUNTIME_IMPLEMENTATION",
            severity: DiagnosticSeverity.WARNING,
            subject: name,
            message: `Supplied runtime implementation "${name}" is undeclared and was ignored.`,
          });
        }
      }
    }
    if (evidence.observedProjectGlobals) {
      const observed = new Set(evidence.observedProjectGlobals);
      for (const name of globals) {
        if (!observed.has(name)) {
          diagnostics.push({
            code: "DECLARED_GLOBAL_UNOBSERVED",
            severity: DiagnosticSeverity.ERROR,
            subject: name,
            message: `Declared workflow global "${name}" was not observed in the assembled context.`,
          });
        }
      }
      for (const name of observed) {
        if (!globals.has(name)) {
          diagnostics.push({
            code: "OBSERVED_GLOBAL_UNDECLARED",
            severity: DiagnosticSeverity.ERROR,
            subject: name,
            message: `Observed project-owned workflow global "${name}" is undeclared.`,
          });
        }
      }
    }
    return diagnostics;
  };

  return {
    definition,
    assembleRuntimeBindings(supplied) {
      const diagnostics = diagnoseAlignment({ suppliedImplementations: supplied });
      const missing = diagnostics.filter((diagnostic) => diagnostic.code === "MISSING_RUNTIME_IMPLEMENTATION");
      if (missing.length > 0) {
        throw new WorkflowCapabilityContractError(
          `missing declared runtime implementation: ${missing.map((diagnostic) => diagnostic.subject).join(", ")}`,
          diagnostics,
        );
      }
      const assembled: Record<string, unknown> = {};
      for (const binding of bindings) assembled[binding.global] = supplied[binding.implementation];
      return { globals: assembled, diagnostics };
    },
    projectStaticReferenceFacts() {
      return definition.capabilities
        .filter((capability) => capability.staticReference !== null)
        .map((capability) => ({
          id: capability.id,
          label: capability.label,
          classification: capability.classification,
          support: capability.support,
          signature: capability.signature,
          options: capability.optionShape ? (optionShapes.get(capability.optionShape) ?? null) : null,
          constraints: capability.constraints,
          reference: capability.staticReference
            ? `${capability.staticReference.path}#${capability.staticReference.anchor}`
            : null,
          dynamicReference: capability.dynamicReference
            ? (dynamicReferences.get(capability.dynamicReference) ?? null)
            : null,
        }));
    },
    diagnoseAlignment,
  };
}

function validateDefinition(definition: WorkflowCapabilityDefinition): CapabilityDiagnostic[] {
  const diagnostics: CapabilityDiagnostic[] = [];
  const ids = new Set<string>();
  const globals = new Set<string>();
  const runtimeImplementations = new Set<string>();
  const optionShapes = new Set<string>();
  const dynamicReferences = new Set<string>();
  const invalid = (subject: string, message: string) =>
    diagnostics.push({ code: "INVALID_CAPABILITY_DEFINITION", severity: DiagnosticSeverity.ERROR, subject, message });
  for (const shape of definition.optionShapes) {
    if (optionShapes.has(shape.id)) invalid(shape.id, `Duplicate option shape "${shape.id}".`);
    optionShapes.add(shape.id);
  }
  for (const reference of definition.dynamicReferences) {
    if (dynamicReferences.has(reference.id)) invalid(reference.id, `Duplicate dynamic reference "${reference.id}".`);
    dynamicReferences.add(reference.id);
  }
  for (const capability of definition.capabilities) {
    if (ids.has(capability.id)) invalid(capability.id, `Duplicate capability id "${capability.id}".`);
    ids.add(capability.id);
    if (capability.classification === CapabilityClassification.RUNTIME_GLOBAL && !capability.runtimeBinding) {
      invalid(capability.id, "Runtime-global capabilities require a runtime binding.");
    }
    if (capability.runtimeBinding) {
      if (globals.has(capability.runtimeBinding.global)) {
        invalid(capability.runtimeBinding.global, `Duplicate runtime global "${capability.runtimeBinding.global}".`);
      }
      globals.add(capability.runtimeBinding.global);
      if (runtimeImplementations.has(capability.runtimeBinding.implementation)) {
        invalid(
          capability.runtimeBinding.implementation,
          `Duplicate runtime implementation identity "${capability.runtimeBinding.implementation}".`,
        );
      }
      runtimeImplementations.add(capability.runtimeBinding.implementation);
      if (
        capability.classification !== CapabilityClassification.RUNTIME_GLOBAL ||
        capability.origin !== CapabilityOrigin.PROJECT
      ) {
        invalid(capability.id, "Runtime bindings require runtime-global classification and project origin.");
      }
    }
    if (capability.optionShape && !optionShapes.has(capability.optionShape)) {
      invalid(capability.id, `Unknown option shape "${capability.optionShape}".`);
    }
    if (capability.dynamicReference && !dynamicReferences.has(capability.dynamicReference)) {
      invalid(capability.id, `Unknown dynamic reference "${capability.dynamicReference}".`);
    }
  }
  return diagnostics;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** Installed validated workflow capability contract. */
export const WORKFLOW_CAPABILITY_CONTRACT = defineWorkflowCapabilityContract(WORKFLOW_CAPABILITY_DEFINITION);
