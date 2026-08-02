/**
 * Save and load reusable workflow commands.
 */

import { basename, join } from "node:path";
import {
  ensureDir as ensureDirFs,
  listJsonFilesSafe,
  type PersistenceFsLayer,
  readJsonWithBackupRecovery,
  resolvePersistenceFs,
  unlinkIfExistsSafe,
  writeJsonAtomicWithBackup,
} from "./fs-persistence.js";
import { parseWorkflowScript } from "./workflow.js";
import { workflowProjectPaths, workflowUserSavedDir } from "./workflow-paths.js";

/**
 * Declared argument schema entry for a saved workflow. `type` is one of
 * "string" | "number" | "integer" | "boolean" ("array" passes through
 * unchanged, since a CLI cannot express it). `required` params must be
 * provided (or defaulted); provided values are coerced to `type` and a
 * failed coercion throws a descriptive error instead of silently passing
 * the raw string through to the script.
 */
export interface WorkflowParameterSpec {
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
}

/** Declared argument schema for a saved workflow: key -> spec. */
export type WorkflowParameters = Record<string, WorkflowParameterSpec>;

export interface SavedWorkflow {
  /** Command name (filename without extension). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** The workflow script. */
  script: string;
  /** Optional parameter schema for parameterized workflows. */
  parameters?: WorkflowParameters;
  /** Where this workflow is saved. */
  location: "project" | "user";
  /** Full file path. */
  path: string;
  /** When it was saved. */
  savedAt: string;
}

export interface WorkflowStorage {
  /** Save a workflow. */
  save(workflow: Omit<SavedWorkflow, "path" | "savedAt">, location?: "project" | "user"): SavedWorkflow;
  /** Load a workflow by name. */
  load(name: string): SavedWorkflow | null;
  /** List all saved workflows. */
  list(): SavedWorkflow[];
  /** Delete a saved workflow. */
  delete(name: string, location?: "project" | "user"): boolean;
}

export function isSafeSavedWorkflowName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    name.trim() === name &&
    name !== "." &&
    name !== ".." &&
    !/[/\\\0]/.test(name)
  );
}

export function assertSafeSavedWorkflowName(name: string): void {
  if (!isSafeSavedWorkflowName(name)) {
    throw new Error("Saved workflow name must be a non-empty path-safe name without slashes.");
  }
}

