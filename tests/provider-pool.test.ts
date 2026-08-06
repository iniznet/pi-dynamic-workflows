import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { WorkflowErrorCode } from "../src/errors.js";
import { ProviderPool, type ProviderPoolConfig, type ProviderPoolEntry } from "../src/gateway/provider-pool.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

type EntrySpec = Omit<ProviderPoolEntry, "provider" | "modelId"> & {
  provider: string;
  modelId: string;
  /** hasConfiguredAuth result for this provider (default true). */
  auth?: boolean;
};

/** Build a normalized ProviderPoolConfig keyed logical-model → provider → entry. */
function makeConfig(
  models: Record<string, EntrySpec[]>,
  overrides: Partial<Pick<ProviderPoolConfig, "whenSaturated" | "saturationWaitTimeoutMs" | "defaultTpmWindowMs">> = {},
): ProviderPoolConfig {
  const normalized: ProviderPoolConfig["models"] = {};
  for (const [logicalModel, specs] of Object.entries(models)) {
    normalized[logicalModel] = {};
    for (const spec of specs) {
      const { auth: _auth, ...entry } = spec;
      normalized[logicalModel][entry.provider] = entry;
    }
  }
  return {
    enabled: true,
    whenSaturated: overrides.whenSaturated ?? "wait",
    saturationWaitTimeoutMs: overrides.saturationWaitTimeoutMs ?? 0,
    defaultTpmWindowMs: overrides.defaultTpmWindowMs ?? 60_000,
    models: normalized,
  };
}

/** Registry stub: find() resolves registered (provider, modelId) pairs; auth per provider. */
function makeRegistry(specs: EntrySpec[]): ModelRegistry {
  const registered = new Set<string>();
  const authByProvider = new Map<string, boolean>();
  for (const spec of specs) {
    registered.add(`${spec.provider}\u0000${spec.modelId}`);
    authByProvider.set(spec.provider, spec.auth ?? true);
  }
  return {
    find: (provider: string, modelId: string) =>
      registered.has(`${provider}\u0000${modelId}`) ? ({ provider, modelId } as never) : undefined,
    hasConfiguredAuth: (model: { provider: string }) => authByProvider.get(model.provider) ?? false,
  } as unknown as ModelRegistry;
}

/** Pool + registry pair for a set of entries serving one logical model. */
function makePool(
  model: string,
  specs: EntrySpec[],
  overrides: Parameters<typeof makeConfig>[1] = {},
  registry?: ModelRegistry,
): { pool: ProviderPool; config: ProviderPoolConfig; registry: ModelRegistry } {
  const config = makeConfig({ [model]: specs }, overrides);
  const reg = registry ?? makeRegistry(specs);
  return { pool: new ProviderPool(config, reg), config, registry: reg };
}

// ─── Weighted routing ───────────────────────────────────────────────────────

test("acquire routes by min(active / weight), spreading across weighted providers", async () => {
  // fast: weight 1, heavy: weight 2 — equal loads route to the lighter-scored one.
  const { pool } = makePool("m", [
    { provider: "fast", modelId: "f", concurrency: 10, weight: 1 },
    { provider: "heavy", modelId: "h", concurrency: 10, weight: 2 },
  ]);

  const first = await pool.acquire("m");
  // Both idle (score 0) → config order wins.
  assert.equal(first?.provider, "fast");

  const second = await pool.acquire("m");
  // fast active 1 → score 1; heavy active 0 → score 0 → heavy wins.
  assert.equal(second?.provider, "heavy");

  const third = await pool.acquire("m");
  // fast active 1 → 1; heavy active 1 → 0.5 → heavy again.
  assert.equal(third?.provider, "heavy");

  const fourth = await pool.acquire("m");
  // fast active 1 → 1; heavy active 2 → 1 → tie → first entry (fast).
  assert.equal(fourth?.provider, "fast");

  assert.equal(pool.snapshot().reservations, 4);
});

// ─── Concurrency caps ───────────────────────────────────────────────────────

test("n-th acquire waits when the provider is at its concurrency cap, then lands after release", async () => {
  const { pool } = makePool("m", [{ provider: "a", modelId: "a", concurrency: 1, weight: 1 }]);

  const first = await pool.acquire("m");
  assert.equal(first?.provider, "a");
  assert.equal(pool.snapshot().entries[0]?.active, 1);

  let second: unknown;
  const waiting = pool.acquire("m").then((choice) => {
    second = choice;
  });
  // Give the (hypothetical) immediate resolution a chance to mis-fire.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(second, undefined, "second acquire must still be queued while capped");

  pool.release(first as NonNullable<typeof first>);
  await waiting;
  assert.equal((second as unknown as { provider: string } | undefined)?.provider, "a");
  assert.equal(pool.snapshot().entries[0]?.active, 1, "waiter's placement re-counts its own slot");
});

