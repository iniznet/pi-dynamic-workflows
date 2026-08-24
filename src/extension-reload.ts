import packageJson from "../package.json" with { type: "json" };
import type { EffortState } from "./effort-command.js";
import type { WorkflowManager } from "./workflow-manager.js";

/**
 * Live extension state that Pi may hand from one extension generation to the
 * next during `/reload`. This deliberately stays process-local: run snapshots
 * and journals already provide the durable cold-start path, while the live
 * manager is what owns in-flight promises, abort controllers, and event streams.
 */
export const WORKFLOW_EXTENSION_VERSION = packageJson.version;

export interface WorkflowReloadRuntime {
  cwd: string;
  /** Package version that created this manager. Only an exact match is retained. */
  extensionVersion: string;
  manager: WorkflowManager;
  effort: EffortState;
  /**
   * Deterministic dispose fanout for resources owned by the extension
   * generation that created this runtime — timers, the host-tool gateway, and
   * any on-demand bridge (e.g. a plannotator review server, whose close() ends
   * its SSE responses and closes the server). Runs at most once per runtime
   * object (stage, replacement, discard, or TTL expiry), and must be
   * idempotent. The live manager itself is deliberately NOT disposed here: a
   * compatible reload claims it and reconfigures it.
   */
  dispose?: () => void;
}

interface WorkflowRuntimeClaim {
  compatible?: WorkflowReloadRuntime;
  versionMismatch?: WorkflowReloadRuntime;
}

interface HandoffEntry {
  runtime: WorkflowReloadRuntime;
  timer: ReturnType<typeof setTimeout>;
}

const RELOAD_HANDOFF_KEY = Symbol.for("@quintinshaw/pi-dynamic-workflows:reload-handoffs");
const RELOAD_HANDOFF_TTL_MS = 30_000;

/** Runtimes whose dispose fanout has already run; guarantees at-most-once. */
const disposedRuntimes = new WeakSet<WorkflowReloadRuntime>();

function disposeRuntimeOnce(runtime: WorkflowReloadRuntime): void {
  if (!runtime.dispose || disposedRuntimes.has(runtime)) return;
  disposedRuntimes.add(runtime);
  runtime.dispose();
}

function handoffs(): Map<string, HandoffEntry> {
  const root = globalThis as typeof globalThis & { [RELOAD_HANDOFF_KEY]?: Map<string, HandoffEntry> };
  const existing = root[RELOAD_HANDOFF_KEY];
  if (existing) return existing;
  const created = new Map<string, HandoffEntry>();
  root[RELOAD_HANDOFF_KEY] = created;
  return created;
}

/**
 * Stage a live runtime immediately before Pi tears down the old extension runner.
 *
 * `ttlMs` is only ever overridden by tests; production callers rely on the
 * default so a slow/failed reload doesn't strand a staged runtime forever.
 *
 * Idempotent against double-fired shutdowns: handing off the SAME runtime
 * object twice (a same-state reload race) is a no-op — the entry is already
 * staged and in flight, so nothing is re-staged or disposed twice. A
 * DIFFERENT runtime for the same cwd (a newer extension generation replacing
 * an unclaimed handoff) replaces the stale entry and disposes it first.
 *
 * The leaving generation's owned resources are closed deterministically
 * (disposeRuntimeOnce) BEFORE staging, so the claiming generation starts from
 * a clean resource surface.
 */
export function handoffWorkflowRuntime(runtime: WorkflowReloadRuntime, ttlMs: number = RELOAD_HANDOFF_TTL_MS): void {
  const store = handoffs();
  const previous = store.get(runtime.cwd);
  if (previous) {
    // Same-state reload: the identical runtime is already staged and waiting
    // to be claimed — re-fired session_shutdown, not a new generation.
    if (previous.runtime === runtime) return;
    clearTimeout(previous.timer);
    disposeRuntimeOnce(previous.runtime);
  }
  disposeRuntimeOnce(runtime);

  const entry = {} as HandoffEntry;
  entry.runtime = runtime;
  entry.timer = setTimeout(() => {
    if (store.get(runtime.cwd) !== entry) return;
    // No new extension generation ever claimed this runtime. Anything still
    // "running" in it would otherwise burn tokens to completion and deliver
    // its result into a manager nobody can reach anymore, so pause it onto
    // the same journal-recovery path a version-mismatch reload uses, then
    // close the abandoned generation's owned resources.
    pauseStrandedWorkflowRuntime(runtime);
    disposeRuntimeOnce(runtime);
    store.delete(runtime.cwd);
  }, ttlMs);
  entry.timer.unref?.();
  store.set(runtime.cwd, entry);
}

/** Claim a staged runtime from the extension generation that `/reload` just stopped. */
export function takeWorkflowRuntime(cwd: string): WorkflowReloadRuntime | undefined {
  const store = handoffs();
  const entry = store.get(cwd);
  if (!entry) return undefined;
  clearTimeout(entry.timer);
  store.delete(cwd);
  return entry.runtime;
}

/**
 * Claim a staged runtime and compare its package version with this extension
 * generation. Any package update falls back to a fresh manager; only reloads
 * within the exact same installed version retain live workflow state.
 *
 * The claimed runtime's resources were already disposed at stage time; only
 * the manager (never disposed) is carried forward.
 */
export function claimWorkflowRuntime(cwd: string): WorkflowRuntimeClaim {
  const runtime = takeWorkflowRuntime(cwd);
  if (!runtime) return {};
  return runtime.extensionVersion === WORKFLOW_EXTENSION_VERSION
    ? { compatible: runtime }
    : { versionMismatch: runtime };
}

/**
 * Move a runtime's live runs onto the existing journal recovery path when no
 * compatible manager will carry them forward — a replaced extension version,
 * or a staged handoff that expired unclaimed.
 */
export function pauseStrandedWorkflowRuntime(runtime: WorkflowReloadRuntime): number {
  let paused = 0;
  for (const run of runtime.manager.listRuns()) {
    if (run.status === "running" && runtime.manager.pause(run.runId)) paused++;
  }
  return paused;
}

/**
 * Dispose a generation's owned resources on the non-reload shutdown path.
 *
 * A plain (non-reload) shutdown never stages a handoff entry, so without an
 * explicit dispose here the usage-limit scheduler timers and the host-tool
 * gateway (MCP bridge socket / spawned bridge process) would be leaked on every
 * normal shutdown. When the caller passes the runtime it is disposing, run its
 * dispose fanout regardless of whether a handoff was ever staged — bounded by
 * disposeRuntimeOnce's at-most-once guard, so a double-fired shutdown is safe.
 *
 * Identity guard: when a handoff IS staged, a stale cleanup cannot delete or
 * dispose a newer generation that replaced the staged entry.
 */
export function discardWorkflowRuntime(cwd: string, runtime?: WorkflowReloadRuntime): void {
  const store = handoffs();
  const entry = store.get(cwd);
  if (!entry) {
    // Non-reload shutdown (no handoff ever staged): still release the
    // explicitly-passed runtime's owned resources.
    if (runtime) disposeRuntimeOnce(runtime);
    return;
  }
  if (runtime && entry.runtime !== runtime) return;
  clearTimeout(entry.timer);
  store.delete(cwd);
  disposeRuntimeOnce(entry.runtime);
}
