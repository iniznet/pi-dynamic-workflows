/**
 * Size-route rule for human approval (tasks/approval-size-routing/design.md).
 *
 * A plan/proposal/draft is classified LARGE when EITHER dimension crosses its
 * threshold: execution step count OR compact serialized byte size. BIG plans
 * REQUIRE the plannotator browser review — the bridge materializes, the review
 * URL is surfaced when the browser cannot auto-open, the run waits for the
 * human verdict, and the CLI `/workflows approve` refuses. SMALL plans never
 * materialize the bridge (no HTTP server, port never bound): the run pauses at
 * the approval point and the human approves via the CLI verb.
 *
 * Dependency-free by design: three consumers need this module — the extension
 * facade (extensions/workflow.ts routing), the headless-big refusal
 * (src/workflow.ts), and the CLI refusal (src/workflow-commands.ts). Hosting
 * it in src/integrations/plannotator.ts would force core src/workflow.ts to
 * import the whole integration module with its server/UI dependencies.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFileAtomic } from "./fs-persistence.js";

/** Default execution-step threshold: more steps than this is a LARGE plan. */
export const PLAN_APPROVAL_STEP_LIMIT_DEFAULT = 8;
/** Default compact-serialized byte threshold: more bytes than this is LARGE. */
export const PLAN_APPROVAL_BYTES_LIMIT_DEFAULT = 20_000;
/** Env override for the step threshold (integer >= 0; invalid/missing → default). */
export const PLAN_APPROVAL_STEP_LIMIT_ENV = "PLAN_APPROVAL_STEP_LIMIT";
/** Env override for the byte threshold (integer >= 0; invalid/missing → default). */
export const PLAN_APPROVAL_BYTES_LIMIT_ENV = "PLAN_APPROVAL_BYTES_LIMIT";

/** The two size-route thresholds. A plan is LARGE when either is exceeded. */
interface ApprovalLimits {
  /** Execution step count threshold (steps > stepLimit ⇒ LARGE). */
  stepLimit: number;
  /** Compact serialized byte threshold (bytes > bytesLimit ⇒ LARGE). */
  bytesLimit: number;
}

/**
 * Resolve the effective thresholds. Explicit `overrides` win over env; env is
 * read PER CALL (no module-level cache, so tests can set process.env between
 * calls); a missing/invalid env value (NaN, fractional, negative) falls back
 * to the default.
 */
export function resolveApprovalLimits(overrides?: Partial<ApprovalLimits>): ApprovalLimits {
  return {
    stepLimit: overrides?.stepLimit ?? readEnvLimit(PLAN_APPROVAL_STEP_LIMIT_ENV, PLAN_APPROVAL_STEP_LIMIT_DEFAULT),
    bytesLimit: overrides?.bytesLimit ?? readEnvLimit(PLAN_APPROVAL_BYTES_LIMIT_ENV, PLAN_APPROVAL_BYTES_LIMIT_DEFAULT),
  };
}

