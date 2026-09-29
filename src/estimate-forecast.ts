/**
 * V2-N4: pre-flight cost & duration forecast (`workflow --estimate`).
 *
 * A read-only AST scan of a workflow script + the shipped segment-aware
 * estimator (estimateTokens) → a forecast of agent count, phase durations,
 * token spend range, and worst-case fan-out — BEFORE anything launches.
 *
 * Contract (roadmap-v2.md V2-N4 + slice H3):
 *  - PURE and side-effect free: parses the script text, walks the
 *    agent()/parallel()/pipeline()/chunked()/loopUntilDry()/recursive()/
 *    checkpoint()/phase() call graph, and returns a structured preview. No
 *    execution, no subagents, no fs writes, no manager activity — the script
 *    is never evaluated in a vm.
 *  - NEVER part of any agent() resume identity: the forecast is pre-flight
 *    display only, exactly like the dryRun surface it extends. Nothing here
 *    touches hashAgentCall's field set.
 *  - Best-effort, documented: static prompts are measured with the same
 *    estimateTokens the runtime's estimate-only accounting path uses; dynamic
 *    prompts (interpolation, unresolvable identifiers) and dynamic fan-out
 *    sizes are reported as warnings and bounded by the run's maxAgents in the
 *    worst case. The reply side is an assumption (replyTokensPerAgent) — the
 *    estimator is a per-value estimator, so no static scan can see a reply.
 *  - Deterministic: no wall-clock timestamps, no RNG — the duration forecast
 *    is a pure model (tokens ÷ tokensPerSecond + per-agent overhead), not a
 *    stopwatch.
 *
 * The CLI surface lives in extensions/workflow.ts (`workflow_estimate` tool);
 * this module owns the pure engine + the human-line renderer so both are
 * unit-testable without a live manager.
 */

import type { Node } from "acorn";
import { parse } from "acorn";
import {
  DEFAULT_RECURSIVE_DEPTH,
  DEFAULT_RECURSIVE_MAX_ROOTS,
  ESTIMATE_AGENT_OVERHEAD_MS_DEFAULT,
  ESTIMATE_REPLY_TOKENS_PER_AGENT_DEFAULT,
  ESTIMATE_TIER_COST_WEIGHTS,
  ESTIMATE_TOKENS_PER_SECOND_DEFAULT,
  ESTIMATE_WARNING_BUDGET_FRACTION,
  MAX_AGENTS_PER_RUN,
  MAX_CONCURRENCY,
  MAX_RECURSIVE_DEPTH,
  MODEL_PRICE_BOOK,
  type ModelPriceUsd,
  modelPriceForEstimate,
  resolveModelPrice,
} from "./config.js";
import { evaluateSpendQuote, type SpendQuoteOptions } from "./spend-quote.js";
import { estimateTokens, parseWorkflowScript, type WorkflowMeta } from "./workflow.js";

/** Every agent-spawning / gating runtime global the scan recognizes. */
export type EstimateCallKind =
  | "agent"
  | "parallel"
  | "pipeline"
  | "chunked"
  | "loopUntilDry"
  | "recursive"
  | "checkpoint"
  | "workflow";

/** One (possibly nested) call site discovered by the scan. */
export interface EstimateCallRecord {
  kind: EstimateCallKind;
  /** 1-based line in the ORIGINAL script (the line the call appears on). */
  line: number;
  /** Attributed phase: explicit agent `phase` option, else the enclosing phase(). */
  phase?: string;
  /** Statically-visible agent label / model / tier (agent calls only). */
  label?: string;
  model?: string;
  tier?: string;
  /** Statically-visible prompt text (undefined when unresolvable). */
  promptText?: string;
  /** Chars of the statically-visible prompt text (agents/checkpoints only). */
  promptChars?: number;
  /** estimateTokens of the statically-visible prompt text (agents/checkpoints only). */
  promptTokens?: number;
  /** False when the prompt could not be statically resolved (agents/checkpoints only). */
  promptKnown?: boolean;
  /** Fan-out item count when statically visible (parallel/pipeline/chunked/recursive root). */
  size?: number;
  /** True when the fan-out size (or a loop bound) is not statically visible. */
  dynamicSize?: boolean;
  /** loopUntilDry round bound / recursive depth & width bounds when statically visible. */
  maxRounds?: number;
  maxDepth?: number;
  maxRoots?: number;
  /** Effective fan-out concurrency (default MAX_CONCURRENCY). */
  concurrency: number;
  /** Statically-visible agent count this subtree contributes (min). */
  agentCount: number;
  /** Worst-case agent count this subtree contributes (dynamic sites bounded by maxAgents). */
  worstCaseAgentCount: number;
  /** Prompt-token estimate this subtree contributes (min). */
  promptTokensSubtotal: number;
  /** Reply-token assumption this subtree contributes (min). */
  replyTokensSubtotal: number;
  /** prompt + reply estimate this subtree contributes (min). */
  totalTokensSubtotal: number;
  /** Duration forecast this subtree contributes (min; pure model, not wall clock). */
  durationMs: number;
  /** Worst-case duration forecast this subtree contributes. */
  worstCaseDurationMs: number;
  /** Recursive sub-forecasts (nested workflow() scripts). */
  nested?: WorkflowEstimate[];
}

/** One fan-out site, flattened for the CLI "Fan-outs:" section. */
export interface EstimateFanOutRow {
  kind: EstimateCallKind;
  line: number;
  size: number | "dynamic";
  maxRounds?: number;
  maxDepth?: number;
  maxRoots?: number;
  concurrency: number;
  agentCount: number;
  worstCaseAgentCount: number;
}

/** Per-phase aggregate row (phases from meta.phases, phase() calls, or agent phases). */
export interface EstimatePhaseRow {
  title: string;
  agentCount: number;
  worstCaseAgentCount: number;
  promptTokens: number;
  replyTokens: number;
  totalTokens: number;
  durationMs: number;
}

/** The full pre-flight forecast for one script. */
export interface WorkflowEstimate {
  /** Script name (meta.name). */
  name: string;
  description: string;
  model?: string;
  /** meta.gate === "approve" — the run pauses for human approval before the body. */
  gate?: "approve";
  /** Declared meta phases (titles, declaration order). */
  metaPhases: string[];
  /** Phases observed in the body via phase() (titles, first-observed order). */
  runtimePhases: string[];
  /** Statically-visible minimum agent count. */
  agentCount: number;
  /** Worst-case agent count (loops at maxRounds, recursive at maxRoots^maxDepth, dynamic sites bounded by maxAgents). */
  worstCaseAgentCount: number;
  promptTokens: number;
  replyTokens: number;
  totalTokens: number;
  worstCaseTotalTokens: number;
  /** Tier-weighted cost proxy (relative, no USD): Σ agent tokens × tier weight. */
  costWeightedTokens: number;
  /**
   * MEASURED USD range quoted from the price book (spend governance): the
   * minimum-case and worst-case dollar figures for the forecast's token
   * counts at the per-model input/output prices. Computed alongside
   * costWeightedTokens — the legacy relative proxy stays, the USD quote is
   * the real-price surface. Best-effort: unpriced models quote at the
   * default reference price and are listed in unpricedModels.
   */
  usdMin: number;
  usdWorstCase: number;
  /**
   * Spend-quote surface (slice C): the resolved ceiling the worst case is
   * compared against, the verdict, and its reason. null ceiling / "off"
   * verdict = gate disabled (current behavior).
   */
  spendCeilingUsd: number | null;
  quoteVerdict: "off" | "ok" | "warn" | "refuse";
  quoteReason?: string;
  /** Distinct model specs seen in the scan with no price-book entry (quoted at the default reference price). */
  unpricedModels: string[];
  durationMs: number;
  worstCaseDurationMs: number;
  /** Human checkpoint() calls discovered (each also carries its prompt-token estimate). */
  checkpoints: number;
  checkpointTokens: number;
  /** maxAgents bound used for dynamic worst cases. */
  maxAgents: number;
  /** Fan-out call sites, flattened in source order. */
  fanOuts: EstimateFanOutRow[];
  /** Per-phase aggregates, meta-declared order first, then observed order. */
  phases: EstimatePhaseRow[];
  /** Dynamic / unresolvable sites — the best-effort documentation surface. */
  warnings: string[];
  /** tokenBudget passed in (null = none configured). */
  budget: number | null;
  /** totalTokens > budget. */
  exceedsBudget: boolean;
  /** budget set and totalTokens >= budget × ESTIMATE_WARNING_BUDGET_FRACTION (and <= budget). */
  nearBudget: boolean;
  /** Top-level call records (subtree order), for structured consumers. */
  calls: EstimateCallRecord[];
}

