/**
 * V2-N6 — trusted-script auto-approval allowlist.
 *
 * A script-hash allowlist persisted under getAgentDir(): a script body hash
 * that was previously HUMAN-approved (via the meta.gate pre-body approval
 * path in workflow.ts) skips the fan-out / meta.gate / confirm-checkpoint
 * gates on re-run. Approval is per EXACT hash — any edit to the script body
 * produces a different hash and invalidates the entry, so a trusted entry
 * can never widen to an edited variant. Gate-skip is host-side policy and is
 * deliberately excluded from hashAgentCall (the same exclusion rule
 * autoApproved/concurrency already follow), so a trusted re-run replays
 * byte-identically.
 *
 * Persistence mirrors the durable-store pattern: a versioned JSON file under
 * getAgentDir()/workflows/trusted-scripts.json, atomically replaced (tmp +
 * rename) on write. Reads are lenient — a missing, corrupt, or unversioned
 * file degrades to an empty allowlist (never a run failure). Timestamps use
 * the durable-store deterministic clock so a replayed write never re-stamps.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { deterministicRunClock } from "./durable-store.js";
import { writeJsonFileAtomic } from "./fs-persistence.js";

export const TRUSTED_SCRIPTS_SCHEMA_VERSION = 1;

/** Subdirectory under getAgentDir() where allowlist files live. */
export const TRUSTED_SCRIPTS_SUBDIR = "workflows";

/**
 * Subdirectory (under getAgentDir()/workflows) holding per-project allowlist
 * files. Mirrors the durable-store pattern: `<projectKey>.json` — a script
 * approved in one project is never auto-trusted in another (never widens),
 * and tests/direct embeds in throwaway cwds never pollute each other.
 */
export const TRUSTED_SCRIPTS_PROJECT_SUBDIR = "trusted-scripts";

export const TRUSTED_SCRIPTS_FILENAME = "trusted-scripts.json";

/** A sha256 hex digest is exactly 64 chars — the allowlist key shape. */
export function scriptBodyHash(script: string): string {
  return createHash("sha256").update(script).digest("hex");
}

/** One allowlist entry. `addedAt` uses the deterministic durable-store clock. */
export interface TrustedScriptRecord {
  /** The exact sha256 of the approved script body. */
  hash: string;
  /** The workflow's meta.name (informational). */
  name?: string;
  /** Where the approval came from (informational). */
  source?: string;
  /**
   * Deterministic timestamp (durable-store clock). The store fills it with
   * the deterministic clock when omitted, so callers never need to supply it.
   */
  addedAt?: string;
  /** The approving run's id (informational). */
  runId?: string;
}

/** The allowlist surface the workflow runtime and tests consume. */
export interface TrustedScriptsStore {
  /** Resolved allowlist file path (for diagnostics/tests). */
  readonly filePath: string;
  /** Whether this exact script hash was previously human-approved. */
  isTrusted(hash: string): boolean;
  /**
   * Add a hash to the allowlist (idempotent, atomic write). Returns false
   * when the write could not be persisted — callers treat that as best-effort
   * observability, never a control-flow reason.
   */
  add(record: TrustedScriptRecord): Promise<boolean>;
  /** Remove a hash. Returns false when the write could not be persisted. */
  remove(hash: string): Promise<boolean>;
  /** Current allowlist entries (read-only view). */
  list(): readonly TrustedScriptRecord[];
}

export interface TrustedScriptsStoreOptions {
  /**
   * Base dir for the allowlist file. Defaults to
   * getAgentDir()/workflows/trusted-scripts — the durable-store pattern.
   */
  dir?: string;
  /**
   * Project-scoping key (workflowProjectKey(cwd)): scopes the default file to
   * `<dir>/<projectKey>.json`, so one project's approvals never trust another
   * project's scripts. Ignored when `filePath` is provided.
   */
  projectKey?: string;
  /** Exact file path — overrides `dir`/`projectKey` (tests inject temp paths). */
  filePath?: string;
}

function isValidHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

interface TrustedScriptsFile {
  version: number;
  records: TrustedScriptRecord[];
}

/**
 * Create the trusted-scripts store. Reads lazily (the file is loaded on the
 * first `isTrusted`/`list` call) and leniently — a missing/corrupt file is an
 * empty allowlist, never an error. Writes re-read the freshest on-disk state
 * (a concurrent run's approval is never clobbered) and atomically replace.
 */
export function createTrustedScriptsStore(options: TrustedScriptsStoreOptions = {}): TrustedScriptsStore {
  const baseDir = options.dir ?? join(getAgentDir(), TRUSTED_SCRIPTS_SUBDIR, TRUSTED_SCRIPTS_PROJECT_SUBDIR);
  const filePath =
    options.filePath ?? join(baseDir, options.projectKey ? `${options.projectKey}.json` : TRUSTED_SCRIPTS_FILENAME);
  const clock = deterministicRunClock();
  let seq = 0;
  let cached: TrustedScriptRecord[] | null = null;

  const rehydrate = (): TrustedScriptRecord[] => {
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<TrustedScriptsFile>;
      if (raw && typeof raw === "object" && Array.isArray(raw.records)) {
        return raw.records.filter((r): r is TrustedScriptRecord => isValidHash(r?.hash));
      }
    } catch {
      // missing / corrupt / unversioned → empty allowlist (never a failure)
    }
    return [];
  };

  const persist = async (mutate: (records: TrustedScriptRecord[], mark: () => void) => void): Promise<boolean> => {
    const current = rehydrate();
    let changed = false;
    const mark = () => {
      changed = true;
    };
    mutate(current, mark);
    if (!changed) return true;
    try {
      const next: TrustedScriptsFile = { version: TRUSTED_SCRIPTS_SCHEMA_VERSION, records: current };
      await writeJsonFileAtomic(filePath, next, { mkdir: true });
      cached = current;
      return true;
    } catch {
      return false;
    }
  };

  return {
    filePath,
    isTrusted(hash) {
      if (cached === null) cached = rehydrate();
      return cached.some((r) => r.hash === hash);
    },
    async add(record) {
      return persist((records, mark) => {
        if (records.some((r) => r.hash === record.hash)) return; // idempotent
        records.push({
          hash: record.hash,
          ...(record.name !== undefined ? { name: record.name } : {}),
          ...(record.source !== undefined ? { source: record.source } : {}),
          addedAt: record.addedAt ?? clock(seq++),
          ...(record.runId !== undefined ? { runId: record.runId } : {}),
        });
        mark();
      });
    },
    async remove(hash) {
      return persist((records, mark) => {
        const at = records.findIndex((r) => r.hash === hash);
        if (at < 0) return; // nothing to remove
        records.splice(at, 1);
        mark();
      });
    },
    list() {
      if (cached === null) cached = rehydrate();
      return cached;
    },
  };
}
