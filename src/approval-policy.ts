/**
 * V2-P01 — risk-classified approval policy + LLM auto-approval classifier.
 *
 * The safety layer that turns the P12 count-threshold fan-out gate (and the
 * journaled checkpoint() gate it shares) into a per-risk-class policy
 * (read/write/execute/network/agent × allow/ask/auto/deny):
 *
 *  - `allow`  — low-risk ops auto-flow by policy (no prompt, no classifier).
 *  - `ask`    — escalate to the human (TUI confirm / checkpointGate); a human
 *               approval records an action-exact, run-scoped grant
 *               (allow-session by default, allow-once via `grantMode`).
 *  - `auto`   — route ONE exact action to an LLM classifier over a bounded
 *               transcript; `allow` approves, anything else escalates to the
 *               human (and a HEADLESS run fails closed — a risky action is
 *               never silently rubber-stamped).
 *  - `deny`   — refuse the action outright (fail closed, no prompt).
 *
 * The classifier is a DIRECT ModelRuntime call over the public
 * `completeSimple` channel (the same seam P09's crosschecker uses); its spend
 * is metered against the run budget by the caller (the run owns
 * shared.spent). Grants are per-run in-memory state — serialized by run
 * order, action-exact, and NEVER widening: no risk-class grants, no
 * cross-run persistence, no automatic escalation of a grant to a new action.
 * Classifier decisions are recorded in the run result/report, NEVER in any
 * agent() resume identity (hashAgentCall's field set is untouched).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Api, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  APPROVAL_CLASSIFIER_MAX_EVIDENCE_CHARS,
  DEFAULT_APPROVAL_CLASSIFIER_MAX_TOKENS,
  DEFAULT_APPROVAL_CLASSIFIER_TIMEOUT_MS,
  DEFAULT_APPROVAL_POLICY,
} from "./config.js";
import { resolveModelForCrosscheck } from "./model-crosscheck.js";
import { withTimeout } from "./timing.js";

/** The five risk classes an approval gate can be classified into. */
export type RiskClass = "read" | "write" | "execute" | "network" | "agent";

/** The policy a risk class resolves to: allow / ask / auto / deny. */
export type RiskPolicy = "allow" | "ask" | "auto" | "deny";

/**
 * Per-risk-class policy table. Partial: an unset class resolves to
 * DEFAULT_APPROVAL_POLICY. Threaded via WorkflowRunOptions.approvalPolicy —
 * approval is host-side policy, never part of any resume identity.
 */
export type ApprovalPolicyConfig = Partial<Record<RiskClass, RiskPolicy>>;

/** Closed enumeration of the risk classes, for iteration/validation. */
export const RISK_CLASSES: readonly RiskClass[] = ["read", "write", "execute", "network", "agent"];

/** Resolve the effective policy for one risk class (defaults when unset). */
export function resolveRiskPolicy(config: ApprovalPolicyConfig | undefined, riskClass: RiskClass): RiskPolicy {
  return config?.[riskClass] ?? DEFAULT_APPROVAL_POLICY[riskClass];
}

/** The distinct decision kinds recorded per approval gate. */
export type ApprovalDecisionKind =
  | "policy-allow"
  | "policy-deny"
  | "human-approve"
  | "human-deny"
  | "classifier-allow"
  | "classifier-escalate"
  | "session-grant"
  | "once-grant"
  | "trusted-script";

/**
 * One recorded approval decision. Nullable riskClass covers trusted-script
 * skips of plain (unclassified) confirm checkpoints. Recorded in the run
 * result + log; NEVER part of any agent() resume identity.
 */
export interface ApprovalDecision {
  riskClass: RiskClass | null;
  /** The policy that produced the decision ("allow" for grant/trusted hits). */
  policy: RiskPolicy;
  decision: ApprovalDecisionKind;
  /** Canonical action identity (the grant key suffix). */
  action: string;
  /** Grant kind recorded with this decision, when a grant was created. */
  grant?: "once" | "session";
  /** Classifier spend estimate (tokens), when a classifier ran. */
  estimatedTokens?: number;
}

/**
 * Canonical grant key for one action: `riskClass:sha256(action)`. Grants are
 * keyed on the EXACT action — a grant never widens to other actions in the
 * same class, and the risk class is part of the key so a re-classified action
 * cannot reuse a grant.
 */
export function approvalGrantKey(riskClass: RiskClass, action: string): string {
  return `${riskClass}:${createHash("sha256").update(action).digest("hex")}`;
}

/**
 * Per-run in-memory approval grant store. Grants are serialized by run order
 * (JS single-thread) and run-scoped:
 *  - `session` — one exact action is pre-approved for the rest of THIS run.
 *  - `once`    — one exact action is pre-approved for exactly ONE future
 *                occurrence (consumed by the occurrence that uses it).
 * Never widens: no class-level grants, no cross-run persistence.
 */
export class ApprovalGrantStore {
  private readonly sessionGrants = new Set<string>();
  private readonly onceGrants = new Set<string>();

