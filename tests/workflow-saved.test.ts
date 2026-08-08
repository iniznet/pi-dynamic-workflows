import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { WORKFLOW_SAVED_DIR } from "../src/config.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { createWorkflowStorage } from "../src/workflow-saved.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { rmForce } from "./helpers/rm-force.js";

/**
 * Minimal script that passes parseWorkflowScript (save-time validation, L21):
 * `export const meta = …` as the first statement with non-empty name/description.
 */
const VALID_SCRIPT = "export const meta = { name: 'wf', description: 'd' };";

/**
 * Run tests with HOME overridden to a temp directory so the user-level
 * saved workflows directory (~/.pi/workflows/saved) is isolated.
 */
function withIsolatedHome(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-ws-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      await rmForce(cwd, fakeHome);
    }
  };
}

test(
  "createWorkflowStorage save creates directory and file",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const saved = storage.save({
      name: "test-wf",
      description: "A test workflow",
      script: "export const meta = { name: 'test', description: 'test' }",
      location: "project",
    });
    assert.equal(saved.name, "test-wf");
    assert.equal(saved.location, "project");
    assert.ok(saved.path.endsWith("test-wf.json"), "should end with test-wf.json");
    assert.ok(saved.savedAt, "should have savedAt timestamp");
    const dir = workflowProjectPaths(cwd).savedDir;
    assert.ok(existsSync(dir), "project saved dir should exist");
    assert.ok(existsSync(join(dir, "test-wf.json")), "file should exist");
    assert.equal(existsSync(join(cwd, WORKFLOW_SAVED_DIR)), false, "legacy project saved dir should not be created");
  }),
);

test(
  "createWorkflowStorage save to user location",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const saved = storage.save(
      {
        name: "user-wf",
        description: "User workflow",
        script: "export const meta = { name: 'u', description: 'u' }",
        location: "user",
      },
      "user",
    );
    assert.equal(saved.location, "user");
    assert.ok(saved.path.includes(`.pi${sep}workflows${sep}saved`), "should contain .pi/workflows/saved");
  }),
);

test(
  "createWorkflowStorage load returns project workflow (takes precedence)",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({
      name: "shared",
      description: "Project version",
      script: VALID_SCRIPT,
      location: "project",
    });
    storage.save(
      {
        name: "shared",
        description: "User version",
        script: VALID_SCRIPT,
        location: "user",
      },
      "user",
    );
    const loaded = storage.load("shared");
    assert.ok(loaded, "should load");
    assert.equal(loaded?.script, VALID_SCRIPT, "project should take precedence");
  }),
);

test(
  "createWorkflowStorage load returns null for nonexistent workflow",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const loaded = storage.load("nonexistent");
    assert.equal(loaded, null);
  }),
);

test(
  "createWorkflowStorage load returns user workflow when no project version exists",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save(
      {
        name: "user-only",
        description: "Only in user",
        script: VALID_SCRIPT,
        location: "user",
      },
      "user",
    );
    const loaded = storage.load("user-only");
    assert.ok(loaded, "should load successfully");
    assert.equal(loaded?.script, VALID_SCRIPT);
    assert.equal(loaded?.location, "user");
  }),
);

test(
  "createWorkflowStorage load reads legacy project workflows before user workflows",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const legacyProjectDir = join(cwd, WORKFLOW_SAVED_DIR);
    mkdirSync(legacyProjectDir, { recursive: true });
    writeFileSync(
      join(legacyProjectDir, "shared.json"),
      JSON.stringify({
        name: "shared",
        description: "Legacy project version",
        script: VALID_SCRIPT,
        location: "project",
        savedAt: "2024-01-01T00:00:00.000Z",
        path: join(legacyProjectDir, "shared.json"),
      }),
      "utf-8",
    );
    storage.save(
      {
        name: "shared",
        description: "User version",
        script: VALID_SCRIPT,
        location: "user",
      },
      "user",
    );

    const loaded = storage.load("shared");
    assert.equal(loaded?.script, VALID_SCRIPT);
    assert.equal(loaded?.location, "project");
  }),
);