// ─── Cooldown after recordLimitEvent ────────────────────────────────────────

test("recordLimitEvent puts the provider in cooldown; fresh acquires skip it until it expires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { pool } = makePool(
    "m",
    [
      { provider: "a", modelId: "a", concurrency: 5, weight: 1, cooldownMs: 100 },
      { provider: "b", modelId: "b", concurrency: 5, weight: 1 },
    ],
    { defaultTpmWindowMs: 60_000 },
  );

  const first = await pool.acquire("m");
  assert.equal(first?.provider, "a");

  pool.recordLimitEvent("a");
  assert.equal(pool.snapshot().entries[0]?.blocked, true, "cooldown marks the endpoint blocked");

  const second = await pool.acquire("m");
  assert.equal(second?.provider, "b", "acquire must skip the cooling-down provider");

  t.mock.timers.tick(101);
  const third = await pool.acquire("m");
  assert.equal(third?.provider, "a", "after cooldown expiry the provider is placeable again");
  assert.equal(pool.snapshot().entries[0]?.cooldownUntil, undefined);
});

test("recordLimitEvent cooldown skips a sticky provider: re-acquire waits and lands after expiry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { pool } = makePool(
    "m",
    [
      { provider: "a", modelId: "a", concurrency: 5, weight: 1, cooldownMs: 100 },
      { provider: "b", modelId: "b", concurrency: 5, weight: 1 },
    ],
    { defaultTpmWindowMs: 60_000 },
  );

  const pinned = await pool.acquire("m", { stickyKey: "run-1" });
  assert.equal(pinned?.provider, "a");

  // The reservation stays live — the run is still attached to the provider
  // that just hit the limit. The sticky re-acquire must wait out the cooldown.
  pool.recordLimitEvent("a");
  let retried: unknown;
  const retry = pool.acquire("m", { stickyKey: "run-1" }).then((choice) => {
    retried = choice;
  });
  // Deterministic: acquire() runs synchronously up to enqueue, so retried is
  // still unset while the cooldown blocks the re-acquire.
  assert.equal(retried, undefined);

  t.mock.timers.tick(101);
  await retry;
  assert.equal((retried as unknown as { provider: string } | undefined)?.provider, "a");
  assert.equal(pool.snapshot().reservations, 1, "no double-count while waiting out cooldown");
});

// ─── Rolling TPM accounting ─────────────────────────────────────────────────

test("recordSpend feeds the rolling TPM window; a capped provider is skipped until tokens roll out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { pool } = makePool(
    "m",
    [
      { provider: "a", modelId: "a", concurrency: 5, weight: 1, tpm: 100 },
      { provider: "b", modelId: "b", concurrency: 5, weight: 1 },
    ],
    { defaultTpmWindowMs: 1_000 },
  );

  const first = await pool.acquire("m");
  assert.equal(first?.provider, "a");

  pool.recordSpend("a", 60);
  assert.equal(pool.snapshot().entries[0]?.measuredTpm, 60);
  assert.equal(pool.snapshot().entries[0]?.blocked, false, "60 < cap 100: TPM gate not tripped yet");

  // Busy b too, so the next routing decision is driven purely by the TPM gate.
  const second = await pool.acquire("m");
  assert.equal(second?.provider, "b");

  pool.recordSpend("a", 50); // window sum now 110 ≥ cap 100
  assert.equal(pool.snapshot().entries[0]?.blocked, true, "TPM cap marks the endpoint blocked");

  const capped = await pool.acquire("m");
  assert.equal(capped?.provider, "b", "TPM-capped provider is skipped");

  t.mock.timers.tick(1_001);
  assert.equal(pool.snapshot().entries[0]?.measuredTpm, 0, "tokens rolled out of the window");
  const afterRollout = await pool.acquire("m");
  assert.equal(afterRollout?.provider, "a");
});

// ─── FIFO wait fairness + abort + timeout ───────────────────────────────────

test("wait-mode acquires resolve strictly in FIFO order as slots free up", async () => {
  const { pool } = makePool("m", [{ provider: "a", modelId: "a", concurrency: 1, weight: 1 }]);

  const first = await pool.acquire("m");
  const order: string[] = [];
  const w2 = pool.acquire("m").then((c) => order.push(`w2:${c?.provider}`));
  const w3 = pool.acquire("m").then((c) => order.push(`w3:${c?.provider}`));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, [], "both later acquires are queued");

  pool.release(first as NonNullable<typeof first>);
  await w2;
  assert.deepEqual(order, ["w2:a"], "head of FIFO resolves first");
  assert.equal(pool.snapshot().waiting, 1);

  pool.release({ provider: "a", modelId: "a", sticky: true });
  await w3;
  assert.deepEqual(order, ["w2:a", "w3:a"]);
  assert.equal(pool.snapshot().waiting, 0);
});

