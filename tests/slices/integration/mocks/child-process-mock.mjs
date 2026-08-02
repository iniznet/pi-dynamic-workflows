/**
 * Test double for `node:child_process` used by the M12 /code-review tests.
 *
 * A resolve hook in m12-code-review-timeout.test.ts redirects ONLY
 * src/builtin-commands.ts's `import { execFile }` here, so the module-level
 * `execFileAsync = promisify(execFile)` wraps this controllable function.
 *
 * The real child_process.execFile carries Node's `util.promisify.custom`
 * symbol (that is why `await promisify(execFile)(...)` resolves to a
 * `{ stdout, stderr }` object — plain promisify would resolve an array). The
 * double mirrors that symbol so the handler's `const { stdout } = await ...`
 * destructure sees the responder's stdout exactly like the real binary's.
 * Every call is recorded (command, args, options) and the per-test responder
 * drives the success and ETIMEDOUT/failure paths without spawning a process.
 */

const kCustomPromisifiedSymbol = Symbol.for("nodejs.util.promisify.custom");

/** Every execFile call made by builtin-commands, in order. */
export const calls = [];

/**
 * Per-test responder: `responder(cmd, args, options, callback)` where
 * `callback(error, stdout, stderr)` mirrors the real child_process contract.
 * When null, the mock throws a loud setup error instead of doing nothing.
 */
export let responder = null;

export function setResponder(next) {
  responder = next;
}

function recordAndRespond(cmd, args, options, callback) {
  calls.push({ cmd, args, options });
  if (!responder) {
    throw new Error("child-process-mock: no responder configured for this test");
  }
  responder(cmd, args, options, callback);
}

/** Direct (non-promisified) execFile contract — builtin-commands never uses this. */
export function execFile(cmd, args, options, callback) {
  recordAndRespond(cmd, args, options, callback);
}

/** The promisified contract builtin-commands actually consumes. */
execFile[kCustomPromisifiedSymbol] = function promisifiedExecFile(cmd, args, options) {
  return new Promise((resolve, reject) => {
    recordAndRespond(cmd, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
};

/** A Node-style ETIMEDOUT error, as the real child_process produces on timeout. */
export function etimedout(message) {
  const error = new Error(message);
  error.code = "ETIMEDOUT";
  return error;
}
