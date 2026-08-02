/**
 * Slice W — tier ranking projection (L10).
 *
 * Covers: lower-median projection (a neutral unknown-cost model never projects
 * to the top half of the price range) and the priced-model-wins-ties guard.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rankByCapability } from "../../../src/model-tier-config.js";

describe("rankByCapability projection (L10)", () => {
  it("projects a neutral unknown-cost model onto the LOWER median, never above a paid flagship", () => {
    // known costs [1, 50]: the OLD upper-median (index 1) projected "self/hosted"
    // to 50, tying the paid flagship — with registry order able to rank the
    // free model FIRST. The lower median (index 0) keeps it at the bottom.
    const ranked = rankByCapability([
      { spec: "self/hosted" }, // no cost, neutral hint
      { spec: "v/cheap", costOutput: 1 },
      { spec: "v/flagship", costOutput: 50 },
    ]).map((m) => m.spec);
    assert.deepEqual(ranked, ["v/cheap", "self/hosted", "v/flagship"]);
  });

  it("lets a real priced model win a cost tie against a projected model", () => {
    // median of [1, 5, 9] is 5: "self/hosted" (neutral hint) projects onto 5 and
    // ties the REAL "v/paid-mid" at 5. The real price must win the tie even when
    // the projected model was registered first.
    const ranked = rankByCapability([
      { spec: "self/hosted" }, // projected → median 5, unpriced
      { spec: "v/paid-mid", costOutput: 5 },
      { spec: "v/cheap", costOutput: 1 },
      { spec: "v/flagship", costOutput: 9 },
    ]).map((m) => m.spec);
    assert.deepEqual(ranked, ["v/cheap", "v/paid-mid", "self/hosted", "v/flagship"]);
  });

  it("keeps hint semantics: a small-hint unknown-cost model still outranks a neutral priced model at the same cost", () => {
    // The hint tie-break comes first: a model NAMED small is genuinely small,
    // so it stays below the neutral priced model. (Regression guard: the
    // priced-wins tie-break must not reorder hint-ranked entries.)
    const ranked = rankByCapability([
      { spec: "self/mini-local" }, // small hint, unpriced → projects to min 2
      { spec: "v/a", costOutput: 2 },
      { spec: "v/b", costOutput: 5 },
    ]).map((m) => m.spec);
    assert.deepEqual(ranked, ["self/mini-local", "v/a", "v/b"]);
  });
});
