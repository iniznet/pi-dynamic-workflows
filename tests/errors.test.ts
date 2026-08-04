import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyContextOverflow,
  classifyProviderLimit,
  isProviderUsageLimit,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "../src/errors.js";

describe("classifyProviderLimit", () => {
  it("matches the documented provider usage/quota/rate-limit wordings", () => {
    const cases = [
      "You have hit your ChatGPT usage limit (plus plan).",
      "Codex usage limit reached (plus plan). Resets in ~3h. Current premium: 5h 100%, weekly 42%.",
      "insufficient_quota",
      "You exceeded your current quota, please check your plan and billing details.",
      "Error 429: too many requests",
      "rate limit exceeded",
      "GoUsageLimitError",
    ];
    for (const text of cases) {
      assert.equal(classifyProviderLimit(text).matched, true, `should match: ${text}`);
    }
  });

  it("does NOT match benign text or unrelated errors", () => {
    for (const text of [
      "file not found",
      "TypeError: x is not a function",
      "agent exploded",
      "overloaded_error",
      undefined,
    ]) {
      assert.equal(classifyProviderLimit(text).matched, false, `should not match: ${text}`);
    }
  });

  it("extracts the verbatim reset hint when present, undefined otherwise", () => {
    assert.equal(classifyProviderLimit("Codex usage limit reached. Resets in ~3h.").resetHint, "Resets in ~3h");
    assert.equal(
      classifyProviderLimit("usage limit reached, resets at 2026-06-20T06:00:00Z.").resetHint,
      "resets at 2026-06-20T06:00:00Z",
    );
    assert.equal(classifyProviderLimit("insufficient_quota").resetHint, undefined);
  });
});

