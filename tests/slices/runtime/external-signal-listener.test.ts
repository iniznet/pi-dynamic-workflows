import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowManager } from "../../../src/workflow-manager.js";

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-runtime-"));
    try {
      await fn(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

test(
  "L3: the external-signal abort listener is removed once the execution settles",
  withTempCwd(async (cwd) => {
    const agent = {
      async run() {
        return "ok";
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    const external = new AbortController();

    const script = `export const meta = { name: 'sig_demo', description: 'signal hygiene' }
return await agent('x')`;

    await manager.runSync(script, undefined, { externalSignal: external.signal });
    assert.equal(
      getEventListeners(external.signal, "abort").length,
      0,
      "a long-lived host signal must not accumulate one leaked listener per settled run (L3)",
    );
  }),
);