/** Forecast-model knobs. Every field optional; defaults come from config.ts. */
export interface EstimateOptions {
  /** Optional token budget the forecast is compared against (warn/flag). */
  tokenBudget?: number | null;
  /** Reply-token assumption per agent (default ESTIMATE_REPLY_TOKENS_PER_AGENT_DEFAULT). */
  replyTokensPerAgent?: number;
  /** Effective tokens/second for the duration model (default ESTIMATE_TOKENS_PER_SECOND_DEFAULT). */
  tokensPerSecond?: number;
  /** Fixed per-agent overhead ms in the duration model (default ESTIMATE_AGENT_OVERHEAD_MS_DEFAULT). */
  agentOverheadMs?: number;
  /** Default fan-out concurrency when a fan-out carries none (default MAX_CONCURRENCY). */
  defaultConcurrency?: number;
  /** Worst-case bound for dynamic fan-out sizes (default MAX_AGENTS_PER_RUN). */
  maxAgents?: number;
  /** Relative tier cost weights (default ESTIMATE_TIER_COST_WEIGHTS). */
  tierCostWeights?: Readonly<Record<string, number>>;
  /**
   * Context-cost (T2-B1): fixed per-agent incoming-context tokens (system
   * prefix + skill stubs + tool defs) that the prompt-token scan cannot see.
   * Default 0 = the pre-existing estimate exactly (pure prompt + reply). The
   * scoped-context wiring passes the measured per-agent prefix so the forecast
   * reflects the default-on savings (a scoped run passes the small scoped
   * prefix, a full-skills run the ~3.5 ktok prefix). Never part of any resume
   * identity — read-only pre-flight display, like the whole forecast.
   */
  perAgentFixedContextTokens?: number;
  /**
   * Measured per-model price book (default MODEL_PRICE_BOOK). The USD range
   * (usdMin/usdWorstCase) and the spend quote are computed from it — the
   * assumed relative weights are only the legacy costWeightedTokens proxy.
   */
  priceBook?: Readonly<Record<string, ModelPriceUsd>>;
  /**
   * Spend-governance knobs (quote-before-spend): base budget threshold (USD),
   * the run's quoted value (USD, wins over budget × tau), the tau multiplier
   * (0/null = gate disabled), and the gate mode. They resolve into
   * spendCeilingUsd + quoteVerdict/quoteReason on the estimate.
   */
  spendBudgetUsd?: number | null;
  quotedValueUsd?: number | null;
  spendTau?: number | null;
  spendQuoteGate?: "warn" | "refuse" | "off";
}

// ── internal AST model ────────────────────────────────────────────────────────

type AnyNode = Node & { [key: string]: any; start: number; end: number };

const UNRESOLVED = Symbol("estimate-unresolved");
type StaticValue = string | number | boolean | null | undefined | StaticValue[] | { [key: string]: StaticValue };

interface StaticEnv {
  bindings: Map<string, StaticValue>;
  /** name → function node, for call-site macro expansion of local helpers. */
  functions: Map<string, AnyNode>;
  /** names currently being macro-expanded (mutual-recursion guard). */
  expanding: Set<string>;
}

/** Mutable scan context threaded through the walk. */
interface ScanCtx {
  /** Current phase from the nearest preceding phase() call. */
  phase: string | undefined;
  /** Static multiplicity product of enclosing statically-visible fan-outs. */
  multi: number;
  /** Worst-case multiplicity product (dynamic sites multiply by maxAgents). */
  worstMulti: number;
  /** True when any enclosing multiplicity is dynamic. */
  dynamic: boolean;
  /** Effective concurrency of the nearest enclosing fan-out (duration model). */
  concurrency: number;
  /** maxAgents bound for dynamic worst cases (run ceiling). */
  maxAgents: number;
  /** Nesting depth of workflow() macro expansions (runaway guard). */
  nestedDepth: number;
}

interface CallNode {
  kind: EstimateCallKind;
  line: number;
  phase?: string;
  label?: string;
  model?: string;
  tier?: string;
  promptText?: string;
  /** Chars of the statically-visible prompt text (agents/checkpoints only). */
  promptChars?: number;
  /** estimateTokens of the statically-visible prompt text (agents/checkpoints only). */
  promptTokens?: number;
  /** False when the prompt could not be statically resolved (agents/checkpoints only). */
  promptKnown?: boolean;
  size?: number;
  dynamicSize?: boolean;
  maxRounds?: number;
  maxDepth?: number;
  maxRoots?: number;
  /** Static chunk size for chunked() (drives the static chunk count). */
  chunkSize?: number;
  concurrency: number;
  /** Static multiplicity of THIS node's own executions (excluding enclosing fan-outs). */
  multi: number;
  /** Worst-case multiplicity of THIS node's own executions. */
  worstMulti: number;
  /**
   * Fan-out child semantics: true = children are ONE item's work executed
   * `size` times (map callbacks, pipeline stages, loop rounds); false =
   * children ARE the full item list (parallel([thunk1, thunk2, ...])).
   */
  template?: boolean;
  children: CallNode[];
  /** Nested workflow() sub-forecasts (each already a full WorkflowEstimate). */
  nested?: WorkflowEstimate[];
}

interface FoldEnv {
  replyTokensPerAgent: number;
  tokensPerSecond: number;
  agentOverheadMs: number;
  maxAgents: number;
  tierCostWeights: Readonly<Record<string, number>>;
  /** Measured per-model price book for the USD quote. */
  priceBook: Readonly<Record<string, ModelPriceUsd>>;
  /** Context-cost: fixed per-agent incoming-context tokens (default 0). */
  perAgentFixedContextTokens: number;
}

interface PhaseAgg {
  agents: number;
  worstAgents: number;
  promptTokens: number;
  replyTokens: number;
  totalTokens: number;
  worstTotalTokens: number;
  durationMs: number;
}

interface Agg {
  agents: number;
  worstAgents: number;
  promptTokens: number;
  worstPromptTokens: number;
  replyTokens: number;
  worstReplyTokens: number;
  costWeightedTokens: number;
  /** Measured USD (min case / worst case) from the price book. */
  usdMin: number;
  usdWorstCase: number;
  durationMs: number;
  worstDurationMs: number;
  checkpoints: number;
  checkpointTokens: number;
  phases: Map<string, PhaseAgg>;
}

// ── static resolution helpers ─────────────────────────────────────────────────

/** Resolve an expression to a fully-static value, or UNRESOLVED. */
function resolveStatic(node: AnyNode | null | undefined, env: StaticEnv): StaticValue | typeof UNRESOLVED {
  if (!node) return UNRESOLVED;
  switch (node.type) {
    case "Literal":
      return node.value as StaticValue;
    case "TemplateLiteral": {
      if (node.expressions.length > 0) return UNRESOLVED;
      const quasis = node.quasis as AnyNode[];
      return quasis.map((q: AnyNode) => q.value.cooked ?? q.value.raw).join("");
    }
    case "Identifier": {
      const bound = env.bindings.get(node.name);
      return bound === undefined ? UNRESOLVED : bound;
    }
    case "ArrayExpression": {
      const out: StaticValue[] = [];
      for (const element of node.elements as Array<AnyNode | null>) {
        if (!element || element.type === "SpreadElement") return UNRESOLVED;
        const value = resolveStatic(element, env);
        if (value === UNRESOLVED) return UNRESOLVED;
        out.push(value);
      }
      return out;
    }
    case "ObjectExpression": {
      const out: Record<string, StaticValue> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement" || prop.type !== "Property" || prop.computed) return UNRESOLVED;
        const key = propKey(prop.key as AnyNode);
        if (key === undefined) return UNRESOLVED;
        const value = resolveStatic(prop.value as AnyNode, env);
        if (value === UNRESOLVED) return UNRESOLVED;
        out[key] = value;
      }
      return out;
    }
    case "UnaryExpression": {
      if (node.operator === "-") {
        const arg = resolveStatic(node.argument as AnyNode, env);
        if (arg === UNRESOLVED || typeof arg !== "number") return UNRESOLVED;
        return -arg;
      }
      return UNRESOLVED;
    }
    case "BinaryExpression": {
      if (node.operator === "+") {
        const left = resolveStatic(node.left as AnyNode, env);
        if (left === UNRESOLVED) return UNRESOLVED;
        const right = resolveStatic(node.right as AnyNode, env);
        if (right === UNRESOLVED) return UNRESOLVED;
        if (typeof left === "number" && typeof right === "number") return left + right;
        if (typeof left === "string" || typeof right === "string") return String(left) + String(right);
        return UNRESOLVED;
      }
      return UNRESOLVED;
    }
    case "MemberExpression": {
      if (memberProp(node) === "length") {
        const obj = resolveStatic(node.object as AnyNode, env);
        if (obj !== UNRESOLVED && Array.isArray(obj)) return obj.length;
      }
      return UNRESOLVED;
    }
    case "ParenthesizedExpression":
      return resolveStatic(node.expression as AnyNode, env);
    default:
      return UNRESOLVED;
  }
}

