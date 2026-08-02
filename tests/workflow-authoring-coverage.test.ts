import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CapabilitySupport, DiscoveryPlacement, WorkflowAuthoringProtection } from "../src/enums.js";
import {
  readLf,
  WORKFLOW_AUTHORING_COVERAGE,
  WORKFLOW_AUTHORING_FROZEN_FILES,
  WORKFLOW_AUTHORING_PATTERN_IDS,
  WORKFLOW_AUTHORING_RECIPE_IDS,
  WORKFLOW_COMPREHENSION_SCENARIO_IDS,
} from "../src/workflow-authoring-coverage.js";
import { WORKFLOW_CAPABILITY_DEFINITION } from "../src/workflow-capability-contract.js";

const ROOT = join(import.meta.dirname, "..");

test("authoring coverage inventories every stable contract, pattern, and recipe exactly once", () => {
  const expectedIds = [
    ...WORKFLOW_CAPABILITY_DEFINITION.capabilities
      .filter(
        ({ discovery, support }) => discovery !== DiscoveryPlacement.NONE && support !== CapabilitySupport.INTERNAL,
      )
      .map(({ id }) => id),
    ...WORKFLOW_AUTHORING_PATTERN_IDS,
    ...WORKFLOW_AUTHORING_RECIPE_IDS,
  ];
  const observedIds = WORKFLOW_AUTHORING_COVERAGE.map(({ id }) => id);

  assert.equal(new Set(observedIds).size, observedIds.length);
  assert.deepEqual(new Set(observedIds), new Set(expectedIds));
});

test("covered entries resolve real scenarios and uncovered entries freeze installed guidance", () => {
  const knownScenarios = new Set(WORKFLOW_COMPREHENSION_SCENARIO_IDS);
  for (const entry of WORKFLOW_AUTHORING_COVERAGE) {
    assert.equal(existsSync(`${ROOT}/${entry.reference.path}`), true, entry.id);
    assert.equal(
      entry.behaviorEvidence.every((path) => existsSync(`${ROOT}/${path}`)),
      true,
      entry.id,
    );
    if (entry.example) assert.equal(existsSync(`${ROOT}/${entry.example}`), true, entry.id);

    if (entry.protection === WorkflowAuthoringProtection.BEHAVIORALLY_COVERED) {
      assert.ok(entry.comprehensionScenarios.length > 0, entry.id);
      assert.equal(
        entry.comprehensionScenarios.every((id) => knownScenarios.has(id)),
        true,
        entry.id,
      );
    } else {
      assert.deepEqual(entry.comprehensionScenarios, [], entry.id);
      assert.ok(entry.protectedGuidance.length > 0, entry.id);
    }
  }
});

test("only the three agreed coverage scenarios unfreeze their named abilities", () => {
  const scenariosById = new Map(
    WORKFLOW_AUTHORING_COVERAGE.map(({ id, comprehensionScenarios }) => [id, comprehensionScenarios]),
  );

  assert.deepEqual(scenariosById.get("workflow.pattern.fan-out-and-synthesize"), ["coverage-fan-out-synthesize"]);
  assert.deepEqual(scenariosById.get("workflow.pattern.generate-and-filter"), ["coverage-generate-filter"]);
  assert.deepEqual(scenariosById.get("workflow.runtime.judgePanel"), ["coverage-judge-panel"]);
  assert.deepEqual(scenariosById.get("workflow.pattern.classify-and-act"), []);
  assert.deepEqual(scenariosById.get("workflow.pattern.tournament"), []);
  assert.deepEqual(scenariosById.get("workflow.runtime.completenessCheck"), []);
});

test("frozen guidance manifest hashes are LF-basis and reject CRLF raw bytes", () => {
  for (const { path, sha256 } of WORKFLOW_AUTHORING_FROZEN_FILES) {
    const lfSource = readLf(`${ROOT}/${path}`);
    assert.equal(createHash("sha256").update(lfSource).digest("hex"), sha256, path);
    const crlfSource = lfSource.replace(/\n/g, "\r\n");
    assert.notEqual(
      createHash("sha256").update(crlfSource).digest("hex"),
      sha256,
      `${path} raw CRLF bytes must not satisfy the LF-basis manifest hash`,
    );
  }
});
