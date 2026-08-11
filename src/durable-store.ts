/**
 * Cross-run durable store (mesh-lite) + provenance ledger.
 *
 * P06: a project-scoped, versioned KV that SURVIVES run end/restart, so
 * workflow runs can keep memory, task boards, and provenance across runs —
 * the durable counterpart to SharedStore's per-run key-value space.
 *
 * Persistence: one JSON file per project under the user's agent dir
 * (`getAgentDir()/durable-store/<projectKey>.json`), schema-versioned, with an
 * exclusive-create lock file around every read-modify-write so concurrent
 * writers (parallel runs, nested workflow() frames, separate pi sessions) merge
 * onto the freshest disk state instead of clobbering each other. Writes are
 * atomic (tmp + rename via writeJsonFileAtomic — Windows-EPERM retry).
 *
 * Runtime injection: runWorkflow's runtimeImplementations binds a fresh store
 * per run (`bindRunDurableStore`) and injects it as the `durableStore` vm
 * global. The same call registers the store in a module-level registry keyed
 * by runId, so HOST-side emission points (agent settle in agent.ts, worktree
 * finalize in worktree.ts, the manager's onAgentEnd) can record provenance
 * into the run's ledger without the vm reference.
 *
 * REPLAY RULE (critical): durable writes re-executed during cached-prefix
 * replay must be IDEMPOTENT or journaled as deltas, or replay diverges from
 * the live run. Every write path here is idempotent by construction:
 *
 *   - `put(key, value)` is a NO-OP when the persisted value for `key` is
 *     deep-equal to `value` — the overwhelmingly common replay case (a script
 *     re-executes the same fixed-value write).
 *   - `putOnce(id, key, value)` writes at most once per caller-chosen `id`
 *     (persisted), so even a re-executed increment lands once.
 *   - `compareAndSwap(key, expected, next)` never re-writes after its own
 *     original write landed (the persisted value no longer matches
 *     `expected`), so a re-executed claim is a no-op.
 *   - `record(entry)` appends to the provenance ledger at most once per
 *     `entry.id` (or per content identity when no id is given).
 *
 * The store is a DATA plane, not a control plane: writes are replay-safe, but
 * script control flow that BRANCHES on a write result (e.g. `if (await
 * compareAndSwap(...))`) is subject to the same determinism rules as the rest
 * of the script (see DETERMINISM_PRELUDE) — a branch whose outcome differs on
 * replay would shift later agent() call indices and break cached-prefix
 * replay. Authors who need cross-run monotonic counters should derive the
 * increment's identity from the run (e.g. `putOnce("count:<runKey>", "count",
 * n)` with a per-run id from `args`) so replay sees an already-written id.
 *
 * Deterministic timestamps: provenance timestamps are INJECTED values derived
 * from a constant epoch plus the store's write sequence
 * (`deterministicRunClock`) — never the wall clock. The same write replayed
 * (idempotent dedupe) never re-stamps, and a resumed run's new writes keep
 * one stable, ordered timeline. The lock file's expiry is host bookkeeping
 * (like the run lease) and is never part of the store's value space.
 *
 * MUST NOT join hashAgentCall (src/workflow.ts): the store's contents are not
 * part of any agent() call's resume identity.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  ensureDir,
  type PersistenceFsLayer,
  readJsonWithBackupRecovery,
  resolvePersistenceFs,
  writeJsonFileAtomic,
} from "./fs-persistence.js";
import { workflowProjectKey } from "./workflow-paths.js";

/** On-disk schema version of the durable store file. */
export const DURABLE_STORE_SCHEMA_VERSION = 1 as const;

/** Subdirectory under getAgentDir() where per-project store files live. */
export const DURABLE_STORE_SUBDIR = "durable-store";

/** Default lock expiry (ms) for one read-modify-write critical section. */
export const DURABLE_STORE_LOCK_TTL_MS = 10_000;

/** How many exclusive-create attempts before giving up on a busy lock. */
export const DURABLE_STORE_LOCK_ATTEMPTS = 50;

/** Delay between lock retries (ms). */
export const DURABLE_STORE_LOCK_RETRY_MS = 20;

/** FIFO cap on the putOnce id trail (bounds the persisted writeIds array). */
export const DURABLE_STORE_MAX_WRITE_IDS = 2_000;

