/**
 * Slice W — model pattern resolution hardening (M10, L5).
 *
 * Covers: empty/whitespace-only patterns rejected (no arbitrary-model
 * resolution, no empty-id fabrication), exact-id-first + version-aware fuzzy
 * ordering, and substring-only warnings.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveModelSpecWithThinking } from "../../../src/model-spec.js";

function model(provider: string, id: string, name = id): Model<Api> {
  return { provider, id, name } as Model<Api>;
}

function registry(models: Model<Api>[]): Pick<ModelRegistry, "getAll"> {
  return { getAll: () => models } as Pick<ModelRegistry, "getAll">;
}

describe("empty model pattern rejection (M10)", () => {
  it("rejects a provider-prefixed empty pattern instead of matching everything", () => {
    const gpt = model("openai", "gpt-5.4");
    // "openai/" infers the provider and leaves an EMPTY pattern; the old code
    // ran String.includes("") which matched every model (audit: "openai/" →
    // "openai/z-model").
    const resolved = resolveModelSpecWithThinking("openai/", registry([gpt]));
    assert.equal(resolved.model, undefined, "no arbitrary model may be resolved");
    assert.match(resolved.error ?? "", /not found/);
  });

  it("rejects a whitespace-only pattern", () => {
    const gpt = model("openai", "gpt-5.4");
    const resolved = resolveModelSpecWithThinking("openai/   ", registry([gpt]));
    assert.equal(resolved.model, undefined);
    assert.match(resolved.error ?? "", /not found/);
  });

  it("rejects a thinking-suffix-only pattern (':high') instead of resolving an arbitrary model", () => {
    const gpt = model("openai", "gpt-5.4");
    const resolved = resolveModelSpecWithThinking(":high", registry([gpt]));
    assert.equal(resolved.model, undefined, '":high" must not resolve to an arbitrary model');
    assert.match(resolved.error ?? "", /not found/);
  });

  it("rejects a bare empty string as no spec", () => {
    const gpt = model("openai", "gpt-5.4");
    const resolved = resolveModelSpecWithThinking("   ", registry([gpt]));
    assert.match(resolved.error ?? "", /No model spec/);
  });
});

describe("version-aware fuzzy ordering (L5)", () => {
  it("prefers the exact base id over a lexicographically-later variant (gpt-4o, not gpt-4o-mini)", () => {
    const gpt4o = model("openai", "gpt-4o");
    const gpt4oMini = model("openai", "gpt-4o-mini");
    // A second provider with the same id makes the exact match ambiguous, which
    // forces the fuzzy path — where the old lexicographic sort picked the mini.
    const gpt4oAzure = model("azure-openai-responses", "gpt-4o");
    const resolved = resolveModelSpecWithThinking("gpt-4o", registry([gpt4oMini, gpt4o, gpt4oAzure]));
    assert.equal(resolved.model?.id, "gpt-4o", "an exact-id match must beat a suffixed variant");
  });

  it("ranks prefix matches ahead of substring-only matches", () => {
    const gpt4o = model("openai", "gpt-4o");
    const midWord = model("openai", "x-gpt-4");
    const resolved = resolveModelSpecWithThinking("gpt-4", registry([midWord, gpt4o]));
    assert.equal(resolved.model?.id, "gpt-4o");
  });

  it("prefers the shortest base id over longer suffixed variants within a prefix band", () => {
    const gpt4o = model("openai", "gpt-4o");
    const gpt4Turbo = model("openai", "gpt-4-turbo");
    const resolved = resolveModelSpecWithThinking("gpt-4", registry([gpt4Turbo, gpt4o]));
    assert.equal(resolved.model?.id, "gpt-4o");
  });

  it("picks the newest dated snapshot among dated versions", () => {
    const older = model("openai", "gpt-4o-20240513");
    const newer = model("openai", "gpt-4o-20240806");
    const resolved = resolveModelSpecWithThinking("gpt-4o-", registry([older, newer]));
    assert.equal(resolved.model?.id, "gpt-4o-20240806");
  });

  it("warns when the pattern only matched as a substring", () => {
    const midWord = model("openai", "x-gpt-4");
    const resolved = resolveModelSpecWithThinking("gpt-4", registry([midWord]));
    assert.equal(resolved.model?.id, "x-gpt-4");
    assert.match(resolved.warning ?? "", /substring match/);
  });

  it("does not warn on exact or prefix matches (including with a thinking suffix)", () => {
    const gpt56 = model("openai-codex", "gpt-5.6-sol");
    const exact = resolveModelSpecWithThinking("openai-codex/gpt-5.6-sol:max", registry([gpt56]));
    assert.equal(exact.warning, undefined, "an exact id with a thinking suffix is not a substring match");
    const prefix = resolveModelSpecWithThinking("gpt-5.6", registry([model("openai-codex", "gpt-5.6-sol")]));
    assert.equal(prefix.warning, undefined, "a prefix match is not a substring match");
  });
});
