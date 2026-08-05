/**
 * Type declarations for the M12 child_process test double
 * (child-process-mock.mjs). Mirrors only the surface the /code-review
 * timeout tests consume: the promisified execFile contract plus call
 * recording and the per-test responder.
 */

export type ExecFileCallback = (error: Error | null, stdout?: string, stderr?: string) => void;

export interface MockExecCall {
  cmd: string;
  args: string[];
  options: Record<string, unknown>;
}

export type MockResponder = (
  cmd: string,
  args: string[],
  options: Record<string, unknown>,
  callback: ExecFileCallback,
) => void;

/** Every execFile call made by builtin-commands, in order. */
export const calls: MockExecCall[];

/** Per-test responder; null means the mock throws a loud setup error. */
export let responder: MockResponder | null;

export function setResponder(next: MockResponder | null): void;

/** A Node-style ETIMEDOUT error, as the real child_process produces on timeout. */
export function etimedout(message: string): Error & { code: string };