test(
  "createWorkflowStorage list combines project and user workflows sorted by name",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({ name: "b-project", description: "b", script: VALID_SCRIPT, location: "project" });
    storage.save({ name: "a-project", description: "a", script: VALID_SCRIPT, location: "project" });
    storage.save({ name: "c-user", description: "c", script: VALID_SCRIPT, location: "user" }, "user");

    const list = storage.list();
    assert.equal(list.length, 3);
    assert.equal(list[0].name, "a-project");
    assert.equal(list[1].name, "b-project");
    assert.equal(list[2].name, "c-user");
  }),
);

test(
  "createWorkflowStorage list returns empty array when no workflows saved",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const list = storage.list();
    assert.deepEqual(list, []);
  }),
);

test(
  "createWorkflowStorage delete removes project workflow",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({ name: "to-delete", description: "d", script: VALID_SCRIPT, location: "project" });
    assert.ok(storage.load("to-delete"), "load() should succeed");
    const deleted = storage.delete("to-delete");
    assert.equal(deleted, true);
    assert.equal(storage.load("to-delete"), null);
  }),
);

test(
  "createWorkflowStorage delete returns false for nonexistent",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    assert.equal(storage.delete("no-such"), false);
  }),
);

test(
  "createWorkflowStorage delete removes from one location only",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({ name: "both", description: "p", script: VALID_SCRIPT, location: "project" });
    storage.save({ name: "both", description: "u", script: VALID_SCRIPT, location: "user" }, "user");
    assert.ok(storage.load("both"), "load() should succeed");
    // Delete only from project
    const deleted = storage.delete("both", "project");
    assert.equal(deleted, true);
    // User version should still exist
    const userVersion = storage.load("both");
    assert.ok(userVersion, "user version should still exist");
    assert.equal(userVersion?.location, "user");
  }),
);

test(
  "createWorkflowStorage save preserves parameters",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const saved = storage.save({
      name: "param-wf",
      description: "Has params",
      script: "export const meta = { name: 'p', description: 'p' }",
      location: "project",
      parameters: {
        input: { type: "string", description: "Input value", required: true },
        limit: { type: "number", description: "Max results", default: 10 },
      },
    });
    assert.ok(saved.parameters, "parameters should be truthy");
    assert.equal(saved.parameters?.input.type, "string");
    assert.equal(saved.parameters?.input.required, true);
    assert.equal(saved.parameters?.limit.default, 10);

    const loaded = storage.load("param-wf");
    assert.deepEqual(loaded?.parameters, saved.parameters);
  }),
);

test(
  "createWorkflowStorage rejects path-unsafe workflow names",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    assert.throws(
      () => storage.save({ name: "../escape", description: "bad", script: "bad", location: "project" }),
      /path-safe name/,
    );
    assert.equal(storage.load("../escape"), null);
    assert.equal(storage.delete("../escape"), false);
    assert.equal(existsSync(join(workflowProjectPaths(cwd).rootDir, "escape.json")), false);
  }),
);

test(
  "createWorkflowStorage file contents are valid JSON with expected fields",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({
      name: "check-json",
      description: "desc",
      script: "export const meta = { name: 'c', description: 'c' }",
      location: "project",
    });
    const filePath = join(workflowProjectPaths(cwd).savedDir, "check-json.json");
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(raw.name, "check-json");
    assert.equal(raw.description, "desc");
    assert.equal(raw.script, "export const meta = { name: 'c', description: 'c' }");
    assert.ok(raw.savedAt, "savedAt should be truthy");
    assert.ok(raw.path, "path should be truthy");
  }),
);

test(
  "createWorkflowStorage handles corrupted files gracefully",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const projectDir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "corrupted.json"), "not valid json{{{");

    const loaded = storage.load("corrupted");
    assert.equal(loaded, null, "corrupted file returns null");
    const list = storage.list();
    assert.ok(Array.isArray(list), "list should be an array");
    assert.equal(list.length, 0); // only corrupted file
  }),
);