function propKey(node: AnyNode): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  return undefined;
}

function memberProp(node: AnyNode): string | undefined {
  const prop = node.property as AnyNode;
  if (prop.type === "Identifier") return prop.name;
  if (prop.type === "Literal" && typeof prop.value === "string") return prop.value;
  return undefined;
}

/** Static array length of an expression, when resolvable. */
function staticArrayLength(node: AnyNode | null | undefined, env: StaticEnv): number | undefined {
  const value = resolveStatic(node, env);
  if (value !== UNRESOLVED && Array.isArray(value)) return value.length;
  return undefined;
}

/** Best-effort prompt text: quasis joined / left-static concat; `static` false when dynamic parts were omitted. */
function resolvePrompt(node: AnyNode | null | undefined, env: StaticEnv): { text: string; static: boolean } {
  if (!node) return { text: "", static: false };
  switch (node.type) {
    case "Literal":
      if (typeof node.value === "string") return { text: node.value, static: true };
      if (node.value !== null && node.value !== undefined) return { text: String(node.value), static: true };
      return { text: "", static: false };
    case "TemplateLiteral": {
      const quasis = node.quasis as AnyNode[];
      const text = quasis.map((q: AnyNode) => q.value.cooked ?? q.value.raw).join("");
      return { text, static: node.expressions.length === 0 };
    }
    case "BinaryExpression": {
      if (node.operator !== "+") return { text: "", static: false };
      const left = resolvePrompt(node.left as AnyNode, env);
      const rightStatic = resolveStatic(node.right as AnyNode, env);
      if (left.static && rightStatic !== UNRESOLVED) return { text: left.text + String(rightStatic), static: true };
      return { text: left.text, static: false };
    }
    case "Identifier": {
      const bound = env.bindings.get(node.name);
      if (bound !== undefined && typeof bound === "string") return { text: bound, static: true };
      return { text: "", static: false };
    }
    case "ParenthesizedExpression":
      return resolvePrompt(node.expression as AnyNode, env);
    default:
      return { text: "", static: false };
  }
}

// ── scan: AST walk ────────────────────────────────────────────────────────────

/** The runtime combinators this scan recognizes (workflow() is handled separately). */
const COMBINATOR_CALLS = new Set(["parallel", "pipeline", "chunked", "loopUntilDry", "recursive"]);
/** Array iteration methods whose callback runs once per statically-visible item. */
const ITERATION_METHODS = new Set(["map", "forEach", "filter", "flatMap", "some", "every"]);
/** loopUntilDry's runtime default round bound (workflow.ts normalizeBoundedCount(opts.maxRounds, 50, ...)). */
const LOOP_UNTIL_DRY_DEFAULT_MAX_ROUNDS = 50;

function callName(node: AnyNode): string | undefined {
  const callee = node.callee as AnyNode | undefined;
  if (callee?.type === "Identifier") return callee.name;
  return undefined;
}

/**
 * Scan one script body (meta already stripped — parseWorkflowScript's body) for
 * runtime-combinator call sites. PURE: reads only the AST, mutates only the
 * local env/ctx/out. Writes nothing, executes nothing.
 */
