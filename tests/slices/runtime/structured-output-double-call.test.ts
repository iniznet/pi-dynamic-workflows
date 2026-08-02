import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { createStructuredOutputTool } from "../../../src/structured-output.js";

test("L16: a second structured_output call is rejected without overwriting the captured result", async () => {
  const capture = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: Type.Object({ ok: Type.Boolean() }),
    capture,
  });

  const first = await tool.execute("call-1", { ok: true });
  assert.equal(first.terminate, true, "the FIRST call terminates the agent");
  assert.deepEqual(capture.value, { ok: true });

  const second = await tool.execute("call-2", { ok: false });
  assert.equal(second.terminate, undefined, "a duplicate call does NOT terminate");
  assert.match(second.content[0].text, /already called/i, "the rejection names the duplicate");
  assert.deepEqual(capture.value, { ok: true }, "the first call's capture stands — never silently overwritten");
  assert.equal(capture.called, true);
});
