import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyProviderLimit,
  isAbortError,
  isTimeoutError,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "../../../src/errors.js";

describe("classifyProviderLimit (H2 — anchored limit semantics, no bare tokens)", () => {
  it("must NOT match bare quota/billing mentions or benign usage prose", () => {
    for (const text of [
      "quota usage at 40%",
      "billing is handled separately",
      "quota",
      "your quota is healthy",
      "check the billing settings",
      "file not found",
      "TypeError: x is not a function",
    ]) {
      assert.equal(classifyProviderLimit(text).matched, false, `should not match: ${text}`);
    }
  });

  it("must match genuine limit semantics", () => {
    for (const text of [
      "rate limit exceeded",
      "429 Too Many Requests",
      "quota exceeded",
      "You exceeded your current quota",
      "insufficient_quota",
      "usage limit reached",
      "Codex usage limit reached (plus plan). Resets in ~3h.",
      "too many requests",
      "out of budget",
      "GoUsageLimitError",
      "FreeUsageLimitError",
    ]) {
      assert.equal(classifyProviderLimit(text).matched, true, `should match: ${text}`);
    }
  });

  it("still extracts the verbatim reset hint", () => {
    assert.equal(classifyProviderLimit("usage limit reached. Resets in ~3h.").resetHint, "Resets in ~3h");
  });
});

describe("wrapError provider-limit gating (H2 — SDK/API-layer only)", () => {
  it("classifies a plain SDK-style Error whose message states a limit", () => {
    const e = wrapError(new Error("Codex usage limit reached (plus plan). Resets in ~3h."), { agentLabel: "a" });
    assert.equal(e.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
    assert.equal(e.recoverable, false);
    assert.equal(e.resetHint, "Resets in ~3h");
  });

  it("does NOT classify script-origin errors that merely mention quota/usage", () => {
    const e = wrapError(new TypeError("quota is not a function"));
    assert.equal(e.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(e.recoverable, true, "a script bug stays a recoverable execution error, not a quota pause");
  });
});

describe("isAbortError / isTimeoutError (L12 — name-first, anchored message)", () => {
  it("gates on error.name first", () => {
    const byName = new Error("socket closed");
    byName.name = "AbortError";
    assert.equal(isAbortError(byName), true);

    const timeoutByName = new Error("socket closed");
    timeoutByName.name = "TimeoutError";
    assert.equal(isTimeoutError(timeoutByName), true);
  });

  it("matches the real anchored messages", () => {
    assert.equal(isAbortError(new Error("The operation was aborted.")), true);
    assert.equal(isAbortError(new Error("Subagent was aborted")), true);
    assert.equal(isTimeoutError(new Error("request timed out after 30s")), true);
    assert.equal(isTimeoutError(new Error("Request timed out after 60000ms: tool")), true);
    assert.equal(isTimeoutError(new Error("Connect timed out after 5000ms: /path")), true);
  });

  it("does NOT substring-match quoted user text", () => {
    assert.equal(isAbortError(new Error('the task output says "aborted" but nothing was')), false);
    assert.equal(isTimeoutError(new Error("the reviewer mentioned a timeout in their notes")), false);
  });

  it("leaves non-Error values unclassified", () => {
    assert.equal(isAbortError({ message: "aborted" }), false);
    assert.equal(isTimeoutError({ message: "timeout" }), false);
  });

  it("a WorkflowError passes through wrapError unchanged", () => {
    const orig = new WorkflowError("nope", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
    assert.equal(wrapError(orig), orig);
  });
});