test("a queued acquire aborts via its own signal and rejects with an AbortError", async () => {
  const { pool } = makePool("m", [{ provider: "a", modelId: "a", concurrency: 1, weight: 1 }]);

  const first = await pool.acquire("m");
  const controller = new AbortController();
  const pending = pool.acquire("m", { signal: controller.signal });

  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
  assert.equal(pool.snapshot().waiting, 0, "aborted waiter leaves the FIFO queue");

  pool.release(first as NonNullable<typeof first>);
  assert.equal(pool.snapshot().reservations, 0);
});

test("saturationWaitTimeoutMs expires a waiting acquire with a non-recoverable PROVIDER_SATURATED error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { pool } = makePool("m", [{ provider: "a", modelId: "a", concurrency: 1, weight: 1 }], {
    whenSaturated: "wait",
    saturationWaitTimeoutMs: 50,
  });

  const first = await pool.acquire("m");
  const pending = pool.acquire("m");

  t.mock.timers.tick(51);
  await assert.rejects(pending, (error: unknown) => {
    assert.equal((error as { code: string }).code, WorkflowErrorCode.PROVIDER_SATURATED);
    assert.equal((error as { recoverable: boolean }).recoverable, false, "whole pool saturated → non-recoverable");
    return true;
  });
  assert.equal(pool.snapshot().waiting, 0, "timed-out waiter is removed from the queue");

  pool.release(first as NonNullable<typeof first>);
});

// ─── Sticky re-acquire ──────────────────────────────────────────────────────

test("sticky re-acquire returns the same choice without double-counting the reservation", async () => {
  const { pool } = makePool("m", [
    { provider: "a", modelId: "a", concurrency: 5, weight: 1 },
    { provider: "b", modelId: "b", concurrency: 5, weight: 1 },
  ]);

  const first = await pool.acquire("m", { stickyKey: "run-1" });
  assert.equal(first?.provider, "a");
  assert.equal(first?.sticky, true);
  assert.equal(pool.snapshot().entries[0]?.active, 1);
  assert.equal(pool.snapshot().reservations, 1);

  const retry = await pool.acquire("m", { stickyKey: "run-1" });
  assert.deepEqual(retry, first, "retry re-acquires the exact same pinned choice");
  assert.equal(pool.snapshot().entries[0]?.active, 1, "no double-count on re-acquire");
  assert.equal(pool.snapshot().reservations, 1);

  pool.release("run-1");
  assert.equal(pool.snapshot().entries[0]?.active, 0);
  assert.equal(pool.snapshot().reservations, 0);
});

test("sticky re-acquire still returns the same choice while the provider is concurrency-capped", async () => {
  const { pool } = makePool("m", [{ provider: "a", modelId: "a", concurrency: 1, weight: 1 }]);

  const pinned = await pool.acquire("m", { stickyKey: "run-1" });
  assert.equal(pinned?.provider, "a");

  // Slot is held by the run itself — the sticky reservation does not re-count.
  const retry = await pool.acquire("m", { stickyKey: "run-1" });
  assert.equal(retry?.provider, "a");
  assert.equal(pool.snapshot().entries[0]?.active, 1);
});

// ─── Release semantics ──────────────────────────────────────────────────────

test("release decrements the provider's active count exactly once and is idempotent", async () => {
  const { pool } = makePool("m", [
    { provider: "a", modelId: "a", concurrency: 2, weight: 1 },
    { provider: "b", modelId: "b", concurrency: 2, weight: 1 },
  ]);

  const a = await pool.acquire("m");
  const b = await pool.acquire("m");
  assert.equal(pool.snapshot().entries[0]?.active, 1);
  assert.equal(pool.snapshot().entries[1]?.active, 1);

  pool.release(a as NonNullable<typeof a>);
  pool.release(a as NonNullable<typeof a>); // double release → no-op
  pool.release({ provider: "nope", modelId: "nope", sticky: true }); // unknown choice → no-op
  assert.equal(pool.snapshot().entries[0]?.active, 0, "active decremented exactly once");
  assert.equal(pool.snapshot().reservations, 1);

  pool.release(b as NonNullable<typeof b>);
  assert.equal(pool.snapshot().reservations, 0);
});

test("release by stickyKey and by choice both settle a reservation", async () => {
  const { pool } = makePool("m", [{ provider: "a", modelId: "a", concurrency: 1, weight: 1 }]);

  const choice = await pool.acquire("m", { stickyKey: "run-1" });
  pool.release(choice as NonNullable<typeof choice>);
  assert.equal(pool.snapshot().entries[0]?.active, 0);
  assert.equal(pool.snapshot().reservations, 0);

  await pool.acquire("m", { stickyKey: "run-2" });
  pool.release("run-2");
  assert.equal(pool.snapshot().entries[0]?.active, 0);
  assert.equal(pool.snapshot().reservations, 0);
});