function readEnvLimit(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Decision-bookkeeping keys the approval flow adds to a plan file
 * (ensurePendingRunPlan: status/submittedAt; decidePlanApproved: reviewedAt).
 * They are NOT plan content — the size classification must be identical no
 * matter which side measured the file, so a plan routed SMALL by submitPlan
 * can never flip LARGE when the CLI re-measures the augmented file
 * (approval-size-routing review finding: +60B status/submittedAt augmentation
 * drifting a borderline plan across the byte threshold).
 */
const DECISION_BOOKKEEPING_KEYS = new Set(["status", "submittedAt", "reviewedAt"]);

/** Deep-free copy of the plan minus decision-bookkeeping keys (shallow is enough: the decision keys are top-level). */
function stripDecisionBookkeeping(plan: unknown): unknown {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return plan;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plan as Record<string, unknown>)) {
    if (!DECISION_BOOKKEEPING_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/**
 * The full size-route measurement of one plan. `bytes` is the COMPACT
 * serialization (Buffer.byteLength of JSON.stringify) — independent of on-disk
 * indentation, so the same plan classifies identically whether the prewalk
 * writer or the CLI wrote it with 2-space formatting. Decision-bookkeeping
 * keys (status/submittedAt/reviewedAt) are stripped before measuring so
 * augmentation never changes a plan's classification (see
 * DECISION_BOOKKEEPING_KEYS).
 */
export function planSizeMetrics(
  plan: unknown,
  overrides?: Partial<ApprovalLimits>,
): { steps: number; bytes: number; stepLimit: number; bytesLimit: number; big: boolean } {
  const limits = resolveApprovalLimits(overrides);
  const record = (plan ?? null) as { executionSteps?: unknown[] } | null;
  const steps = Array.isArray(record?.executionSteps) ? record.executionSteps.length : 0;
  const bytes = Buffer.byteLength(JSON.stringify(stripDecisionBookkeeping(plan ?? null)), "utf8");
  return {
    steps,
    bytes,
    stepLimit: limits.stepLimit,
    bytesLimit: limits.bytesLimit,
    big: steps > limits.stepLimit || bytes > limits.bytesLimit,
  };
}

/** True when the plan crosses either size threshold. */
export function isPlanBig(plan: unknown, overrides?: Partial<ApprovalLimits>): boolean {
  return planSizeMetrics(plan, overrides).big;
}

/**
 * Checkpoint identity of a plan a run is asking a human to approve: the
 * journaled call index of the checkpoint() that published it (the payload
 * built at src/workflow.ts checkpoint()). Per-checkpoint small-path plans are
 * addressed at `<runId>-c<callIndex>.json` (D-02), so one CLI verdict can
 * never rubber-stamp a LATER checkpoint of the same run.
 */
interface CheckpointIdentity {
  /** The journaled call index of the checkpoint within its run. */
  callIndex: number;
}

/**
 * File base (no `.json`) of a plan file. Per-checkpoint plans are addressed
 * at `<runId>-c<callIndex>`; the run-level prewalk ExecutionBlueprint stays at
 * `<runId>` — the path the Phase 1 prewalk stage writes (src/phases/prewalk.ts)
 * and `/workflows implement` fans out from.
 */
function planFileBase(runId: string, checkpoint?: CheckpointIdentity): string {
  return checkpoint === undefined ? runId : `${runId}-c${checkpoint.callIndex}`;
}

/** Result of {@link classifyRunPlan}: the effective plan + its size verdict. */
interface ClassifiedRunPlan {
  /** The plan that was measured (the run-plan file content, else the payload). */
  plan: unknown;
  /** Where the measured plan came from. */
  source: "run-plan" | "blueprint";
  steps: number;
  bytes: number;
  big: boolean;
}

/**
 * Classify the plan a run is asking a human to approve: when
 * `<dir>/<runId>.json` exists (the prewalk ExecutionBlueprint at
 * `.pi/workflows/plans/<runId>.json`), that file is the plan under review and
 * wins over the payload; otherwise (missing or unreadable — e.g. an in-body
 * checkpoint on a run without a prewalk) the payload itself is classified.
 */
export async function classifyRunPlan(options: {
  dir: string;
  runId: string;
  blueprint: unknown;
  /** Checkpoint identity: the per-checkpoint file `<runId>-c<callIndex>.json` is consulted first. */
  checkpoint?: CheckpointIdentity;
  overrides?: Partial<ApprovalLimits>;
}): Promise<ClassifiedRunPlan> {
  const { dir, runId, blueprint, checkpoint } = options;
  let plan: unknown = blueprint;
  let source: "run-plan" | "blueprint" = "blueprint";
  // A per-checkpoint file (when the payload carries a checkpoint identity)
  // wins; then the run-level prewalk ExecutionBlueprint; then the payload
  // itself (never a prewalk run, or mid-write). Missing/unreadable files are
  // treated as absent and the next candidate is consulted.
  const candidates = checkpoint ? [planFileBase(runId, checkpoint), runId] : [runId];
  for (const base of candidates) {
    try {
      plan = JSON.parse(await readFile(join(dir, `${base}.json`), "utf-8")) as unknown;
      source = "run-plan";
      break;
    } catch {
      // Missing or unreadable candidate; fall through to the next one.
    }
  }
  const metrics = planSizeMetrics(plan, options.overrides);
  return { plan, source, steps: metrics.steps, bytes: metrics.bytes, big: metrics.big };
}

/** Result of {@link ensurePendingRunPlan}. */
interface EnsurePendingRunPlanResult {
  /** The runId the plan is addressed at (always `<dir>/<runId>.json`). */
  id: string;
  /** True when a plan file was written/augmented; false on a decided no-op. */
  wrote: boolean;
  /** True when the plan file already carried a final verdict (no-op). */
  decided: boolean;
}

/**
 * Make the plan file pollable by waitForStatus: the raw prewalk ExecutionBlueprint
 * has NO status field, and waitForStatus resolves on any non-pending status — an
 * unaugmented file would resolve false instantly (plannotator.ts waitForStatus).
 * So an existing undecided file is augmented with `status: "pending"` +
 * `submittedAt` (all blueprint fields preserved); a missing file gets a
 * payload-shaped pending plan; an already-decided file (approved/rejected) is
 * never clobbered. Atomic tmp+rename via the shared writeJsonFileAtomic
 * (fs-persistence.ts, audit WPA-01).
 *
 * Addressing (D-02): a checkpoint identity names the file
 * `<runId>-c<callIndex>.json`, so each checkpoint of a run is approved
 * independently; without one the file stays at the run-level `<runId>.json`
 * (the prewalk plan the CLI `/workflows implement` fans out from). The returned
 * `id` is the plan-file base the facade dispatches the wait at.
 */
export async function ensurePendingRunPlan(
  dir: string,
  runId: string,
  blueprint: unknown,
  checkpoint?: CheckpointIdentity,
): Promise<EnsurePendingRunPlanResult> {
  const base = planFileBase(runId, checkpoint);
  const path = join(dir, `${base}.json`);
  let existing: unknown = null;
  try {
    existing = JSON.parse(await readFile(path, "utf-8")) as unknown;
  } catch {
    // Missing file: the payload-shaped pending plan is written below.
  }
  if (existing !== null) {
    const status = (existing as { status?: unknown }).status;
    if (status === "approved" || status === "rejected") {
      // A verdict already exists: never overwrite it. waitForApproval observes
      // the decision directly (approved → true, rejected → false).
      return { id: base, wrote: false, decided: true };
    }
  }
  const plan =
    existing !== null
      ? {
          ...(existing as Record<string, unknown>),
          status: "pending",
          submittedAt: new Date().toISOString(),
        }
      : {
          id: runId,
          title: "Execution Blueprint Review",
          blueprint,
          status: "pending",
          submittedAt: new Date().toISOString(),
        };
  await mkdir(dir, { recursive: true });
  await writePlanAtomic(dir, base, plan);
  return { id: base, wrote: true, decided: false };
}

/**
 * Atomic replace of a plan file — thin alias of the shared
 * {@link writeJsonFileAtomic} (fs-persistence.ts). Audit WPA-01: the retrying
 * writer was triplicated and only THIS copy carried the bounded rename retry;
 * consolidating on the shared util gives every plan writer the same semantics,
 * so a concurrent 250ms waitForStatus poller never observes a torn file and a
 * Windows-EPERM rename (a reader holding the destination open without
 * delete-sharing) is retried with the same bounded cadence everywhere.
 */
async function writePlanAtomic(dir: string, base: string, plan: unknown): Promise<void> {
  await writeJsonFileAtomic(join(dir, `${base}.json`), plan);
}
