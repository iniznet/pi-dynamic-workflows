import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readJsonWithBackupRecovery,
  resolvePersistenceFs,
  writeJsonAtomicWithBackup,
} from "../../../src/fs-persistence.js";

test("L9: a forced rename failure unlinks the orphaned .tmp and rethrows", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dw-l9-"));
  const fs = resolvePersistenceFs({
    renameSync: () => {
      throw new Error("simulated rename failure");
    },
  });
  try {
    const path = join(dir, "state.json");
    assert.throws(() => writeJsonAtomicWithBackup(fs, path, { a: 1 }), /rename failure/);
    assert.equal(existsSync(`${path}.tmp`), false, "no orphaned .tmp after a failed rename (L9)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("L9: the .bak sidecar is written atomically (tmp + rename, no half-written sidecar)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dw-l9b-"));
  try {
    const path = join(dir, "state.json");
    writeJsonAtomicWithBackup(resolvePersistenceFs(), path, { a: 1 });
    assert.equal(existsSync(`${path}.bak`), true, ".bak exists");
    assert.equal(existsSync(`${path}.tmp`), false, "no leftover primary .tmp");
    assert.equal(existsSync(`${path}.bak.tmp`), false, "no leftover .bak .tmp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("L9: a primary rename failure leaves a previous good primary untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dw-l9c-"));
  try {
    const path = join(dir, "state.json");
    const good = resolvePersistenceFs();
    writeJsonAtomicWithBackup(good, path, { version: "good" });

    const broken = resolvePersistenceFs({
      renameSync: () => {
        throw new Error("simulated crash before rename");
      },
    });
    assert.throws(() => writeJsonAtomicWithBackup(broken, path, { version: "new" }));
    assert.deepEqual(readJsonWithBackupRecovery(good, path), { version: "good" }, "primary untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
