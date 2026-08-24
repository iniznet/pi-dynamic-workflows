/**
 * Cache-friendly state machine and tool guardrails for deterministic phase
 * ordering in pi-dynamic-workflows.
 *
 * Phases progress strictly forward: 0 → 1 → 2 → 3.
 * Subagent-spawning tools are blocked until Phase 3 with human approval.
 * State is persisted to .pi/workflows/active-state.json for crash recovery.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { WorkflowError, WorkflowErrorCode } from "../errors.js";

// ---------------------------------------------------------------------------
// Error codes (numeric, stable, exported for caller inspection)
// ---------------------------------------------------------------------------

/** Attempted a non-forward phase transition. */
export const PHASE_TRANSITION_INVALID = -31001;

/** Subagent spawn blocked because Phase 3 or human approval not reached. */
export const SUBAGENT_SPAWN_BLOCKED = -31002;

/** Human approval is required before the requested action is allowed. */
export const APPROVAL_REQUIRED = -31003;

/** A flag that must be true before a phase may be entered. */
interface PhasePrerequisite {
  /** The state flag acting as the gate. */
  flag: "humanApproved" | "wayfinderComplete" | "prewalkComplete" | "plannotatorSubmitted";
  /** Human-readable reason shown in the gate failure. */
  description: string;
}

/**
 * Flags that gate entry into each phase. Phase 0 (wayfinder) is the start and
 * has no prerequisites; every later phase is entered through the flag its
 * preceding stage produces.
 */
export const PHASE_PREREQUISITES: Readonly<Record<PhaseStage, readonly PhasePrerequisite[]>> = {
  0: [],
  1: [{ flag: "wayfinderComplete", description: "the Phase 0 wayfinder step must be complete" }],
  2: [{ flag: "prewalkComplete", description: "the Phase 1 prewalk step must be complete" }],
  3: [
    { flag: "plannotatorSubmitted", description: "the Phase 2 plan must have been submitted" },
    { flag: "humanApproved", description: "a human must have approved the plan" },
  ],
};

/** Maximum compare-and-swap attempts before setState gives up under contention. */
const MAX_SET_STATE_ATTEMPTS = 8;

// ---------------------------------------------------------------------------
// PhaseState
// ---------------------------------------------------------------------------

/** Deterministic workflow stage in the persisted phase state machine (0–3). */
export type PhaseStage = 0 | 1 | 2 | 3;

/**
 * N01: workspace change-scope fingerprint captured at a phase boundary (host
 * side, where fs/git are available). Pure data: a read-only git tree hash of
 * the committed baseline plus the full `git status --porcelain` snapshot, so
 * a later machine diff can answer "only intended files changed". Snapshots
 * persist WITH the phase state (inside active-state.json) and are forward-only
 * (a phase's snapshot is recorded once, never regressed). Never part of any
 * agent() resume hash.
 */
export interface WorkspaceFingerprint {
  /** The phase boundary this snapshot was captured at (0–3). */
  phase: PhaseStage;
  /** `git rev-parse HEAD^{tree}` — the committed tree baseline (null outside a repo). */
  treeHash: string | null;
  /** Every non-empty `git status --porcelain` line ([] outside a repo). */
  gitStatus: string[];
}

/**
 * N01: host-injected provider that captures a WorkspaceFingerprint at a phase
 * boundary. The workflow layer stays fs/git-free; the host (WorkflowManager)
 * injects the real capture (tree hash + porcelain status) and the machine
 * persists the result alongside active-state.json.
 */
type WorkspaceFingerprintProvider = (phase: PhaseStage) => WorkspaceFingerprint | Promise<WorkspaceFingerprint>;

/**
 * N01: the inputs a scope enforcer sees after a forward phase transition — the
 * fingerprint captured AT the boundary just crossed plus the most recent
 * fingerprint captured at a LOWER boundary (the diff baseline). `previous` is
 * undefined for the run's first boundary (no baseline yet → nothing to diff).
 * Because the snapshots are forward-only (never rewritten), a resume replay
 * sees the SAME persisted inputs, so the enforcer fires at most once per
 * boundary across the run's whole lifetime — deterministically.
 */
