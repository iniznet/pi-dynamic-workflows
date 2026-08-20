/**
 * I1/I2 agent-label context — a DEPENDENCY-FREE module (imports nothing but
 * node:async_hooks) so the headless pi-tui-free guarantee holds: config.ts and
 * workflow.ts import this instead of command-watchdog.js (which imports the
 * SDK barrel, and pi-coding-agent pulls pi-tui at module scope).
 *
 * The workflow layer wraps every agentRunner.run in `agentLabelContext.run(label, …)`
 * (workflow.ts), and the command watchdog's per-exec label fn (bound in
 * resolveCommandWatchdogOptions) reads it — so the shared CommandActivityRegistry
 * records command idle-kills under the AGENT label and the run-level watcher's
 * `isStalling(agent.label)` bound actually fires in production (df-5). Falls
 * back to the command text outside a workflow agent run (direct embeds, tests).
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const agentLabelContext = new AsyncLocalStorage<string | undefined>();
