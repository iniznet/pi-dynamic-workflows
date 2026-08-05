/**
 * Workflow logger with file persistence.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "./run-persistence.js";
import { workflowProjectPaths } from "./workflow-paths.js";

/** Max log entries retained in memory (a ring buffer; persisted logs are not capped). */
export const DEFAULT_MAX_LOG_ENTRIES = 1000;

/**
 * Ring-buffer one entry onto a bounded string array, dropping the oldest
 * entries beyond `cap` (default {@link DEFAULT_MAX_LOG_ENTRIES}). Mirrors the
 * logger's own in-memory cap so sibling log surfaces (run-result logs,
 * managed-run snapshot logs) stay bounded the same way. Unlike the logger's
 * shift()-then-push, splice-based pruning also bounds an over-cap seed (e.g. a
 * log array persisted before the cap existed), so the bound holds even when
 * no new entry is pushed.
 */
export function pushBoundedLog(logs: string[], message: string, cap = DEFAULT_MAX_LOG_ENTRIES): void {
  if (logs.length >= cap) logs.splice(0, logs.length - cap + 1);
  logs.push(message);
}

// ---------------------------------------------------------------------------
// Redaction (L8)
// ---------------------------------------------------------------------------

/**
 * Logger-specific high-entropy patterns layered on top of the shared
 * redactText() rules (API keys, JWTs, bearer tokens, sk- keys). These catch
 * bare long hex/base64 tokens that the shared rules don't cover.
 */
const LOG_REDACTION_RULES: ReadonlyArray<{ re: RegExp; replace: string }> = [
  // 32+ hex chars = 128+ bits of key/hash material; almost never legitimate prose.
  { re: /\b[0-9a-f]{32,}\b/gi, replace: "[REDACTED]" },
  // 48+ consecutive base64-alphabet chars (no separators) = raw key material.
  { re: /\b[A-Za-z0-9+/]{48,}\b/g, replace: "[REDACTED]" },
];

/** Mask secrets in one log line before it enters memory, disk, or a host sink. */
function redactLogLine(message: string): string {
  let out = redactText(message);
  for (const rule of LOG_REDACTION_RULES) out = out.replace(rule.re, rule.replace);
  return out;
}

// ---------------------------------------------------------------------------
// Default runId (L8)
// ---------------------------------------------------------------------------

let lastDefaultRunIdMs = 0;
let defaultRunIdSequence = 0;

/**
 * A process-monotonic default runId: `run-<base36-ms>-<seq>`. Two loggers
 * created within the same millisecond would otherwise collide on the bare
 * `run-<ms>` name (same .log file, cross-run contamination) — the sequence
 * suffix keeps same-millisecond runs distinct.
 */
function defaultRunId(now: number): string {
  if (now === lastDefaultRunIdMs) defaultRunIdSequence++;
  else {
    lastDefaultRunIdMs = now;
    defaultRunIdSequence = 0;
  }
  return `run-${now.toString(36)}-${defaultRunIdSequence}`;
}

export interface WorkflowLogger {
  log(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  getLogs(): string[];
  persist(): string | null;
}

export interface WorkflowLoggerOptions {
  /** Run ID for persistence. */
  runId?: string;
  /** Working directory for file paths. */
  cwd?: string;
  /** Whether to persist logs to disk. */
  persist?: boolean;
  /** Callback for each log entry. */
  onLog?: (message: string) => void;
  /** In-memory ring-buffer cap. Defaults to {@link DEFAULT_MAX_LOG_ENTRIES}. */
  maxLogEntries?: number;
}

export function createWorkflowLogger(options: WorkflowLoggerOptions = {}): WorkflowLogger {
  const maxEntries = Math.max(1, options.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES);
  const logs: string[] = [];
  const persistLogs = options.persist ?? true;
  const cwd = options.cwd ?? process.cwd();
  const runId = options.runId ?? defaultRunId(Date.now());
  const runsDir = workflowProjectPaths(cwd).runsDir;
  let logFile: string | null = null;

  const write = (level: string, message: string) => {
    const timestamp = new Date().toISOString();
    // Redact before the line enters ANY sink (ring buffer, disk file, host
    // callback): agent output routinely contains keys/JWTs, and logs are both
    // persisted and surfaced to the user (L8).
    const safeMessage = redactLogLine(message);
    const entry = `[${timestamp}] [${level}] ${safeMessage}`;
    // Ring buffer: drop the oldest entry once the cap is hit, so the array
    // (and every getLogs() copy) stays bounded however long the run lives.
    pushBoundedLog(logs, entry, maxEntries);
    try {
      options.onLog?.(safeMessage);
    } catch {
      // A throwing log sink must never corrupt the caller's control flow: a
      // caller that logs an error and then runs cleanup (e.g. a store-delta
      // rollback) would silently skip that cleanup if the throw propagated.
    }

    if (persistLogs && logFile) {
      try {
        appendFileSync(logFile, `${entry}\n`);
      } catch {
        // Silent fail for log persistence
      }
    }
  };

  const logger: WorkflowLogger = {
    log(message: string) {
      write("INFO", message);
    },
    error(message: string) {
      write("ERROR", message);
    },
    warn(message: string) {
      write("WARN", message);
    },
    getLogs() {
      return [...logs];
    },
    persist() {
      if (!persistLogs) return null;
      try {
        mkdirSync(runsDir, { recursive: true });
        logFile = join(runsDir, `${runId}.log`);
        writeFileSync(logFile, `${logs.join("\n")}\n`);
        return logFile;
      } catch {
        return null;
      }
    },
  };

  // Initialize log file if persisting
  if (persistLogs) {
    try {
      mkdirSync(runsDir, { recursive: true });
      logFile = join(runsDir, `${runId}.log`);
    } catch {
      // Silent fail
    }
  }

  return logger;
}
