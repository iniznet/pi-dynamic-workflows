/**
 * ProviderPool settings parsing + env override (design: tasks/provider-load-balance/
 * design.md "Config surface").
 *
 * The `providerPool` settings key is a nested object inside the workflows
 * settings (settings.json "workflows" section), overridable in headless/CI via
 * the `PI_WORKFLOW_PROVIDER_POOL` env var as a full-JSON override — the same
 * env-overrides-file merge the `applyEnvSettingsOverride` layer performs for
 * scalar keys (src/config.ts).
 *
 * Parsing follows the file's settings convention exactly: the outer settings
 * schema accepts any object for this key (SETTINGS_SCHEMA `["object"]`,
 * workflow-settings.ts) and THIS module is the lenient value-level normalizer —
 * unknown keys, wrong-typed values, and invalid entries are dropped on
 * violation, never thrown (the same drop-on-violation leniency as
 * `normalizeSettings`). A config that normalizes to nothing is simply "no
 * pool": `createProviderPoolFromConfig` returns undefined and the extension
 * keeps the legacy single-resolution behavior.
 *
 * Internal module: imported by src/gateway/provider-pool.ts (runtime values)
 * and by the settings/env wiring layer. Re-exported from src/index.ts.
 */

import type { ProviderPoolConfig, ProviderPoolEntry } from "./provider-pool.js";

/** Env var carrying the full JSON providerPool override (headless/CI). */
export const PROVIDER_POOL_ENV_VAR = "PI_WORKFLOW_PROVIDER_POOL";

/** Saturation default: FIFO-queue saturated acquires (run-abort is the only exit at 0). */
export const DEFAULT_WHEN_SATURATED = "wait";

/** Default wait budget for a saturated acquire (0 = wait forever). */
export const DEFAULT_SATURATION_WAIT_TIMEOUT_MS = 300_000;

/** Default rolling window for measured output-TPM and the TPM cap gate. */
export const DEFAULT_TPM_WINDOW_MS = 60_000;

/** Default cooldown a provider enters after a recorded 429/limit event. */
export const DEFAULT_COOLDOWN_MS = 60_000;

/** Raw per-provider entry as written in settings.json / the env JSON override. */
export interface ProviderPoolEntryInput {
  /**
   * Registry model id this provider serves for the logical model. Defaults to
   * the logical model id (the common same-id case); must be set when the
   * provider's alias differs (e.g. `"deepseek/deepseek-v4-flash"` on
   * OpenRouter).
   */
  modelId?: string;
  /** Max concurrent agents on this provider endpoint (default 1). */
  concurrency?: number;
  /**
   * Proportional routing weight among non-capped providers (default 1): the
   * pool picks `min(active / weight)`, so a 3×-weighted provider takes ~3×
   * the load without being hammered first.
   */
  weight?: number;
  /** Manual output-TPM cap over `defaultTpmWindowMs` (primary TPM gate). */
  tpm?: number;
  /** Cooldown after a recorded 429/limit event, ms (default 60s). */
  cooldownMs?: number;
}

/** Raw provider map for one logical model id (key = provider id). */
export interface ProviderPoolModelInput {
  [provider: string]: ProviderPoolEntryInput | undefined;
}

/**
 * Raw `providerPool` settings object as written in settings.json or the env
 * JSON override. Not yet validated/normalized — feed through
 * {@link normalizeProviderPoolConfig} (or `createProviderPoolFromConfig`,
 * which normalizes) before use.
 */
export interface ProviderPoolSettingsInput {
  /** Pool on/off. Off → legacy single-resolution behavior. */
  enabled?: boolean;
  /** Saturation behavior: "wait" (FIFO, abort-aware) | "fail" (error). */
  whenSaturated?: "wait" | "fail";
  /** Wait budget for a saturated acquire in ms; 0 = wait forever. */
  saturationWaitTimeoutMs?: number;
  /** Rolling window (ms) for measured output-TPM and the TPM cap gate. */
  defaultTpmWindowMs?: number;
  /** Logical model id → provider map → per-provider entry. */
  models?: Record<string, ProviderPoolModelInput | undefined>;
}

/**
 * Normalize an arbitrary `providerPool` settings value into a fully-shaped
 * {@link ProviderPoolConfig}. Lenient drop-on-violation (see module doc):
 * non-object input, unknown/wrong-typed keys, and invalid entries are dropped
 * to their defaults; the result is always a well-formed config (possibly with
 * an empty `models` map, which means "no pool" to the factory).
 */
