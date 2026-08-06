/**
 * ProviderPool — per-provider concurrency caps + run-sticky provider routing
 * for workflow subagents (design: tasks/provider-load-balance/design.md).
 *
 * Subagents fan out in parallel and hit the first provider's TPM / concurrent
 * request limit before the run finishes. The pool mixes two+ providers serving
 * the same logical model: each acquire pins the run to ONE provider
 * (`ProviderChoice`, `sticky: true`) whose bound model never changes for the
 * session, with per-provider concurrency caps, a manual output-TPM gate, and
 * an automatic cooldown after recorded 429/limit events.
 *
 * Contract summary (design §"ProviderPool API" + behavior matrix):
 *  - `acquire` consults a per-logical-model FIFO queue when every candidate is
 *    saturated ("wait" mode, abort-aware) or throws `WorkflowError
 *    PROVIDER_SATURATED` ("fail" mode). Sticky re-acquires (retry attempts,
 *    same `stickyKey`) return the SAME choice without re-counting — the
 *    reservation holds its concurrency slot across attempts and `release` is
 *    idempotent, so the pool stays accurate during backoff.
 *  - "fail" mode recoverability: `recoverable:false` when the ENTIRE pool is
 *    saturated (the run checkpoints/pauses like a usage limit); `recoverable:
 *    true` when only the run's sticky provider is capped/cooling down while
 *    other providers are free (the retry lands once the cap frees).
 *  - Routing among non-capped, non-cooldown, auth-configured providers picks
 *    `min(active / weight)` (proportional, concurrency floor); providers with
 *    no configured auth in the registry are skipped with a one-time log.
 *  - Handoff sessions bypass the pool entirely at the caller (`agent.ts` skips
 *    `acquire` when reusing a handoff session); this class never swaps a bound
 *    model.
 *
 * One stickyKey = one reservation. A run's acquire is the only caller per
 * `agent.run()` (deltaKey = stickyKey), so a re-acquire for the same logical
 * model returns the pinned choice; a re-acquire for a DIFFERENT logical model
 * falls through to fresh routing (the previous reservation is replaced).
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import { DEFAULT_COOLDOWN_MS, normalizeProviderPoolConfig } from "./provider-pool-config.js";

// ─── Public config surface ──────────────────────────────────────────────────

/**
 * One provider endpoint serving a logical model: the registry `modelId` this
 * provider exposes, its concurrency cap, routing weight, optional manual
 * output-TPM cap, and optional 429-cooldown duration.
 */
export interface ProviderPoolEntry {
  /** Registry provider id (must have configured auth in the registry). */
  provider: string;
  /** Registry model id this provider serves for the logical model. */
  modelId: string;
  /** Max concurrent agents on this provider endpoint. */
  concurrency: number;
  /** Proportional routing weight (pick min(active/weight) among free providers). */
  weight: number;
  /** Manual output-TPM cap over `defaultTpmWindowMs` (primary TPM gate). */
  tpm?: number;
  /** Cooldown after a recorded 429/limit event, ms (default 60s). */
  cooldownMs?: number;
}

/**
 * Normalized provider pool configuration (see provider-pool-config.ts for the
 * raw settings input + normalization).
 */
export interface ProviderPoolConfig {
  /** Pool on/off. Off → legacy single-resolution behavior. */
  enabled: boolean;
  /** Saturation behavior: "wait" (FIFO, abort-aware) | "fail" (PROVIDER_SATURATED). */
  whenSaturated: "wait" | "fail";
  /** Wait budget for a saturated acquire in ms; 0 = wait forever. */
  saturationWaitTimeoutMs: number;
  /** Rolling window (ms) for measured output-TPM and the TPM cap gate. */
  defaultTpmWindowMs: number;
  /** Logical model id → provider id → entry. */
  models: Record<string, Record<string, ProviderPoolEntry>>;
}

/** Options for {@link ProviderPool} construction. */
export interface ProviderPoolOptions {
  /**
   * Pool-level abort signal (e.g. the host session's turn signal). Pending
   * waiters abort when it fires, in addition to each acquire's own signal.
   */
  signal?: AbortSignal;
}

/**
 * The pinned routing decision for one agent run. `sticky: true` is
 * architectural: the chosen provider is fixed for the whole session and retry
 * attempts re-acquire the same choice.
 */
export interface ProviderChoice {
  /** Registry provider id. */
  provider: string;
  /** Registry model id on that provider (may differ from the logical model id). */
  modelId: string;
  /** Always true — the pool never hands out a swappable choice. */
  sticky: true;
}

// ─── Snapshot ───────────────────────────────────────────────────────────────

