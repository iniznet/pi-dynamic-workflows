/**
 * Per-stage model routing for workflows.
 * Allows different phases to use different models.
 *
 * Single routing authority: task classification (classifyTask) folded in from
 * the retired engine/tier-router stack (P2-1 consolidation) so model routing
 * and tier classification live in one module.
 */

export interface ModelRoute {
  /** Phase name pattern (regex or exact match). */
  phasePattern: string;
  /** Model to use for this phase. */
  model: string;
  /** Whether to use regex matching. */
  useRegex?: boolean;
}

export interface ModelRoutingConfig {
  /** Default model for all phases. */
  defaultModel?: string;
  /** Per-phase model overrides. */
  routes: ModelRoute[];
}

/**
 * Resolve which model to use for a given phase.
 */
export function resolveModelForPhase(phase: string | undefined, config: ModelRoutingConfig): string | undefined {
  if (!phase || !config.routes.length) {
    return config.defaultModel;
  }

  for (const route of config.routes) {
    if (route.useRegex) {
      try {
        const regex = new RegExp(route.phasePattern, "i");
        if (regex.test(phase)) {
          return route.model;
        }
      } catch {
        // Invalid regex, skip
      }
    } else if (phase === route.phasePattern) {
      // Exact, case-sensitive match — phase titles are author-controlled literals,
      // so fuzzy substring matching only caused mis-routes (e.g. "analyze" matching
      // "analyze-deep" or vice-versa). Use the regex branch for fuzzy needs.
      return route.model;
    }
  }

  return config.defaultModel;
}

/**
 * Parse model routing from workflow meta: per-phase models from meta.phases[].model
 * and a top-level default from meta.model (used when no phase route matches).
 */
export function parseModelRoutingFromMeta(
  phases?: Array<{ title: string; model?: string }>,
  defaultModel?: string,
): ModelRoutingConfig {
  const routes: ModelRoute[] = [];

  if (phases) {
    for (const phase of phases) {
      if (phase.model) {
        routes.push({
          phasePattern: phase.title,
          model: phase.model,
        });
      }
    }
  }

  return { defaultModel, routes };
}

// ---------------------------------------------------------------------------
// Task classification (folded from engine/tier-router.ts, P2-1)
// ---------------------------------------------------------------------------

/**
 * Task classification categories derived from phase context and prompt content.
 * Used to determine which model tier should handle a given task.
 */
export enum TaskClassification {
  /** File listings, searches, lightweight reconnaissance. */
  SCAN = "scan",
  /** Code edits, refactoring, implementation work. */
  EDIT = "edit",
  /** Prewalk synthesis, final summary generation — flagship reasoning. */
  SYNTHESIZE = "synthesize",
  /** Code review, analysis, critique — structured reasoning. */
  ANALYZE = "analyze",
}

/** Keywords that signal a scan/search task (case-insensitive substring match). */
const SCAN_KEYWORDS = ["scan", "find", "list", "search", "grep", "glob", "locate", "discover"];

/** Keywords that signal an edit/implementation task. */
const EDIT_KEYWORDS = ["edit", "refactor", "fix", "implement", "write", "create", "update", "modify", "patch", "build"];

/** Keywords that signal a synthesis or high-level analysis task. */
const SYNTHESIZE_KEYWORDS = ["synthesize", "summarize", "prewalk", "final", "consolidate", "aggregate", "overview"];

/** Keywords that signal an analysis/review task. */
const ANALYZE_KEYWORDS = ["analyze", "review", "critique", "audit", "inspect", "evaluate", "assess", "compare"];

/** Phase identifiers that qualify as early reconnaissance phases (0, 1). */
const EARLY_PHASES = new Set(["0", "1", "phase-0", "phase-1", "phase0", "phase1"]);

function matchesAnyKeyword(prompt: string, keywords: readonly string[]): boolean {
  const lower = prompt.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Classify a task based on its workflow phase and prompt content.
 *
 * Classification priority:
 * - Phase 0/1 + scan keywords → SCAN
 * - Phase 0/1 + edit keywords → EDIT
 * - Phase 1 + synthesize/analyze keywords → SYNTHESIZE
 * - Prompt-level synthesize keywords (any phase) → SYNTHESIZE
 * - Prompt-level analyze keywords (any phase) → ANALYZE
 * - Prompt-level scan keywords (any phase) → SCAN
 * - Default → EDIT
 */
export function classifyTask(phase: string, prompt: string): TaskClassification {
  const isEarlyPhase = EARLY_PHASES.has(phase);

  // Early phases: prioritize scan/edit classification
  if (isEarlyPhase) {
    if (matchesAnyKeyword(prompt, SCAN_KEYWORDS)) return TaskClassification.SCAN;
    if (matchesAnyKeyword(prompt, EDIT_KEYWORDS)) return TaskClassification.EDIT;
    if (matchesAnyKeyword(prompt, SYNTHESIZE_KEYWORDS)) return TaskClassification.SYNTHESIZE;
    if (matchesAnyKeyword(prompt, ANALYZE_KEYWORDS)) return TaskClassification.ANALYZE;
  }

  // Any phase: keyword-driven classification
  if (matchesAnyKeyword(prompt, SYNTHESIZE_KEYWORDS)) return TaskClassification.SYNTHESIZE;
  if (matchesAnyKeyword(prompt, ANALYZE_KEYWORDS)) return TaskClassification.ANALYZE;
  if (matchesAnyKeyword(prompt, SCAN_KEYWORDS)) return TaskClassification.SCAN;
  if (matchesAnyKeyword(prompt, EDIT_KEYWORDS)) return TaskClassification.EDIT;

  return TaskClassification.EDIT;
}

/**
 * Map a task classification to the model tier whose capability profile fits.
 * Powers the prompt-aware tier fallback (see tierNameForTask): a cheap scan
 * routes to "small", a heavy synthesis to "big".
 */
export function tierNameForClassification(classification: TaskClassification): "small" | "medium" | "big" {
  switch (classification) {
    case TaskClassification.SCAN:
      return "small";
    case TaskClassification.SYNTHESIZE:
    case TaskClassification.ANALYZE:
      return "big";
    case TaskClassification.EDIT:
      return "medium";
  }
}

/**
 * Classify a phase+prompt and return the model tier that fits. Gives the tier
 * fallback a prompt-aware default when no model-tiers.json is configured, so
 * a reconnaissance phase and a final synthesis no longer collapse onto the
 * same fallback model.
 */
export function tierNameForTask(phase: string, prompt: string): "small" | "medium" | "big" {
  return tierNameForClassification(classifyTask(phase, prompt));
}
