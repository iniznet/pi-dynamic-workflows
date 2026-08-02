/**
 * Slice W — logger hardening (L8).
 *
 * Covers: redaction of sk- keys, JWTs, long hex/base64 tokens in log output,
 * and same-millisecond default runId uniqueness (no .log file collisions).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createWorkflowLogger } from "../../../src/logger.js";

describe("logger redaction (L8)", () => {
  it("redacts sk- API keys from log lines", () => {
    const log = createWorkflowLogger({ persist: false });
    log.warn("leaked key: sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-abcdefghijklmnopqrstuvwxyz");
    const line = log.getLogs()[0];
    assert.ok(!line.includes("sk-ant-"), "the key material must not reach the log");
    assert.ok(line.includes("[REDACTED]"));
  });

  it("redacts JWT-shaped tokens", () => {
    const log = createWorkflowLogger({ persist: false });
    log.warn("token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
    const line = log.getLogs()[0];
    assert.ok(!line.includes("eyJhbGci"), "JWT segments must be masked");
    assert.ok(line.includes("[REDACTED]"));
  });

  it("redacts long bare hex tokens (32+ chars)", () => {
    const log = createWorkflowLogger({ persist: false });
    const hex = "0123456789abcdef".repeat(2); // 32 hex chars
    log.log(`hash=${hex}`);
    const line = log.getLogs()[0];
    assert.ok(!line.includes(hex), "long hex must be masked");
    assert.ok(line.includes("[REDACTED]"));
  });

  it("redacts long bare base64 tokens (48+ chars)", () => {
    const log = createWorkflowLogger({ persist: false });
    const b64 = "AbCdEf0123456789".repeat(3); // 48 chars
    log.log(`secret=${b64}`);
    const line = log.getLogs()[0];
    assert.ok(!line.includes(b64), "long base64 must be masked");
    assert.ok(line.includes("[REDACTED]"));
  });

  it("leaves ordinary prose and short tokens untouched", () => {
    const log = createWorkflowLogger({ persist: false });
    log.log("resolved 3 agents in 42ms (phase: research)");
    const line = log.getLogs()[0];
    assert.ok(line.includes("resolved 3 agents in 42ms"), "non-secret content survives verbatim");
  });

  it("redacts before the onLog host sink sees the message", () => {
    const captured: string[] = [];
    const log = createWorkflowLogger({ persist: false, onLog: (m) => captured.push(m) });
    log.log("key=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890");
    assert.ok(!captured[0].includes("sk-proj-"), "host sinks must not receive secrets either");
  });
});

describe("logger default runId (L8)", () => {
  it("two default-runId loggers in the same millisecond get distinct log files", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dw-logger-runid-"));
    try {
      // Back-to-back construction almost always lands in the same millisecond;
      // the monotonic sequence suffix guarantees distinct file paths either way.
      const a = createWorkflowLogger({ persist: true, cwd: dir });
      const b = createWorkflowLogger({ persist: true, cwd: dir });
      const fileA = a.persist();
      const fileB = b.persist();
      assert.ok(fileA && fileB, "both loggers must persist");
      assert.notEqual(fileA, fileB, "same-millisecond default runIds must not collide on the .log file");
      assert.ok(fileA.endsWith(".log") && fileB.endsWith(".log"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