  /** Record a grant. Idempotent for the same key/kind. */
  grant(grantKey: string, kind: "once" | "session"): void {
    (kind === "once" ? this.onceGrants : this.sessionGrants).add(grantKey);
  }

  /** The grant kind in effect for `grantKey`, or null. */
  peek(grantKey: string): "session" | "once" | null {
    if (this.sessionGrants.has(grantKey)) return "session";
    if (this.onceGrants.has(grantKey)) return "once";
    return null;
  }

  /** Consume a once grant after its occurrence used it. True when consumed. */
  consumeOnce(grantKey: string): boolean {
    return this.onceGrants.delete(grantKey);
  }

  /** Total grant count (observability; never part of any identity). */
  get size(): number {
    return this.sessionGrants.size + this.onceGrants.size;
  }
}

// ─── LLM auto-approval classifier (public ModelRuntime completeSimple) ──────

/** What the classifier needs to decide on ONE exact action. */
export interface ApprovalClassifierInput {
  /** The exact action text under review (the canonical grant key input). */
  action: string;
  riskClass: RiskClass;
  /** Bounded transcript evidence (recent run activity), pre-truncated. */
  evidence: string;
}

/**
 * Classifier outcome. `verdict: null` means the classifier was unavailable
 * (auth/config/network/timeout/unparseable) — the caller MUST fail closed
 * (escalate), never treat null as allow. `prompt`/`reply` let the run meter
 * the call's estimated spend against its budget.
 */
export interface ApprovalClassifierResult {
  verdict: "allow" | "escalate" | null;
  /** The exact prompt sent (for budget metering via estimateTokens). */
  prompt: string;
  /** The raw text reply, or null when the call failed/returned no text. */
  reply: string | null;
}

/** Injectable classifier surface (tests inject a fake; run creates the real one). */
export interface ApprovalClassifier {
  classify(input: ApprovalClassifierInput): Promise<ApprovalClassifierResult>;
}

export interface ApprovalClassifierOptions {
  /** Prebuilt runtime (tests inject a fake); absent → memoized real runtime. */
  runtime?: ModelRuntime;
  /** Auth file path for the lazily-created runtime (default: agentDir/auth.json). */
  authPath?: string;
  /** Models catalog path for the lazily-created runtime (default: agentDir/models.json). */
  modelsPath?: string;
  /** Model spec to classify on (default: the first model in the runtime catalog). */
  modelSpec?: string;
  /** Per-request timeout (default DEFAULT_APPROVAL_CLASSIFIER_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Response token cap (default DEFAULT_APPROVAL_CLASSIFIER_MAX_TOKENS). */
  maxTokens?: number;
  /** Evidence truncation cap (default APPROVAL_CLASSIFIER_MAX_EVIDENCE_CHARS). */
  maxEvidenceChars?: number;
}

/** Module-level memoized real runtime; busted on rejection like the crosschecker's. */
let defaultClassifierRuntimePromise: Promise<ModelRuntime> | undefined;

function ensureClassifierRuntime(options: ApprovalClassifierOptions): Promise<ModelRuntime> {
  if (options.runtime) return Promise.resolve(options.runtime);
  if (!defaultClassifierRuntimePromise) {
    defaultClassifierRuntimePromise = (async () => {
      const dir = getAgentDir();
      return ModelRuntime.create({
        authPath: options.authPath ?? join(dir, "auth.json"),
        modelsPath: options.modelsPath ?? join(dir, "models.json"),
      });
    })();
    defaultClassifierRuntimePromise.catch(() => {
      defaultClassifierRuntimePromise = undefined;
    });
  }
  return defaultClassifierRuntimePromise;
}

/**
 * Build the classifier prompt for ONE exact action: the risk class, the
 * action, and bounded transcript evidence, with an explicit fail-closed rule
 * ("when in doubt, ESCALATE"). The evidence is truncated at the configured
 * cap; the whole prompt is bounded so the classifier request stays cheap.
 */
export function buildApprovalClassifierPrompt(
  action: string,
  riskClass: RiskClass,
  evidence: string,
  maxEvidenceChars: number,
): string {
  const bounded =
    evidence.length > maxEvidenceChars ? `${evidence.slice(0, maxEvidenceChars)}\n… (evidence truncated)` : evidence;
  return [
    `Risk class: ${riskClass}`,
    `Action to approve: ${action}`,
    "",
    "Bounded transcript evidence (recent run activity):",
    bounded || "(no run activity yet)",
    "",
    "Decide whether this exact action may proceed unattended.",
    "- ALLOW only when it is clearly low-risk for its risk class and the evidence shows no reason to pause.",
    "- ESCALATE when there is ANY uncertainty, significant side effects are possible, or the evidence is insufficient.",
    "- When in doubt, ESCALATE (fail closed).",
    "Reply with exactly one word: ALLOW or ESCALATE.",
  ].join("\n");
}

