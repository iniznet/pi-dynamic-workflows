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

/**
 * One write in a key's shadow history (see `SharedStore.writeHistory`). Each
 * entry records who wrote the value and when, so a failed attempt's rollback
 * can find the last value NOT written by that attempt.
 */
interface WriteHistoryEntry {
  /** The deltaKey that wrote this value; `undefined` for unattributed writes. */
  writer: string | undefined;
  /** Monotonic per-store write sequence number — the write's position in order. */
  seq: number;
  /** The value that was written. */
  value: unknown;
}

export class SharedStore {
  private readonly map = new Map<string, unknown>();
  // Per-agent write deltas for delta-journaling; keyed by a run-unique
  // `${runId}:${callIndex}` string (see class doc) so nested workflow() runs
  // sharing this store can't collide on a bare callIndex.
  private readonly agentDeltas = new Map<string, Record<string, unknown>>();
  // Per-key shadow history for rollback (see `discardDelta`): the most recent
  // value written to a key by EACH writer, in last-write order. A writer is a
  // deltaKey (for `trackPut` writes) or `undefined` (for unattributed writes
  // via `put`/`applyDelta`/`restore`). Keeping the whole per-key write trail —
  // not just a single snapshot of the pre-window value — is what lets a failed
  // attempt's rollback restore the last value NOT written by that attempt,
  // even when a concurrent sibling's write landed BETWEEN the attempt's own
  // writes to the same key (the A/B/A interleave: a sibling's write must never
  // be erased by the failed attempt's rollback). A writer's history entry is
  // REPLACED (not appended) when it writes the key again, so the trail stays
  // bounded by the number of distinct writers and every entry is always that
  // writer's LATEST value — the only one a later rollback could ever target.
  // Committed writes stay in the trail as a permanent baseline; discarded
  // writes are removed when rolled back.
  private readonly writeHistory = new Map<string, WriteHistoryEntry[]>();
  private writeSeq = 0;
  // Monotonic per-store commit ordinal, assigned in commitDeltaOrdered. Because
  // the counter lives on the ONE store instance that a parent run and every
  // nested workflow() frame share, the ordinals order every committed delta in
  // the run tree by real completion time (E2's commit-order replay). Seeded
  // from the resume journal on resume so ordinals stay monotonic across
  // pause/resume cycles (a fresh store would otherwise restart at 0 and tie
  // with — or sort before — earlier entries).
  private commitSeqCounter = 0;
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
    // A write that can never succeed even in an empty store must be rejected
    // BEFORE evicting anything, so a rejected put has no side effects: it
    // never destroys existing entries as a side effect of inevitably failing.
    if (!had && this.limits.maxKeys < 1) {
      throw new RangeError(`store key count would exceed maxKeys (${this.limits.maxKeys})`);
    }
    if (bytes > this.limits.maxTotalBytes) {
      throw new RangeError(
        `store value for "${key}" (${bytes} B) exceeds maxTotalBytes (${this.limits.maxTotalBytes} B)`,
      );
    }
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