export interface WorkspaceScopeCheck {
  /** The phase boundary just crossed (the NEW stage). */
  stage: PhaseStage;
  /** Most recent fingerprint captured below `stage` (undefined = no baseline). */
  previous: WorkspaceFingerprint | undefined;
  /** The fingerprint captured at THIS boundary. */
  next: WorkspaceFingerprint;
}

/**
 * N01: host-injected scope enforcer, invoked AFTER the boundary fingerprint is
 * persisted — deliberately OUTSIDE the capture's best-effort try/catch, so a
 * throwing enforcer genuinely rejects the transition. The host computes the
 * machine diff + violation assertion (diffWorkspaceFingerprints /
 * workspaceScopeViolations live host-side in workflow-manager.ts) and applies
 * its documented policy (flag / reject / ui.confirm). The machine itself stays
 * fs/git-free and holds no policy.
 */
type WorkspaceScopeEnforcer = (check: WorkspaceScopeCheck) => void | Promise<void>;

/**
 * N01: persisted result of a scope assertion at one phase boundary. Written by
 * the host's enforcer through `recordScopeViolations`; forward-only like
 * fingerprints (a boundary's record is written once, never regressed), so
 * resume replays see a stable audit trail.
 */
export interface ScopeViolationRecord {
  /** Human-readable change descriptions outside the intended set ("added: x"). */
  violations: string[];
  /** The intended-path set the boundary was asserted against (exact paths +
   *  "/"-suffixed subtree prefixes, relative to the run's cwd). */
  allowed: string[];
  /** ui.confirm mode: true when a human explicitly approved the out-of-scope
   *  change (the transition proceeded); absent in flag/reject modes. */
  approved?: boolean;
}

/** Persisted workflow phase state. */
export interface PhaseState {
  /** Currently active workflow phase (0–3). */
  activePhase: PhaseStage;
  /** Whether a human has approved the plan (valid only in Phase 2+). */
  humanApproved: boolean;
  /** Phase 1 wayfinder step completed. */
  wayfinderComplete: boolean;
  /** Phase 1 prewalk step completed. */
  prewalkComplete: boolean;
  /** Phase 2 plannotator output submitted. */
  plannotatorSubmitted: boolean;
  /** ISO-8601 timestamp of the last state mutation. */
  updatedAt: string;
  /**
   * Monotonic write generation used as the optimistic-lock token for
   * compare-and-swap in `setState`. Each successful write advances it by one,
   * so a writer can detect that a concurrent writer landed between its read
   * and its rename and retry without losing either update.
   */
  version: number;
  /**
   * N01: workspace fingerprints captured at each phase boundary, keyed by the
   * phase they were captured for (0–3). Absent until the first capture (and
   * absent on legacy state files) — JSON drops the undefined key, so
   * pre-N01 active-state.json stays byte-identical. Forward-only: an entry is
   * written once per phase and never regressed.
   */
  fingerprints?: Partial<Record<PhaseStage, WorkspaceFingerprint>>;
  /**
   * N01: scope-assertion outcomes recorded at phase boundaries by the host's
   * enforcer (flag / reject / ui.confirm), keyed by phase. Absent when no
   * violation was ever asserted (and on legacy files) — JSON drops the key.
   * Forward-only, same rule as fingerprints. Never part of any agent() resume
   * hash.
   */
  scopeViolations?: Partial<Record<PhaseStage, ScopeViolationRecord>>;
}

/** Factory for a fresh default state (new timestamp on every call). */
function createDefaultState(): PhaseState {
  return {
    activePhase: 0,
    humanApproved: false,
    wayfinderComplete: false,
    prewalkComplete: false,
    plannotatorSubmitted: false,
    updatedAt: new Date().toISOString(),
    version: 0,
  };
}

/**
 * Degrade a stale/hand-edited sidecar to defaults field-by-field instead of
 * propagating wrong-typed values (a string activePhase, a non-boolean flag, a
 * garbage timestamp) into the machine where they would corrupt comparisons.
 */
