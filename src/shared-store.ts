/**
 * In-memory key-value store scoped to a single workflow run.
 *
 * One `SharedStore` instance is created at run start and disposed when the run
 * ends. Two MCP-compatible tool definitions (`store_put` / `store_get`) are
 * injected into every agent's tool list so parallel agents can share
 * intermediate state without coordinating through the script itself.
 *
 * Journal integration: callers capture `store.commitDelta(deltaKey)` alongside
 * each agent result in the journal. On resume, `store.applyDelta(delta)` rebuilds
 * the store state additively in callSeq order, so parallel-agent writes are
 * replayed correctly without the last-complete-wins ordering bug that a
 * whole-Map restore() would cause.
 *
 * `deltaKey` must be unique across every run that shares this store instance,
 * not just within one run's callSeq. A nested `workflow()` call restarts its own
 * callSeq at 0 while inheriting the parent's store (so parent and nested-run
 * agents can share state), so a bare callIndex would collide between a parent
 * agent and a concurrently-running nested-run agent that both got index 0 —
 * whichever commits its delta last would clobber the other's entry in
 * `agentDeltas`. Callers compose `deltaKey` as `${runId}:${callIndex}`, and
 * since every run (including each nested run) gets its own distinct `runId`,
 * the composite key is unique across the whole store's lifetime.
 *
 * Guardrails: the store is size-bounded so store_put can never grow a run's
 * memory without limit. Every write path (`put`, `trackPut`, `applyDelta`,
 * `restore`) enforces the configured caps: values that are not JSON-serializable
 * or that exceed `maxValueBytes` are rejected with a loud error, and when the
 * key count or total byte size would exceed its cap, the oldest entries are
 * evicted (FIFO) to make room. Entries can also expire (`ttlMs`, lazy) so
 * long-running runs do not accumulate stale intermediate state.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Size / TTL guardrails applied to every store write. */
export interface SharedStoreLimits {
  /** Max live keys; oldest keys are evicted first beyond this. */
  maxKeys?: number;
  /** Approx max total size of all values, in JSON bytes; oldest evicted to stay under. */
  maxTotalBytes?: number;
  /** Reject individual values whose JSON size exceeds this. */
  maxValueBytes?: number;
  /** Lazy expiry: entries written more than `ttlMs` ago read as absent. */
  ttlMs?: number;
}

/** Default guardrails applied when a run constructs a store without explicit limits. */
export const DEFAULT_STORE_LIMITS: Required<SharedStoreLimits> = {
  maxKeys: 10_000,
  maxTotalBytes: 8 * 1024 * 1024,
  maxValueBytes: 1024 * 1024,
  ttlMs: 0,
};

export class SharedStore {
  private readonly map = new Map<string, unknown>();
  // Per-agent write deltas for delta-journaling; keyed by a run-unique
  // `${runId}:${callIndex}` string (see class doc) so nested workflow() runs
  // sharing this store can't collide on a bare callIndex.
  private readonly agentDeltas = new Map<string, Record<string, unknown>>();
  // Pre-write shadow values for the CURRENT delta-key's in-progress writes,
  // so a failed retry attempt's mutations can be rolled back (see
  // `discardDelta`) instead of leaking into the live store or a later
  // successful attempt's recorded delta. Populated lazily by `trackPut` (only
  // the first write to a given key within the current delta window is
  // shadowed — later writes to the same key within the same attempt are
  // already covered by that first shadow) and cleared whenever the delta is
  // finalized, either way, via `commitDelta`/`discardDelta`.
  private readonly priorValues = new Map<string, Map<string, { existed: boolean; value: unknown }>>();
  private readonly limits: Required<SharedStoreLimits>;
  // JSON-size (bytes) per key, so eviction accounting never re-serializes a
  // value just to evict it.
  private readonly bytesByKey = new Map<string, number>();
  private totalBytes = 0;
  // Absolute expiry timestamps (ms epoch) per key when a TTL is configured.
  private readonly expiresAt = new Map<string, number>();

  constructor(limits: SharedStoreLimits = {}) {
    this.limits = { ...DEFAULT_STORE_LIMITS, ...limits };
  }

  /** Serialized size of `value`; throws for non-JSON-serializable values. */
  private measure(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  }