// ─── Fail-mode classification ───────────────────────────────────────────────

test("fail mode: whole-pool saturation is non-recoverable (TPM-capped single provider)", async () => {
  const { pool } = makePool("m", [{ provider: "a", modelId: "a", concurrency: 5, weight: 1, tpm: 100 }], {
    whenSaturated: "fail",
  });

  await pool.acquire("m");
  pool.recordSpend("a", 100);

  await assert.rejects(pool.acquire("m"), (error: unknown) => {
    assert.equal((error as { code: string }).code, WorkflowErrorCode.PROVIDER_SATURATED);
    assert.equal((error as { recoverable: boolean }).recoverable, false);
    return true;
  });
});

test("fail mode: whole-pool saturation is non-recoverable (concurrency-capped single provider)", async () => {
  const { pool } = makePool("m", [{ provider: "a", modelId: "a", concurrency: 1, weight: 1 }], {
    whenSaturated: "fail",
  });

  await pool.acquire("m");
  await assert.rejects(pool.acquire("m"), (error: unknown) => {
    assert.equal((error as { code: string }).code, WorkflowErrorCode.PROVIDER_SATURATED);
    assert.equal((error as { recoverable: boolean }).recoverable, false);
    return true;
  });
});

test("fail mode: sticky provider capped while another is free is recoverable", async () => {
  const { pool } = makePool(
    "m",
    [
      { provider: "a", modelId: "a", concurrency: 5, weight: 1, tpm: 100 },
      { provider: "b", modelId: "b", concurrency: 5, weight: 1 },
    ],
    { whenSaturated: "fail" },
  );

  const pinned = await pool.acquire("m", { stickyKey: "run-1" });
  assert.equal(pinned?.provider, "a");
  pool.recordSpend("a", 100); // only the pinned provider is now capped

  await assert.rejects(pool.acquire("m", { stickyKey: "run-1" }), (error: unknown) => {
    assert.equal((error as { code: string }).code, WorkflowErrorCode.PROVIDER_SATURATED);
    assert.equal(
      (error as { recoverable: boolean }).recoverable,
      true,
      "pinned provider blocked while others are free → recoverable retry",
    );
    return true;
  });
});

// ─── Fallback & no-auth ─────────────────────────────────────────────────────

test("acquire returns undefined for a logical model with no pool entries (legacy fallback)", async () => {
  const { pool } = makePool("m", [{ provider: "a", modelId: "a", concurrency: 5, weight: 1 }]);
  assert.equal(await pool.acquire("unmapped-model"), undefined);
});

test("providers without configured auth are skipped by routing (with a one-time warning)", async (t) => {
  const warnMock = t.mock.method(console, "warn", () => {});
  const { pool } = makePool(
    "m",
    [
      { provider: "noauth", modelId: "n", concurrency: 5, weight: 1, auth: false },
      { provider: "authed", modelId: "a", concurrency: 5, weight: 1 },
    ],
    {},
  );

  const choice = await pool.acquire("m");
  assert.equal(choice?.provider, "authed", "no-auth provider must never be chosen");
  assert.equal(warnMock.mock.callCount(), 1);
});

test("registry lookup is case-sensitive: a mixed-case provider key must match exactly (picker seeds verbatim)", async () => {
  // The UI picker seeds the pool key verbatim from the canonical spec (the
  // registry's provider map is keyed case-sensitively). A lowercased key must
  // NOT resolve — isAuthConfigured fails and routing skips the entry, so the
  // whole pool saturates (non-recoverable) instead of a case-blind match.
  const reg = makeRegistry([{ provider: "MyOllama", modelId: "llama-3.3", concurrency: 5, weight: 1 }]);
  const { pool: verbatimPool } = makePool(
    "llama-3.3",
    [{ provider: "MyOllama", modelId: "llama-3.3", concurrency: 5, weight: 1 }],
    {},
    reg,
  );
  const choice = await verbatimPool.acquire("llama-3.3");
  assert.equal(choice?.provider, "MyOllama", "verbatim mixed-case key routes");

  const { pool: loweredPool } = makePool(
    "llama-3.3",
    [{ provider: "myollama", modelId: "llama-3.3", concurrency: 5, weight: 1 }],
    { whenSaturated: "fail" },
    reg,
  );
  await assert.rejects(
    loweredPool.acquire("llama-3.3"),
    (err: Error & { code?: string }) => err.code === "PROVIDER_SATURATED",
    "lowercased key never becomes placeable → whole-pool saturation (non-recoverable)",
  );
});
