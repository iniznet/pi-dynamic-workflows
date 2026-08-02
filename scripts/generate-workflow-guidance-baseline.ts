import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  renderWorkflowGuidanceBaseline,
  WORKFLOW_GUIDANCE_BASELINE_PATH,
  writeWorkflowGuidanceBaseline,
} from "../src/workflow-release-gate.js";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");

if (check) {
  const absolute = resolve(root, WORKFLOW_GUIDANCE_BASELINE_PATH);
  if (!existsSync(absolute)) {
    console.error(`Missing workflow guidance baseline: ${WORKFLOW_GUIDANCE_BASELINE_PATH}`);
    process.exitCode = 1;
  } else if (
    readFileSync(absolute, "utf8").replace(/\r\n/g, "\n") !== renderWorkflowGuidanceBaseline(root)
  ) {
    console.error(`Non-contractual workflow prose drift: ${WORKFLOW_GUIDANCE_BASELINE_PATH}`);
    process.exitCode = 1;
  } else {
    console.log("Workflow guidance prose baseline is unchanged.");
  }
} else {
  writeWorkflowGuidanceBaseline(root);
  console.log(`Generated ${WORKFLOW_GUIDANCE_BASELINE_PATH}.`);
}