export function createWorkflowStorage(
  cwd: string,
  fsOverride?: Partial<PersistenceFsLayer>,
  /** Diagnostic sink for load-time reconciliation (e.g. embedded-name mismatches). */
  onDiagnostic?: (message: string) => void,
): WorkflowStorage {
  const fs = resolvePersistenceFs(fsOverride);
  const paths = workflowProjectPaths(cwd);
  const projectDir = paths.savedDir;
  const legacyProjectDir = paths.legacySavedDir;
  const userDir = workflowUserSavedDir();

  const ensureDir = (dir: string) => ensureDirFs(fs, dir);

  const workflowPath = (name: string, location: "project" | "user") => {
    assertSafeSavedWorkflowName(name);
    const dir = location === "project" ? projectDir : userDir;
    return join(dir, `${name}.json`);
  };
  const legacyProjectWorkflowPath = (name: string) => {
    assertSafeSavedWorkflowName(name);
    return join(legacyProjectDir, `${name}.json`);
  };

  // Same atomic-write-with-backup + corrupt-file recovery contract as
  // run-persistence.ts (see fs-persistence.ts) — a saved workflow is a
  // user-authored artifact just as worth protecting from a crash mid-write
  // or a truncated file as a run's resumable state is.
  const loadFromFile = (path: string, location: "project" | "user"): SavedWorkflow | null => {
    const data = readJsonWithBackupRecovery<Record<string, unknown>>(fs, path);
    if (!data || typeof data !== "object") return null;
    // The workflow's identity is its SANITIZED FILENAME, never the embedded
    // `name` field: files are addressed by basename (load/delete/list), so
    // trusting contents would let a mismatch (rename, copy, hand-edit) register
    // a command under a different name than the file — or an unsafe one (L7).
    const fileName = basename(path).replace(/\.json$/, "");
    if (!isSafeSavedWorkflowName(fileName)) return null;
    const embeddedName =
      typeof (data as { name?: unknown }).name === "string" ? (data as { name: string }).name : undefined;
    if (embeddedName !== undefined && embeddedName !== fileName) {
      onDiagnostic?.(
        `[workflow-saved] "${fileName}" at ${path} has an embedded name "${embeddedName}" that differs from its ` +
          `filename; using the filename. Rename the file to fix the mismatch.`,
      );
    }
    return {
      ...(data as Omit<SavedWorkflow, "location" | "path" | "name">),
      name: fileName,
      location,
      path,
    };
  };

  return {
    save(workflow, location = "project") {
      assertSafeSavedWorkflowName(workflow.name);
      // Validate the script BEFORE persisting: a malformed script must fail at
      // save time with a clear message, not at every future /name invocation
      // (L21).
      try {
        parseWorkflowScript(workflow.script);
      } catch (error) {
        throw new Error(
          `Cannot save workflow "${workflow.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const dir = location === "project" ? projectDir : userDir;
      ensureDir(dir);

      const path = workflowPath(workflow.name, location);
      const saved: SavedWorkflow = {
        ...workflow,
        location,
        path,
        savedAt: new Date().toISOString(),
      };

      writeJsonAtomicWithBackup(fs, path, saved);
      return saved;
    },

    load(name: string): SavedWorkflow | null {
      if (!isSafeSavedWorkflowName(name)) return null;
      // Project takes precedence over user
      const projectPath = workflowPath(name, "project");
      const project = loadFromFile(projectPath, "project");
      if (project) return project;

      const legacyProject = loadFromFile(legacyProjectWorkflowPath(name), "project");
      if (legacyProject) return legacyProject;

      const userPath = workflowPath(name, "user");
      return loadFromFile(userPath, "user");
    },

    list(): SavedWorkflow[] {
      const workflows: SavedWorkflow[] = [];

      const seen = new Set<string>();
      const addDir = (dir: string, location: "project" | "user") => {
        // A missing or unreadable directory (not yet created, deleted
        // mid-race, permission-denied) degrades to "no files" here — same
        // guard run-persistence.ts's list() uses — rather than throwing and
        // taking down the whole listing over one bad storage location.
        for (const file of listJsonFilesSafe(fs, dir)) {
          const wf = loadFromFile(join(dir, file), location);
          if (wf && !seen.has(wf.name)) {
            seen.add(wf.name);
            workflows.push(wf);
          }
        }
      };

      // Priority order mirrors load(): project > legacy project > user.
      addDir(projectDir, "project");
      addDir(legacyProjectDir, "project");
      addDir(userDir, "user");

      return workflows.sort((a, b) => a.name.localeCompare(b.name));
    },

    delete(name: string, location?: "project" | "user"): boolean {
      if (!isSafeSavedWorkflowName(name)) return false;
      const locations = location ? [location] : (["project", "user"] as const);
      let deleted = false;

      for (const loc of locations) {
        const path = workflowPath(name, loc);
        // Clean up the .bak sidecar too, mirroring run-persistence.ts's delete()
        // (sidecar cleanup does not by itself count as "deleted the workflow").
        unlinkIfExistsSafe(fs, `${path}.bak`);
        if (unlinkIfExistsSafe(fs, path)) {
          deleted = true;
        }
        if (loc === "project") {
          const legacyPath = legacyProjectWorkflowPath(name);
          unlinkIfExistsSafe(fs, `${legacyPath}.bak`);
          if (unlinkIfExistsSafe(fs, legacyPath)) {
            deleted = true;
          }
        }
      }

      return deleted;
    },
  };
}