function normalizePhaseState(parsed: unknown): PhaseState {
  const defaults = createDefaultState();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return defaults;
  const raw = parsed as Record<string, unknown>;

  const activePhase =
    typeof raw.activePhase === "number" &&
    Number.isInteger(raw.activePhase) &&
    raw.activePhase >= 0 &&
    raw.activePhase <= 3
      ? (raw.activePhase as PhaseStage)
      : defaults.activePhase;

  const asBoolean = (
    key: "humanApproved" | "wayfinderComplete" | "prewalkComplete" | "plannotatorSubmitted",
  ): boolean => (typeof raw[key] === "boolean" ? (raw[key] as boolean) : defaults[key]);

  const updatedAt =
    typeof raw.updatedAt === "string" && !Number.isNaN(Date.parse(raw.updatedAt)) ? raw.updatedAt : defaults.updatedAt;

  const version =
    typeof raw.version === "number" &&
    Number.isInteger(raw.version) &&
    raw.version >= 0 &&
    raw.version <= Number.MAX_SAFE_INTEGER
      ? raw.version
      : defaults.version;

  const fingerprints = normalizeFingerprints(raw.fingerprints);
  const scopeViolations = normalizeScopeViolations(raw.scopeViolations);

  return {
    activePhase,
    humanApproved: asBoolean("humanApproved"),
    wayfinderComplete: asBoolean("wayfinderComplete"),
    prewalkComplete: asBoolean("prewalkComplete"),
    plannotatorSubmitted: asBoolean("plannotatorSubmitted"),
    updatedAt,
    version,
    ...(fingerprints ? { fingerprints } : {}),
    ...(scopeViolations ? { scopeViolations } : {}),
  };
}

/**
 * Validate the persisted fingerprints side of active-state.json (N01): keep
 * only well-formed entries whose numeric key matches the embedded phase and
 * whose gitStatus is a string array; drop everything else (hand-edits degrade
 * leniently, exactly like the other fields). Returns undefined when nothing
 * valid remains (legacy files normalize to the pre-N01 shape).
 */
function normalizeFingerprints(value: unknown): Partial<Record<PhaseStage, WorkspaceFingerprint>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Partial<Record<PhaseStage, WorkspaceFingerprint>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const phase = Number(key);
    if (!Number.isInteger(phase) || phase < 0 || phase > 3) continue;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (entry.phase !== phase) continue;
    const treeHash = typeof entry.treeHash === "string" ? entry.treeHash : null;
    if (!Array.isArray(entry.gitStatus)) continue;
    if (entry.gitStatus.some((line) => typeof line !== "string")) continue;
    out[phase as PhaseStage] = { phase: phase as PhaseStage, treeHash, gitStatus: entry.gitStatus as string[] };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate the persisted scope-violation sidecar of active-state.json (N01):
 * keep only well-formed entries whose numeric key matches the phase, whose
 * violations/allowed are string arrays, and whose optional approved is a
 * boolean; drop everything else (hand-edits degrade leniently, exactly like
 * the fingerprints side). Returns undefined when nothing valid remains (legacy
 * files normalize to the pre-enforcement shape).
 */
