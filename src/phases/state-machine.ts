/**
 * Cache-friendly state machine and tool guardrails for deterministic phase
 * ordering in pi-dynamic-workflows.
 *
 * Phases progress strictly forward: 0 → 1 → 2 → 3.
 * Subagent-spawning tools are blocked until Phase 3 with human approval.
 * State is persisted to .pi/workflows/active-state.json for crash recovery.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
export class WorkflowStateManager {
  private readonly workflowDir: string;
  private readonly statePath: string;
  private cachedState: PhaseState | null = null;

  constructor(workflowDir: string = ".pi/workflows") {
    this.workflowDir = workflowDir;
    this.statePath = join(workflowDir, "active-state.json");
  }

  // -----------------------------------------------------------------------
  // State access
  // -----------------------------------------------------------------------

  /**
   * Read the current phase state from disk.
   * Returns a default state when the file does not exist or is malformed.
   * Always refreshes the in-memory cache.
   */
  async getState(): Promise<PhaseState> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as PhaseState;
      // Defensive: ensure required fields exist
      this.cachedState = { ...createDefaultState(), ...parsed };
      return this.cachedState;
    } catch {
      // File missing or unreadable — start from defaults
      this.cachedState = createDefaultState();
      return this.cachedState;
    }
  }

  /**
   * Merge partial state into the current snapshot and persist atomically.
   *
   * Atomic semantics: writes to a temp file first, then renames so readers
   * never observe a half-written JSON blob.
   */
  async setState(state: Partial<PhaseState>): Promise<void> {
    const current = await this.getState();
    const merged: PhaseState = {
      ...current,
      ...state,
      updatedAt: new Date().toISOString(),
    };

    await mkdir(this.workflowDir, { recursive: true });

    const tmpPath = `${this.statePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
    await rename(tmpPath, this.statePath);

    this.cachedState = merged;
  }

  // -----------------------------------------------------------------------
  // Phase transitions
  // -----------------------------------------------------------------------

  /**
   * Advance to `phase` if it is strictly greater than the current phase.
   * Throws PHASE_TRANSITION_INVALID on backward or no-op transitions.
   */
  async transitionTo(phase: PhaseStage): Promise<void> {
    const current = await this.getState();

    if (phase <= current.activePhase) {
      throw new WorkflowError(
        `Invalid phase transition: cannot move from Phase ${current.activePhase} to Phase ${phase}. Only forward transitions are allowed.`,
        WorkflowErrorCode.UNKNOWN,
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
        WorkflowErrorCode.UNKNOWN,
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
        WorkflowErrorCode.UNKNOWN,
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
            WorkflowErrorCode.UNKNOWN,
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
