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
export interface PhasePrerequisite {
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

  return {
    activePhase,
    humanApproved: asBoolean("humanApproved"),
    wayfinderComplete: asBoolean("wayfinderComplete"),
    prewalkComplete: asBoolean("prewalkComplete"),
    plannotatorSubmitted: asBoolean("plannotatorSubmitted"),
    updatedAt,
  };
}

/** Compare two normalized states structurally (field order is stable). */
function sameState(a: PhaseState, b: PhaseState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
export interface WorkflowStateManagerOptions {
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
   * Concurrency: compare-and-swap. Every attempt re-reads the disk snapshot,
   * merges the caller's patch on top, writes to a UNIQUE temp file (a shared
   * fixed `.tmp` name would let concurrent writers clobber each other's buffer),
   * renames it into place, then verifies the on-disk state matches what was
   * written. If a concurrent writer slipped in between the read and the rename,
   * the verification fails and the merge is retried against the newer snapshot,
   * so no update is lost.
   */
  async setState(state: Partial<PhaseState>): Promise<void> {
    await mkdir(this.workflowDir, { recursive: true });

    for (let attempt = 0; attempt < MAX_SET_STATE_ATTEMPTS; attempt++) {
      const current = await this.readStateFromDisk();
      const merged: PhaseState = {
        ...current,
        ...state,
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

      // Compare-and-swap verification: our write must be what's on disk.
      const onDisk = await this.readStateFromDisk();
      if (sameState(onDisk, merged)) {
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
  }

  /**
   * Record human approval of the plan.
   * Only valid when the active phase is exactly 2.
   * Throws APPROVAL_REQUIRED if called from any other phase.
   */
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