  /**
   * Guardrail check for writing `key` -> `value`: reject oversized values, and
   * evict the oldest entries (never `key` itself) until the key-count and
   * total-byte caps would fit. Throws when the write could never fit even
   * after evicting every other key. Returns the serialized byte size.
   */
  private assertWriteFits(key: string, value: unknown): number {
    const bytes = this.measure(value);
    if (bytes > this.limits.maxValueBytes) {
      throw new RangeError(
        `store value for "${key}" (${bytes} B) exceeds maxValueBytes (${this.limits.maxValueBytes} B)`,
      );
    }
    const had = this.map.has(key);
    const extraKeys = had ? 0 : 1;
    const oldBytes = this.bytesByKey.get(key) ?? 0;
    const wouldFit = () =>
      this.map.size + extraKeys <= this.limits.maxKeys &&
      this.totalBytes - oldBytes + bytes <= this.limits.maxTotalBytes;
    if (wouldFit()) return bytes;
    for (const k of [...this.map.keys()]) {
      if (k === key) continue;
      this.removeKey(k);
      if (wouldFit()) return bytes;
    }
    if (this.map.size + extraKeys > this.limits.maxKeys) {
      throw new RangeError(`store key count would exceed maxKeys (${this.limits.maxKeys})`);
    }
    throw new RangeError(
      `store value for "${key}" (${bytes} B) exceeds maxTotalBytes (${this.limits.maxTotalBytes} B)`,
    );
  }

  private setExpiry(key: string): void {
    if (this.limits.ttlMs > 0) this.expiresAt.set(key, Date.now() + this.limits.ttlMs);
    else this.expiresAt.delete(key);
  }

  private isExpired(key: string): boolean {
    const at = this.expiresAt.get(key);
    return at !== undefined && Date.now() >= at;
  }

  private removeKey(key: string): void {
    if (!this.map.has(key)) return;
    this.map.delete(key);
    this.totalBytes -= this.bytesByKey.get(key) ?? 0;
    this.bytesByKey.delete(key);
    this.expiresAt.delete(key);
  }

  private purgeExpired(): void {
    if (this.limits.ttlMs <= 0) return;
    const now = Date.now();
    for (const [key, at] of this.expiresAt) {
      if (now >= at) this.removeKey(key);
    }
  }

  /** Store a value under `key`. Overwrites any existing value. */
  put(key: string, value: unknown): void {
    const bytes = this.assertWriteFits(key, value);
    const oldBytes = this.bytesByKey.get(key) ?? 0;
    this.map.set(key, value);
    this.totalBytes += bytes - oldBytes;
    this.bytesByKey.set(key, bytes);
    this.setExpiry(key);
  }

  /**
   * Store a value and record the write in the per-agent delta for `deltaKey`
   * (a run-unique `${runId}:${callIndex}` string — see class doc). Used by
   * per-agent tools created via `createAgentStoreTools` so that each agent's
   * writes can be journaled and replayed independently.
   */
  trackPut(key: string, value: unknown, deltaKey: string): void {
    const bytes = this.assertWriteFits(key, value);
    const oldBytes = this.bytesByKey.get(key) ?? 0;
    let priors = this.priorValues.get(deltaKey);
    if (!priors) {
      priors = new Map();
      this.priorValues.set(deltaKey, priors);
    }
    // Only shadow the value from BEFORE this delta window started writing to
    // this key — a second write to the same key within the same attempt must
    // not overwrite the shadow with its own (already-in-window) value.
    if (!priors.has(key)) {
      priors.set(
        key,
        this.map.has(key) ? { existed: true, value: this.map.get(key) } : { existed: false, value: undefined },
      );
    }
    this.map.set(key, value);
    this.totalBytes += bytes - oldBytes;
    this.bytesByKey.set(key, bytes);
    this.setExpiry(key);
    let delta = this.agentDeltas.get(deltaKey);
    if (!delta) {
      delta = {};
      this.agentDeltas.set(deltaKey, delta);
    }
    delta[key] = value;
  }

  /** Retrieve the value for `key`, or `undefined` when absent. */
  get(key: string): unknown {
    if (this.isExpired(key)) this.removeKey(key);
    return this.map.get(key);
  }

  /** Whether `key` is present in the store. */
  has(key: string): boolean {
    if (this.isExpired(key)) this.removeKey(key);
    return this.map.has(key);
  }

  /** Return a deep-copied plain-object snapshot of all entries. */
  snapshot(): Record<string, unknown> {
    this.purgeExpired();
    return structuredClone(Object.fromEntries(this.map));
  }

  /**
   * Extract and clear the write delta accumulated for `deltaKey`.
   * Called after an agent completes to get the set of keys it wrote.
   */
  commitDelta(deltaKey: string): Record<string, unknown> {
    const delta = this.agentDeltas.get(deltaKey) ?? {};
    this.agentDeltas.delete(deltaKey);
    this.priorValues.delete(deltaKey);
    return delta;
  }