function scanScript(
  body: string,
  bodyLineToScriptLine: number[],
  opts: EstimateOptions,
  env: StaticEnv,
  ctx: ScanCtx,
  out: CallNode[],
  runtimePhases: string[],
): void {
  const ast = parse(body, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    locations: true,
  }) as AnyNode;

  const registerFunction = (name: string, node: AnyNode): void => {
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionExpression"
    ) {
      env.functions.set(name, node);
    }
  };

  const lineOf = (node: AnyNode): number => {
    const bodyLine = node.loc?.start?.line ?? 0;
    if (bodyLine < 1 || bodyLine >= bodyLineToScriptLine.length) return bodyLine;
    return bodyLineToScriptLine[bodyLine] ?? bodyLine;
  };

  /** Scan an arrow/function BODY into `target` with an optional ctx override. */
  const scanFunctionBodyInto = (fn: AnyNode, target: CallNode[], override?: Partial<ScanCtx>): void => {
    const savedCtx = ctx;
    const savedOut = out;
    if (override) ctx = { ...ctx, ...override };
    out = target;
    const body = fn.body as AnyNode;
    if (body.type === "BlockStatement") {
      for (const inner of body.body as AnyNode[]) scanStatement(inner);
    } else {
      scanExpr(body);
    }
    out = savedOut;
    ctx = savedCtx;
  };

  const scanStatement = (stmt: AnyNode): void => {
    if (!stmt) return;
    switch (stmt.type) {
      case "VariableDeclaration":
        for (const decl of stmt.declarations as AnyNode[]) {
          const id = decl.id as AnyNode;
          let registeredFunction = false;
          if (id?.type === "Identifier" && decl.init) {
            const value = resolveStatic(decl.init, env);
            if (value !== UNRESOLVED) env.bindings.set(id.name, value);
            if (decl.init.type === "ArrowFunctionExpression" || decl.init.type === "FunctionExpression") {
              registerFunction(id.name, decl.init);
              registeredFunction = true;
            }
          }
          // A helper function's BODY is scanned at its call sites (macro
          // expansion), never here — scanning it as a definition would double
          // count every agent() call inside it.
          if (decl.init && !registeredFunction) scanExpr(decl.init);
        }
        break;
      case "ExpressionStatement":
        scanExpr(stmt.expression);
        break;
      case "ReturnStatement":
        if (stmt.argument) scanExpr(stmt.argument);
        break;
      case "IfStatement":
        scanExpr(stmt.test);
        scanStatement(stmt.consequent);
        scanStatement(stmt.alternate);
        break;
      case "BlockStatement":
        for (const inner of stmt.body as AnyNode[]) scanStatement(inner);
        break;
      case "TryStatement":
        scanStatement(stmt.block);
        if (stmt.handler?.body) scanStatement(stmt.handler.body);
        break;
      case "ForStatement":
        if (stmt.test) scanExpr(stmt.test);
        if (stmt.update) scanExpr(stmt.update);
        scanStatement(stmt.body);
        break;
      case "ForInStatement":
      case "ForOfStatement": {
        // A for-of over a statically-sized array runs its body once per item.
        if (stmt.type === "ForOfStatement") {
          const length = staticArrayLength(stmt.right, env);
          const savedCtx = ctx;
          if (length !== undefined) {
            ctx = { ...ctx, multi: ctx.multi * length, worstMulti: ctx.worstMulti * length };
          } else {
            ctx = { ...ctx, multi: ctx.multi * 1, worstMulti: ctx.worstMulti * ctx.maxAgents, dynamic: true };
          }
          scanStatement(stmt.body);
          ctx = savedCtx;
        } else {
          scanStatement(stmt.body);
        }
        break;
      }
      case "WhileStatement":
      case "DoWhileStatement":
        scanStatement(stmt.body);
        break;
      case "SwitchStatement":
        scanExpr(stmt.discriminant);
        for (const caseNode of stmt.cases as AnyNode[]) {
          if (caseNode.test) scanExpr(caseNode.test);
          for (const inner of caseNode.consequent as AnyNode[]) scanStatement(inner);
        }
        break;
      case "ThrowStatement":
        if (stmt.argument) scanExpr(stmt.argument);
        break;
      case "FunctionDeclaration":
        if (stmt.id?.name) registerFunction(stmt.id.name, stmt);
        break;
      default:
        break;
    }
  };

  /** Resolve an options-object literal (undefined for non-object arguments). */
  const optionObject = (node: AnyNode | null | undefined): Record<string, AnyNode> => {
    if (node?.type !== "ObjectExpression") return {};
    const out: Record<string, AnyNode> = {};
    for (const prop of node.properties as AnyNode[]) {
      if (prop.type !== "Property" || prop.computed) continue;
      const key = propKey(prop.key as AnyNode);
      if (key !== undefined) out[key] = prop.value as AnyNode;
    }
    return out;
  };

  const optionNumber = (options: Record<string, AnyNode>, key: string): number | undefined => {
    const value = resolveStatic(options[key], env);
    return value !== UNRESOLVED && typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };

  const optionString = (options: Record<string, AnyNode>, key: string): string | undefined => {
    const value = resolveStatic(options[key], env);
    return value !== UNRESOLVED && typeof value === "string" ? value : undefined;
  };

  /**
   * Handle a combinator call. `size` is the statically-visible item count
   * (undefined = dynamic); `perItem` carries one item's subtree (the thunk
   * bodies / the mapped callback body).
   */
  const fanOutShape = (arg: AnyNode): { size?: number; perItem: CallNode[]; template: boolean } => {
    const perItem: CallNode[] = [];
    // parallel(items.map(item => async () => ...)) — the mapped callback is
    // ONE item's thunk template; the receiver's static length is the item count.
    if (arg.type === "CallExpression" && arg.callee?.type === "MemberExpression") {
      const method = memberProp(arg.callee as AnyNode);
      if (method !== undefined && ITERATION_METHODS.has(method)) {
        const length = staticArrayLength(arg.callee?.object, env);
        const callback = (arg.arguments?.[0] as AnyNode | undefined) ?? arg.callee?.arguments?.[0];
        if (callback) scanFunctionBodyInto(callback, perItem);
        return { size: length, perItem, template: true };
      }
    }
    // parallel([thunk1, thunk2, ...]) — each element IS one item; the element
    // COUNT is statically visible even though the thunk bodies are not static
    // values (a spread element makes the count unknowable).
    if (arg.type === "ArrayExpression") {
      const elements = arg.elements as Array<AnyNode | null>;
      const size = elements.some((el) => el === null || el.type === "SpreadElement") ? undefined : elements.length;
      for (const element of elements) {
        if (!element) continue;
        if (element.type === "ArrowFunctionExpression" || element.type === "FunctionExpression") {
          scanFunctionBodyInto(element, perItem);
        } else if (element.type === "Identifier" && env.functions.has(element.name)) {
          // A named helper used as a thunk: expand its body as one item.
          scanFunctionBodyInto(env.functions.get(element.name) as AnyNode, perItem);
        } else {
          scanExpr(element);
        }
      }
      return { size, perItem, template: false };
    }
    // Unresolvable receiver: scan its expression for per-item work (template
    // semantics — the work it holds executes once per item; size unknown →
    // dynamic).
    const size = staticArrayLength(arg, env);
    if (arg.type !== "Identifier") {
      const savedOut = out;
      out = perItem;
      scanExpr(arg);
      out = savedOut;
    } else {
      scanExpr(arg);
    }
    return { size, perItem, template: true };
  };

  const scanExpr = (expr: AnyNode): void => {
    if (!expr) return;
    switch (expr.type) {
      case "CallExpression": {
        const name = callName(expr);
        const args = (expr.arguments as AnyNode[]) ?? [];
        if (name === "agent") {
          const prompt = resolvePrompt(args[0], env);
          const optsObj = optionObject(args[1]);
          emit({
            kind: "agent",
            line: lineOf(expr),
            phase: optionString(optsObj, "phase") ?? ctx.phase,
            label: optionString(optsObj, "label"),
            model: optionString(optsObj, "model"),
            tier: optionString(optsObj, "tier"),
            promptText: prompt.static ? prompt.text : undefined,
            promptChars: prompt.text.length,
            promptTokens: estimateTokens(prompt.text),
            promptKnown: prompt.static,
            concurrency: ctx.concurrency,
            multi: ctx.multi,
            worstMulti: ctx.worstMulti,
            children: [],
          });
          return;
        }
        if (name === "checkpoint") {
          const prompt = resolvePrompt(args[0], env);
          emit({
            kind: "checkpoint",
            line: lineOf(expr),
            phase: ctx.phase,
            promptText: prompt.static ? prompt.text : undefined,
            promptChars: prompt.text.length,
            promptTokens: estimateTokens(prompt.text),
            promptKnown: prompt.static,
            concurrency: ctx.concurrency,
            multi: ctx.multi,
            worstMulti: ctx.worstMulti,
            children: [],
          });
          return;
        }
        if (name === "phase") {
          const title = resolveStatic(args[0], env);
          if (title !== UNRESOLVED && typeof title === "string") {
            ctx.phase = title;
            if (!runtimePhases.includes(title)) runtimePhases.push(title);
          }
          return;
        }
        if (name === "workflow") {
          const nestedScript = resolveStatic(args[0], env);
          if (nestedScript !== UNRESOLVED && typeof nestedScript === "string" && ctx.nestedDepth < 4) {
            const nestedCalls: CallNode[] = [];
            const nestedPhases: string[] = [];
            let nestedEstimate: WorkflowEstimate | undefined;
            const nestedCtx: ScanCtx = { ...ctx, nestedDepth: ctx.nestedDepth + 1 };
            try {
              const parsed = parseWorkflowScript(nestedScript);
              scanScript(parsed.body, parsed.bodyLineToScriptLine, opts, env, nestedCtx, nestedCalls, nestedPhases);
              for (const p of nestedPhases) if (!runtimePhases.includes(p)) runtimePhases.push(p);
              nestedEstimate = buildEstimate(parsed.meta, nestedPhases, nestedCalls, opts);
            } catch {
              // Unparseable nested script — the dynamic warning below covers it.
            }
            emit({
              kind: "workflow",
              line: lineOf(expr),
              phase: ctx.phase,
              concurrency: ctx.concurrency,
              multi: 1,
              worstMulti: 1,
              children: [],
              ...(nestedEstimate !== undefined ? { nested: [nestedEstimate] } : {}),
              ...(nestedEstimate === undefined ? { dynamicSize: true } : {}),
            });
          } else {
            // Dynamic or too-deep nested workflow(): an unbounded dynamic site.
            emit({
              kind: "workflow",
              line: lineOf(expr),
              phase: ctx.phase,
              concurrency: ctx.concurrency,
              multi: 1,
              worstMulti: 1,
              dynamicSize: true,
              children: [],
            });
          }
          return;
        }
        if (name !== undefined && COMBINATOR_CALLS.has(name)) {
          const node = combinatorNode(expr, name);
          if (node) return;
        }
        // A call to a locally-defined helper → macro-expand its body at this
        // call site (inherits the call site's multiplicity context). Guarded
        // against mutual recursion (a helper that calls itself/its sibling
        // expands once, then stops).
        if (expr.callee?.type === "Identifier") {
          const helper = env.functions.get(expr.callee.name);
          if (helper && !env.expanding.has(expr.callee.name)) {
            for (const arg of args) scanExpr(arg);
            env.expanding.add(expr.callee.name);
            try {
              scanFunctionBodyInto(helper, out);
            } finally {
              env.expanding.delete(expr.callee.name);
            }
            return;
          }
        }
        // Iteration methods on statically-sized arrays: the callback runs once
        // per item (map/filter/... produce a dynamic multiplicity when the
        // receiver size is unknown).
        if (expr.callee?.type === "MemberExpression") {
          const method = memberProp(expr.callee as AnyNode);
          if (method !== undefined && ITERATION_METHODS.has(method)) {
            const length = staticArrayLength(expr.callee?.object, env);
            const callback = (args[0] as AnyNode | undefined) ?? expr.callee?.arguments?.[0];
            if (callback && (callback.type === "ArrowFunctionExpression" || callback.type === "FunctionExpression")) {
              const override: Partial<ScanCtx> =
                length !== undefined
                  ? { multi: ctx.multi * length, worstMulti: ctx.worstMulti * length }
                  : { multi: ctx.multi * 1, worstMulti: ctx.worstMulti * ctx.maxAgents, dynamic: true };
              scanFunctionBodyInto(callback, out, override);
              return;
            }
          }
        }
        // Otherwise recurse into callee + arguments (nested calls).
        scanExpr(expr.callee as AnyNode);
        for (const arg of args) scanExpr(arg);
        return;
      }
      case "ArrowFunctionExpression":
      case "FunctionExpression": {
        // A standalone callback not tied to a fan-out/iteration: its agent()
        // calls run at least once (min), unbounded in the worst case.
        scanFunctionBodyInto(expr, out, {
          multi: ctx.multi * 1,
          worstMulti: ctx.worstMulti * ctx.maxAgents,
          dynamic: true,
        });
        return;
      }
      case "ObjectExpression":
        for (const prop of expr.properties as AnyNode[]) {
          if (prop.type === "SpreadElement") continue;
          if (prop.type === "Property") scanExpr(prop.value as AnyNode);
        }
        return;
      case "ArrayExpression":
        for (const element of expr.elements as Array<AnyNode | null>) {
          if (element) scanExpr(element);
        }
        return;
      case "TemplateLiteral":
        for (const interpolation of expr.expressions as AnyNode[]) scanExpr(interpolation);
        return;
      case "BinaryExpression":
      case "LogicalExpression":
        scanExpr(expr.left as AnyNode);
        scanExpr(expr.right as AnyNode);
        return;
      case "AssignmentExpression":
        scanExpr(expr.right as AnyNode);
        return;
      case "ConditionalExpression":
        scanExpr(expr.test as AnyNode);
        scanExpr(expr.consequent as AnyNode);
        scanExpr(expr.alternate as AnyNode);
        return;
      case "UnaryExpression":
        scanExpr(expr.argument as AnyNode);
        return;
      case "MemberExpression":
        scanExpr(expr.object as AnyNode);
        return;
      case "SequenceExpression":
        for (const inner of expr.expressions as AnyNode[]) scanExpr(inner);
        return;
      case "AwaitExpression":
        scanExpr(expr.argument as AnyNode);
        return;
      case "TaggedTemplateExpression":
        scanExpr(expr.tag as AnyNode);
        for (const interpolation of expr.quasi?.expressions ?? []) scanExpr(interpolation as AnyNode);
        return;
      case "YieldExpression":
        if (expr.argument) scanExpr(expr.argument);
        return;
      case "SpreadElement":
        scanExpr(expr.argument as AnyNode);
        return;
      default:
        return;
    }
  };

  const emit = (node: CallNode): void => {
    out.push(node);
  };

  /** Build one combinator call node (parallel/pipeline/chunked/loopUntilDry/recursive). */
  const combinatorNode = (expr: AnyNode, name: string): CallNode | undefined => {
    const args = (expr.arguments as AnyNode[]) ?? [];
    const line = lineOf(expr);
    const options = optionObject(args[args.length - 1] as AnyNode);
    const concurrency = optionNumber(options, "concurrency") ?? ctx.concurrency;

    const base = (kind: EstimateCallKind, extra: Partial<CallNode>): CallNode => ({
      kind,
      line,
      phase: ctx.phase,
      concurrency,
      multi: 1,
      worstMulti: 1,
      children: [],
      ...extra,
    });

    switch (name) {
      case "parallel": {
        const array = args[0] as AnyNode | undefined;
        if (!array) return undefined;
        const { size, perItem, template } = fanOutShape(array);
        const node = base("parallel", {
          size,
          ...(size === undefined ? { dynamicSize: true } : {}),
          template,
          children: perItem,
        });
        emit(node);
        return node;
      }
      case "pipeline": {
        const array = args[0] as AnyNode | undefined;
        if (!array) return undefined;
        const { size, perItem } = fanOutShape(array);
        // Stages run SEQUENTIALLY per item — fold them into the per-item template.
        const stageNodes: CallNode[] = [];
        for (const stage of args.slice(1) as AnyNode[]) {
          if (!stage) continue;
          if (stage.type === "ArrowFunctionExpression" || stage.type === "FunctionExpression") {
            scanFunctionBodyInto(stage, stageNodes);
          }
        }
        const node = base("pipeline", {
          size,
          ...(size === undefined ? { dynamicSize: true } : {}),
          // Pipeline items are data; the stages ARE the per-item work (template
          // semantics — one template executed `size` times).
          template: true,
          children: [...perItem, ...stageNodes],
        });
        emit(node);
        return node;
      }
      case "chunked": {
        const array = args[0] as AnyNode | undefined;
        const optsObj = optionObject(args[1] as AnyNode);
        const itemCount = staticArrayLength(array, env);
        const chunkSizeValue = optionNumber(optsObj, "chunkSize");
        const mapper = optsObj.mapper;
        const perChunk: CallNode[] = [];
        if (mapper && (mapper.type === "ArrowFunctionExpression" || mapper.type === "FunctionExpression")) {
          scanFunctionBodyInto(mapper, perChunk);
        }
        // The synthesizer runs ONCE after all chunks — scan it as a sibling so
        // it is not multiplied by the chunk count.
        const synthesizer = optsObj.synthesizer;
        if (
          synthesizer &&
          (synthesizer.type === "ArrowFunctionExpression" || synthesizer.type === "FunctionExpression")
        ) {
          scanFunctionBodyInto(synthesizer, out);
        }
        const node = base("chunked", {
          size: itemCount,
          ...(itemCount === undefined || chunkSizeValue === undefined ? { dynamicSize: true } : {}),
          ...(chunkSizeValue !== undefined ? { chunkSize: chunkSizeValue } : {}),
          template: true,
          children: perChunk,
        });
        emit(node);
        return node;
      }
      case "loopUntilDry": {
        const optsObj = optionObject(args[0] as AnyNode);
        const round = optsObj.round;
        const perRound: CallNode[] = [];
        if (round && (round.type === "ArrowFunctionExpression" || round.type === "FunctionExpression")) {
          scanFunctionBodyInto(round, perRound);
        }
        // The runtime defaults maxRounds to 50 (a static bound); an explicit
        // but unresolvable option (e.g. maxRounds: args.limit) is dynamic.
        const maxRoundsValue = optionNumber(optsObj, "maxRounds");
        const maxRounds =
          maxRoundsValue !== undefined && maxRoundsValue >= 1
            ? Math.floor(maxRoundsValue)
            : LOOP_UNTIL_DRY_DEFAULT_MAX_ROUNDS;
        const dynamic = optsObj.maxRounds !== undefined && maxRoundsValue === undefined;
        const node = base("loopUntilDry", {
          maxRounds,
          ...(dynamic ? { dynamicSize: true } : {}),
          template: true,
          children: perRound,
        });
        emit(node);
        return node;
      }
      case "recursive": {
        const array = args[0] as AnyNode | undefined;
        const optsObj = optionObject(args[1] as AnyNode);
        const solve = optsObj.solve;
        const perSolve: CallNode[] = [];
        if (solve && (solve.type === "ArrowFunctionExpression" || solve.type === "FunctionExpression")) {
          scanFunctionBodyInto(solve, perSolve);
        }
        // merge runs once per BRANCH (not per leaf) — scan as a sibling;
        // branch count is unknowable statically, so it contributes a single
        // best-effort occurrence.
        const merge = optsObj.merge;
        if (merge && (merge.type === "ArrowFunctionExpression" || merge.type === "FunctionExpression")) {
          scanFunctionBodyInto(merge, out);
        }
        const maxDepthValue = optionNumber(optsObj, "maxDepth");
        const maxDepth =
          maxDepthValue !== undefined && maxDepthValue >= 1
            ? Math.min(Math.floor(maxDepthValue), MAX_RECURSIVE_DEPTH)
            : DEFAULT_RECURSIVE_DEPTH;
        const maxRootsValue = optionNumber(optsObj, "maxRecursiveRoots");
        const maxRoots =
          maxRootsValue !== undefined && maxRootsValue >= 1 ? Math.floor(maxRootsValue) : DEFAULT_RECURSIVE_MAX_ROOTS;
        const itemCount = staticArrayLength(array, env);
        const node = base("recursive", {
          size: itemCount,
          ...(itemCount === undefined ? { dynamicSize: true } : {}),
          maxDepth,
          maxRoots,
          template: true,
          children: perSolve,
        });
        emit(node);
        return node;
      }
      default:
        return undefined;
    }
  };

  for (const stmt of ast.body as AnyNode[]) scanStatement(stmt);
}