/** Per-endpoint view for the /workflows models menu + get_workflow_status tool. */
export interface ProviderPoolSnapshotEntry {
  provider: string;
  modelId: string;
  /** Logical model ids this endpoint serves. */
  logicalModels: readonly string[];
  concurrency: number;
  /** Live (unreleased) reservations on this endpoint. */
  active: number;
  weight: number;
  tpm?: number;
  /** Measured output tokens in the current rolling window. */
  measuredTpm: number;
  cooldownMs?: number;
  /** Epoch ms when a 429-cooldown expires; absent when not cooling down. */
  cooldownUntil?: number;
  /** True when the endpoint is capped, TPM-capped, or in cooldown. */
  blocked: boolean;
}

/** Snapshot of the whole pool for status surfaces. */
export interface ProviderPoolSnapshot {
  enabled: boolean;
  whenSaturated: "wait" | "fail";
  saturationWaitTimeoutMs: number;
  defaultTpmWindowMs: number;
  entries: ProviderPoolSnapshotEntry[];
  /** Total FIFO waiters queued across all logical models. */
  waiting: number;
  /** Total live (unreleased) reservations. */
  reservations: number;
}

// ─── Internal state ─────────────────────────────────────────────────────────

/** Per-endpoint (provider+modelId) concurrency state. */
interface EntryState {
  active: number;
}

/** Per-provider cooldown + rolling TPM window state. */
interface ProviderMetrics {
  cooldownUntil: number;
  /** Rolling TPM window entries in timestamp order; same-ms spends are aggregated. */
  tpmTokens: Array<{ at: number; tokens: number }>;
  /** Incremental sum of non-evicted entries in `tpmTokens` (lazy-pruned). */
  tpmSum: number;
  /** Eviction pointer: index of the first entry still inside the window. */
  tpmHead: number;
}

/** A live (unreleased) acquisition, keyed by id and optionally by stickyKey. */
interface Reservation {
  id: number;
  stickyKey?: string;
  logicalModel: string;
  provider: string;
  modelId: string;
  released: boolean;
}

/** A queued acquire waiting for a slot / cooldown expiry. */
interface Waiter {
  logicalModel: string;
  /** "fresh" placements count against a concurrency cap; "sticky" re-acquires do not. */
  mode: "fresh" | "sticky";
  /** Fresh waiters: the stickyKey to attach to the reservation they create. */
  stickyKey?: string;
  /** Sticky waiters: the live reservation they are waiting to re-acquire. */
  reservation?: Reservation;
  resolve: (choice: ProviderChoice) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
}

