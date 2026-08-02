/**
 * Workflow logger with file persistence.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflowProjectPaths } from "./workflow-paths.js";

/** Max log entries retained in memory (a ring buffer; persisted logs are not capped). */
const DEFAULT_MAX_LOG_ENTRIES = 1000;

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
  const runId = options.runId ?? `run-${Date.now()}`;
  const runsDir = workflowProjectPaths(cwd).runsDir;
  let logFile: string | null = null;

  const write = (level: string, message: string) => {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${level}] ${message}`;
    // Ring buffer: drop the oldest entry once the cap is hit, so the array
    // (and every getLogs() copy) stays bounded however long the run lives.
    if (logs.length >= maxEntries) logs.shift();
    logs.push(entry);
    try {
      options.onLog?.(message);
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