// ── fold: bottom-up aggregation ───────────────────────────────────────────────

function emptyPhaseAgg(): PhaseAgg {
  return {
    agents: 0,
    worstAgents: 0,
    promptTokens: 0,
    replyTokens: 0,
    totalTokens: 0,
    worstTotalTokens: 0,
    durationMs: 0,
  };
}

function emptyAgg(): Agg {
  return {
    agents: 0,
    worstAgents: 0,
    promptTokens: 0,
    worstPromptTokens: 0,
    replyTokens: 0,
    worstReplyTokens: 0,
    costWeightedTokens: 0,
    usdMin: 0,
    usdWorstCase: 0,
    durationMs: 0,
    worstDurationMs: 0,
    checkpoints: 0,
    checkpointTokens: 0,
    phases: new Map(),
  };
}

function mergeAgg(target: Agg, add: Agg): void {
  target.agents += add.agents;
  target.worstAgents += add.worstAgents;
  target.promptTokens += add.promptTokens;
  target.worstPromptTokens += add.worstPromptTokens;
  target.replyTokens += add.replyTokens;
  target.worstReplyTokens += add.worstReplyTokens;
  target.costWeightedTokens += add.costWeightedTokens;
  target.usdMin += add.usdMin;
  target.usdWorstCase += add.usdWorstCase;
  target.durationMs += add.durationMs;
  target.worstDurationMs += add.worstDurationMs;
  target.checkpoints += add.checkpoints;
  target.checkpointTokens += add.checkpointTokens;
  for (const [phase, row] of add.phases) {
    const current = target.phases.get(phase) ?? emptyPhaseAgg();
    current.agents += row.agents;
    current.worstAgents += row.worstAgents;
    current.promptTokens += row.promptTokens;
    current.replyTokens += row.replyTokens;
    current.totalTokens += row.totalTokens;
    current.worstTotalTokens += row.worstTotalTokens;
    current.durationMs += row.durationMs;
    target.phases.set(phase, current);
  }
}