/**
 * Deterministic provenance clock: a fixed epoch base (never the wall clock)
 * plus the store's monotonic write sequence. The SAME seq always produces the
 * SAME ISO timestamp, so a replayed (idempotent, deduped) write never
 * re-stamps and every entry in one store is strictly ordered by its seq.
 */
export function deterministicRunClock(_runId?: string): (seq: number) => string {
  // Fixed constant epoch — the base is deliberately NOT wall-clock, so
  // timestamps are reproducible across runs, processes, and replay. seq is
  // small (a per-store counter), so base + seq stays well inside Date range.
  const BASE_EPOCH_MS = 1_700_000_000_000;
  return (seq: number) => new Date(BASE_EPOCH_MS + seq).toISOString();
}

/**
 * One provenance ledger entry: a change/claim record with
 * `{source | file, agent, phase, timestamp}` (the P06 contract shape) plus an
 * optional stable `id` used for replay dedupe (auto-derived from content when
 * absent). `timestamp` is stamped by the store's injected clock when omitted
 * (deterministic — see {@link deterministicRunClock}).
 */
export interface ProvenanceEntry {
  /** Stable dedupe identity; auto-derived from content when omitted. */
  id?: string;
  /** Who/what recorded the change (e.g. "agent", "worktree", a script label). */
  source?: string;
  /** The file path the change/claim is about (worktree path, target file...). */
  file?: string;
  /** The agent (or branch) that made the change. */
  agent?: string;
  /** The workflow phase the change happened in, when known. */
  phase?: string;
  /** Deterministic injected timestamp (store-stamped when omitted). */
  timestamp?: string;
}

/** Shape of the persisted store file (versioned). */
export interface DurableStoreFile {
  version: number;
  seq: number;
  entries: Record<string, unknown>;
  ledger: ProvenanceEntry[];
  /** ids seen by putOnce — the replay dedupe trail (FIFO-capped). */
  writeIds: string[];
}

export interface DurableStoreOptions {
  /** The run's stable identity; registers the store as the run's provenance sink. */
  runId?: string;
  /** Project-scoped persistence namespace (workflowProjectKey(cwd)). */
  projectKey: string;
  /** Override the base dir (defaults to getAgentDir()/durable-store). */
  dir?: string;
  /**
   * Injected deterministic clock: `(seq) => timestamp` for provenance records.
   * Defaults to {@link deterministicRunClock} (constant epoch + write seq —
   * never wall-clock). Override in tests for exact-value assertions.
   */
  now?: (seq: number) => string;
  /** Test seam for the fs layer (see resolvePersistenceFs). */
  fs?: Partial<PersistenceFsLayer>;
  /** Lock expiry override (ms). */
  lockTimeoutMs?: number;
}

/**
 * Deep-equality for store values: canonical (sorted-key) JSON so logically
 * equal values written by a replayed script produce the identical bytes.
 * Values are JSON-serializable by contract (the SharedStore family precedent).
 */
export function isDeepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

function contentIdentity(entry: ProvenanceEntry): string {
  return createHash("sha256")
    .update(stableStringify({ source: entry.source, file: entry.file, agent: entry.agent, phase: entry.phase }))
    .digest("hex");
}

interface StoreLockFile {
  projectKey: string;
  pid: number;
  token: string;
  startedAt: string;
  expiresAt: string;
}

/**
 * Cross-run durable KV + provenance ledger for one project. Construct via
 * {@link createRunDurableStore} (registers the instance as the run's
 * provenance sink) or directly for tests/hosts.
 */
export class DurableStore {
  private readonly projectKey: string;
  private readonly dir: string;
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly fs: PersistenceFsLayer;
  private readonly now: (seq: number) => string;
  private readonly lockTtlMs: number;
  private entries: Record<string, unknown> = {};
  private ledger: ProvenanceEntry[] = [];
  private writeIds: string[] = [];
  private seq = 0;

  constructor(options: DurableStoreOptions) {
    this.projectKey = options.projectKey;
    const baseDir = options.dir ?? join(getAgentDir(), DURABLE_STORE_SUBDIR);
    this.dir = baseDir;
    this.filePath = join(baseDir, `${options.projectKey}.json`);
    this.lockPath = `${this.filePath}.lock`;
    this.fs = resolvePersistenceFs(options.fs);
    this.now = options.now ?? deterministicRunClock(options.runId);
    this.lockTtlMs = options.lockTimeoutMs ?? DURABLE_STORE_LOCK_TTL_MS;
    this.load();
  }

