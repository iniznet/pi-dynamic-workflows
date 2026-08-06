/**
 * Faithful file-side syntax/contract check for a workflow script.
 *
 * The workflow tool reads scripts via `scriptPath`; this script validates a
 * file the same way the tool will (parseWorkflowScript — acorn with top-level
 * await/return allowed, determinism blocklist, `export const meta` first, meta
 * name/description/phases shape). Plain `node --check` is NOT a faithful
 * substitute: top-level `return` is legal inside the workflow vm sandbox but a
 * hard syntax error in plain ESM, so node would reject valid scripts.
 *
 * Usage: npx tsx scripts/check-workflow-script.ts <path-to-script>
 * Exit 0 = valid (prints the meta); exit 1 = invalid (prints the reason).
 */
import { readFileSync } from "node:fs";
import { parseWorkflowScript } from "../src/workflow.js";

const path = process.argv[2];
if (!path) {
  console.error("Usage: npx tsx scripts/check-workflow-script.ts <path-to-script>");
  process.exit(2);
}

let source: string;
try {
  source = readFileSync(path, "utf8");
} catch (error) {
  console.error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

try {
  const { meta } = parseWorkflowScript(source);
  const phases = meta.phases?.map((p) => p.title).join(", ") ?? "(none)";
  console.log(`OK ${path} — workflow "${meta.name}": ${meta.description} (phases: ${phases})`);
} catch (error) {
  console.error(`INVALID ${path}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