/** Fold one node's subtree into an Agg (per enclosing multiplicity — fan-outs multiply their children). */
function fold(node: CallNode, env: FoldEnv): Agg {
  switch (node.kind) {
    case "agent": {
      const promptTokens = node.promptTokens ?? 0;
      // Context-cost: the fixed per-agent incoming context (system prefix +
      // skill stubs + tool defs) is billed once per agent execution, on top of
      // the static prompt/reply the AST scan can measure. Default 0 keeps the
      // legacy forecast byte-identical; the scoped-context wiring passes the
      // measured per-agent prefix.
      const fixed = env.perAgentFixedContextTokens;
      const perTokens = promptTokens + env.replyTokensPerAgent + fixed;
      const perDurationMs = (perTokens / env.tokensPerSecond) * 1000 + env.agentOverheadMs;
      const weight = env.tierCostWeights[node.tier ?? ""] ?? 1;
      const min = node.multi;
      const worst = Math.min(env.maxAgents, node.worstMulti);
      const agg = emptyAgg();
      agg.agents = min;
      agg.worstAgents = worst;
      agg.promptTokens = (promptTokens + fixed) * min;
      agg.worstPromptTokens = (promptTokens + fixed) * worst;
      agg.replyTokens = env.replyTokensPerAgent * min;
      agg.worstReplyTokens = env.replyTokensPerAgent * worst;
      agg.costWeightedTokens = perTokens * min * weight;
      // Measured USD from the price book: prompt tokens bill at the input
      // price, the reply assumption at the output price. An explicit model
      // spec's price wins, then the tier reference, then the default.
      const price = modelPriceForEstimate(node.model, node.tier, env.priceBook);
      const perUsd =
        ((promptTokens + fixed) / 1000) * price.inputPer1kUsd + (env.replyTokensPerAgent / 1000) * price.outputPer1kUsd;
      agg.usdMin = perUsd * min;
      agg.usdWorstCase = perUsd * worst;
      agg.durationMs = perDurationMs * min;
      agg.worstDurationMs = perDurationMs * worst;
      if (node.phase) {
        const row = emptyPhaseAgg();
        row.agents = min;
        row.worstAgents = worst;
        row.promptTokens = (promptTokens + fixed) * min;
        row.replyTokens = env.replyTokensPerAgent * min;
        row.totalTokens = perTokens * min;
        row.worstTotalTokens = perTokens * worst;
        row.durationMs = perDurationMs * min;
        agg.phases.set(node.phase, row);
      }
      return agg;
    }
    case "checkpoint": {
      const min = node.multi;
      const worst = Math.min(env.maxAgents, node.worstMulti);
      const promptTokens = node.promptTokens ?? 0;
      const agg = emptyAgg();
      agg.checkpoints = min;
      agg.checkpointTokens = promptTokens * min;
      if (node.phase) {
        const row = emptyPhaseAgg();
        row.promptTokens = promptTokens * min;
        row.totalTokens = promptTokens * min;
        row.worstTotalTokens = promptTokens * worst;
        agg.phases.set(node.phase, row);
      }
      return agg;
    }
    case "workflow": {
      if (!node.nested?.[0]) return emptyAgg();
      const nested = node.nested[0];
      const agg = emptyAgg();
      agg.agents = nested.agentCount * node.multi;
      agg.worstAgents = Math.min(env.maxAgents, nested.worstCaseAgentCount * node.worstMulti);
      agg.promptTokens = nested.promptTokens * node.multi;
      agg.worstPromptTokens = nested.promptTokens * node.worstMulti;
      agg.replyTokens = nested.replyTokens * node.multi;
      agg.worstReplyTokens = nested.replyTokens * node.worstMulti;
      agg.costWeightedTokens = nested.costWeightedTokens * node.multi;
      agg.usdMin = nested.usdMin * node.multi;
      agg.usdWorstCase = nested.usdWorstCase * node.worstMulti;
      agg.durationMs = nested.durationMs * node.multi;
      agg.worstDurationMs = nested.worstCaseDurationMs * node.worstMulti;
      for (const row of nested.phases) {
        const aggRow = emptyPhaseAgg();
        aggRow.agents = row.agentCount * node.multi;
        aggRow.worstAgents = Math.min(env.maxAgents, row.worstCaseAgentCount * node.worstMulti);
        aggRow.promptTokens = row.promptTokens * node.multi;
        aggRow.replyTokens = row.replyTokens * node.multi;
        aggRow.totalTokens = row.totalTokens * node.multi;
        aggRow.worstTotalTokens = row.totalTokens * node.worstMulti;
        aggRow.durationMs = row.durationMs * node.multi;
        agg.phases.set(row.title, aggRow);
      }
      return agg;
    }
    default: {
      // Fan-out. Children are either (a) ONE item's work executed `size` times
      // (template=true — map callbacks, pipeline stages, loop rounds, chunk
      // mappers, recursive solves) or (b) the FULL item list, each child one
      // item (template=false — parallel([thunk, thunk, ...])).
      const item = emptyAgg();
      let maxItemDurationMs = 0;
      for (const child of node.children) {
        const childAgg = fold(child, env);
        maxItemDurationMs = Math.max(maxItemDurationMs, childAgg.durationMs);
        mergeAgg(item, childAgg);
      }
      const agg = emptyAgg();
      let itemsMin = 1;
      let itemsWorst = 1;
      switch (node.kind) {
        case "parallel":
        case "pipeline":
          if (node.template) {
            if (node.size !== undefined) {
              itemsMin = node.size;
              itemsWorst = node.size;
            } else {
              itemsMin = 1;
              itemsWorst = env.maxAgents;
            }
          } else {
            // Each child is one item — the item count IS the children count.
            itemsMin = Math.max(1, node.children.length);
            itemsWorst = itemsMin;
          }
          break;
        case "chunked": {
          if (node.size !== undefined && node.chunkSize !== undefined && node.chunkSize >= 1) {
            itemsMin = Math.max(1, Math.ceil(node.size / node.chunkSize));
            itemsWorst = itemsMin;
          } else {
            itemsMin = 1;
            itemsWorst = env.maxAgents;
          }
          break;
        }
        case "loopUntilDry":
          itemsMin = 1;
          itemsWorst = node.maxRounds ?? env.maxAgents;
          break;
        case "recursive": {
          const depth = node.maxDepth ?? DEFAULT_RECURSIVE_DEPTH;
          const roots = node.maxRoots ?? DEFAULT_RECURSIVE_MAX_ROOTS;
          itemsMin = 1;
          itemsWorst = Math.min(env.maxAgents, Math.min(roots ** depth, Number.MAX_SAFE_INTEGER));
          break;
        }
        default:
          break;
      }
      const min = itemsMin;
      const worst = itemsWorst;
      // template=false: `item` already aggregates the FULL batch (one child per
      // item) — the batch multiplier is 1. template=true: `item` is one item's
      // work — scale by the item count.
      const batchMin = node.template ? min : 1;
      const batchWorst = node.template ? worst : 1;
      agg.agents = item.agents * batchMin;
      agg.worstAgents = Math.min(env.maxAgents, item.worstAgents * batchWorst);
      agg.promptTokens = item.promptTokens * batchMin;
      agg.worstPromptTokens = item.promptTokens * batchWorst;
      agg.replyTokens = item.replyTokens * batchMin;
      agg.worstReplyTokens = item.replyTokens * batchWorst;
      agg.costWeightedTokens = item.costWeightedTokens * batchMin;
      agg.usdMin = item.usdMin * batchMin;
      agg.usdWorstCase = item.usdWorstCase * batchWorst;
      // Propagate the children's per-phase aggregates (scaled the same way).
      for (const [phase, row] of item.phases) {
        const aggRow = emptyPhaseAgg();
        aggRow.agents = row.agents * batchMin;
        aggRow.worstAgents = Math.min(env.maxAgents, row.worstAgents * batchWorst);
        aggRow.promptTokens = row.promptTokens * batchMin;
        aggRow.replyTokens = row.replyTokens * batchMin;
        aggRow.totalTokens = row.totalTokens * batchMin;
        aggRow.worstTotalTokens = row.totalTokens * batchWorst;
        aggRow.durationMs = row.durationMs * batchMin;
        agg.phases.set(phase, aggRow);
      }

      // Duration models:
      //  - parallel/pipeline/chunked: a bounded worker pool — makespan ≈
      //    max(max-item, ceil(items/concurrency) × avg-item).
      //  - loopUntilDry: rounds run strictly sequentially.
      //  - recursive: balanced-tree approximation — depth+1 levels, each level
      //    fans `maxRoots` solves out in waves of the fan-out concurrency.
      switch (node.kind) {
        case "parallel":
        case "pipeline":
        case "chunked": {
          if (node.template) {
            // One template executed `items` times through the worker pool.
            const perItemDur = item.durationMs;
            const eff = Math.max(1, Math.min(node.concurrency, worst));
            agg.durationMs = Math.ceil(min / eff) * perItemDur;
            agg.worstDurationMs = Math.ceil(worst / eff) * perItemDur;
          } else {
            // Full item list — average-item makespan with a max-item floor.
            const eff = Math.max(1, Math.min(node.concurrency, worst));
            const itemCount = Math.max(1, node.children.length);
            const avgItem = item.durationMs / itemCount;
            agg.durationMs = Math.max(maxItemDurationMs, Math.ceil(min / eff) * avgItem);
            agg.worstDurationMs = Math.max(maxItemDurationMs, Math.ceil(worst / eff) * avgItem);
          }
          break;
        }
        case "loopUntilDry":
          agg.durationMs = item.durationMs * min;
          agg.worstDurationMs = item.durationMs * worst;
          break;
        case "recursive": {
          const depth = node.maxDepth ?? DEFAULT_RECURSIVE_DEPTH;
          const roots = node.maxRoots ?? DEFAULT_RECURSIVE_MAX_ROOTS;
          const eff = Math.max(1, Math.min(node.concurrency, roots));
          const levelMs = Math.ceil(roots / eff) * item.durationMs;
          agg.durationMs = item.durationMs;
          agg.worstDurationMs = (depth + 1) * levelMs;
          break;
        }
        default:
          agg.durationMs = item.durationMs;
          agg.worstDurationMs = item.durationMs;
      }
      return agg;
    }
  }
}