function normalizeScopeViolations(value: unknown): Partial<Record<PhaseStage, ScopeViolationRecord>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Partial<Record<PhaseStage, ScopeViolationRecord>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const phase = Number(key);
    if (!Number.isInteger(phase) || phase < 0 || phase > 3) continue;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (!Array.isArray(entry.violations) || entry.violations.some((v) => typeof v !== "string")) continue;
    if (!Array.isArray(entry.allowed) || entry.allowed.some((v) => typeof v !== "string")) continue;
    const approved = typeof entry.approved === "boolean" ? entry.approved : undefined;
    out[phase as PhaseStage] = {
      violations: entry.violations as string[],
      allowed: entry.allowed as string[],
      ...(approved !== undefined ? { approved } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// WorkflowStateManager
// ---------------------------------------------------------------------------

/**
 * Manages deterministic phase transitions and persists state to disk.
 *
 * The in-memory cache is updated on every `getState()` call so that
 * synchronous accessors (`canSpawnSubagents`, `assertCanSpawnSubagents`)
 * always reflect the latest persisted snapshot without an extra read.
 */
interface WorkflowStateManagerOptions {
  /**
   * Gate transitions on prerequisite flags (PHASE_PREREQUISITES). Off by
   * default: legacy callers that declare stage jumps without running every
   * preceding phase keep their existing behavior. Individual transitions can
   * override this via transitionTo's options.
   */
  enforcePrerequisites?: boolean;
}

export class WorkflowStateManager {
  private readonly workflowDir: string;
  private readonly statePath: string;
  private readonly enforcePrerequisites: boolean;
  private cachedState: PhaseState | null = null;
  /**
   * N01: host-injected workspace fingerprint provider (see
   * setFingerprintCapture). When set, every successful forward transition
   * captures a snapshot at the phase boundary and persists it with the phase
   * state. Never set by the machine itself — the host (WorkflowManager)
   * injects the fs/git-backed capture.
   */
  private fingerprintCapture: WorkspaceFingerprintProvider | undefined;
  /**
   * N01: host-injected workspace scope enforcer (see setScopeEnforcer). When
   * set, every successful forward transition runs it AFTER the boundary
   * fingerprint is persisted. Unlike the capture (best-effort), a throwing
   * enforcer REJECTS the transition — the fail-closed enforcement path.
   */
  private scopeEnforcer: WorkspaceScopeEnforcer | undefined;
  /**
   * Serialize writes originating from this manager instance. Concurrent
   * `setState`/`transitionTo`/`approvePlan` calls on the same state machine
   * are applied one after another instead of racing on the read-merge-write
   * sequence, so no caller's partial update is silently overwritten by a peer
   * that read the same pre-write snapshot. Each write still verifies the
   * on-disk generation to guard against writers from other processes.
   */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(workflowDir: string = ".pi/workflows", options: WorkflowStateManagerOptions = {}) {
    this.workflowDir = workflowDir;
    this.statePath = join(workflowDir, "active-state.json");
    this.enforcePrerequisites = options.enforcePrerequisites ?? false;
  }

  // -----------------------------------------------------------------------
  // State access
  // -----------------------------------------------------------------------

  /**
   * Read the current phase state from disk, normalizing stale or hand-edited
   * sidecar content to defaults. Does not touch the in-memory cache — callers
   * that want the cache refreshed use getState().
   */
  private async readStateFromDisk(): Promise<PhaseState> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      return normalizePhaseState(JSON.parse(raw));
    } catch {
      // File missing, unreadable, or not JSON — start from defaults
      return createDefaultState();
    }
  }

  /**
   * Read the current phase state from disk.
   * Returns a default state when the file does not exist or is malformed.
   * Always refreshes the in-memory cache.
   */
  async getState(): Promise<PhaseState> {
    this.cachedState = await this.readStateFromDisk();
    return this.cachedState;
  }

  /**
   * Merge partial state into the current snapshot and persist atomically.
   *
   * Concurrency: each write is serialized within this manager instance, so
   * concurrent calls on the same state machine apply one after another instead
   * of racing on the read-merge-write sequence. Within a write, compare-and-swap
   * is enforced via the persisted `version` generation: the on-disk generation
   * captured BEFORE merging is the value our write must advance. After the
   * atomic rename, the on-disk generation is re-read; if it no longer equals the
   * generation we just wrote, a concurrent writer (from another process) landed
   * between our read and our rename, and the merge is retried on top of the
   * newer snapshot — so no update is lost. The generation check replaces the
   * earlier post-write field-equality self-check, which passed whenever a
   * writer read back its own value even as a peer was about to clobber it.
   */
  async setState(state: Partial<PhaseState>): Promise<void> {
    const run = this.writeChain.then(() => this.applyStateUpdate(state));
    // Detach the chain from this run's outcome so a rejected write does not
    // permanently poison subsequent writes on the same instance.
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  /**
   * Single compare-and-swap attempt loop for {@link setState}, expected to run
   * serialized against other writes from this instance by {@link setState}.
   */
  private async applyStateUpdate(state: Partial<PhaseState>): Promise<void> {
    await mkdir(this.workflowDir, { recursive: true });

    for (let attempt = 0; attempt < MAX_SET_STATE_ATTEMPTS; attempt++) {
      // Snapshot the on-disk generation BEFORE merging. This is the
      // optimistic-lock token our write must advance.
      const current = await this.readStateFromDisk();
      const baseVersion = current.version;
      const merged: PhaseState = {
        ...current,
        ...state,
        version: baseVersion + 1,
        updatedAt: new Date().toISOString(),
      };

      const tmpPath = `${this.statePath}.${randomUUID()}.${process.pid}.tmp`;
      try {
        await writeFile(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
        await rename(tmpPath, this.statePath);
      } catch (error) {
        // Clean up the unique temp file, then retry the whole round-trip — a
        // transient failure (e.g. EBUSY on Windows while a reader holds the
        // file) is not a reason to drop the update.
        await rm(tmpPath, { force: true }).catch(() => undefined);
        if (attempt === MAX_SET_STATE_ATTEMPTS - 1) {
          throw new WorkflowError(
            `setState failed after ${MAX_SET_STATE_ATTEMPTS} attempts: ${error instanceof Error ? error.message : String(error)}`,
            WorkflowErrorCode.PERSISTENCE_ERROR,
            { recoverable: true },
          );
        }
        continue;
      }

      // Optimistic-lock verification: the on-disk generation must equal the one
      // we just wrote. A different value means a concurrent writer (from
      // another process) renamed over our commit either before or after our
      // rename, so re-merge on top of the newer snapshot and retry.
      const onDisk = await this.readStateFromDisk();
      if (onDisk.version === merged.version) {
        this.cachedState = merged;
        return;
      }
    }

    throw new WorkflowError(
      `setState could not converge after ${MAX_SET_STATE_ATTEMPTS} concurrent-write attempts`,
      WorkflowErrorCode.PERSISTENCE_ERROR,
      { recoverable: true },
    );
  }

  /**
   * N01: inject (or replace) the host-side workspace fingerprint provider. The
   * machine calls it after each successful forward transition and persists the
   * captured snapshot with the phase state (see recordFingerprint). Idempotent:
   * the provider is shared per machine across runs; re-injection just replaces
   * it.
   */
  setFingerprintCapture(provider: WorkspaceFingerprintProvider): void {
    this.fingerprintCapture = provider;
  }

  /**
   * N01: inject (or replace) the host-side workspace scope enforcer. The
   * machine calls it after each successful forward transition's fingerprint is
   * persisted and passes the boundary check (stage + previous/next snapshots);
   * the host decides flag/reject/confirm. Idempotent like the capture
   * provider: shared per machine across runs; re-injection just replaces it.
   */
  setScopeEnforcer(enforcer: WorkspaceScopeEnforcer): void {
    this.scopeEnforcer = enforcer;
  }

  /**
   * N01: persist one scope-assertion outcome with the phase state. Forward-only
   * exactly like recordFingerprint: a phase's record is written once and never
   * overwritten (a resumed run that re-crosses the same boundary re-asserts
   * against the SAME persisted diff — the enforcer's reject/approve decision is
   * deterministic on replay). Merged inside the write chain (serialized with
   * setState/transitionTo/recordFingerprint on this instance).
   */
  async recordScopeViolations(phase: PhaseStage, record: ScopeViolationRecord): Promise<void> {
    const run = this.writeChain.then(async () => {
      const current = await this.readStateFromDisk();
      const existing = current.scopeViolations ?? {};
      if (existing[phase] !== undefined) return;
      await this.applyStateUpdate({ scopeViolations: { ...existing, [phase]: record } });
    });
    // Detach the chain from this run's outcome (same policy as setState).
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  /**
   * N01: persist one workspace fingerprint with the phase state. Forward-only:
   * an entry for a phase is written exactly once (a repeat capture of the same
   * phase is a no-op), and a phase below the highest already recorded is
   * refused — so pause/resume cycles can add NEW boundary snapshots but never
   * regress or rewrite history. Merged inside the write chain (serialized with
   * setState/transitionTo on this instance) so concurrent transitions on a
   * shared machine can't drop each other's snapshots; the CAS loop still
   * guards cross-process writers.
   */
  async recordFingerprint(fingerprint: WorkspaceFingerprint): Promise<void> {
    const run = this.writeChain.then(async () => {
      const current = await this.readStateFromDisk();
      const existing = current.fingerprints ?? {};
      const highest = Math.max(0, ...Object.keys(existing).map(Number));
      // Forward-only: never record a phase below the newest snapshot, and
      // never overwrite a phase already captured.
      if (fingerprint.phase < highest || existing[fingerprint.phase] !== undefined) return;
      await this.applyStateUpdate({ fingerprints: { ...existing, [fingerprint.phase]: fingerprint } });
    });
    // Detach the chain from this run's outcome (same policy as setState).
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  // -----------------------------------------------------------------------
  // Phase transitions
  // -----------------------------------------------------------------------

  /**
   * Advance to `phase` if it is strictly greater than the current phase.
   * Throws PHASE_TRANSITION_INVALID on backward or no-op transitions.
   *
   * When prerequisite enforcement is active (constructor option or the per-call
   * override), the flags produced by earlier phases become real gates: entry
   * into a phase with unmet prerequisites throws PHASE_TRANSITION_INVALID (or
   * APPROVAL_REQUIRED when human approval is the missing gate).
   */
  async transitionTo(phase: PhaseStage, options?: { enforcePrerequisites?: boolean }): Promise<void> {
    const current = await this.getState();

    if (phase <= current.activePhase) {
      throw new WorkflowError(
        `Invalid phase transition: cannot move from Phase ${current.activePhase} to Phase ${phase}. Only forward transitions are allowed.`,
        WorkflowErrorCode.PHASE_TRANSITION_INVALID,
        {
          recoverable: false,
          details: {
            code: PHASE_TRANSITION_INVALID,
            from: current.activePhase,
            to: phase,
          },
        },
      );
    }

    const enforce = options?.enforcePrerequisites ?? this.enforcePrerequisites;
    if (enforce) {
      const unmet = PHASE_PREREQUISITES[phase].filter((prerequisite) => !current[prerequisite.flag]);
      if (unmet.length > 0) {
        const approvalBlocked = unmet.some((prerequisite) => prerequisite.flag === "humanApproved");
        throw new WorkflowError(
          `Cannot transition to Phase ${phase}: prerequisite(s) unmet — ${unmet
            .map((prerequisite) => prerequisite.description)
            .join("; ")}.`,
          approvalBlocked ? WorkflowErrorCode.APPROVAL_REQUIRED : WorkflowErrorCode.PHASE_TRANSITION_INVALID,
          {
            recoverable: false,
            details: {
              code: approvalBlocked ? APPROVAL_REQUIRED : PHASE_TRANSITION_INVALID,
              from: current.activePhase,
              to: phase,
              unmet: unmet.map((prerequisite) => prerequisite.flag),
            },
          },
        );
      }
    }

    await this.setState({ activePhase: phase });
    // N01: workspace fingerprint at the phase boundary (host-injected capture).
    // Best-effort: a failing capture must never fail a transition the machine
    // already committed — the snapshot is diagnostic evidence, not a gate.
    let fingerprint: WorkspaceFingerprint | undefined;
    if (this.fingerprintCapture) {
      try {
        const captured = await this.fingerprintCapture(phase);
        if (captured) {
          await this.recordFingerprint(captured);
          fingerprint = captured;
        }
      } catch {
        // capture is diagnostic only
      }
    }
    // N01: scope enforcement at the phase boundary (host-injected enforcer).
    // Deliberately OUTSIDE the capture's best-effort try/catch: the enforcer's
    // diff + violation assertion is the gate itself, so a throwing enforcer
    // (fail-closed reject, or a ui.confirm denial) genuinely rejects this
    // transition and surfaces at the run's flush point. The diff baseline is
    // the most recent persisted snapshot BELOW this stage — forward-only, so
    // the same boundary re-asserted on resume sees the same inputs.
    if (this.scopeEnforcer && fingerprint) {
      const state = await this.getState();
      const snapshots = state.fingerprints ?? {};
      let previous: WorkspaceFingerprint | undefined;
      let highest = -1;
      for (const [key, entry] of Object.entries(snapshots)) {
        const stage = Number(key);
        if (Number.isInteger(stage) && stage >= 0 && stage < phase && entry && stage > highest) {
          highest = stage;
          previous = entry;
        }
      }
      await this.scopeEnforcer({ stage: phase, previous, next: fingerprint });
    }
  }

  /**
   * Record human approval of the plan.
   * Only valid when the active phase is exactly 2.
   * Throws APPROVAL_REQUIRED if called from any other phase.
   */
  /**
   * Record that the Phase 0 wayfinder step completed — the prerequisite for
   * entering Phase 1 (prewalk). Set by the run-entry pipeline once the
   * decision map's fog is dissolved (or the prompt was never foggy);
   * PHASE_PREREQUISITES[1] gates on this flag.
   */
  async markWayfinderComplete(): Promise<void> {
    await this.setState({ wayfinderComplete: true });
  }

  /**
   * Record that the Phase 1 prewalk step produced a blueprint — the
   * prerequisite for entering Phase 2 (plannotator review). Set by the
   * run-entry pipeline after the blueprint lands in
   * `.pi/workflows/plans/<run-id>.json`; PHASE_PREREQUISITES[2] gates on it.
   */
  async markPrewalkComplete(): Promise<void> {
    await this.setState({ prewalkComplete: true });
  }

  async approvePlan(): Promise<void> {
    const current = await this.getState();

    if (current.activePhase !== 2) {
      throw new WorkflowError(
        `Plan approval is only valid in Phase 2 (current phase: ${current.activePhase}).`,
        WorkflowErrorCode.APPROVAL_REQUIRED,
        {
          recoverable: false,
          details: {
            code: APPROVAL_REQUIRED,
            currentPhase: current.activePhase,
          },
        },
      );
    }

    await this.setState({ humanApproved: true });
  }

  // -----------------------------------------------------------------------
  // Subagent gating (synchronous — relies on cached state)
  // -----------------------------------------------------------------------

  /**
   * Returns `true` only when Phase 3 is active AND a human has approved the
   * plan.  Uses the in-memory cache populated by the most recent `getState()`
   * call; returns `false` when no state has been loaded yet (conservative).
   */
  canSpawnSubagents(): boolean {
    if (!this.cachedState) return false;
    return this.cachedState.activePhase === 3 && this.cachedState.humanApproved;
  }

  /**
   * Throws SUBAGENT_SPAWN_BLOCKED when `canSpawnSubagents()` is `false`.
   * Safe to call without a preceding `getState()` — falls back to defaults.
   */
  assertCanSpawnSubagents(): void {
    if (!this.canSpawnSubagents()) {
      const state = this.cachedState ?? createDefaultState();
      throw new WorkflowError(
        `Cannot spawn subagents: requires Phase 3 with human approval (current: Phase ${state.activePhase}, approved: ${state.humanApproved}).`,
        WorkflowErrorCode.SUBAGENT_SPAWN_BLOCKED,
        {
          recoverable: false,
          details: {
            code: SUBAGENT_SPAWN_BLOCKED,
            currentPhase: state.activePhase,
            humanApproved: state.humanApproved,
          },
        },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// PhaseGuard
// ---------------------------------------------------------------------------

/**
 * Wraps tool definitions with phase-aware execution guards.
 *
 * Internal helper: NOT part of the package's public barrel exports (see
 * src/index.ts). The single enforced gate in the product is the one inside
 * `agent()` (`assertPhaseGateOpen` in runWorkflow, workflow.ts) — it uses the
 * same predicate (`canSpawnSubagents`) and error code (`SUBAGENT_SPAWN_BLOCKED`)
 * as this wrapper, so behavior cannot drift between the two paths. This class
 * exists for embedders/tests that need the same guard on a tool outside
 * `agent()` without re-implementing the check.
 *
 * Primary use-case: intercept subagent-spawning tools before Phase 3 so the
 * LLM cannot bypass the deterministic phase ordering.
 */
export class PhaseGuard {
  private readonly stateManager: WorkflowStateManager;

  constructor(stateManager: WorkflowStateManager) {
    this.stateManager = stateManager;
  }

  /**
   * Return a new `ToolDefinition` whose `execute` method refreshes the
   * phase state cache and blocks execution unless subagent spawning is
   * currently allowed.
   *
   * All non-execution properties (name, label, description, parameters,
   * renderers, etc.) are shallow-copied from the original tool.
   */
  wrapTool(tool: ToolDefinition): ToolDefinition {
    const stateManager = this.stateManager;

    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        // Refresh cache so synchronous checks reflect latest persisted state
        await stateManager.getState();

        if (!stateManager.canSpawnSubagents()) {
          const state = await stateManager.getState();
          throw new WorkflowError(
            `Tool "${tool.name}" is gated: subagent spawning requires Phase 3 with human approval (current: Phase ${state.activePhase}, approved: ${state.humanApproved}).`,
            WorkflowErrorCode.SUBAGENT_SPAWN_BLOCKED,
            {
              recoverable: false,
              details: {
                code: SUBAGENT_SPAWN_BLOCKED,
                toolName: tool.name,
                currentPhase: state.activePhase,
                humanApproved: state.humanApproved,
              },
            },
          );
        }

        return tool.execute(toolCallId, params, signal, onUpdate, ctx);
      },
    };
  }
}
