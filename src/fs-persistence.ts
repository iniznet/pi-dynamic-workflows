/**
 * Shared filesystem primitives for JSON-backed persistence.
 *
 * Both run-persistence.ts (workflow runs) and workflow-saved.ts (saved
 * workflow commands) persist plain-JSON records to per-record files under a
 * project/user directory, and both need the same three guarantees:
 *
 *  1. Atomic writes with a recovery backup — a crash mid-write must never
 *     corrupt the live file, and a later-discovered-truncated primary must
 *     still be recoverable from the last good write.
 *  2. Corrupt-file recovery on read — a truncated/corrupt primary falls back
 *     to its `.bak` sidecar instead of losing the record.
 *  3. A missing or unreadable directory degrades to "no files" rather than
 *     throwing — a listing must never crash because one storage location is
 *     temporarily inaccessible (not yet created, deleted mid-race, EACCES).
 *
 * This module is the single implementation of all three; run-persistence.ts
 * and workflow-saved.ts both call into it rather than maintaining parallel
 * copies.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir as mkdirAsync,
  rename as renameAsync,
  rm as rmAsync,
  writeFile as writeFileAsync,
} from "node:fs/promises";
import { dirname } from "node:path";

/** Filesystem operations used by JSON persistence. Exposed for testing. */
export type PersistenceFsLayer = {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  renameSync: typeof renameSync;
  statSync: typeof statSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
};

/** The real node:fs implementations. */
export function defaultPersistenceFs(): PersistenceFsLayer {
  return { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync };
}

/** Merge a partial test override on top of the real node:fs implementations. */
export function resolvePersistenceFs(overrides?: Partial<PersistenceFsLayer>): PersistenceFsLayer {
  const base = defaultPersistenceFs();
  return overrides ? { ...base, ...overrides } : base;
}

/** Ensure `dir` exists (recursive mkdir), idempotent. */
export function ensureDir(fs: PersistenceFsLayer, dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Atomically write JSON to `path`: tmp-write + rename (atomic on the same
 * filesystem, so a crash mid-write can't corrupt the live file), then
 * best-effort refresh a `.bak` sidecar from the just-written good state —
 * the recovery fallback readJsonWithBackupRecovery() uses if the primary is
 * later found truncated (e.g. a rename that itself got interrupted by a
 * power loss on a filesystem/OS combination where rename isn't fully atomic).
 * L9: a failed rename unlinks the orphaned `.tmp` before rethrowing, and the
 * `.bak` itself is written atomically (tmp + rename) so a crash mid-backup
 * can never leave a half-written sidecar that shadows the good primary.
 */
export function writeJsonAtomicWithBackup(fs: PersistenceFsLayer, path: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(`${path}.tmp`, json);
  try {
    fs.renameSync(`${path}.tmp`, path);
  } catch (error) {
    // The primary write failed — never leave the orphaned .tmp behind, then
    // surface the original failure.
    try {
      fs.unlinkSync(`${path}.tmp`);
    } catch {
      // unlink is best-effort cleanup; the rename failure is the real error.
    }
    throw error;
  }
  try {
    const bakPath = `${path}.bak`;
    fs.writeFileSync(`${bakPath}.tmp`, json);
    fs.renameSync(`${bakPath}.tmp`, bakPath);
  } catch {
    // Backup is best-effort; the primary write already succeeded. Clean any
    // half-written backup tmp so it can't accumulate.
    try {
      fs.unlinkSync(`${path}.bak.tmp`);
    } catch {
      // ignore
    }
  }
}

/** How many times to retry an atomic rename when the destination is briefly busy. */
export const RENAME_RETRY_ATTEMPTS = 5;
/** Delay between rename retries (see {@link writeJsonFileAtomic}). */
export const RENAME_RETRY_DELAY_MS = 20;

/** Options for {@link writeJsonFileAtomic}. */
export interface WriteJsonFileAtomicOptions {
  /**
   * Ensure the parent directory exists (recursive mkdir) before writing. Dir
   * semantics stay at the call site: the caller decides whether the parent is
   * guaranteed to exist (already mkdir'd) or must be created here.
   */
  mkdir?: boolean;
}

/**
 * Async atomic replace of `filePath` with JSON-serialized `data` (tmp-write +
 * rename in the same directory, atomic on the same filesystem) so a concurrent
 * reader never observes a torn file; an orphaned tmp is unlinked on failure.
 * The rename is retried a bounded number of times: on Windows a concurrent
 * reader that opens the destination without delete-sharing (libuv default)
 * makes MoveFileEx fail EPERM for the few ms the read is in flight.
 *
 * The SINGLE shared implementation for the plan-approval writers — audit
 * WPA-01: writePlanAtomic was triplicated (src/plan-size.ts, src/workflow-
 * commands.ts, src/integrations/plannotator.ts) and only one copy carried this
 * retry, so the two un-hardened copies (CLI approve + bridge /approve) could
 * 500 / silently fail against the same concurrent 250ms waitForStatus poller.
 */
export async function writeJsonFileAtomic(
  filePath: string,
  data: unknown,
  options?: WriteJsonFileAtomicOptions,
): Promise<void> {
  if (options?.mkdir) await mkdirAsync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.${process.pid}.tmp`;
  await writeFileAsync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  let lastError: unknown;
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt++) {
    try {
      await renameAsync(tmpPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < RENAME_RETRY_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS));
      }
    }
  }
  try {
    await rmAsync(tmpPath, { force: true });
  } catch {
    // tmp cleanup is best-effort; the rename failure is the real error.
  }
  throw lastError;
}

/**
 * Read JSON from `path`, falling back to `path.bak` if the primary is
 * missing or fails to parse. Returns null if neither candidate parses.
 */
export function readJsonWithBackupRecovery<T>(fs: PersistenceFsLayer, path: string): T | null {
  for (const candidate of [path, `${path}.bak`]) {
    try {
      if (!fs.existsSync(candidate)) continue;
      return JSON.parse(fs.readFileSync(candidate, "utf-8")) as T;
    } catch {
      // Corrupt candidate -> fall through to the next candidate.
    }
  }
  return null;
}

/**
 * List `.json` record files in `dir`. A missing directory (never created
 * yet) or an unreadable one (deleted between the existsSync check and
 * readdirSync, permission-denied, etc.) both degrade to an empty list
 * rather than throwing — callers (run listings, saved-workflow listings)
 * must never crash a navigator/listing because one storage location is
 * temporarily inaccessible.
 */
export function listJsonFilesSafe(fs: PersistenceFsLayer, dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

/** Best-effort unlink; ignores missing-file/permission errors, reports whether it deleted anything. */
export function unlinkIfExistsSafe(fs: PersistenceFsLayer, path: string): boolean {
  try {
    if (fs.existsSync(path)) {
      fs.unlinkSync(path);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}