/**
 * Lenient ALLOW/ESCALATE parser over the classifier's free-text reply: the
 * first word-boundary occurrence of either word decides. Anything else
 * (missing, or an unrecognized reply) resolves null — the caller fails closed.
 */
export function parseApprovalClassifierVerdict(text: string | null | undefined): "allow" | "escalate" | null {
  if (!text) return null;
  const normalized = text.trim().toUpperCase();
  const allowMatch = /\bALLOW\b/.exec(normalized);
  const escalateMatch = /\bESCALATE\b/.exec(normalized);
  const allowIndex = allowMatch?.index;
  const escalateIndex = escalateMatch?.index;
  if (allowIndex === undefined && escalateIndex === undefined) return null;
  if (allowIndex === undefined) return "escalate";
  if (escalateIndex === undefined) return "allow";
  return allowIndex <= escalateIndex ? "allow" : "escalate";
}

/** Concatenate the text content of an assistant reply (mirrors the crosschecker). */
function textOf(message: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
    .trim();
}

/** First model in the runtime's catalog, or undefined when the catalog is empty. */
function firstAvailableModel(runtime: ModelRuntime): Model<Api> | undefined {
  const models = runtime.getModels();
  return models[0];
}

/** Build a runtime-backed approval classifier (memoized; injectable for tests). */
export function createApprovalClassifier(options: ApprovalClassifierOptions = {}): ApprovalClassifier {
  const classify = async (input: ApprovalClassifierInput): Promise<ApprovalClassifierResult> => {
    const prompt = buildApprovalClassifierPrompt(
      input.action,
      input.riskClass,
      input.evidence,
      options.maxEvidenceChars ?? APPROVAL_CLASSIFIER_MAX_EVIDENCE_CHARS,
    );
    try {
      const runtime = await ensureClassifierRuntime(options);
      const model = options.modelSpec
        ? resolveModelForCrosscheck(runtime, options.modelSpec)
        : firstAvailableModel(runtime);
      if (!model) return { verdict: null, prompt, reply: null };
      const requestOptions: ModelsSimpleStreamOptions = {
        maxTokens: options.maxTokens ?? DEFAULT_APPROVAL_CLASSIFIER_MAX_TOKENS,
      };
      const message = await withTimeout(
        runtime.completeSimple(model, { messages: [{ role: "user", content: prompt, timestamp: 0 }] }, requestOptions),
        options.timeoutMs ?? DEFAULT_APPROVAL_CLASSIFIER_TIMEOUT_MS,
        "approval classifier",
      );
      const reply = textOf(message);
      return { verdict: parseApprovalClassifierVerdict(reply), prompt, reply };
    } catch {
      // auth/config/network/timeout — the classifier is unavailable; the caller
      // must fail closed (escalate), never treat the action as approved.
      return { verdict: null, prompt, reply: null };
    }
  };
  return { classify };
}

// ─── V2-N3: gate-time cost preview ──────────────────────────────────────────

export interface GateCostLineInput {
  /** Estimated tokens of the planned work (undefined when not estimable). */
  plannedTokens?: number;
  /** Number of agents the planned work would launch (fan-outs). */
  plannedAgents?: number;
  /** The run's remaining budget (Infinity when no budget configured). */
  budgetRemaining: number;
  /** The run's total budget (null = no run budget). */
  budgetTotal: number | null;
  /** Tokens spent so far (for the per-token $ rate). */
  spentTokens: number;
  /** Provider-reported cost so far (0 when nothing has reported usage). */
  costUsd: number;
}

/**
 * One consent-line string for approval gates: "estimated ~X tokens of agent
 * work · N agent(s) · ~$D at the observed rate · R tokens remaining (forecast
 * within/EXCEEDS budget)". A dollar figure appears ONLY when the run has a
 * real provider-reported per-token rate (P09 was parked precisely because no
 * dollar conversion exists otherwise — the rate here is derived from actual
 * spend, never invented). DISPLAY-ONLY: callers must keep this string out of
 * any checkpoint identity (pass it via CheckpointOptions.details, never by
 * editing the prompt text).
 */
export function buildGateCostLine(input: GateCostLineInput): string {
  const parts: string[] = [];
  if (input.plannedTokens !== undefined) {
    parts.push(`estimated ~${Math.round(input.plannedTokens)} tokens of agent work`);
  }
  if (input.plannedAgents !== undefined && input.plannedAgents > 0) {
    parts.push(`${input.plannedAgents} agent(s)`);
  }
  if (input.spentTokens > 0 && input.costUsd > 0 && input.plannedTokens !== undefined) {
    const rate = input.costUsd / input.spentTokens;
    parts.push(`~$${(rate * input.plannedTokens).toFixed(3)} at the observed rate`);
  }
  if (input.budgetTotal === null) {
    parts.push("no run token budget");
  } else {
    const remaining = Math.max(0, input.budgetRemaining);
    const forecast = input.plannedTokens ?? 0;
    parts.push(`${remaining} tokens remaining (forecast ${forecast > remaining ? "EXCEEDS" : "within"} budget)`);
  }
  return parts.join(" · ");
}
