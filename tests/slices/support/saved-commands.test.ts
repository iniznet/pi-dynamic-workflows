/**
 * Slice W — positional argument binding (M11).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommandArgs } from "../../../src/saved-commands.js";

describe("parseCommandArgs positional binding (M11)", () => {
  it("binds positionals to declared params in declaration order before defaults apply", () => {
    // Audit repro: alpha was silently replaced by its default and the user
    // value dumped into `_`.
    const result = parseCommandArgs("alpha beta", { alpha: { default: "ADEF" }, beta: {} });
    assert.equal(result.alpha, "alpha", "first positional binds to the first declared param");
    assert.equal(result.beta, "beta", "second positional binds to the second declared param");
    assert.equal(result._, "", "bound positionals are not dumped into _");
  });

  it("skips params already satisfied by key=value tokens when binding positionals", () => {
    const result = parseCommandArgs("alpha=given beta", { alpha: {}, beta: {} });
    assert.equal(result.alpha, "given");
    assert.equal(result.beta, "beta");
    assert.equal(result._, "");
  });

  it("defaults still fill declared params not satisfied by positionals", () => {
    const result = parseCommandArgs("alpha", { alpha: {}, gamma: { default: "G" } });
    assert.equal(result.alpha, "alpha");
    assert.equal(result.gamma, "G");
  });

  it("coerces positionally-bound values to their declared types", () => {
    const result = parseCommandArgs("5 true", { count: { type: "integer" }, verbose: { type: "boolean" } });
    assert.equal(result.count, 5);
    assert.equal(result.verbose, true);
  });

  it("leaves extra positionals in _", () => {
    const result = parseCommandArgs("a b c", { alpha: {} });
    assert.equal(result.alpha, "a");
    assert.equal(result._, "b c");
  });

  it("keeps _raw intact and still throws on missing required params", () => {
    const result = parseCommandArgs("a=1", { alpha: { default: "ADEF" } });
    assert.equal(result._raw, "a=1");
    assert.throws(() => parseCommandArgs("a=1", { required: { required: true } }), /Missing required argument/);
  });
});