export function normalizeProviderPoolConfig(input: unknown): ProviderPoolConfig {
  const config: ProviderPoolConfig = {
    enabled: true,
    whenSaturated: DEFAULT_WHEN_SATURATED,
    saturationWaitTimeoutMs: DEFAULT_SATURATION_WAIT_TIMEOUT_MS,
    defaultTpmWindowMs: DEFAULT_TPM_WINDOW_MS,
    models: {},
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) return config;
  const raw = input as Record<string, unknown>;
  if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
  if (raw.whenSaturated === "wait" || raw.whenSaturated === "fail") config.whenSaturated = raw.whenSaturated;
  const saturationWaitTimeoutMs = normalizeInteger(raw.saturationWaitTimeoutMs, 0, Number.MAX_SAFE_INTEGER);
  if (saturationWaitTimeoutMs !== undefined) config.saturationWaitTimeoutMs = saturationWaitTimeoutMs;
  const defaultTpmWindowMs = normalizeInteger(raw.defaultTpmWindowMs, 1_000, Number.MAX_SAFE_INTEGER);
  if (defaultTpmWindowMs !== undefined) config.defaultTpmWindowMs = defaultTpmWindowMs;
  if (raw.models && typeof raw.models === "object" && !Array.isArray(raw.models)) {
    config.models = normalizeModels(raw.models as Record<string, unknown>);
  }
  return config;
}

/**
 * Read the `PI_WORKFLOW_PROVIDER_POOL` env override. Returns undefined when
 * the var is absent/empty or holds invalid JSON, so a misconfigured CI env
 * silently falls back to the file value (drop-on-violation, matching
 * `workflowSettingsFromEnv`).
 */
export function providerPoolFromEnv(
  env: Record<string, string | undefined> = process.env,
): ProviderPoolSettingsInput | undefined {
  const value = env[PROVIDER_POOL_ENV_VAR];
  if (value === undefined || value.trim() === "") return undefined;
  return parseProviderPoolEnvJson(value);
}

/**
 * Parse the providerPool env JSON. Shallow key-filtering only (same leniency
 * as the file path): unknown keys and wrong-typed scalars are dropped; the
 * `models` map is passed through raw and deeply normalized later by
 * {@link normalizeProviderPoolConfig}.
 */
export function parseProviderPoolEnvJson(raw: string): ProviderPoolSettingsInput | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const input: ProviderPoolSettingsInput = {};
  if (typeof record.enabled === "boolean") input.enabled = record.enabled;
  if (record.whenSaturated === "wait" || record.whenSaturated === "fail") input.whenSaturated = record.whenSaturated;
  const saturationWaitTimeoutMs = normalizeInteger(record.saturationWaitTimeoutMs, 0, Number.MAX_SAFE_INTEGER);
  if (saturationWaitTimeoutMs !== undefined) input.saturationWaitTimeoutMs = saturationWaitTimeoutMs;
  const defaultTpmWindowMs = normalizeInteger(record.defaultTpmWindowMs, 1_000, Number.MAX_SAFE_INTEGER);
  if (defaultTpmWindowMs !== undefined) input.defaultTpmWindowMs = defaultTpmWindowMs;
  if (record.models && typeof record.models === "object" && !Array.isArray(record.models)) {
    // Deep shape is re-walked leniently by normalizeProviderPoolConfig, so the
    // cast is advisory only — garbage nested values are dropped there.
    input.models = record.models as ProviderPoolSettingsInput["models"];
  }
  return input;
}

function normalizeModels(raw: Record<string, unknown>): ProviderPoolConfig["models"] {
  const models: ProviderPoolConfig["models"] = {};
  for (const [logicalModel, providers] of Object.entries(raw)) {
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) continue;
    const entries: Record<string, ProviderPoolEntry> = {};
    for (const [provider, value] of Object.entries(providers as Record<string, unknown>)) {
      const entry = normalizeEntry(provider, logicalModel, value);
      if (entry) entries[provider] = entry;
    }
    if (Object.keys(entries).length > 0) models[logicalModel] = entries;
  }
  return models;
}

function normalizeEntry(provider: string, logicalModel: string, value: unknown): ProviderPoolEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const modelId = typeof raw.modelId === "string" && raw.modelId.trim().length > 0 ? raw.modelId.trim() : logicalModel;
  const concurrency = normalizeInteger(raw.concurrency, 1, Number.MAX_SAFE_INTEGER) ?? 1;
  const weight = normalizeInteger(raw.weight, 1, Number.MAX_SAFE_INTEGER) ?? 1;
  const tpm = normalizeInteger(raw.tpm, 1, Number.MAX_SAFE_INTEGER);
  const cooldownMs = normalizeInteger(raw.cooldownMs, 1, Number.MAX_SAFE_INTEGER);
  const entry: ProviderPoolEntry = { provider, modelId, concurrency, weight };
  if (tpm !== undefined) entry.tpm = tpm;
  if (cooldownMs !== undefined) entry.cooldownMs = cooldownMs;
  return entry;
}

function normalizeInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) return undefined;
  return Math.min(max, Math.floor(value));
}
