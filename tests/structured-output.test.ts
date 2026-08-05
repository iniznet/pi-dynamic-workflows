import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createStructuredOutputTool } from "../src/structured-output.js";

test("createStructuredOutputTool creates a tool with the given name", () => {
  const capture = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: Type.Object({ result: Type.String() }),
    capture,
    name: "my_output",
  });
  assert.equal(tool.name, "my_output");
});

test("createStructuredOutputTool defaults name to structured_output", () => {
  const capture = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: Type.Object({ result: Type.String() }),
    capture,
  });
  assert.equal(tool.name, "structured_output");
});

test("renderCall and renderResult actually render the tool call and result", () => {
  const capture = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: Type.Object({ ok: Type.Boolean() }),
    capture,
  });
  assert.ok(tool.renderCall, "renderCall must be defined");
  assert.ok(tool.renderResult, "renderResult must be defined");

  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
  const call = tool.renderCall({ ok: true }, theme, {} as never);
  const result = tool.renderResult(
    { content: [{ type: "text", text: "Structured output received." }], details: { ok: true }, terminate: true },
    { isPartial: false, expanded: false },
    theme,
    {} as never,
  );

  assert.ok(call instanceof Text, "renderCall returns a TUI Text component");
  assert.ok(result instanceof Text, "renderResult returns a TUI Text component");
  assert.match(call.render(80).join(""), /structured_output/, "renderCall shows the tool name");
  assert.match(result.render(80).join(""), /\{"ok":true\}/, "renderResult shows the captured payload");

  const partial = tool.renderResult(
    { content: [{ type: "text", text: "Structured output received." }], details: { ok: true }, terminate: true },
    { isPartial: true, expanded: false },
    theme,
    {} as never,
  );
  assert.ok(partial instanceof Text);
});

test("createStructuredOutputTool execute captures value and marks called", async () => {
  const capture = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: Type.Object({ ok: Type.Boolean() }),
    capture,
  });
  const result = await tool.execute("call-1", { ok: true }, undefined, undefined, undefined as never);
  assert.equal(capture.called, true);
  assert.deepEqual(capture.value, { ok: true });
  assert.ok(result.terminate, "should terminate the agent");
  assert.equal((result.content[0] as { type: "text"; text: string }).text, "Structured output received.");
});

test("createStructuredOutputTool captures complex nested objects", async () => {
  const capture = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: Type.Object({
      items: Type.Array(Type.Object({ id: Type.Number(), name: Type.String() })),
      total: Type.Number(),
    }),
    capture,
  });
  const data = {
    items: [
      { id: 1, name: "foo" },
      { id: 2, name: "bar" },
    ],
    total: 2,
  };
  await tool.execute("call-2", data, undefined, undefined, undefined as never);
  assert.equal(capture.called, true);
  assert.deepEqual(capture.value, data);
});

test("createStructuredOutputTool returns details with captured params", async () => {
  const capture = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: Type.Object({ x: Type.Number() }),
    capture,
  });
  const result = await tool.execute("call-3", { x: 42 }, undefined, undefined, undefined as never);
  assert.deepEqual(result.details, { x: 42 });
});

test("createStructuredOutputTool has promptSnippet and promptGuidelines", () => {
  const capture = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: Type.Object({ result: Type.String() }),
    capture,
  });
  assert.ok(tool.promptSnippet, "promptSnippet should be truthy");
  assert.ok(Array.isArray(tool.promptGuidelines), "tool.promptGuidelines should be an array");
  assert.ok(tool.promptGuidelines.length > 0, "tool.promptGuidelines should not be empty");
  // Should mention the tool name in guidelines
  assert.ok(
    tool.promptGuidelines.some((g: string) => g.includes("structured_output")),
    "should contain structured_output",
  );
});

test("createStructuredOutputTool uses parameters from schema", () => {
  const capture = { called: false, value: undefined };
  const schema = Type.Object({
    verdict: Type.String(),
    score: Type.Number(),
  });
  const tool = createStructuredOutputTool({ schema, capture });
  // TypeBox-defined parameters are available
  assert.ok(tool.parameters, "parameters should be truthy");
});