/** Build one public EstimateCallRecord (subtotal for its subtree). */
function recordFrom(node: CallNode, env: FoldEnv): EstimateCallRecord {
  const agg = fold(node, env);
  return {
    kind: node.kind,
    line: node.line,
    ...(node.phase !== undefined ? { phase: node.phase } : {}),
    ...(node.label !== undefined ? { label: node.label } : {}),
    ...(node.model !== undefined ? { model: node.model } : {}),
    ...(node.tier !== undefined ? { tier: node.tier } : {}),
    ...(node.promptText !== undefined ? { promptText: node.promptText } : {}),
    promptChars: node.promptChars ?? 0,
    promptTokens: node.promptTokens ?? 0,
    promptKnown: node.promptKnown ?? false,
    ...(node.size !== undefined ? { size: node.size } : {}),
    ...(node.dynamicSize ? { dynamicSize: true } : {}),
    ...(node.maxRounds !== undefined ? { maxRounds: node.maxRounds } : {}),
    ...(node.maxDepth !== undefined ? { maxDepth: node.maxDepth } : {}),
    ...(node.maxRoots !== undefined ? { maxRoots: node.maxRoots } : {}),
    concurrency: node.concurrency,
    agentCount: agg.agents,
    worstCaseAgentCount: Math.min(env.maxAgents, agg.worstAgents),
    promptTokensSubtotal: agg.promptTokens,
    replyTokensSubtotal: agg.replyTokens,
    totalTokensSubtotal: agg.promptTokens + agg.replyTokens,
    durationMs: agg.durationMs,
    worstCaseDurationMs: agg.worstDurationMs,
    ...(node.nested !== undefined && node.nested.length > 0 ? { nested: node.nested } : {}),
  };
}

function collectFanOuts(nodes: CallNode[], env: FoldEnv, out: EstimateFanOutRow[], warnings: string[]): void {
  for (const node of nodes) {
    if (
      node.kind === "parallel" ||
      node.kind === "pipeline" ||
      node.kind === "chunked" ||
      node.kind === "loopUntilDry" ||
      node.kind === "recursive"
    ) {
      const agg = fold(node, env);
      const dynamic = node.dynamicSize === true;
      // loopUntilDry's "size" is its round bound; recursive carries the root
      // item count; the sized fan-outs carry their item count.
      const size: number | "dynamic" =
        node.kind === "loopUntilDry" ? (node.maxRounds ?? "dynamic") : node.size !== undefined ? node.size : "dynamic";
      out.push({
        kind: node.kind,
        line: node.line,
        size,
        ...(node.maxRounds !== undefined ? { maxRounds: node.maxRounds } : {}),
        ...(node.maxDepth !== undefined ? { maxDepth: node.maxDepth } : {}),
        ...(node.maxRoots !== undefined ? { maxRoots: node.maxRoots } : {}),
        concurrency: node.concurrency,
        agentCount: agg.agents,
        worstCaseAgentCount: Math.min(env.maxAgents, agg.worstAgents),
      });
      if (dynamic) {
        warnings.push(
          `${node.kind}() at line ${node.line} has a dynamic size — size unknown statically; worst case bounded by maxAgents (${env.maxAgents})`,
        );
      }
    }
    for (const child of node.children) collectFanOuts([child], env, out, warnings);
  }
}

function countDynamicPrompts(nodes: CallNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.kind === "agent" && !node.promptKnown) count++;
    count += countDynamicPrompts(node.children);
  }
  return count;
}

/**
 * Distinct explicit model specs seen in the scan with NO price-book entry.
 * These quote at the default reference price (documented via a warning).
 */
function collectUnpricedModels(nodes: CallNode[], env: FoldEnv): string[] {
  const found = new Set<string>();
  const walk = (list: CallNode[]): void => {
    for (const node of list) {
      if (node.kind === "agent" && node.model && resolveModelPrice(node.model, env.priceBook) === undefined) {
        found.add(node.model);
      }
      walk(node.children);
    }
  };
  // Nested workflow() forecasts carry PUBLIC records (EstimateCallRecord[]), a
  // different shape than the internal CallNode walk above — walk them with the
  // public-shaped recursion instead of forcing them into the internal one.
  const walkPublic = (list: EstimateCallRecord[]): void => {
    for (const node of list) {
      if (node.kind === "agent" && node.model && resolveModelPrice(node.model, env.priceBook) === undefined) {
        found.add(node.model);
      }
      for (const nested of node.nested ?? []) walkPublic(nested.calls);
    }
  };
  walk(nodes);
  for (const nested of nodes.flatMap((node) => node.nested ?? [])) walkPublic(nested.calls);
  return [...found];
}

function buildFoldEnv(opts: EstimateOptions): FoldEnv {
  return {
    replyTokensPerAgent: opts.replyTokensPerAgent ?? ESTIMATE_REPLY_TOKENS_PER_AGENT_DEFAULT,
    tokensPerSecond: opts.tokensPerSecond ?? ESTIMATE_TOKENS_PER_SECOND_DEFAULT,
    agentOverheadMs: opts.agentOverheadMs ?? ESTIMATE_AGENT_OVERHEAD_MS_DEFAULT,
    maxAgents: opts.maxAgents ?? MAX_AGENTS_PER_RUN,
    tierCostWeights: opts.tierCostWeights ?? ESTIMATE_TIER_COST_WEIGHTS,
    priceBook: opts.priceBook ?? MODEL_PRICE_BOOK,
    perAgentFixedContextTokens: opts.perAgentFixedContextTokens ?? 0,
  };
}

/** Fold a top-level call list into one aggregate (phase rows + totals). */
function aggregateCalls(calls: CallNode[], opts: EstimateOptions): Agg {
  const env = buildFoldEnv(opts);
  const agg = emptyAgg();
  for (const node of calls) mergeAgg(agg, fold(node, env));
  return agg;
}