describe("wrapError provider-limit classification", () => {
  it("classifies a thrown usage-limit Error as non-recoverable PROVIDER_USAGE_LIMIT (defense for a throwing SDK)", () => {
    const e = wrapError(new Error("Codex usage limit reached (plus plan). Resets in ~3h."), { agentLabel: "a" });
    assert.equal(e.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
    assert.equal(e.recoverable, false);
    assert.equal(e.resetHint, "Resets in ~3h");
    assert.equal(e.agentLabel, "a");
  });

  it("keeps transient overloaded/5xx errors as recoverable AGENT_EXECUTION_ERROR (not a quota pause)", () => {
    const e = wrapError(new Error("overloaded_error: server is busy"));
    assert.equal(e.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(e.recoverable, true);
  });

  it("passes an existing WorkflowError through unchanged", () => {
    const orig = new WorkflowError("nope", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
    assert.equal(wrapError(orig), orig);
  });
});

describe("wrapError abort/timeout classification", () => {
  it("classifies abort-like errors as WORKFLOW_ABORTED (recoverable, no agent label)", () => {
    const e = wrapError(new Error("The operation was aborted."));
    assert.equal(e.code, WorkflowErrorCode.WORKFLOW_ABORTED);
    assert.equal(e.recoverable, true);
    assert.match(e.message, /aborted/i);
    assert.equal(e.agentLabel, undefined);
  });

  it("classifies timeout errors as AGENT_TIMEOUT and passes the agent label through", () => {
    const e = wrapError(new Error("request timed out after 30s"), { agentLabel: "research-agent" });
    assert.equal(e.code, WorkflowErrorCode.AGENT_TIMEOUT);
    assert.equal(e.recoverable, true);
    assert.equal(e.agentLabel, "research-agent");
    assert.match(e.message, /timed out/i);
  });

  it("classifies a timeout by error name as well (TimeoutError)", () => {
    const err = new Error("socket closed");
    err.name = "TimeoutError";
    const e = wrapError(err);
    assert.equal(e.code, WorkflowErrorCode.AGENT_TIMEOUT);
  });

  it("does not classify non-Error abort-ish values as aborts", () => {
    const e = wrapError({ message: "aborted" });
    assert.equal(e.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
  });
});

describe("isProviderUsageLimit", () => {
  it("is true only for a PROVIDER_USAGE_LIMIT WorkflowError", () => {
    assert.equal(
      isProviderUsageLimit(new WorkflowError("x", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false })),
      true,
    );
    assert.equal(isProviderUsageLimit(new WorkflowError("x", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE)), false);
    assert.equal(isProviderUsageLimit(new Error("usage limit")), false);
  });
});

describe("classifyContextOverflow", () => {
  it("matches the documented provider context-window overflow wordings", () => {
    const cases = [
      "prompt is too long: 213462 tokens > 200000 maximum", // Anthropic
      "request_too_large: your request exceeds the maximum allowed input size", // Anthropic 413
      "Input is too long for requested model", // Amazon Bedrock
      "Your input exceeds the context window of this model", // OpenAI
      "Requested token count exceeds the model's maximum context length of 131072 tokens", // LiteLLM
      "Maximum input token count exceeds the maximum allowed tokens", // Google Gemini
      "This model's maximum prompt length is 131072 but the request contains 537812 tokens", // xAI
      "Please reduce the length of the messages or number of messages", // Groq
      "This endpoint's maximum context length is 100000 tokens. However, you requested about 200000 tokens", // OpenRouter
      "Input (123456 tokens) is longer than the model's context length (131072 tokens)", // Together
      "The prompt exceeds the limit of 131072 tokens", // GitHub Copilot
      "exceeds the available context size", // llama.cpp
      "your prompt is greater than the context length", // LM Studio
      "context window exceeds limit", // MiniMax
      "exceeded model token limit", // Kimi
      "Prompt contains 200000 tokens. Too large for model with 131072 maximum context length", // Mistral
      "The prompt has 200000 tokens, but the configured context size is 131072 tokens", // DS4
      "prompt too long; exceeded context length", // Ollama
      "range of input length should be [1, 128000]", // DashScope
      "context_length_exceeded: the conversation is too long", // generic
    ];
    for (const text of cases) {
      assert.equal(classifyContextOverflow(text), true, `should match: ${text}`);
    }
  });

  it("does NOT match rate limits (NON_OVERFLOW exclusion) or benign text", () => {
    for (const text of [
      "ThrottlingException: Too many tokens, please wait before trying again.", // Bedrock rate limit
      "Service unavailable: too many requests",
      "rate limit reached, resets in 3h", // provider usage limit, not overflow
      "Error 429: too many requests",
      "file not found",
      "TypeError: x is not a function",
      "context length is a common topic in this essay", // benign mention
      undefined,
    ]) {
      assert.equal(classifyContextOverflow(text), false, `should not match: ${text}`);
    }
  });

  it("prefers overflow over a provider-limit when both could match", () => {
    // A context error that also mentions a limit must classify as overflow
    // (settles failed) — never as a pausable usage limit.
    assert.equal(classifyContextOverflow("context_length_exceeded: usage limit reached"), true);
  });
});

describe("wrapError context-overflow classification", () => {
  it("classifies a thrown overflow Error as non-recoverable CONTEXT_OVERFLOW (defense for a throwing SDK)", () => {
    const e = wrapError(new Error("prompt is too long: 213462 tokens > 200000 maximum"), { agentLabel: "a" });
    assert.equal(e.code, WorkflowErrorCode.CONTEXT_OVERFLOW);
    assert.equal(e.recoverable, false);
    assert.equal(e.agentLabel, "a");
  });

  it("still classifies a plain rate limit as PROVIDER_USAGE_LIMIT (not overflow)", () => {
    const e = wrapError(new Error("rate limit reached, resets in 3h"));
    assert.equal(e.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
    assert.equal(e.recoverable, false);
  });

  it("keeps benign text as a recoverable execution error", () => {
    const e = wrapError(new Error("the model's context length was mentioned in passing"));
    assert.equal(e.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(e.recoverable, true);
  });
});
