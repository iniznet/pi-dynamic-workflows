/**
 * V2-P10 — recorded-replay simulation harness.
 *
 * Record a real run's agent() call→result pairs (the journal: call hashes,
 * results, store deltas, per-call artifacts) into a CANNED fixture, then replay
 * workflow scripts against those CACHED results with a mock agent executor — no
 * subagent is ever launched, nothing is persisted, nothing is spent. This gives
 * penny-cost iteration on scripts, golden-master regression for the built-ins,
 * and a no-launch CI surface.
 *
 * Design notes:
 *  - The replay reuses the runtime's own resume machinery: `replayWorkflow`
 *    feeds the fixture as a `resumeJournal` (the same map the resume path
 *    builds from a persisted journal — `buildResumeJournal` in
 *    run-persistence.ts) and forces the run under the fixture's recorded
 *    runId, so the cache-hit path at workflow.ts:2908 returns `cached.result`
 *    byte-identically and fires the same onAgentStart/onAgentEnd callbacks.
 *  - Safety: every call's recomputed hashAgentCall hash must equal the recorded
 *    hash. A changed script/args/config makes the hash differ → the cache
 *    misses → the injected replay agent THROWS `REPLAY_MISS` instead of
 *    launching. A replay never fabricates a result for different inputs.
 *  - Determinism: fixtures are pure functions of the journal (no wall-clock
 *    timestamps), and replay introduces NO new agent()/parallel()/verify()/
 *    global option — `mainModel`/`args` flow through the existing
 *    `WorkflowRunOptions` fields, so hashAgentCall's field set is untouched.
 */