/** Assemble the final WorkflowEstimate from the scan output (pure). */
function buildEstimate(
  meta: WorkflowMeta,
  runtimePhases: string[],
  calls: CallNode[],
  opts: EstimateOptions,
): WorkflowEstimate {
  const env = buildFoldEnv(opts);
  const maxAgents = env.maxAgents;
  const agg = aggregateCalls(calls, opts);

  const fanOuts: EstimateFanOutRow[] = [];
  const warnings: string[] = [];
  collectFanOuts(calls, env, fanOuts, warnings);

  const dynamicPrompts = countDynamicPrompts(calls);
  if (dynamicPrompts > 0) {
    warnings.push(
      `${dynamicPrompts} agent call(s) have dynamic prompts (interpolation / unresolvable text) — their prompt text is not included in the token forecast`,
    );
  }
  if (agg.checkpoints > 0) {
    warnings.push(
      `${agg.checkpoints} human checkpoint() gate(s) pause the run — gate turnaround time is not included in the duration forecast`,
    );
  }

  const totalTokens = agg.promptTokens + agg.replyTokens;
  const budget = opts.tokenBudget ?? null;
  const exceedsBudget = budget !== null && totalTokens > budget;
  const nearBudget =
    budget !== null && totalTokens >= budget * ESTIMATE_WARNING_BUDGET_FRACTION && totalTokens <= budget;
  if (budget !== null && exceedsBudget) {
    warnings.push(
      `Forecast ${totalTokens} tokens EXCEEDS the token budget (${budget}) — the run would stop at the budget ceiling`,
    );
  } else if (budget !== null && nearBudget) {
    warnings.push(
      `Forecast ${totalTokens} tokens is within ${Math.round(ESTIMATE_WARNING_BUDGET_FRACTION * 100)}% of the token budget (${budget})`,
    );
  }

  // ── Spend governance: measured USD range + quote verdict (slice C) ──
  // The USD range comes from the price book fold; the quote verdict comes from
  // the shared spend-quote evaluator so the estimator and the runtime gate can
  // never disagree on the ceiling. Unpriced models are documented (they quote
  // at the default reference price — conservative unless the book is extended).
  const unpricedModels = collectUnpricedModels(calls, env);
  if (unpricedModels.length > 0) {
    warnings.push(
      `${unpricedModels.length} model spec(s) have no price-book entry (${unpricedModels.join(", ")}) — quoted at the default reference price; extend MODEL_PRICE_BOOK for an exact quote`,
    );
  }
  const quote = evaluateSpendQuote({ usdMin: agg.usdMin, usdWorstCase: agg.usdWorstCase }, opts);
  if (quote.verdict === "refuse" || quote.verdict === "warn") {
    warnings.push(quote.reason);
  }

  // Phase rows: meta-declared order first, then body-observed order.
  const seen = new Set<string>();
  const rows: EstimatePhaseRow[] = [];
  for (const title of [...(meta.phases ?? []).map((p) => p.title), ...runtimePhases]) {
    if (seen.has(title)) continue;
    seen.add(title);
    const row = agg.phases.get(title);
    if (row) {
      rows.push({
        title,
        agentCount: row.agents,
        worstCaseAgentCount: row.worstAgents,
        promptTokens: row.promptTokens,
        replyTokens: row.replyTokens,
        totalTokens: row.totalTokens,
        durationMs: row.durationMs,
      });
    } else {
      rows.push({
        title,
        agentCount: 0,
        worstCaseAgentCount: 0,
        promptTokens: 0,
        replyTokens: 0,
        totalTokens: 0,
        durationMs: 0,
      });
    }
  }

  return {
    name: meta.name,
    description: meta.description,
    ...(meta.model !== undefined ? { model: meta.model } : {}),
    ...(meta.gate !== undefined ? { gate: meta.gate } : {}),
    metaPhases: (meta.phases ?? []).map((p) => p.title),
    runtimePhases: [...runtimePhases],
    agentCount: agg.agents,
    worstCaseAgentCount: Math.min(maxAgents, agg.worstAgents),
    promptTokens: agg.promptTokens,
    replyTokens: agg.replyTokens,
    totalTokens,
    worstCaseTotalTokens: agg.worstPromptTokens + agg.worstReplyTokens,
    costWeightedTokens: agg.costWeightedTokens,
    usdMin: agg.usdMin,
    usdWorstCase: agg.usdWorstCase,
    spendCeilingUsd: quote.ceilingUsd,
    quoteVerdict: quote.verdict,
    ...(quote.reason !== undefined ? { quoteReason: quote.reason } : {}),
    unpricedModels,
    durationMs: agg.durationMs,
    worstCaseDurationMs: agg.worstDurationMs,
    checkpoints: agg.checkpoints,
    checkpointTokens: agg.checkpointTokens,
    maxAgents,
    fanOuts,
    phases: rows,
    warnings,
    budget,
    exceedsBudget,
    nearBudget,
    calls: calls.map((node) => recordFrom(node, env)),
  };
}

// ── public entry ──────────────────────────────────────────────────────────────

/**
 * V2-N4 entry: forecast a workflow script's cost/duration/agents without
 * running it. Pure and synchronous — the script is parsed and statically
 * scanned, never evaluated, and nothing is written to disk.
 */
export function estimateWorkflowForecast(script: string, options: EstimateOptions = {}): WorkflowEstimate {
  const parsed = parseWorkflowScript(script);
  const env: StaticEnv = { bindings: new Map(), functions: new Map(), expanding: new Set() };
  const ctx: ScanCtx = {
    phase: undefined,
    multi: 1,
    worstMulti: 1,
    dynamic: false,
    concurrency: options.defaultConcurrency ?? MAX_CONCURRENCY,
    maxAgents: options.maxAgents ?? MAX_AGENTS_PER_RUN,
    nestedDepth: 0,
  };
  const calls: CallNode[] = [];
  const runtimePhases: string[] = [];
  scanScript(parsed.body, parsed.bodyLineToScriptLine, options, env, ctx, calls, runtimePhases);
  return buildEstimate(parsed.meta, runtimePhases, calls, options);
}

// ── human renderer ────────────────────────────────────────────────────────────

/** Human duration ("45s" / "12m 30s" / "2h 05m") — mirrors display.formatElapsed's shape. */
export function formatEstimateDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Comma-group a non-negative number for human lines. */
function groupThousands(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * V2-N4 renderer: the human line(s) for the estimate. Pure — the CLI surface
 * (extensions/workflow.ts `workflow_estimate` tool) renders this text and
 * attaches the structured WorkflowEstimate to its details.
 */
export function renderWorkflowEstimate(estimate: WorkflowEstimate): string {
  const lines: string[] = [];
  lines.push(`Workflow estimate: **${estimate.name}** — ${estimate.description}`);
  lines.push(
    `Agents: **${groupThousands(estimate.agentCount)}** statically visible · worst case: **${groupThousands(
      estimate.worstCaseAgentCount,
    )}**`,
  );
  lines.push(
    `Tokens: ~${groupThousands(estimate.promptTokens)} prompt + ~${groupThousands(estimate.replyTokens)} reply = ~**${groupThousands(
      estimate.totalTokens,
    )}** total (worst ~${groupThousands(estimate.worstCaseTotalTokens)})`,
  );
  // Spend governance: the measured USD range from the price book + the quote verdict.
  lines.push(
    `Cost: ~**${formatQuoteUsd(estimate.usdMin)} – ${formatQuoteUsd(estimate.usdWorstCase)}** (min – worst case, measured price book)`,
  );
  if (estimate.quoteVerdict !== "off") {
    lines.push(`Quote: ${quoteVerdictLabel(estimate.quoteVerdict)} — ${estimate.quoteReason ?? ""}`);
  } else if (estimate.spendCeilingUsd !== null) {
    lines.push(`Quote: off (spend quote gate disabled)`);
  }
  lines.push(
    `Duration: ~${formatEstimateDuration(estimate.durationMs)} (worst ~${formatEstimateDuration(
      estimate.worstCaseDurationMs,
    )})`,
  );
  if (estimate.checkpoints > 0) {
    lines.push(
      `Gates: ${estimate.checkpoints} human checkpoint() pause(s) (~${groupThousands(estimate.checkpointTokens)} tokens)`,
    );
  }
  const allPhases = [...new Set([...estimate.metaPhases, ...estimate.runtimePhases])];
  if (allPhases.length > 0) lines.push(`Phases: ${allPhases.join(" → ")}`);
  if (estimate.fanOuts.length > 0) {
    const fanOutLines = estimate.fanOuts.map((f) => {
      const size =
        f.size === "dynamic"
          ? "dynamic size"
          : f.kind === "loopUntilDry"
            ? `up to ${f.size} round${f.size === 1 ? "" : "s"}`
            : `${f.size} item${f.size === 1 ? "" : "s"}`;
      const agents =
        f.agentCount === f.worstCaseAgentCount
          ? `${groupThousands(f.agentCount)} agent${f.agentCount === 1 ? "" : "s"}`
          : `${groupThousands(f.agentCount)}–${groupThousands(f.worstCaseAgentCount)} agents`;
      return `  · ${f.kind}@${f.line} — ${size} → ${agents} (concurrency ${f.concurrency})`;
    });
    lines.push(`Fan-outs:\n${fanOutLines.join("\n")}`);
  }
  const phaseRows = estimate.phases.filter((p) => p.agentCount > 0);
  if (phaseRows.length > 0) {
    const phaseLines = phaseRows.map(
      (p) =>
        `  · ${p.title}: ${groupThousands(p.agentCount)} agent(s) · ~${groupThousands(p.totalTokens)} tokens · ~${formatEstimateDuration(p.durationMs)}`,
    );
    lines.push(`Phase budget:\n${phaseLines.join("\n")}`);
  }
  if (estimate.gate === "approve") {
    lines.push('⚠ meta.gate "approve": the run pauses for human approval before the script body runs');
  }
  for (const warning of estimate.warnings) lines.push(`⚠ ${warning}`);
  lines.push("Estimate only — best-effort static scan; no run was started, nothing was executed or written.");
  return lines.join("\n");
}

/** Human label for a quote verdict (spend governance). */
function quoteVerdictLabel(verdict: "off" | "ok" | "warn" | "refuse"): string {
  switch (verdict) {
    case "ok":
      return "within spend ceiling";
    case "warn":
      return "⚠ over spend ceiling — requires confirmation";
    case "refuse":
      return "✗ over spend ceiling — launch refused";
    case "off":
      return "disabled";
  }
}

/** Format USD for a human cost line (same shape as the quote evaluator). */
function formatQuoteUsd(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}
