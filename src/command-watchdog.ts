/**
 * Command watchdog (I1 — idle-detector design-final.json §commandWatchdog).
 *
 * A BashOperations wrapper around the SDK's local shell backend that kills a
 * command when it stops producing output for `idleTimeoutMs` and enforces a
 * run-level hard timeout, while preserving the partial output and returning
 * the SDK's killed shape ({ exitCode: null }).
 *
 * Why this shape:
 *  - The SDK bash tool calls `operations.exec(command, cwd, { onData, signal,
 *    timeout, env })` (bash.js:226) and renders tool results from the resolved
 *    { exitCode } — a null exitCode is treated as SUCCESS (bash.js:349-352),
 *    so the killed command's partial output + kill marker reach the SAME
 *    agent session as a normal tool result and the model decides next steps.
 *  - The inner (createLocalBashOperations) listens to exactly ONE signal:
 *    pre-check + addEventListener('abort', onAbort → killProcessTree)
 *    (bash.js:82/98-102). We therefore forward a COMPOSITE signal
 *    (AbortSignal.any([toolSignal, ownController.signal])) so the session
 *    abort path STILL kills the tree through the wrapper, and the wrapper can
 *    distinguish the idle kill (own controller fired) from a session abort
 *    (tool signal fired) with no ambiguity.
 *
 * Knob defaults are conservative: 0 ms = disabled → thin passthrough
 * (byte-identical to the bare inner). The module never creates timers or
 * controllers when both knobs are 0.
 *
 * Determinism: the kill marker renders the CONFIGURED thresholds only
 * (idleTimeoutMs/hardTimeoutMs — fixed given config). Measured wall-clock
 * (idleMs) is passed ONLY to onCommandKill for host-side logs — never into
 * transcripts or any resume hash.
 */