  // ── loading / persistence ────────────────────────────────────────────────

  private load(): void {
    const raw = readJsonWithBackupRecovery<DurableStoreFile>(this.fs, this.filePath);
    if (raw && typeof raw.version === "number") {
      // Versioned file: currently only version 1 exists. Unknown NEWER
      // versions are treated as empty (never downgrade-write a newer shape).
      if (raw.version === DURABLE_STORE_SCHEMA_VERSION) {
        this.entries = typeof raw.entries === "object" && raw.entries !== null ? raw.entries : {};
        this.ledger = Array.isArray(raw.ledger) ? raw.ledger : [];
        this.writeIds = Array.isArray(raw.writeIds) ? raw.writeIds : [];
        this.seq = Number.isFinite(raw.seq) && raw.seq >= 0 ? raw.seq : 0;
        return;
      }
      return;
    }
    // Legacy/unversioned or absent: start empty. Writes re-stamp the version.
  }

  /** The current in-memory view — a deep copy, safe to mutate by callers. */
  snapshot(): { entries: Record<string, unknown>; ledger: ProvenanceEntry[] } {
    return {
      entries: structuredClone(this.entries),
      ledger: structuredClone(this.ledger),
    };
  }

  /** The store's project key (the on-disk namespace). */
  projectName(): string {
    return this.projectKey;
  }

  /** True when the store file exists on disk (used by tests/observers). */
  existsOnDisk(): boolean {
    return this.fs.existsSync(this.filePath);
  }

  /** Absolute path of the persisted store file. */
  path(): string {
    return this.filePath;
  }

  // ── lock (exclusive-create, mirrors the run-lease pattern) ───────────────

  private lockIsHeldByLiveOwner(lock: StoreLockFile): boolean {
    if (lock.pid === process.pid) {
      // Same-process holder: our own async critical sections serialize via
      // this module's per-store promise chain, but a stale lock from an
      // earlier crashed attempt must still expire — so only treat a live
      // same-pid lock as held while its expiry has not passed.
      return Date.parse(lock.expiresAt) > Date.now();
    }
    if (!Number.isInteger(lock.pid) || lock.pid <= 0) return false;
    try {
      process.kill(lock.pid, 0);
      return Date.parse(lock.expiresAt) > Date.now();
    } catch {
      return false; // dead pid → reclaimable
    }
  }