test(
  "createWorkflowStorage loads legacy files with unsafe embedded names using the sanitized filename (L7)",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const projectDir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "unsafe.json"),
      JSON.stringify({
        name: "../unsafe",
        description: "unsafe",
        script: VALID_SCRIPT,
        location: "project",
        savedAt: "2024-01-01T00:00:00.000Z",
        path: join(projectDir, "unsafe.json"),
      }),
      "utf-8",
    );

    // The embedded name is data, not identity: the workflow loads under the
    // SANITIZED FILENAME ("unsafe"), never the unsafe embedded "../unsafe".
    const listed = storage.list();
    assert.equal(listed.length, 1, "the legacy file is loaded, not skipped");
    assert.equal(listed[0].name, "unsafe");
    assert.equal(storage.load("unsafe")?.name, "unsafe");
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// Write safety: atomic write-with-backup + corrupt-file recovery, unified
// with run-persistence.ts via fs-persistence.ts (previously saved-workflow
// writes were a plain writeFileSync with no backup/recovery).
// ═══════════════════════════════════════════════════════════════════════════

test(
  "createWorkflowStorage save writes atomically (tmp+rename, no leftover .tmp) and leaves a .bak",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({ name: "atomic-wf", description: "d", script: VALID_SCRIPT, location: "project" });
    const path = join(workflowProjectPaths(cwd).savedDir, "atomic-wf.json");
    assert.ok(existsSync(path), "primary written");
    assert.ok(existsSync(`${path}.bak`), ".bak written");
    assert.equal(existsSync(`${path}.tmp`), false, "no leftover .tmp");
  }),
);

test(
  "createWorkflowStorage save survives a simulated crash mid-write: a rename that never completes leaves the previous good file intact",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd, {
      // Simulate a crash between the .tmp write and the rename: the .tmp
      // lands on disk but the atomic rename into place never happens. The
      // previously-saved good primary must still be there and loadable —
      // exactly the property tmp+rename is supposed to give us.
      renameSync: () => {
        throw new Error("simulated crash before rename completed");
      },
    });
    const goodStorage = createWorkflowStorage(cwd);
    goodStorage.save({ name: "crash-wf", description: "good version", script: VALID_SCRIPT, location: "project" });

    assert.throws(() =>
      storage.save({ name: "crash-wf", description: "new version", script: VALID_SCRIPT, location: "project" }),
    );

    // The primary file must be untouched — still the last good save.
    const recovered = goodStorage.load("crash-wf");
    assert.equal(recovered?.description, "good version", "primary is unaffected by the failed rename");
    assert.equal(recovered?.script, VALID_SCRIPT);
  }),
);

test(
  "createWorkflowStorage load recovers from .bak when the primary is corrupt",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({ name: "corrupt-recovery", description: "good", script: VALID_SCRIPT, location: "project" });
    const path = join(workflowProjectPaths(cwd).savedDir, "corrupt-recovery.json");
    writeFileSync(path, "{ truncated by a crash", "utf-8");

    const loaded = storage.load("corrupt-recovery");
    assert.ok(loaded, "load falls back to the intact .bak");
    assert.equal(loaded?.script, VALID_SCRIPT);
  }),
);

test(
  "createWorkflowStorage delete removes the .bak sidecar too",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({ name: "del-bak", description: "d", script: VALID_SCRIPT, location: "project" });
    const path = join(workflowProjectPaths(cwd).savedDir, "del-bak.json");
    assert.ok(existsSync(`${path}.bak`), ".bak exists before delete");
    storage.delete("del-bak");
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(`${path}.bak`), false, ".bak cleaned up too");
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// Unguarded directory read: list() must degrade to "no files" for a missing
// or unreadable directory instead of throwing (same guard run-persistence.ts
// uses, via the shared listJsonFilesSafe()).
// ═══════════════════════════════════════════════════════════════════════════

test(
  "createWorkflowStorage list returns empty (not throw) when a saved-workflow directory is unreadable",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd, {
      readdirSync: () => {
        throw new Error("EACCES: permission denied, scandir");
      },
    });
    // Make sure the directory actually exists, so the throwing readdirSync
    // path (not the pre-existing existsSync-false path) is what's exercised.
    mkdirSync(workflowProjectPaths(cwd).savedDir, { recursive: true });

    assert.deepEqual(storage.list(), [], "an unreadable directory degrades to an empty list, not a thrown error");
  }),
);

test(
  "createWorkflowStorage list returns empty for a project directory that was never created",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    assert.equal(existsSync(workflowProjectPaths(cwd).savedDir), false, "directory really doesn't exist yet");
    assert.deepEqual(storage.list(), []);
  }),
);
