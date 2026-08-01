/**
 * Configuration constants for pi-dynamic-workflows.
 */

/** Maximum number of agents allowed per workflow run. */
export const MAX_AGENTS_PER_RUN = 1000;

/** Default timeout for a single agent in milliseconds. null means no hard timeout. */
export const DEFAULT_AGENT_TIMEOUT_MS = null;

/**
 * Drain-side backstop deadline in milliseconds. After a workflow script has
 * finished, the top-level run waits up to this long for outstanding (possibly
 * un-awaited) agent() calls to settle before aborting them via the run's fatal
 * controller and completing the run anyway. Guards the drain against the wedge
 * where a signal-ignoring agent with agentTimeoutMs: null would otherwise block
 * run completion forever. Deterministic termination — this is a hard deadline,
 * not a heuristic poll.
 */
export const DRAIN_ABORT_TIMEOUT_MS = 60_000;

/** Maximum concurrent agents (matches Claude Code limit). */
export const MAX_CONCURRENCY = 16;

/**
 * Hard ceiling on live nested workflow() frames, enforced at the vm wrapper —
 * the single choke point every script execution passes through. This is a
 * RUNAWAY guard, not a security boundary: the vm is deliberately not a
 * sandbox, so this only stops runaway recursion from piling frames up
 * unbounded, it makes no isolation promise. The `maxNestedWorkflowDepth`
 * runWorkflow option (default 1, the documented one-level-deep policy) is
 * clamped to at most this value; once a frame's nesting reaches the ceiling
 * the run fails with a clear SCRIPT_VALIDATION_ERROR instead of recursing on.
 */
export const MAX_NESTED_WORKFLOW_DEPTH = 8;

/** Maximum automatic retry attempts after a recoverable agent failure. */
export const MAX_AGENT_RETRIES = 3;

/** Default token budget if none specified. */
export const DEFAULT_TOKEN_BUDGET = null;

/** Legacy project-relative directory for persisted workflow run state. New writes use workflowProjectPaths(). */
export const WORKFLOW_RUNS_DIR = ".pi/workflows/runs";

/** Legacy project-relative directory for saved workflow commands. New writes use workflowProjectPaths(). */
export const WORKFLOW_SAVED_DIR = ".pi/workflows/saved";

/** User-level saved workflows directory. */
export const USER_WORKFLOW_SAVED_DIR = "~/.pi/workflows/saved";

/** User-level model tiers config file, relative to the home directory. */
export const MODEL_TIERS_FILE = ".pi/workflows/model-tiers.json";

/** User-level workflow extension settings file, relative to the home directory. */
export const WORKFLOW_SETTINGS_FILE = ".pi/workflows/settings.json";

/** Default keyword that arms workflows mode from interactive input. */
export const DEFAULT_KEYWORD_TRIGGER_WORD = "workflow";

/** Normalize a user-configured keyword trigger word. */
export function normalizeKeywordTriggerWord(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const word = value.trim();
  if (!word || word.startsWith("/") || /\s/.test(word)) return undefined;
  return word;
}

/**
 * Named workflow subagent definitions directory. Resolved project-relative
 * (cwd/.pi/agents), plus user-level at `~/.pi/agent/agents/` (the primary
 * location, via `getAgentDir()` in agent-registry.ts) with the legacy
 * `~/.pi/agents/` (this constant, home-relative) scanned as a deprecated
 * fallback. Project entries win on name collision, then the primary user
 * location, then the legacy one. Each `*.md` file is an agent definition
 * (frontmatter + body prompt).
 */
export const AGENTS_DIR = ".pi/agents";
