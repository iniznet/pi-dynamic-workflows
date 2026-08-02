import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../../../src/errors.js";
import { runWorkflow } from "../../../src/workflow.js";

const okAgent = {
  async run() {
    return "ok";
  },
};

test("M2: a plain script bug inside a parallel() thunk rethrows (never a silent null)", async () => {
  const script = `export const meta = { name: 'p_rethrow', description: 'script bug propagates' }
const xs = await parallel([
  () => agent('good'),
  () => { JSON.parse('{malformed'); return null },
])
return xs`;

  await assert.rejects(() => runWorkflow(script, { agent: okAgent, persistLogs: false }), /JSON|Expected|SyntaxError/i);
});

test("M2: a plain script bug inside a pipeline() stage rethrows", async () => {
  const script = `export const meta = { name: 'pipe_rethrow', description: 'stage bug propagates' }
const xs = await pipeline(['a'], () => { throw new TypeError('stage exploded') })
return xs`;

  await assert.rejects(() => runWorkflow(script, { agent: okAgent, persistLogs: false }), /stage exploded/);
});

test("M2: recoverable agent exhaustion still resolves null (not a rethrow) so fan-out semantics hold", async () => {
  const exhausted = {
    async run() {
      throw new Error("recoverable runner failure");
    },
  };
  const script = `export const meta = { name: 'p_null', description: 'recoverable null' }
const xs = await parallel([() => agent('x', { label: 'x' })])
return xs`;

  const result = await runWorkflow<Array<unknown>>(script, { agent: exhausted, persistLogs: false });
  assert.deepEqual([...result.result], [null], "a recoverable-exhausted agent stays a null, exactly as before");
});

test("M2: non-recoverable WorkflowErrors still propagate through parallel()", async () => {
  const fatal = {
    async run() {
      throw new WorkflowError("cap blown", WorkflowErrorCode.AGENT_LIMIT_EXCEEDED, { recoverable: false });
    },
  };
  const script = `export const meta = { name: 'p_fatal', description: 'fatal propagates' }
const xs = await parallel([() => agent('x')])
return xs`;

  await assert.rejects(() => runWorkflow(script, { agent: fatal, persistLogs: false }), /cap blown/);
});