  /**
   * Undo the writes recorded for `deltaKey` and discard its bookkeeping,
   * without touching any other key. Used when a retry attempt fails: that
   * attempt's writes must not remain visible in the live store (e.g. to a
   * concurrently-running sibling agent's store_get, or to script code reading
   * `store.get` directly) and must not merge into the delta eventually
   * recorded when a later attempt of the SAME call succeeds — otherwise a
   * failed attempt's mutations would silently survive into the run's live
   * state while being absent from the journaled delta that resume replay
   * reconstructs from, leaving live execution and replay permanently
   * inconsistent. Each key touched during this delta window is restored to
   * whatever it held immediately before the window started (or deleted, if
   * it did not exist yet) — never to some other attempt's or caller's value.
   *
   * Per-key guard: a key is only rolled back if the store STILL holds this
   * attempt's own last write to it (checked with `Object.is` against the
   * value recorded in `delta`). If a concurrently-running sibling (a
   * different `deltaKey`, e.g. another agent in the same parallel() batch)
   * legitimately overwrote the same key AFTER this attempt wrote it but
   * BEFORE it failed, that sibling's write is left untouched — rolling back
   * unconditionally would silently erase a live, unrelated write that this
   * attempt never made and has no business undoing.
   *
   * A no-op if `deltaKey` never wrote anything (nothing to roll back).
   */
  discardDelta(deltaKey: string): void {
    const delta = this.agentDeltas.get(deltaKey);
    if (!delta) return;
    const priors = this.priorValues.get(deltaKey);
    for (const key of Object.keys(delta)) {
      // Someone else already overwrote this key since our last write to it —
      // leave their write in place instead of clobbering it with our rollback.
      if (!Object.is(this.map.get(key), delta[key])) continue;
      const prior = priors?.get(key);
      if (prior?.existed) {
        this.put(key, prior.value);
      } else {
        this.removeKey(key);
      }
    }
    this.agentDeltas.delete(deltaKey);
    this.priorValues.delete(deltaKey);
  }

  /**
   * Apply a write delta additively — sets each key without clearing others.
   * Used during resume replay so parallel-agent deltas applied in callSeq
   * order accumulate correctly regardless of original completion order.
   * Guardrails apply identically to a live write, so replay reconstructs the
   * same bounded state the original run produced.
   */
  applyDelta(delta: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(delta)) {
      this.put(k, v);
    }
  }

  /**
   * Replace all entries with a snapshot (for full resets).
   * Prefer `applyDelta` for resume replay — see journal integration above.
   */
  restore(snap: Record<string, unknown>): void {
    this.map.clear();
    this.totalBytes = 0;
    this.bytesByKey.clear();
    this.expiresAt.clear();
    for (const [k, v] of Object.entries(snap)) {
      this.put(k, v);
    }
  }

  /** Clear all entries (called when the run ends). */
  dispose(): void {
    this.map.clear();
    this.agentDeltas.clear();
    this.priorValues.clear();
    this.bytesByKey.clear();
    this.expiresAt.clear();
    this.totalBytes = 0;
  }
}

/**
 * Create per-agent store tools that attribute writes to `deltaKey`, a
 * run-unique `${runId}:${callIndex}` string (see the `SharedStore` class doc
 * for why the bare callIndex alone is not enough once a nested `workflow()`
 * call shares this store).
 * Used internally by `runWorkflow` so each agent's puts are tracked in the
 * store's delta journal and can be replayed additively on resume.
 */
export function createAgentStoreTools(store: SharedStore, deltaKey: string): ToolDefinition[] {
  const storePut = defineTool({
    name: "store_put",
    label: "Store Put",
    description:
      "Write a value to the shared run store. Any other agent in this workflow run can read it with store_get. Overwrites any existing value for the key. Note: when two parallel agents write the same key, the last write wins — no merge is performed.",
    promptSnippet: "Write a value to the shared store",
    parameters: Type.Object({
      key: Type.String({ description: "The key to store the value under." }),
      value: Type.Any({ description: "The value to store (any JSON-serializable value)." }),
    }),
    async execute(_id: string, params: { key: string; value: unknown }) {
      store.trackPut(params.key, params.value, deltaKey);
      return {
        content: [{ type: "text", text: `Stored value under key "${params.key}".` }],
        details: { key: params.key },
      };
    },
  }) as unknown as ToolDefinition;

  const storeGet = defineTool({
    name: "store_get",
    label: "Store Get",
    description:
      "Read a value from the shared run store previously written by store_put. Returns the stored value, or null when the key does not exist.",
    promptSnippet: "Read a value from the shared store",
    parameters: Type.Object({
      key: Type.String({ description: "The key to read." }),
    }),
    async execute(_id: string, params: { key: string }) {
      const found = store.has(params.key);
      const value = store.get(params.key);
      const text = found
        ? `Value for key "${params.key}": ${JSON.stringify(value)}`
        : `Key "${params.key}" not found in store.`;
      return {
        content: [{ type: "text", text }],
        details: { key: params.key, value: found ? value : null, found },
      };
    },
  }) as unknown as ToolDefinition;

  return [storePut, storeGet];
}
