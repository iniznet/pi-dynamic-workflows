import { resolve } from "node:path";
import { acceptWorkflowGuidance } from "../src/accept-workflow-guidance.js";
import { WORKFLOW_AUTHORING_FROZEN_FILES } from "../src/workflow-authoring-coverage.js";
import { writeWorkflowContextMeasurement } from "../src/workflow-context-measurement.js";
import { writeWorkflowGuidanceBaseline } from "../src/workflow-release-gate.js";

const root = resolve(import.meta.dirname, "..");

/**
 * One-command atomic drift repair for the model-free workflow authoring gates:
 * refreshes the context measurement (context:generate), the guidance prose
 * baseline (guidance:generate), and re-accepts every frozen guidance file
 * (guidance:accept) in a single deterministic pass. All three artifacts are
 * generated on the same LF basis, so they never disagree about line endings.
 *
 * The `guidance:repair` npm script wires this entry point.
 */
writeWorkflowContextMeasurement(root);
writeWorkflowGuidanceBaseline(root);
const accepted = acceptWorkflowGuidance(
  root,
  WORKFLOW_AUTHORING_FROZEN_FILES.map(({ path }) => path),
);
for (const { path, previousSha256, sha256, changed } of accepted) {
  console.log(changed ? `Accepted ${path}: ${previousSha256} -> ${sha256}` : `Already accepted ${path}: ${sha256}`);
}
console.log(
  "Repaired workflow guidance: refreshed docs/workflow-context-surfaces.json and docs/workflow-guidance-baseline.json, re-accepted all frozen guidance files.",
);