import {
  type BashOperations,
  createBashToolDefinition,
  createLocalBashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** Default number of consecutive idle kills within one attempt before the run-level watcher escalates. */
// I1 DC-8: kept in tandem with the config.ts copy (the CONTRACT surface).
// The config copy must stay the owner because config.ts cannot value-import
// this module without violating the headless pi-tui-free guarantee; tests
// import THIS copy directly (tests/command-watchdog.test.ts:22).
export const DEFAULT_MAX_CONSECUTIVE_IDLE_KILLS = 3;

/**
 * Options for {@link createWatchdogBashOperations} and the toolset injection.
 * All values are CONFIGURED (never measured wall-clock) so the kill marker
 * stays deterministic given the resolved knobs.
 */
export interface CommandWatchdogOptions {
  /** Kill a command that emits no onData bytes for this many ms. 0 = disabled. */
  idleTimeoutMs: number;
  /**
   * Run-level default bash timeout in ms, forwarded to the inner as seconds
   * when the model passes no explicit `timeout` (the model's timeout ALWAYS
   * wins). 0 = disabled. Clamped to the SDK ceiling at knob resolution.
   */
  hardTimeoutMs: number;
  /**
   * Consecutive idle kills within one attempt before `onCommandKill` reports
   * reason "idle-escalated" and {@link CommandActivityRegistry.isStalling}
   * flips. Default {@link DEFAULT_MAX_CONSECUTIVE_IDLE_KILLS}.
   */
  maxConsecutiveIdleKills?: number;
  /** Registry for run-level forensics; defaults to the shared module instance. */
  registry?: CommandActivityRegistry;
  /**
   * Per-execution registry label. A string is used verbatim; a function is
   * resolved per exec (so a run can bind its agent call label lazily). Default:
   * the command text.
   */
  label?: string | (() => string | undefined);
  /** Fired once per exec when the watchdog starts watching the command. */
  onCommandStart?: (info: { command: string; cwd: string }) => void;
  /**
   * Fired when the watchdog kills a command. `idleMs` is measured wall-clock
   * (diagnostic only — never a transcript/hash input); `consecutiveKills` is
   * the running count for this label.
   */
  onCommandKill?: (info: {
    command: string;
    reason: "idle" | "idle-escalated" | "hard-timeout";
    idleMs?: number;
    consecutiveKills?: number;
  }) => void;
}

/** One command's activity window, keyed by execution label. */
interface CommandActivityEntry {
  command: string;
  cwd: string;
  startedAtMs: number;
  lastDataAtMs: number;
  consecutiveIdleKills: number;
}

/**
 * Run-level command-activity forensics. Records start/data/kill timestamps
 * per execution label so the agent-idle watcher can enrich its stall logs
 * ("agent idle; last bash command observed: …") and detect a same-command
 * kill/rerun churn loop (isStalling). Diagnostic-only — never a transcript or
 * hash input. Host-side ephemeral (module-scoped), like lastActiveAtMs.
 */
export class CommandActivityRegistry {
  private readonly entries = new Map<string, CommandActivityEntry>();

  recordStart(label: string, command: string, cwd: string): void {
    // Preserve the consecutive-kill chain across execs of the SAME label so a
    // kill → rerun → kill blind-loop accumulates (the marker names the running
    // count). Reset happens at attempt start (resetAttempt) or on success.
    const prior = this.entries.get(label);
    this.entries.set(label, {
      command,
      cwd,
      startedAtMs: Date.now(),
      lastDataAtMs: Date.now(),
      consecutiveIdleKills: prior?.consecutiveIdleKills ?? 0,
    });
  }

  recordData(label: string): void {
    const entry = this.entries.get(label);
    if (entry) entry.lastDataAtMs = Date.now();
  }

  /** Increment the label's consecutive idle-kill counter; returns the new count. */
  recordIdleKill(label: string): number {
    const entry = this.entries.get(label);
    const next = (entry?.consecutiveIdleKills ?? 0) + 1;
    if (entry) entry.consecutiveIdleKills = next;
    else this.entries.set(label, { command: "", cwd: "", startedAtMs: 0, lastDataAtMs: 0, consecutiveIdleKills: next });
    return next;
  }

  /** A successful (non-killed) completion breaks the consecutive-kill chain. */
  recordSuccess(label: string): void {
    const entry = this.entries.get(label);
    if (entry) entry.consecutiveIdleKills = 0;
  }

  /** Explicit per-attempt reset (run-level watcher calls this at attempt start). */
  resetAttempt(label: string): void {
    const entry = this.entries.get(label);
    if (entry) entry.consecutiveIdleKills = 0;
  }

  /** Whether the label has been idle-killed `max` times in a row. */
  isStalling(label: string, max: number = DEFAULT_MAX_CONSECUTIVE_IDLE_KILLS): boolean {
    return (this.entries.get(label)?.consecutiveIdleKills ?? 0) >= max;
  }

  getEntry(label: string): CommandActivityEntry | undefined {
    return this.entries.get(label);
  }

  /** All recorded activity windows (run-level forensics). */
  snapshot(): ReadonlyMap<string, CommandActivityEntry> {
    return this.entries;
  }
}

/** Shared module instance used by default (host-side ephemeral, like lastActiveAtMs). */
let defaultRegistry: CommandActivityRegistry | undefined;
export function getCommandWatchdogRegistry(): CommandActivityRegistry {
  defaultRegistry ??= new CommandActivityRegistry();
  return defaultRegistry;
}

/**
 * Deterministic kill marker. Renders CONFIGURED thresholds only:
 * `[killed: idle 120s — no output within the watchdog budget; process tree
 * aborted]`, and after the first kill in one attempt also names the running
 * consecutive-kill count and the configured knobs so the model can
 * self-correct instead of blind-looping:
 * `… (kill #2 this attempt; knobs: commandIdleTimeoutMs=120000, commandHardTimeoutMs=0)`.
 */
export function buildWatchdogKillMarker(
  idleTimeoutMs: number,
  hardTimeoutMs: number,
  consecutiveKills: number,
): string {
  const base = `[killed: idle ${idleTimeoutMs / 1000}s — no output within the watchdog budget; process tree aborted`;
  if (consecutiveKills <= 1) return `${base}]`;
  return `${base} (kill #${consecutiveKills} this attempt; knobs: commandIdleTimeoutMs=${idleTimeoutMs}, commandHardTimeoutMs=${hardTimeoutMs})]`;
}

/**
 * Wrap any BashOperations backend with the command watchdog. `inner` is
 * normally `createLocalBashOperations()`; passing a different backend keeps
 * the interception composeable (SSH/gateway remotes etc.).
 *
 * Behavior per exec:
 *  - effectiveTimeout = model timeout (seconds) ?? hardTimeoutMs/1000; the
 *    model's explicit timeout ALWAYS wins over the run-level default.
 *  - A composite AbortSignal (tool signal + private controller) is forwarded
 *    so the session-abort path still tree-kills through the wrapper.
 *  - An idle deadline is armed and reset on every onData byte; if no bytes
 *    arrive for idleTimeoutMs the private controller fires → inner kills the
 *    tree → inner rejects → we append the marker and resolve { exitCode: null }.
 *  - Three-way error routing (watchdog-error-routing): a tool-signal abort is
 *    rethrown verbatim (SDK renders "Command aborted"); every non-own error —
 *    including the inner's `timeout:` rejection — is rethrown unchanged (SDK
 *    renders "Command timed out after N seconds"); only an own-controller
 *    abort becomes the { exitCode: null } + marker kill.
 *
 * All knobs 0 → thin passthrough (no timers, no controller).
 */
export function createWatchdogBashOperations(inner: BashOperations, options: CommandWatchdogOptions): BashOperations {
  const maxKills = options.maxConsecutiveIdleKills ?? DEFAULT_MAX_CONSECUTIVE_IDLE_KILLS;
  return {
    async exec(command, cwd, execOptions) {
      const { onData, signal, timeout, env } = execOptions;
      const effectiveTimeout = timeout ?? (options.hardTimeoutMs > 0 ? options.hardTimeoutMs / 1000 : undefined);
      const ownController = new AbortController();
      const composite = signal ? AbortSignal.any([signal, ownController.signal]) : ownController.signal;
      const label = typeof options.label === "function" ? (options.label() ?? command) : (options.label ?? command);
      const registry = options.registry ?? getCommandWatchdogRegistry();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let lastDataAtMs = Date.now();

      const clearIdle = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
      };
      const armIdle = () => {
        clearIdle();
        if (options.idleTimeoutMs <= 0) return;
        idleTimer = setTimeout(() => {
          idleTimer = undefined;
          if (!ownController.signal.aborted) ownController.abort();
        }, options.idleTimeoutMs);
      };

      registry.recordStart(label, command, cwd);
      options.onCommandStart?.({ command, cwd });
      armIdle();
      try {
        const result = await inner.exec(command, cwd, {
          onData: (data) => {
            lastDataAtMs = Date.now();
            registry.recordData(label);
            onData(data);
            // Every byte resets the idle deadline: never kill while output flows.
            armIdle();
          },
          signal: composite,
          timeout: effectiveTimeout,
          env,
        });
        registry.recordSuccess(label);
        return result;
      } catch (error) {
        // Three-way routing (watchdog-error-routing / V2).
        if (signal?.aborted) {
          // (1) session/tool abort → SDK renders "Command aborted".
          throw error;
        }
        if (!ownController.signal.aborted) {
          // (2) any non-own error (model timeout, missing cwd, spawn failure)
          // → SDK renders the standard error text unchanged.
          throw error;
        }
        // (3) own idle kill: preserve partial output + deterministic marker,
        // return the SDK's killed shape ({ exitCode: null } = success).
        const consecutiveKills = registry.recordIdleKill(label);
        const reason = consecutiveKills >= maxKills ? "idle-escalated" : "idle";
        const marker = buildWatchdogKillMarker(options.idleTimeoutMs, options.hardTimeoutMs, consecutiveKills);
        onData(Buffer.from(`\n\n${marker}`, "utf8"));
        options.onCommandKill?.({ command, reason, idleMs: Date.now() - lastDataAtMs, consecutiveKills });
        return { exitCode: null };
      } finally {
        clearIdle();
        // Release the composite listener; the tool signal listener is the
        // caller's (the SDK removes its own in its finally).
        ownController.abort();
      }
    },
  };
}