import type { AgentUsage, OperationTrace } from "./agent.js";
import { isWorkflowError, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { buildResumeJournal, readRunJournalForReplay } from "./run-persistence.js";
import {
  type JournalEntry,
  runWorkflow,
  type WorkflowAgentRunner,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from "./workflow.js";

/** Schema version of the canned fixture — bump on any breaking field change. */
export const REPLAY_FIXTURE_SCHEMA_VERSION = 1 as const;

/**
 * One canned agent() call→result pair. Carries exactly the journal fields the
 * replay needs (index/hash/result/model/store delta/commit ordinal) plus the
 * per-call artifacts (tokens/tokenUsage/operations) so a fixture is also a
 * self-contained record of the recorded call. JSON-normalized at build time.
 */
export interface ReplayFixtureEntry {
  /** Deterministic call index (the resume journal's position within its frame). */
  index: number;
  /**
   * Frame runId of the recorded call. Absent for the top-level frame (kept
   * compact; reconstruction treats an absent runId as the fixture's own runId,
   * exactly like a legacy JournalEntry).
   */
  runId?: string;
  /** sha256 of the call's identity (hashAgentCall) — the replay match key. */
  hash: string;
  /** The recorded agent result, replayed verbatim on a match. */
  result: unknown;
  /** The model the recorded agent actually ran on (replayed label). */
  model?: string;
  /** Final-attempt scalar tokens (artifacts only — replay charges 0). */
  tokens?: number;
  /** Final-attempt usage breakdown (artifacts only). */
  tokenUsage?: AgentUsage;
  /** SharedStore write delta, replayed additively at the next live boundary. */
  storeDelta?: Record<string, unknown>;
  /** Store commit ordinal (E2 commit-order replay). */
  storeCommitSeq?: number;
  /** Typed operation traces of the recorded call (artifacts). */
  operations?: OperationTrace[];
}

/**
 * Canonical canned fixture: a versioned, JSON-safe snapshot of one run's
 * agent() call→result pairs plus the run identity the replay must reproduce
 * (runId, args, mainModel) so recomputed resume hashes can match.
 */
export interface ReplayFixture {
  schemaVersion: typeof REPLAY_FIXTURE_SCHEMA_VERSION;
  /** Recorded workflow name (meta.name) — the fixture's human label. */
  name: string;
  /** Recorded workflow description (meta.description), when present. */
  description?: string;
  /**
   * The recorded run's id. Replay MUST execute under this id: the resume
   * journal is keyed by `${frameRunId}:${index}` and the top-level frame's
   * lookups use its own runId (a nested workflow() derives child ids from it
   * deterministically), so any other id would miss every call.
   */
  runId: string;
  /**
   * The recorded run's `args`. Replay defaults to these so the script sees the
   * same inputs (an explicit replay-time `args` overrides — the caller's win).
   */
  args?: unknown;
  /**
   * The recorded run's session main model — one of hashAgentCall's inputs
   * (the untagged/config-less fallback). Captured so a replay passes the same
   * knob and unchanged calls keep matching across sessions.
   */
  mainModel?: string;
  /** Canned call→result pairs, sorted by (frameRunId, index). */
  entries: ReplayFixtureEntry[];
}

/** The raw material a fixture is built from — a run identity plus its journal. */
export interface ReplayFixtureSource {
  runId: string;
  name: string;
  description?: string;
  args?: unknown;
  mainModel?: string;
  journal: JournalEntry[];
}

/**
 * Build a canonical canned fixture from a recorded run's journal. Pure function
 * of the journal: no wall-clock stamps, sorted by (frameRunId, index), and
 * JSON-normalized (undefined fields dropped) so building the same journal twice
 * yields byte-identical bytes — the golden-master property.
 */
export function buildReplayFixture(source: ReplayFixtureSource): ReplayFixture {
  const entries: ReplayFixtureEntry[] = [...source.journal]
    .sort((a, b) => {
      const frameA = a.runId ?? source.runId;
      const frameB = b.runId ?? source.runId;
      if (frameA !== frameB) return frameA < frameB ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => ({
      index: entry.index,
      // Top-level-frame entries are kept compact: an absent runId reconstructs
      // to the fixture's own runId (the same legacy-degradation as JournalEntry).
      ...(entry.runId !== undefined && entry.runId !== source.runId ? { runId: entry.runId } : {}),
      hash: entry.hash,
      result: entry.result,
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.tokens !== undefined ? { tokens: entry.tokens } : {}),
      ...(entry.tokenUsage !== undefined ? { tokenUsage: entry.tokenUsage } : {}),
      ...(entry.storeDelta !== undefined && entry.storeDelta !== null && Object.keys(entry.storeDelta).length > 0
        ? { storeDelta: entry.storeDelta }
        : {}),
      ...(entry.storeCommitSeq !== undefined ? { storeCommitSeq: entry.storeCommitSeq } : {}),
      ...(entry.operations !== undefined && entry.operations.length > 0 ? { operations: entry.operations } : {}),
    }));
  return JSON.parse(
    JSON.stringify({
      schemaVersion: REPLAY_FIXTURE_SCHEMA_VERSION,
      name: source.name,
      ...(source.description !== undefined ? { description: source.description } : {}),
      runId: source.runId,
      ...(source.args !== undefined ? { args: source.args } : {}),
      ...(source.mainModel !== undefined ? { mainModel: source.mainModel } : {}),
      entries,
    }),
  ) as ReplayFixture;
}

/**
 * Inverse of buildReplayFixture: reconstruct the JournalEntry[] a fixture was
 * built from (entry.runId absent → top-level, resolving to the fixture's
 * runId at resume-map time, exactly like a legacy journal).
 */
export function replayFixtureToJournalEntries(fixture: ReplayFixture): JournalEntry[] {
  return fixture.entries.map((entry) => ({
    index: entry.index,
    ...(entry.runId !== undefined ? { runId: entry.runId } : {}),
    hash: entry.hash,
    result: entry.result,
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(entry.tokens !== undefined ? { tokens: entry.tokens } : {}),
    ...(entry.tokenUsage !== undefined ? { tokenUsage: entry.tokenUsage } : {}),
    ...(entry.storeDelta !== undefined ? { storeDelta: entry.storeDelta } : {}),
    ...(entry.storeCommitSeq !== undefined ? { storeCommitSeq: entry.storeCommitSeq } : {}),
    ...(entry.operations !== undefined ? { operations: entry.operations } : {}),
  }));
}

/**
 * The resume-replay map a fixture replays through: the same `${runId}:${index}`
 * keying the live resume path uses, so the runtime's cache-hit check at
 * workflow.ts:2908 matches (hash-verified) and returns cached results.
 */
export function createReplayResumeJournal(fixture: ReplayFixture): Map<string, JournalEntry> {
  return buildResumeJournal(fixture.runId, replayFixtureToJournalEntries(fixture));
}

/** A live agent() call the replay refused to serve (recorded for diagnostics). */
export interface ReplayMiss {
  /** The agent's prompt (the identity text whose hash did not match). */
  prompt: string;
  /** The agent's label, when the script set one. */
  label?: string;
  /**
   * The run options the runtime passed to the runner (kept untyped — the
   * runner's own parameter is structural; nothing here is ever replayed).
   */
  options: unknown;
}

/** Structural read of the runner's options parameter (only what the miss reports). */
function missLabel(runOptions: unknown): string | undefined {
  if (typeof runOptions !== "object" || runOptions === null) return undefined;
  const label = (runOptions as { label?: unknown }).label;
  return typeof label === "string" ? label : undefined;
}

/** Options for createReplayAgent(). */
export interface ReplayAgentOptions {
  /**
   * Optional fixture for a richer miss message (name/runId of what is being
   * replayed against). Pure diagnostics — never affects replay decisions.
   */
  fixture?: ReplayFixture;
  /** Invoked once per refused live call (the harness's miss telescope). */
  onMiss?: (miss: ReplayMiss) => void;
}

/**
 * The mock agent executor for a replay: it NEVER runs a subagent. The runtime
 * only invokes it on a genuine cache miss (no fixture entry for the call, or
 * the recomputed hashAgentCall hash differs), so it throws a non-recoverable
 * REPLAY_MISS error — the simulation fails loudly instead of fabricating a
 * result for different inputs.
 */
export function createReplayAgent(options: ReplayAgentOptions = {}): WorkflowAgentRunner {
  return {
    async run(prompt: string, runOptions?: unknown) {
      const label = missLabel(runOptions);
      options.onMiss?.({ prompt, label, options: runOptions });
      const fixtureRef = options.fixture ? ` (fixture "${options.fixture.name}", run ${options.fixture.runId})` : "";
      const labelRef = label ? ` — agent "${label}"` : "";
      throw new WorkflowError(
        `replay miss${fixtureRef}: no recorded result matches this agent() call. ` +
          `The script, its args, or the run's model/tier configuration changed since the fixture was ` +
          `recorded, and the replay harness serves CACHED results only — it never launches a subagent. ` +
          `Re-record the fixture from a fresh run (or run live) to pick up the change.${labelRef}`,
        WorkflowErrorCode.REPLAY_MISS,
        { recoverable: false, agentLabel: label, details: { prompt } },
      );
    },
  };
}

/** Whether an error is a replay miss (a refused live call during a replay). */
export function isReplayMiss(error: unknown): error is WorkflowError {
  return isWorkflowError(error) && error.code === WorkflowErrorCode.REPLAY_MISS;
}

/**
 * Replay a workflow script against a canned fixture's cached results.
 *
 * Executes the FULL script body (phases, parallel/pipeline fan-outs, store
 * reads, result composition) over the fixture's call→result pairs: every
 * agent() call whose hash matches a recorded entry returns that cached result
 * byte-identically; a changed/new call throws REPLAY_MISS instead of launching.
 * Nothing is persisted (persistLogs defaults to false) and nothing is spent
 * (replayed calls charge zero tokens, exactly like resume cache hits).
 *
 * The replay forces `runId` to the fixture's recorded id (the resume journal is
 * keyed against it) and defaults `args`/`mainModel` to the fixture's recorded
 * values — the explicit `options` always win over those defaults.
 */
export async function replayWorkflow<T = unknown>(
  script: string,
  fixture: ReplayFixture,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  return runWorkflow<T>(script, {
    ...options,
    runId: fixture.runId,
    args: options.args ?? fixture.args,
    mainModel: options.mainModel ?? fixture.mainModel,
    agent: options.agent ?? createReplayAgent({ fixture }),
    resumeJournal: createReplayResumeJournal(fixture),
    // A simulation never persists logs.
    persistLogs: options.persistLogs ?? false,
  });
}

/** Replay a script against a raw recorded journal (builds the fixture first). */
export async function replayWorkflowFromJournal<T = unknown>(
  script: string,
  source: ReplayFixtureSource,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  return replayWorkflow<T>(script, buildReplayFixture(source), options);
}

/**
 * Build a canned fixture from a PERSISTED run (its journal on disk). Returns
 * null when the run id is unknown. `mainModel` is not persisted in run state,
 * so callers that know the recording session's main model should pass it here
 * to keep untagged/config-less call hashes matchable across sessions.
 */
export async function buildReplayFixtureFromRun(
  runId: string,
  options: { cwd?: string; mainModel?: string; name?: string; description?: string } = {},
): Promise<ReplayFixture | null> {
  const source = readRunJournalForReplay(runId, options.cwd);
  if (!source) return null;
  return buildReplayFixture({
    runId: source.runId,
    name: options.name ?? source.workflowName,
    description: options.description,
    args: source.args,
    mainModel: options.mainModel,
    journal: source.journal,
  });
}

/**
 * Validate an unknown JSON value (e.g. an inline `replayFixture` tool arg) into
 * a typed ReplayFixture. Structural only: schemaVersion/name/runId/entries
 * with numeric index + string hash + a result on every entry. Throws a
 * TypeError naming the offending field — replay never guesses at malformed
 * fixtures.
 */
export function parseReplayFixture(value: unknown): ReplayFixture {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("replay fixture must be a JSON object");
  }
  const candidate = value as Partial<ReplayFixture>;
  if (candidate.schemaVersion !== REPLAY_FIXTURE_SCHEMA_VERSION) {
    throw new TypeError(`replay fixture schemaVersion must be ${REPLAY_FIXTURE_SCHEMA_VERSION}`);
  }
  if (typeof candidate.name !== "string" || candidate.name.length === 0) {
    throw new TypeError("replay fixture must have a non-empty string name");
  }
  if (typeof candidate.runId !== "string" || candidate.runId.length === 0) {
    throw new TypeError("replay fixture must have a non-empty string runId");
  }
  if (!Array.isArray(candidate.entries)) {
    throw new TypeError("replay fixture must have an entries array");
  }
  for (const entry of candidate.entries) {
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError("replay fixture entry must be an object");
    }
    if (typeof entry.index !== "number" || !Number.isInteger(entry.index) || entry.index < 0) {
      throw new TypeError("replay fixture entry must have a non-negative integer index");
    }
    if (typeof entry.hash !== "string" || entry.hash.length === 0) {
      throw new TypeError("replay fixture entry must have a non-empty string hash");
    }
    if (!("result" in entry)) {
      throw new TypeError("replay fixture entry must carry a result");
    }
  }
  return candidate as ReplayFixture;
}

/**
 * The deterministic replay surface for golden-master regression: the script's
 * computed result plus the run's structural outcome (phases/agentCount/failed
 * agents). Deliberately EXCLUDES durationMs (wall clock), tokenUsage and logs
 * (replay cache hits charge zero tokens and produce replay-specific log lines),
 * so a stored golden signature is byte-stable across replays.
 */
export interface ReplaySignature {
  result: unknown;
  phases: string[];
  agentCount: number;
  failedAgents: WorkflowRunResult["failedAgents"];
}

/** Extract the byte-stable golden-master signature from a replay result. */
export function replaySignature(result: WorkflowRunResult): ReplaySignature {
  return {
    result: result.result,
    phases: result.phases,
    agentCount: result.agentCount,
    failedAgents: result.failedAgents,
  };
}

/** Canonical JSON string of a replay signature (the golden-master comparison key). */
export function stringifyReplaySignature(result: WorkflowRunResult): string {
  return JSON.stringify(replaySignature(result));
}