  private async acquireLock(): Promise<string | null> {
    ensureDir(this.fs, this.dir);
    const now = Date.now();
    const token = `${process.pid}-${now.toString(36)}-${Math.random().toString(36).slice(2)}`;
    const payload: StoreLockFile = {
      projectKey: this.projectKey,
      pid: process.pid,
      token,
      startedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.lockTtlMs).toISOString(),
    };
    for (let attempt = 0; attempt < DURABLE_STORE_LOCK_ATTEMPTS; attempt++) {
      try {
        this.fs.writeFileSync(this.lockPath, JSON.stringify(payload, null, 2), { flag: "wx" });
        return token;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "EEXIST") throw error;
        const existing = readJsonWithBackupRecovery<StoreLockFile>(this.fs, this.lockPath);
        if (existing && this.lockIsHeldByLiveOwner(existing)) {
          await sleepMs(DURABLE_STORE_LOCK_RETRY_MS);
          continue;
        }
        // Stale (dead pid / expired): reclaim.
        try {
          this.fs.unlinkSync(this.lockPath);
        } catch {
          // raced another reclaimer; retry the exclusive-create
        }
      }
    }
    return null;
  }

  private releaseLock(token: string): void {
    try {
      const existing = readJsonWithBackupRecovery<StoreLockFile>(this.fs, this.lockPath);
      if (existing?.token === token) this.fs.unlinkSync(this.lockPath);
    } catch {
      // best-effort cleanup only
    }
  }

  // ── read-modify-write core ───────────────────────────────────────────────

  /**
   * Serialize one write under the lock: re-read the freshest on-disk state
   * (so a concurrent writer's changes are never clobbered), apply the mutator
   * on top, persist atomically, and refresh the in-memory cache. Returns false
   * when the lock could not be acquired (bounded retries) or the write was a
   * dedup no-op — callers use the boolean only for observability, never for
   * control flow (a false must not change the script's branch outcome).
   */
  private async commit(mutate: (fresh: DurableStoreFile) => { changed: boolean; merge: () => void }): Promise<boolean> {
    const token = await this.acquireLock();
    if (token === null) return false;
    try {
      // Re-read under the lock: another process/run may have persisted since
      // our construction (mesh-lite merge). Lenient read — a torn/corrupt
      // file degrades to the current in-memory view rather than failing the
      // write (the backup-recovery read keeps a stale view). A file
      // carrying a NEWER schema version is NEVER overwritten: this writer can
      // not understand its shape, so any write would be a downgrade — skip
      // (the caller observes false).
      let fresh: DurableStoreFile;
      const onDisk = readJsonWithBackupRecovery<DurableStoreFile>(this.fs, this.filePath);
      if (onDisk && typeof onDisk.version === "number" && onDisk.version !== DURABLE_STORE_SCHEMA_VERSION) {
        return false;
      }
      if (onDisk && typeof onDisk.entries === "object" && onDisk.entries !== null) {
        fresh = onDisk;
      } else {
        // No valid file yet (first write, or a legacy/unversioned file we
        // cannot trust): start from the current in-memory state.
        fresh = this.toFile();
      }
      const { changed, merge } = mutate(fresh);
      if (!changed) return false;
      merge();
      const next: DurableStoreFile = {
        version: DURABLE_STORE_SCHEMA_VERSION,
        seq: fresh.seq,
        entries: fresh.entries,
        ledger: fresh.ledger,
        writeIds: fresh.writeIds,
      };
      // Async atomic replace (tmp + rename with a bounded Windows-EPERM
      // retry — a concurrent reader that opened the destination without
      // delete-sharing makes MoveFileEx fail for a few ms). The lock
      // serializes writers; this guards the rename itself.
      await writeJsonFileAtomic(this.filePath, next);
      // Refresh the in-memory cache from the merged file state.
      this.entries = fresh.entries;
      this.ledger = fresh.ledger;
      this.writeIds = fresh.writeIds;
      this.seq = fresh.seq;
      return true;
    } finally {
      this.releaseLock(token);
    }
  }

  private toFile(): DurableStoreFile {
    return {
      version: DURABLE_STORE_SCHEMA_VERSION,
      seq: this.seq,
      entries: this.entries,
      ledger: this.ledger,
      writeIds: this.writeIds,
    };
  }

  // ── public KV API (idempotent by construction — see the module doc) ──────

  /** Read the value for `key` from the in-memory cache (undefined when absent). */
  get(key: string): unknown {
    return this.entries[key];
  }

  /** Whether `key` is present in the in-memory cache. */
  has(key: string): boolean {
    return key in this.entries;
  }

  /** All keys currently in the in-memory cache. */
  keys(): string[] {
    return Object.keys(this.entries);
  }

  /**
   * Write `key -> value` atomically. REPLAY-IDEMPOTENT: a re-executed write
   * whose value is deep-equal to the persisted value is a no-op (no lock, no
   * file write), so cached-prefix replay leaves the store byte-identical.
   */
  async put(key: string, value: unknown): Promise<void> {
    return this.commit((fresh) => {
      if (isDeepEqual(fresh.entries[key], value)) return { changed: false, merge: () => {} };
      return {
        changed: true,
        merge: () => {
          fresh.entries[key] = value;
          fresh.seq += 1;
        },
      };
    }).then(() => {});
  }

  /**
   * Write at most once per caller-chosen `id` (persisted trail). The replay-
   * safe way to express a write that MUST happen exactly once per identity
   * (e.g. a cross-run counter keyed by a per-run id from `args`).
   */
  async putOnce(id: string, key: string, value: unknown): Promise<boolean> {
    return this.commit((fresh) => {
      if (fresh.writeIds.includes(id)) return { changed: false, merge: () => {} };
      return {
        changed: true,
        merge: () => {
          fresh.entries[key] = value;
          fresh.seq += 1;
          fresh.writeIds.push(id);
          if (fresh.writeIds.length > DURABLE_STORE_MAX_WRITE_IDS) {
            fresh.writeIds = fresh.writeIds.slice(-DURABLE_STORE_MAX_WRITE_IDS);
          }
        },
      };
    });
  }

  /**
   * Compare-and-swap (the CAS task board primitive). Replay-safe: after the
   * original CAS landed, the persisted value no longer matches `expected`, so
   * a re-executed CAS fails without writing — the board state never diverges.
   */
  async compareAndSwap(key: string, expected: unknown, next: unknown): Promise<boolean> {
    const written = await this.commit((fresh) => {
      const current = fresh.entries[key];
      const matches = current === undefined ? isDeepEqual(expected, undefined) : isDeepEqual(current, expected);
      if (!matches) return { changed: false, merge: () => {} };
      return {
        changed: true,
        merge: () => {
          fresh.entries[key] = next;
          fresh.seq += 1;
        },
      };
    });
    return written;
  }

  /**
   * Append a provenance record to the ledger (at most once per `entry.id`, or
   * per content identity `{source,file,agent,phase}` when no id is given —
   * replay re-execution is a no-op). The timestamp is stamped by the store's
   * injected deterministic clock when `entry.timestamp` is omitted.
   */
  async record(entry: ProvenanceEntry): Promise<boolean> {
    const id = entry.id ?? contentIdentity(entry);
    return this.commit((fresh) => {
      if (fresh.ledger.some((existing) => existing.id === id)) return { changed: false, merge: () => {} };
      return {
        changed: true,
        merge: () => {
          const stamped: ProvenanceEntry = {
            ...entry,
            id,
            timestamp: entry.timestamp ?? this.now(fresh.seq + 1),
          };
          fresh.seq += 1;
          fresh.ledger.push(stamped);
        },
      };
    });
  }

  /** The provenance ledger (deep copy). */
  ledgerEntries(): ProvenanceEntry[] {
    return structuredClone(this.ledger);
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── run-scoped registry (the provenance sink) ─────────────────────────────

const runStores = new Map<string, DurableStore>();

/**
 * The DurableStore registered for `runId` (the run's provenance sink), or
 * undefined when the run never bound one.
 */
export function runDurableStore(runId: string | undefined): DurableStore | undefined {
  return runId === undefined ? undefined : runStores.get(runId);
}

/**
 * Create (and register) the durable store for one run. Idempotent per runId:
 * a second call for the same runId returns the EXISTING instance — the vm
 * injection and the manager agree on one sink per run. Nested workflow()
 * frames bind their own runId (see bindRunDurableStore) and are closed
 * together with the parent by closeRunDurableStore.
 */
export function createRunDurableStore(options: DurableStoreOptions): DurableStore {
  if (options.runId !== undefined) {
    const existing = runStores.get(options.runId);
    if (existing) return existing;
    const store = new DurableStore(options);
    runStores.set(options.runId, store);
    return store;
  }
  return new DurableStore(options);
}

/**
 * Unregister the run's store (and any nested-frame stores of the same run).
 * The store object stays usable for its remaining lifetime; this only drops
 * the registry entry so a long-lived process never leaks per-run sinks.
 */
export function closeRunDurableStore(runId: string | undefined): void {
  if (runId === undefined) return;
  runStores.delete(runId);
  const prefix = `${runId}-nested`;
  for (const key of [...runStores.keys()]) {
    if (key.startsWith(prefix)) runStores.delete(key);
  }
}

/**
 * Route one provenance entry to the run's registered store. A no-op when the
 * runId is absent or no store is registered (direct embeds, non-workflow
 * hosts). Failures are swallowed: provenance is observability, never a reason
 * to fail the run.
 */
export async function recordProvenance(runId: string | undefined, entry: ProvenanceEntry): Promise<void> {
  if (runId === undefined) return;
  const store = runStores.get(runId);
  if (!store) return;
  try {
    await store.record(entry);
  } catch {
    // provenance is best-effort
  }
}

/**
 * The run-bind helper invoked by runWorkflow's runtimeImplementations (the
 * single permitted workflow.ts touch for P06): builds the run's project-scoped
 * durable store with a deterministic provenance clock and registers it as the
 * run's sink. The returned object is the `durableStore` vm global — a plain
 * subset of the DurableStore API, so scripts get the same idempotent surface.
 */
export function bindRunDurableStore(options: { runId?: string; cwd?: string }): DurableStore {
  const projectKey = workflowProjectKey(options.cwd ?? process.cwd());
  return createRunDurableStore({
    runId: options.runId,
    projectKey,
    now: deterministicRunClock(options.runId),
  });
}