/**
 * The toolset-assembly injection (bash-injection / I1): swap every HOST-ORIGIN
 * bash-named def's `execute` with a watchdog-wrapped one via
 * `createBashToolDefinition(cwd, { operations: wrappedLocalOps }).execute`;
 * the spread keeps the SDK schema/description/promptSnippet/renderCall/
 * renderState intact (no defineTool shadow). When the knobs are both 0 the
 * toolset is returned unchanged (byte-identical).
 *
 * Callers scope the input to HOST-ORIGIN defs (the assembler wraps only the
 * host bundle; builtinToolsetTools wraps only the coding/read-only subset; the
 * agent runner wraps its own createCodingTools defaults) so a third-party/MCP
 * def named "bash" is NEVER rebound to the local backend.
 *
 * Notes (documented in design-final.json bash-injection): enabling the knobs
 * rebinds a host-origin 'bash' def to the watchdog-wrapped local backend —
 * SDK description/parameters/render preserved; a caller-supplied bash def's
 * spawnHook/commandPrefix/exposeSessionEnvironment are dropped by the rebuild
 * (nil in-repo today — all subagent bash defs come from createCodingTools
 * defaults).
 */
export function applyCommandWatchdogToTools(
  tools: readonly ToolDefinition[],
  cwd: string,
  options: CommandWatchdogOptions | undefined,
): ToolDefinition[] {
  if (!options || (options.idleTimeoutMs <= 0 && options.hardTimeoutMs <= 0)) return [...tools];
  const wrappedOps = createWatchdogBashOperations(createLocalBashOperations(), options);
  const replacementExecute = createBashToolDefinition(cwd, { operations: wrappedOps }).execute;
  return tools.map((def) => (def.name === "bash" ? { ...def, execute: replacementExecute } : def));
}
