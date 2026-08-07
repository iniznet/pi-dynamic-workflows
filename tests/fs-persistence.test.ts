/**
 * Unit tests for the shared atomic JSON writer (audit WPA-01): the single
 * writeJsonFileAtomic implementation the plan-approval writers route through
 * (src/plan-size.ts, src/integrations/plannotator.ts). Pins:
 *   1. atomic replace — a second write replaces the live file with no torn
 *      intermediate observable and no tmp leftovers;
 *   2. tmp cleanup on rename failure — every retry fails, the util rejects and
 *      the orphaned tmp is unlinked;
 *   3. retry succeeds — the first rename fails onto a directory, the directory
 *      is removed during the inter-attempt sleep, a later attempt lands.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeJsonFileAtomic } from "../src/fs-persistence.js";

function withTempDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dw-fa-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const tmpLeftovers = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".tmp"));

test(
  "writeJsonFileAtomic replaces a file atomically (tmp + rename, no torn intermediates)",
  withTempDir(async (dir) => {
    const path = join(dir, "record.json");
    await writeJsonFileAtomic(path, { step: 1 });
    assert.equal((JSON.parse(readFileSync(path, "utf-8")) as { step: number }).step, 1);

    await writeJsonFileAtomic(path, { step: 2 });
    const onDisk = JSON.parse(readFileSync(path, "utf-8")) as { step: number };
    assert.equal(onDisk.step, 2, "a second write replaces the live file");
    assert.equal(JSON.stringify(onDisk), JSON.stringify({ step: 2 }), "no fields from the first write survive");
    assert.deepEqual(tmpLeftovers(dir), [], "no tmp files remain after successful writes");
  }),
);

test(
  "writeJsonFileAtomic cleans up its tmp and rejects when the rename keeps failing",
  withTempDir(async (dir) => {
    // A file can never rename over a non-empty directory — every retry fails
    // (EISDIR / ENOTEMPTY / EPERM across platforms), exercising the bounded
    // retry and the final-failure cleanup.
    const destDir = join(dir, "dest");
    mkdirSync(destDir);
    writeFileSync(join(destDir, "occupied.txt"), "x", "utf-8");
    await assert.rejects(writeJsonFileAtomic(destDir, { x: 1 }));
    assert.deepEqual(tmpLeftovers(dir), [], "the orphaned tmp is unlinked after the failed rename");
  }),
);

test(
  "writeJsonFileAtomic retries the rename and succeeds once the destination frees up",
  withTempDir(async (dir) => {
    const destDir = join(dir, "dest");
    mkdirSync(destDir);
    // The first rename attempt fails onto the directory; removing it during
    // the 20ms inter-attempt sleep lets a later attempt land. (Pathological
    // timing — the directory already gone before attempt 0 — still passes:
    // the write simply succeeds immediately.)
    const removal = setTimeout(() => rmdirSync(destDir), 5);
    await writeJsonFileAtomic(destDir, { retried: true });
    clearTimeout(removal);
    const onDisk = JSON.parse(readFileSync(destDir, "utf-8")) as { retried: boolean };
    assert.equal(onDisk.retried, true, "the destination is now a real file carrying the written data");
    assert.deepEqual(tmpLeftovers(dir), [], "no tmp files remain after the retried rename");
  }),
);