/** Identity of a config entry for runtime-state bookkeeping. */
function entryKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`;
}

/** Abort-shaped rejection so callers classify it as an abort (WORKFLOW_ABORTED). */
function abortError(message = "Provider pool acquire aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * Per-provider concurrency + run-sticky routing. Construct via the
 * {@link createProviderPoolFromConfig} factory for normalized configs.
 */
export class ProviderPool {
  private readonly config: ProviderPoolConfig;
  private readonly registry: ModelRegistry;
  private readonly poolSignal?: AbortSignal;

  /** Logical model → its entries in config order. */
  private readonly entriesByModel = new Map<string, ProviderPoolEntry[]>();
  /** Endpoint key → logical models serving it (for targeted wake dispatch). */
  private readonly modelsByEntry = new Map<string, string[]>();
  /** Endpoint key → concurrency state. */
  private readonly entryStates = new Map<string, EntryState>();
  /** Provider id → cooldown + TPM window state. */
  private readonly providerMetrics = new Map<string, ProviderMetrics>();
  /** stickyKey → reservation id. */
  private readonly sticky = new Map<string, number>();
  /** reservation id → reservation. */
  private readonly reservations = new Map<number, Reservation>();
  /** Logical model → FIFO waiter queue. */
  private readonly waiters = new Map<string, Waiter[]>();
  /** Logical model → earliest-unblock wake timer. */
  private readonly wakeTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; dueAt: number }>();
  /** Providers already logged as "no configured auth" (one-time log per provider). */
  private readonly warnedNoAuth = new Set<string>();
  private nextReservationId = 0;
  /** Set once shutdown() ran; acquires then reject like a pool-level abort. */
  private shutdownDone = false;

  constructor(config: ProviderPoolConfig, registry: ModelRegistry, options: ProviderPoolOptions = {}) {
    this.config = config;
    this.registry = registry;
    this.poolSignal = options.signal;
    if (config.enabled) this.indexEntries(config.models);
    // A pool-level abort (host session end) deterministically tears the pool
    // down: settle every queued waiter and clear every armed wake timer. Without
    // this, a pool dropped mid-saturation keeps its timers alive until the next
    // cooldown/TPM expiry even though nothing will ever satisfy its waiters.
    if (this.poolSignal) {
      if (this.poolSignal.aborted) this.shutdown();
      else this.poolSignal.addEventListener("abort", () => this.shutdown(), { once: true });
    }
  }

  /**
   * Acquire a provider for a logical model.
   *
   * Returns `undefined` when the logical model has no pool entries — the
   * caller falls back to legacy single-resolution. Otherwise returns a
   * {@link ProviderChoice} (sticky, pinned to one provider).
   *
   * Sticky re-acquire (`stickyKey` already reserved for the same logical
   * model): returns the SAME choice without re-counting; if the pinned
   * provider is cooling down or TPM-capped it FIFO-waits ("wait") or throws
   * PROVIDER_SATURATED ("fail").
   *
   * Fresh acquires count against the provider's concurrency cap. When every
   * candidate is saturated: "wait" enqueues a FIFO waiter (abort-aware,
   * bounded by `saturationWaitTimeoutMs`, 0 = forever); "fail" throws
   * PROVIDER_SATURATED — recoverable:false when the whole pool is saturated,
   * recoverable:true when only the sticky provider is blocked and others are
   * free.
   */
  async acquire(
    logicalModel: string,
    options: { stickyKey?: string; signal?: AbortSignal } = {},
  ): Promise<ProviderChoice | undefined> {
    const entries = this.entriesByModel.get(logicalModel);
    if (!entries || entries.length === 0) return undefined;
    if (this.shutdownDone || this.poolSignal?.aborted) throw abortError("Provider pool was shut down");
    if (options.signal?.aborted) throw abortError();

    // Sticky re-acquire: retry attempts share the stickyKey (deltaKey) and
    // must return the same pinned choice without re-counting.
    if (options.stickyKey !== undefined) {
      const reservationId = this.sticky.get(options.stickyKey);
      if (reservationId !== undefined) {
        const reservation = this.reservations.get(reservationId);
        if (reservation && !reservation.released && reservation.logicalModel === logicalModel) {
          return this.acquireSticky(logicalModel, reservation, options.signal);
        }
      }
    }

    // Fresh placement (first attempt, or sticky fall-through after config/auth
    // drift). Counts against the chosen provider's concurrency cap.
    const placed = this.place(logicalModel);
    if (placed) {
      const reservation = this.makeReservation(logicalModel, placed, options.stickyKey);
      return this.toChoice(reservation);
    }

    if (this.config.whenSaturated === "fail") {
      throw this.saturationError(logicalModel, undefined);
    }
    return this.enqueueWaiter(logicalModel, { mode: "fresh", stickyKey: options.stickyKey, signal: options.signal });
  }

  /**
   * Release a reservation — decrement its provider's active count exactly once
   * (never below zero), drop the sticky pin, and wake any FIFO waiter that a
   * freed slot satisfies. Idempotent: releasing twice, or releasing an
   * unknown/never-acquired choice, is a no-op. Accepts either the original
   * stickyKey (preferred — unambiguous) or the choice (releases the oldest
   * live reservation matching provider+modelId).
   */
  release(ref: ProviderChoice | string): void {
    let reservation: Reservation | undefined;
    if (typeof ref === "string") {
      const reservationId = this.sticky.get(ref);
      reservation = reservationId !== undefined ? this.reservations.get(reservationId) : undefined;
    } else {
      reservation = this.findLiveReservation(ref.provider, ref.modelId);
    }
    if (!reservation) return;
    this.releaseReservation(reservation);
  }

  /**
   * Record measured output-token spend on a provider into its rolling TPM
   * window (width `defaultTpmWindowMs`). A provider whose window sum reaches
   * an entry's `tpm` cap is treated as saturated for new placements until old
   * tokens roll out. No-op for non-finite/non-positive counts.
   */
  recordSpend(provider: string, outputTokens: number): void {
    if (!Number.isFinite(outputTokens) || outputTokens <= 0) return;
    const metrics = this.providerMetricsFor(provider);
    const now = Date.now();
    this.pruneTpm(metrics, now);
    // Same-ms spends merge into one entry so the window grows with wall-clock
    // seconds rather than recordSpend call volume.
    const last = metrics.tpmTokens[metrics.tpmTokens.length - 1];
    if (last && last.at === now) last.tokens += outputTokens;
    else metrics.tpmTokens.push({ at: now, tokens: outputTokens });
    metrics.tpmSum += outputTokens;
  }

  /**
   * Record a 429/usage-limit event for a provider: it enters a cooldown
   * (default 60s, or the entry's `cooldownMs`) during which new placements
   * skip it. Already-running agents are unaffected (their reservations stay).
   */
  recordLimitEvent(provider: string): void {
    const entry = this.firstEntryForProvider(provider);
    const cooldownMs = entry?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.providerMetricsFor(provider).cooldownUntil = Date.now() + cooldownMs;
    // A provider entering cooldown only BLOCKS more work, so no waiter can be
    // satisfied by this event; the wake timers are re-armed so a queued wait
    // that depends on this provider's expiry wakes at the right moment.
    this.scheduleWakeForProvider(provider);
  }

  /** Snapshot for status surfaces (/workflows models, get_workflow_status). */
  snapshot(): ProviderPoolSnapshot {
    const entries: ProviderPoolSnapshotEntry[] = [];
    const seen = new Set<string>();
    for (const [_logicalModel, modelEntries] of this.entriesByModel) {
      for (const entry of modelEntries) {
        const key = entryKey(entry.provider, entry.modelId);
        if (seen.has(key)) continue;
        seen.add(key);
        const state = this.entryState(entry.provider, entry.modelId);
        const metrics = this.providerMetricsFor(entry.provider);
        const now = Date.now();
        const cooldownUntil = metrics.cooldownUntil > now ? metrics.cooldownUntil : undefined;
        entries.push({
          provider: entry.provider,
          modelId: entry.modelId,
          logicalModels: this.modelsByEntry.get(key) ?? [],
          concurrency: entry.concurrency,
          active: state.active,
          weight: entry.weight,
          tpm: entry.tpm,
          measuredTpm: this.measuredTpm(entry.provider),
          cooldownMs: entry.cooldownMs,
          cooldownUntil,
          blocked:
            this.isProviderInCooldown(entry.provider) || this.isTpmCapped(entry) || state.active >= entry.concurrency,
        });
      }
    }
    let waiting = 0;
    for (const queue of this.waiters.values()) waiting += queue.length;
    return {
      enabled: this.config.enabled,
      whenSaturated: this.config.whenSaturated,
      saturationWaitTimeoutMs: this.config.saturationWaitTimeoutMs,
      defaultTpmWindowMs: this.config.defaultTpmWindowMs,
      entries,
      waiting,
      reservations: this.reservations.size,
    };
  }

  // ─── Acquire internals ────────────────────────────────────────────────────

  /** Sticky re-acquire for an existing reservation. */
  private async acquireSticky(
    logicalModel: string,
    reservation: Reservation,
    signal: AbortSignal | undefined,
  ): Promise<ProviderChoice> {
    const entry = this.findEntry(logicalModel, reservation.provider);
    if (!entry) {
      // Config drift (entry removed mid-run): the pinned endpoint is gone —
      // release the stale reservation and route fresh under the same stickyKey.
      this.releaseReservation(reservation);
      return this.acquireFreshAfterStickyDrift(logicalModel, reservation, signal);
    }
    if (!this.isProviderInCooldown(entry.provider) && !this.isTpmCapped(entry)) {
      // Unblocked: same choice, no re-count (the reservation already holds its
      // concurrency slot for the whole run).
      return this.toChoice(reservation);
    }
    if (this.config.whenSaturated === "fail") {
      throw this.saturationError(logicalModel, reservation.provider);
    }
    return this.enqueueWaiter(logicalModel, { mode: "sticky", reservation, signal });
  }

  /**
   * Fresh-routing fallback after sticky drift. The old reservation's slot is
   * gone; place like a first attempt and keep the stickyKey pin on the new
   * reservation so subsequent retries stick to the fresh choice.
   */
  private async acquireFreshAfterStickyDrift(
    logicalModel: string,
    previous: Reservation,
    signal: AbortSignal | undefined,
  ): Promise<ProviderChoice> {
    const placed = this.place(logicalModel);
    if (placed) {
      const reservation = this.makeReservation(logicalModel, placed, previous.stickyKey);
      return this.toChoice(reservation);
    }
    if (this.config.whenSaturated === "fail") {
      throw this.saturationError(logicalModel, undefined);
    }
    return this.enqueueWaiter(logicalModel, { mode: "fresh", stickyKey: previous.stickyKey, signal });
  }

  /**
   * Route among non-capped, non-cooldown, auth-configured entries: pick
   * `min(active / weight)` (proportional, with the concurrency floor enforced
   * per entry). Returns undefined when every candidate is saturated.
   */
  private place(logicalModel: string): { provider: string; modelId: string } | undefined {
    let best: { provider: string; modelId: string; score: number } | undefined;
    for (const entry of this.entriesByModel.get(logicalModel) ?? []) {
      if (!this.isEntryPlaceable(entry)) continue;
      const state = this.entryState(entry.provider, entry.modelId);
      const score = state.active / entry.weight;
      if (!best || score < best.score) {
        best = { provider: entry.provider, modelId: entry.modelId, score };
      }
    }
    return best ? { provider: best.provider, modelId: best.modelId } : undefined;
  }

  /** Whether a fresh acquire may land on this entry right now. */
  private isEntryPlaceable(entry: ProviderPoolEntry): boolean {
    if (this.isProviderInCooldown(entry.provider)) return false;
    if (this.isTpmCapped(entry)) return false;
    if (!this.isAuthConfigured(entry)) return false;
    return this.entryState(entry.provider, entry.modelId).active < entry.concurrency;
  }

  /** Whether ANY entry for the model (other than `exceptProvider`) can take a fresh acquire. */
  private hasFreeEntry(logicalModel: string, exceptProvider?: string): boolean {
    for (const entry of this.entriesByModel.get(logicalModel) ?? []) {
      if (entry.provider === exceptProvider) continue;
      if (this.isEntryPlaceable(entry)) return true;
    }
    return false;
  }

  /** A registry-auth check (model exists + hasConfiguredAuth). Warns once per provider. */
  private isAuthConfigured(entry: ProviderPoolEntry): boolean {
    const model = this.registry.find(entry.provider, entry.modelId);
    // Feature-detect: the public registry surface grew hasConfiguredAuth in a
    // later SDK; without it an existing model is trusted (optimistic).
    const configured =
      model !== undefined &&
      (typeof this.registry.hasConfiguredAuth !== "function" || this.registry.hasConfiguredAuth(model));
    if (configured) {
      // Re-arm the warning so a provider that regains auth later logs again if
      // it loses it again.
      this.warnedNoAuth.delete(entry.provider);
      return true;
    }
    if (!this.warnedNoAuth.has(entry.provider)) {
      this.warnedNoAuth.add(entry.provider);
      console.warn(
        `[workflows] Provider pool: provider "${entry.provider}" (model "${entry.modelId}") has no ` +
          "configured auth in the registry — skipped by routing. Add its credentials to auth.json " +
          "or register it dynamically to pool it.",
      );
    }
    return false;
  }

  /** Create a reservation, count its concurrency slot, and pin the stickyKey. */
  private makeReservation(
    logicalModel: string,
    choice: { provider: string; modelId: string },
    stickyKey?: string,
  ): Reservation {
    const reservation: Reservation = {
      id: ++this.nextReservationId,
      logicalModel,
      provider: choice.provider,
      modelId: choice.modelId,
      released: false,
      stickyKey,
    };
    this.reservations.set(reservation.id, reservation);
    this.entryState(choice.provider, choice.modelId).active += 1;
    if (stickyKey !== undefined) this.sticky.set(stickyKey, reservation.id);
    return reservation;
  }

  /** Idempotent release of one reservation. */
  private releaseReservation(reservation: Reservation): void {
    if (reservation.released) return;
    reservation.released = true;
    const state = this.entryState(reservation.provider, reservation.modelId);
    if (state.active > 0) state.active -= 1;
    if (reservation.stickyKey !== undefined) this.sticky.delete(reservation.stickyKey);
    this.reservations.delete(reservation.id);
    this.dispatch(reservation.logicalModel);
  }

  /** Oldest live reservation matching provider+modelId (release-by-choice fallback). */
  private findLiveReservation(provider: string, modelId: string): Reservation | undefined {
    for (const reservation of this.reservations.values()) {
      if (!reservation.released && reservation.provider === provider && reservation.modelId === modelId) {
        return reservation;
      }
    }
    return undefined;
  }

  // ─── Saturation errors ────────────────────────────────────────────────────

  /**
   * PROVIDER_SATURATED with the design's recoverability split: recoverable
   * only when a pinned (sticky) provider is blocked while other providers are
   * free — the retry may land once the cap frees. A whole-pool saturation
   * (or a fresh acquire that found no free provider) is non-recoverable so the
   * run checkpoints/pauses like a usage limit instead of burning retries.
   */
  private saturationError(logicalModel: string, pinnedProvider: string | undefined): WorkflowError {
    const recoverable = pinnedProvider !== undefined && this.hasFreeEntry(logicalModel, pinnedProvider);
    const message =
      pinnedProvider !== undefined
        ? `Provider pool saturated for model "${logicalModel}": pinned provider "${pinnedProvider}" is ` +
          "at capacity, TPM-capped, or cooling down."
        : `Provider pool saturated for model "${logicalModel}": every configured provider is at ` +
          "capacity, TPM-capped, or cooling down.";
    return new WorkflowError(message, WorkflowErrorCode.PROVIDER_SATURATED, { recoverable });
  }

  // ─── Wait mode: FIFO queue ────────────────────────────────────────────────

  /** Enqueue a waiter (fresh or sticky) with abort + timeout handling. */
  private enqueueWaiter(
    logicalModel: string,
    options: {
      mode: "fresh" | "sticky";
      stickyKey?: string;
      reservation?: Reservation;
      signal?: AbortSignal;
    },
  ): Promise<ProviderChoice> {
    return new Promise<ProviderChoice>((resolve, reject) => {
      const waiter: Waiter = {
        logicalModel,
        mode: options.mode,
        stickyKey: options.stickyKey,
        reservation: options.reservation,
        resolve,
        reject,
        settled: false,
      };
      const queue = this.waiters.get(logicalModel) ?? [];
      queue.push(waiter);
      this.waiters.set(logicalModel, queue);
      this.armWaiter(waiter, options.signal);
      // Nothing changed that could free a slot (placement was just attempted),
      // but arm the wake timer for cooldown/TPM expiries now.
      this.scheduleWake(logicalModel);
    });
  }

  /** Attach abort listeners + the saturation-wait timeout to a queued waiter. */
  private armWaiter(waiter: Waiter, signal?: AbortSignal): void {
    const listeners: Array<[AbortSignal, () => void]> = [];
    const onAbort = (): void => {
      if (waiter.settled) return;
      this.settleWaiter(waiter, undefined, abortError(), true);
    };
    const poolSignal = this.poolSignal;
    if (poolSignal) {
      if (poolSignal.aborted) return void onAbort();
      poolSignal.addEventListener("abort", onAbort, { once: true });
      listeners.push([poolSignal, onAbort]);
    }
    if (signal) {
      if (signal.aborted) return void onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      listeners.push([signal, onAbort]);
    }
    waiter.abortCleanup = () => {
      for (const [listenerSignal, listener] of listeners) {
        listenerSignal.removeEventListener("abort", listener);
      }
    };
    if (this.config.saturationWaitTimeoutMs > 0) {
      waiter.timeoutTimer = setTimeout(() => {
        // Wait budget exhausted: degrade to the fail-mode classification.
        const error = this.saturationError(waiter.logicalModel, waiter.reservation?.provider);
        this.settleWaiter(waiter, undefined, error, true);
      }, this.config.saturationWaitTimeoutMs);
    }
  }

  /**
   * Settle a waiter: clear timers/listeners, reject or resolve. With
   * `removeFromQueue` (timeout/abort paths) the waiter is spliced out of its
   * FIFO queue; the dispatch path rebuilds the queue itself.
   */
  private settleWaiter(
    waiter: Waiter,
    choice: ProviderChoice | undefined,
    error: unknown,
    removeFromQueue: boolean,
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timeoutTimer) clearTimeout(waiter.timeoutTimer);
    waiter.abortCleanup?.();
    if (removeFromQueue) this.removeWaiter(waiter);
    if (error !== undefined) waiter.reject(error);
    else waiter.resolve(choice as ProviderChoice);
  }

  private removeWaiter(waiter: Waiter): void {
    const queue = this.waiters.get(waiter.logicalModel);
    if (!queue) return;
    const index = queue.indexOf(waiter);
    if (index === -1) return;
    queue.splice(index, 1);
    if (queue.length === 0) {
      this.waiters.delete(waiter.logicalModel);
      // Abort/timeout paths settle a waiter without a dispatch() to clean up
      // after it, so the model's wake timer (armed at enqueue) would otherwise
      // survive and fire into an empty queue at the next cooldown/TPM expiry —
      // a timer a dead pool must not keep around. The release path is already
      // covered: dispatch() clears it when the queue empties.
      this.clearWakeTimer(waiter.logicalModel);
    }
  }

  /**
   * Scan a model's FIFO queue head-first and place every waiter that is
   * currently satisfiable; blocked heads are skipped (not starved) so later
   * waiters on free providers proceed. Sticky waiters resolve their existing
   * reservation (no re-count); fresh waiters place + count.
   */
  private dispatch(logicalModel: string): void {
    const queue = this.waiters.get(logicalModel);
    if (!queue || queue.length === 0) {
      this.clearWakeTimer(logicalModel);
      return;
    }
    const remaining: Waiter[] = [];
    for (const waiter of queue) {
      if (waiter.settled) continue;
      if (waiter.mode === "sticky") {
        const reservation = waiter.reservation;
        if (!reservation || reservation.released) {
          // The reservation vanished while waiting (released elsewhere) — the
          // wait can never be honored; fail it rather than hanging forever.
          this.settleWaiter(waiter, undefined, this.saturationError(logicalModel, reservation?.provider), false);
          continue;
        }
        const entry = this.findEntry(logicalModel, reservation.provider);
        if (!entry || this.isProviderInCooldown(entry.provider) || this.isTpmCapped(entry)) {
          remaining.push(waiter);
          continue;
        }
        // No re-count: the sticky reservation already holds its slot.
        this.settleWaiter(waiter, this.toChoice(reservation), undefined, false);
        continue;
      }
      const placed = this.place(logicalModel);
      if (!placed) {
        remaining.push(waiter);
        continue;
      }
      this.makeReservation(logicalModel, placed, waiter.stickyKey);
      this.settleWaiter(waiter, this.toChoice(placed.provider, placed.modelId), undefined, false);
    }
    this.waiters.set(logicalModel, remaining);
    if (remaining.length > 0) this.scheduleWake(logicalModel);
    else this.clearWakeTimer(logicalModel);
  }

  // ─── Cooldown / TPM / wake timers ─────────────────────────────────────────

  private isProviderInCooldown(provider: string): boolean {
    return this.providerMetricsFor(provider).cooldownUntil > Date.now();
  }

  private isTpmCapped(entry: ProviderPoolEntry): boolean {
    if (entry.tpm === undefined) return false;
    return this.measuredTpm(entry.provider) >= entry.tpm;
  }

  /** Current rolling-window output-token sum for a provider. */
  private measuredTpm(provider: string): number {
    const metrics = this.providerMetricsFor(provider);
    this.pruneTpm(metrics);
    return metrics.tpmSum;
  }

  /**
   * Lazily evict window entries with a head pointer (no O(n) shift per call)
   * while keeping `tpmSum` correct, and compact the array once the evicted
   * prefix dominates it (amortized O(1) over a window's lifetime).
   */
  private pruneTpm(metrics: ProviderMetrics, now: number = Date.now()): void {
    const cutoff = now - this.config.defaultTpmWindowMs;
    const tokens = metrics.tpmTokens;
    while (metrics.tpmHead < tokens.length && tokens[metrics.tpmHead].at <= cutoff) {
      metrics.tpmSum -= tokens[metrics.tpmHead].tokens;
      metrics.tpmHead += 1;
    }
    if (metrics.tpmHead >= 64 && metrics.tpmHead * 2 >= tokens.length) {
      tokens.splice(0, metrics.tpmHead);
      metrics.tpmHead = 0;
    }
  }

  /**
   * Earliest moment any entry for the model becomes placeable again via time
   * (cooldown expiry or TPM window roll-off). Concurrency-capped entries free
   * only via release() → dispatch(), so they contribute no time.
   */
  private earliestUnblockTime(logicalModel: string): number | undefined {
    let earliest: number | undefined;
    const now = Date.now();
    for (const entry of this.entriesByModel.get(logicalModel) ?? []) {
      const cooldownUntil = this.providerMetricsFor(entry.provider).cooldownUntil;
      if (cooldownUntil > now) earliest = minOr(earliest, cooldownUntil);
      if (entry.tpm !== undefined) {
        const tpmUnblock = this.tpmUnblockTime(entry.provider, entry.tpm);
        if (tpmUnblock !== undefined) earliest = minOr(earliest, tpmUnblock);
      }
    }
    return earliest;
  }

  /** When the rolling window will drop below `cap` again (or undefined if not capped). */
  private tpmUnblockTime(provider: string, cap: number): number | undefined {
    const metrics = this.providerMetricsFor(provider);
    this.pruneTpm(metrics);
    if (metrics.tpmSum < cap) return undefined;
    // Tokens are pushed in timestamp order. Removing the k oldest tokens
    // (running -= tokens[k]) brings the sum under cap exactly when token k
    // exits the window.
    let running = metrics.tpmSum;
    for (let i = metrics.tpmHead; i < metrics.tpmTokens.length; i++) {
      const entry = metrics.tpmTokens[i];
      running -= entry.tokens;
      if (running < cap) return entry.at + this.config.defaultTpmWindowMs;
    }
    return Date.now() + this.config.defaultTpmWindowMs;
  }

  /** One wake timer per model, re-armed when an earlier unblock appears. */
  private scheduleWake(logicalModel: string): void {
    const queue = this.waiters.get(logicalModel);
    if (!queue || queue.length === 0) {
      this.clearWakeTimer(logicalModel);
      return;
    }
    const earliest = this.earliestUnblockTime(logicalModel);
    if (earliest === undefined) {
      this.clearWakeTimer(logicalModel);
      return;
    }
    const existing = this.wakeTimers.get(logicalModel);
    if (existing && existing.dueAt <= earliest) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(
      () => {
        this.wakeTimers.delete(logicalModel);
        this.dispatch(logicalModel);
      },
      Math.max(0, earliest - Date.now()),
    );
    // A wake timer is purely advisory — dispatch() is also triggered by
    // release(), recordLimitEvent(), and acquire(). unref() so a pool that is
    // dropped (or waiting out a long cooldown) can never pin the event loop
    // open on its own; if the process is alive for any other reason the timer
    // still fires and re-checks the queue.
    timer.unref();
    this.wakeTimers.set(logicalModel, { timer, dueAt: earliest });
  }

  private clearWakeTimer(logicalModel: string): void {
    const existing = this.wakeTimers.get(logicalModel);
    if (existing) {
      clearTimeout(existing.timer);
      this.wakeTimers.delete(logicalModel);
    }
  }

  /**
   * Deterministic teardown for a dead pool: settle every queued waiter with an
   * abort error and clear every armed wake timer. Idempotent — a pool-level
   * signal abort, a host shutdown, and each waiter's own abort all converge on
   * this, and later calls (or a re-entrant settle from a listener) are no-ops.
   * Acquires after shutdown reject like a pool-level abort.
   */
  shutdown(): void {
    if (this.shutdownDone) return;
    this.shutdownDone = true;
    for (const [logicalModel] of [...this.waiters]) {
      // settleWaiter → removeWaiter clears each model's wake timer via the
      // queue-empty path below; the sweep is a safety net for any timer whose
      // model map entry was already gone.
      for (const waiter of [...(this.waiters.get(logicalModel) ?? [])]) {
        this.settleWaiter(waiter, undefined, abortError("Provider pool was shut down"), true);
      }
    }
    for (const logicalModel of [...this.wakeTimers.keys()]) this.clearWakeTimer(logicalModel);
  }

  /** Re-arm wake timers for every logical model served by a provider. */
  private scheduleWakeForProvider(provider: string): void {
    const models = new Set<string>();
    for (const [key, logicalModels] of this.modelsByEntry) {
      if (key.startsWith(`${provider}\u0000`)) {
        for (const logicalModel of logicalModels) models.add(logicalModel);
      }
    }
    for (const logicalModel of models) this.scheduleWake(logicalModel);
  }

  // ─── Small lookups ────────────────────────────────────────────────────────

  private findEntry(logicalModel: string, provider: string): ProviderPoolEntry | undefined {
    return this.entriesByModel.get(logicalModel)?.find((entry) => entry.provider === provider);
  }

  private firstEntryForProvider(provider: string): ProviderPoolEntry | undefined {
    for (const modelEntries of this.entriesByModel.values()) {
      const entry = modelEntries.find((candidate) => candidate.provider === provider);
      if (entry) return entry;
    }
    return undefined;
  }

  private entryState(provider: string, modelId: string): EntryState {
    const key = entryKey(provider, modelId);
    let state = this.entryStates.get(key);
    if (!state) {
      state = { active: 0 };
      this.entryStates.set(key, state);
    }
    return state;
  }

  private providerMetricsFor(provider: string): ProviderMetrics {
    let metrics = this.providerMetrics.get(provider);
    if (!metrics) {
      metrics = { cooldownUntil: 0, tpmTokens: [], tpmSum: 0, tpmHead: 0 };
      this.providerMetrics.set(provider, metrics);
    }
    return metrics;
  }

  private toChoice(provider: string, modelId: string): ProviderChoice;
  private toChoice(reservation: Reservation): ProviderChoice;
  private toChoice(providerOrReservation: string | Reservation, modelId?: string): ProviderChoice {
    if (typeof providerOrReservation === "string") {
      return { provider: providerOrReservation, modelId: modelId as string, sticky: true };
    }
    return { provider: providerOrReservation.provider, modelId: providerOrReservation.modelId, sticky: true };
  }

  /** Build the entries index + reverse logical-model map from config. */
  private indexEntries(models: ProviderPoolConfig["models"]): void {
    for (const [logicalModel, providers] of Object.entries(models)) {
      const entries = Object.values(providers).filter((entry): entry is ProviderPoolEntry => entry !== undefined);
      if (entries.length === 0) continue;
      this.entriesByModel.set(logicalModel, entries);
      for (const entry of entries) {
        const key = entryKey(entry.provider, entry.modelId);
        const logicalModels = this.modelsByEntry.get(key) ?? [];
        if (!logicalModels.includes(logicalModel)) logicalModels.push(logicalModel);
        this.modelsByEntry.set(key, logicalModels);
      }
    }
  }
}

/**
 * Build a pool from a provider pool config. Accepts an already-normalized
 * {@link ProviderPoolConfig} or any raw settings/env value (normalized via
 * `normalizeProviderPoolConfig`, idempotently). Returns `undefined` when the
 * pool is disabled or has no entries — the caller keeps legacy behavior.
 */
export function createProviderPoolFromConfig(
  config: ProviderPoolConfig | unknown,
  registry: ModelRegistry,
  options: ProviderPoolOptions = {},
): ProviderPool | undefined {
  const normalized = normalizeProviderPoolConfig(config);
  if (!normalized.enabled) return undefined;
  if (Object.keys(normalized.models).length === 0) return undefined;
  return new ProviderPool(normalized, registry, options);
}

function minOr(a: number | undefined, b: number): number {
  return a === undefined || b < a ? b : a;
}