  /**
   * Record a write in the key's shadow history. Keeps at most one entry per
   * writer: a writer's previous entry is dropped when it writes the key again,
   * so the trail stays ordered by last-write time and bounded by the number of
   * distinct writers of the key (see `writeHistory`).
   */
  private recordHistory(key: string, writer: string | undefined, value: unknown): void {
    let history = this.writeHistory.get(key);
    if (!history) {
      history = [];
      this.writeHistory.set(key, history);
    }
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].writer === writer) {
        history.splice(i, 1);
        break;
      }
    }
    history.push({ writer, seq: this.writeSeq++, value });
  }

  /**
   * Write `key` -> `value` WITHOUT invoking the size/count guardrails (and so
   * WITHOUT evicting anything). Used only to UNDO a prior write — a rollback
   * is contractually an "undo", never a new bounded write, so it must never
   * destroy a live sibling agent's entry under cap pressure the way
   * `assertWriteFits` would. The restored value is the exact bytes/entry that
   * previously fit (it was accepted when first written), so it always fits
   * again by construction: it strictly shrinks or matches the store's prior
   * footprint for `key`, and leaves every other key untouched.
   */
  private restoreKey(key: string, value: unknown): void {
    const bytes = this.measure(value);
    const oldBytes = this.bytesByKey.get(key) ?? 0;
    this.map.set(key, value);
    this.totalBytes += bytes - oldBytes;
    this.bytesByKey.set(key, bytes);
    this.setExpiry(key);
  }

  private isExpired(key: string): boolean {
    const at = this.expiresAt.get(key);
    return at !== undefined && Date.now() >= at;
  }

  private removeKey(key: string): void {
    // The key's live state is gone (eviction / TTL expiry / rollback delete), so
    // its whole write trail is stale too — dropping it prevents a later window
    // from restoring a value that no longer exists anywhere (see `discardDelta`).
    this.writeHistory.delete(key);
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
    this.recordHistory(key, undefined, value);
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
    this.map.set(key, value);
    this.totalBytes += bytes - oldBytes;
    this.bytesByKey.set(key, bytes);
    this.setExpiry(key);
    this.recordHistory(key, deltaKey, value);
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
   * The committed writes stay in the shadow history as a permanent baseline:
   * a sibling that fails LATER rolls back to this attempt's final value.
   */
  commitDelta(deltaKey: string): Record<string, unknown> {
    const delta = this.agentDeltas.get(deltaKey) ?? {};
    this.agentDeltas.delete(deltaKey);
    return delta;
  }

  /**
   * Commit `deltaKey`'s accumulated writes and tag them with a monotonic
   * per-store commit ordinal — the delta's position in the store's commit
   * (completion) order. Each successful call consumes the NEXT ordinal, so
   * ordinals order deltas exactly as the run completed them, even across
   * parent and nested workflow() frames sharing this store. Resume replay
   * sorts replayed deltas by this ordinal to reconstruct the same store the
   * live run ended with instead of a callSeq-order reconstruction (E2).
   */
  commitDeltaOrdered(deltaKey: string): { delta: Record<string, unknown>; seq: number } {
    const delta = this.commitDelta(deltaKey);
    return { delta, seq: this.commitSeqCounter++ };
  }

  /**
   * Resume only: continue the commit-ordinal counter AFTER `maxSeq` (the
   * highest ordinal in the resume journal), so a run resumed more than once
   * keeps ordinals strictly increasing across the whole history — a fresh
   * store starts at 0, which would tie with (or sort before) already-journaled
   * ordinals and corrupt commit-order replay on the second resume. Raises-only
   * (never lowers), so re-seeding the shared store from a nested frame's own
   * resumeJournal view is idempotent.
   */
  seedCommitSeq(maxSeq: number): void {
    this.commitSeqCounter = Math.max(this.commitSeqCounter, maxSeq + 1);
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
   * the last value NOT written by this attempt — the value a sibling or
   * caller left in place, or the pre-window value, or deleted if the key did
   * not exist before this window wrote it.
   *
   * Rollback consults the key's shadow HISTORY (`writeHistory`), not a single
   * pre-window snapshot: if a concurrently-running sibling (a different
   * `deltaKey`, e.g. another agent in the same parallel() batch) legitimately
   * wrote the same key BETWEEN this attempt's own writes (the A/B/A
   * interleave), the rollback restores the sibling's value — rolling back to
   * the pre-window snapshot instead would silently erase a live, unrelated
   * write this attempt never made and has no business undoing.
   *
   * Per-key guards: a key is only rolled back when (a) the trail's last write
   * is this attempt's own (a sibling that overwrote the key AFTER this
   * attempt's last write already left the live value in the state this
   * rollback would produce — nothing to do), and (b) the store still holds
   * that value (a key evicted under cap pressure or expired is left absent
   * rather than resurrected).
   *
   * A no-op if `deltaKey` never wrote anything (nothing to roll back).
   */
  discardDelta(deltaKey: string): void {
    const delta = this.agentDeltas.get(deltaKey);
    if (!delta) return;
    for (const key of Object.keys(delta)) {
      const history = this.writeHistory.get(key);
      if (!history || history.length === 0) continue;
      // The trail's last entry is the most recent write to this key. If a
      // concurrent sibling overwrote it AFTER this attempt's last write, the
      // last entry is theirs, not ours — the live value already IS the last
      // value this attempt did not write, so there is nothing to roll back.
      const top = history[history.length - 1];
      if (top.writer !== deltaKey) continue;
      // If the store no longer holds this attempt's write (the key was
      // evicted under cap pressure or expired since), the key's live state
      // has been purged — leave it absent and drop its whole trail, so a
      // later window cannot restore a value that no longer exists anywhere.
      if (!Object.is(this.map.get(key), top.value)) {
        this.writeHistory.delete(key);
        continue;
      }
      // Restore the last value NOT written by this attempt — some sibling's
      // write, a caller's (unattributed) write, or the pre-window value — or
      // delete the key when every write in the trail was this attempt's.
      let target: WriteHistoryEntry | undefined;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].writer !== deltaKey) {
          target = history[i];
          break;
        }
      }
      if (target) {
        // `top` is this attempt's single trail entry (at most one per writer),
        // always the last element — pop it so the trail ends at the restored
        // value, matching the live state the rollback produces.
        history.splice(history.indexOf(top), 1);
        this.restoreKey(key, target.value);
      } else {
        // Every write in the trail was this attempt's — the key did not exist
        // before this window. `removeKey` also drops the now-empty trail.
        this.removeKey(key);
      }
    }
    this.agentDeltas.delete(deltaKey);
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
   * The shadow history is cleared too: a full reset makes every prior write
   * trail meaningless (a later rollback's `Object.is` guard would skip any
   * key whose live value now comes from the snapshot anyway).
   */
  restore(snap: Record<string, unknown>): void {
    this.map.clear();
    this.totalBytes = 0;
    this.bytesByKey.clear();
    this.expiresAt.clear();
    this.writeHistory.clear();
    for (const [k, v] of Object.entries(snap)) {
      this.put(k, v);
    }
  }

  /** Clear all entries (called when the run ends). */
  dispose(): void {
    this.map.clear();
    this.agentDeltas.clear();
    this.writeHistory.clear();
    this.bytesByKey.clear();
    this.expiresAt.clear();
    this.totalBytes = 0;
    this.commitSeqCounter = 0;
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
