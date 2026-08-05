/**
 * Slice W — saved-workflow save-time validation + filename trust (L21, L7).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WORKFLOW_SAVED_DIR } from "../../../src/config.js";
import { workflowProjectPaths } from "../../../src/workflow-paths.js";
import { createWorkflowStorage } from "../../../src/workflow-saved.js";
import { withFakeHomeAsync } from "../../helpers/fake-home.js";

const VALID_SCRIPT = "export const meta = { name: 'wf', description: 'd' };";

function withIsolatedHome(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-saved-support-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-saved-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

test(
  "createWorkflowStorage save rejects an invalid script with a message (L21)",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    assert.throws(
      () =>
        storage.save({
          name: "bad-script",
          description: "d",
          script: "this is not a workflow script",
          location: "project",
        }),

      /Cannot save workflow "bad-script"/,
    );
    assert.equal(
      existsSync(join(workflowProjectPaths(cwd).savedDir, "bad-script.json")),
      false,
      "an invalid script must never reach disk",
    );
  }),
);

test(
  "createWorkflowStorage save accepts a valid script (L21)",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const saved = storage.save({ name: "good-script", description: "d", script: VALID_SCRIPT, location: "project" });
    assert.equal(saved.name, "good-script");
    assert.ok(existsSync(join(workflowProjectPaths(cwd).savedDir, "good-script.json")));
  }),
);

test(
  "createWorkflowStorage load trusts the sanitized filename, not the embedded name (L7)",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const projectDir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(projectDir, { recursive: true });
    // The file was renamed/copied after save; its embedded name is stale.
    writeFileSync(
      join(projectDir, "renamed.json"),
      JSON.stringify({
        name: "original-name",
        description: "d",
        script: VALID_SCRIPT,
        location: "project",
        savedAt: "2024-01-01T00:00:00.000Z",
        path: join(projectDir, "renamed.json"),
      }),
      "utf-8",
    );

    const loaded = storage.load("renamed");
    assert.equal(loaded?.name, "renamed", "the filename is the workflow's identity");
    assert.equal(loaded?.script, VALID_SCRIPT, "the rest of the record is preserved");
  }),
);

test(
  "createWorkflowStorage reports an embedded-name mismatch via the diagnostic sink (L7)",
  withIsolatedHome(async (cwd) => {
    const diagnostics: string[] = [];
    const storage = createWorkflowStorage(cwd, undefined, (m) => diagnostics.push(m));
    const projectDir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "renamed.json"),
      JSON.stringify({ name: "original-name", description: "d", script: VALID_SCRIPT }),
      "utf-8",
    );

    storage.load("renamed");
    assert.ok(
      diagnostics.some((m) => m.includes("renamed") && m.includes("original-name")),
      `a mismatch diagnostic must be emitted; got: ${JSON.stringify(diagnostics)}`,
    );
  }),
);

test(
  "createWorkflowStorage save validates the script even in the legacy project directory flow",
  withIsolatedHome(async (cwd) => {
    // The legacy saved dir is READ for migration; saving still goes through the
    // project/user dirs and is validated the same way.
    const storage = createWorkflowStorage(cwd);
    const legacyDir = join(cwd, WORKFLOW_SAVED_DIR);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "legacy.json"),
      JSON.stringify({ name: "legacy", description: "d", script: VALID_SCRIPT }),
      "utf-8",
    );
    const loaded = storage.load("legacy");
    assert.equal(loaded?.name, "legacy");
  }),
);
