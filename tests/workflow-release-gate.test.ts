import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import packageJson from "../package.json" with { type: "json" };
import { WORKFLOW_AUTHORING_COVERAGE } from "../src/workflow-authoring-coverage.js";
import { CAPABILITY_DETAIL_PATH } from "../src/workflow-authoring-reference.js";
import { WORKFLOW_CAPABILITY_DEFINITION } from "../src/workflow-capability-contract.js";
import { checkWorkflowRelease, parseNpmPackFilePaths, runNpmPack } from "../src/workflow-release-gate.js";

const ROOT = join(import.meta.dirname, "..");

// `npm pack --dry-run --json` takes ~2–6s per spawn and the release-gate tests
// call publishableFiles() ~19 times (F-T5). Compute the pack output once at
// module scope; the tmp-tree tests inject their own file lists and never rely
// on re-spawning the real pack. The function keeps its signature so call sites
// stay byte-identical.
let publishableFilesMemo: string[] | undefined;

function publishableFiles(): string[] {
  publishableFilesMemo ??= runNpmPack({ cwd: ROOT });
  return publishableFilesMemo;
}

test("npm pack parsing keeps only valid publishable file paths", () => {
  assert.deepEqual(parseNpmPackFilePaths(JSON.stringify([{ files: [{ path: "README.md" }, {}, { path: 42 }] }])), [
    "README.md",
  ]);
  assert.deepEqual(parseNpmPackFilePaths(JSON.stringify({ files: [] })), []);
});

test("normal tests and publishing share the model-free release gate", () => {
  assert.match(packageJson.scripts.test, /release:check/);
  assert.match(packageJson.scripts.prepublishOnly, /release:check/);
  assert.match(packageJson.scripts["release:check"], /docs:check/);
  assert.match(packageJson.scripts["release:check"], /context:check/);
  assert.match(packageJson.scripts["release:check"], /test:unit/);
  assert.match(packageJson.scripts["release:check"], /release:verify/);
  assert.equal(packageJson.scripts["guidance:accept"], "tsx scripts/accept-workflow-guidance.ts");
  assert.doesNotMatch(packageJson.scripts["release:check"], /model|provider|comprehension/i);
});

test("release gate accepts the aligned contract, package, documentation, and measurements", () => {
  const diagnostics = checkWorkflowRelease({ root: ROOT, publishableFiles: publishableFiles() });

  assert.deepEqual(diagnostics, []);
});

test("release gate blocks runtime constraint disagreements", () => {
  const definition = structuredClone(WORKFLOW_CAPABILITY_DEFINITION);
  const tokenBudgetIndex = definition.capabilities.findIndex(({ label }) => label === "tokenBudget");
  const tokenBudget = definition.capabilities[tokenBudgetIndex];
  assert.ok(tokenBudget);
  const capabilities = [...definition.capabilities];
  capabilities[tokenBudgetIndex] = {
    ...tokenBudget,
    constraints: ["hard total-token budget with no overshoot"],
  };
  definition.capabilities = capabilities;

  const diagnostics = checkWorkflowRelease({ root: ROOT, definition, publishableFiles: publishableFiles() });

  assert.ok(
    diagnostics.some(
      ({ code, severity, subject }) =>
        code === "RUNTIME_CONSTRAINT_DISAGREEMENT" && severity === "error" && subject === "tokenBudget",
    ),
  );
});

test("release gate names incompatible versions and missing behavior evidence", () => {
  const definition = structuredClone(WORKFLOW_CAPABILITY_DEFINITION);
  definition.versions.content.version = "0.0.0";
  const capabilities = [...definition.capabilities];
  capabilities[0] = { ...capabilities[0], behaviorEvidence: [] };
  definition.capabilities = capabilities;

  const diagnostics = checkWorkflowRelease({
    root: ROOT,
    definition,
    extensionVersion: packageJson.version,
    skillVersion: "9.0.0",
    publishableFiles: publishableFiles(),
  });

  assert.ok(
    diagnostics.some(
      ({ code, subject, message }) =>
        code === "INCOMPATIBLE_VERSION" && subject === "contract content" && message.includes(packageJson.version),
    ),
  );
  assert.ok(diagnostics.some(({ code, subject }) => code === "INCOMPATIBLE_VERSION" && subject === "installed skill"));
  assert.ok(
    diagnostics.some(
      ({ code, subject }) => code === "MISSING_BEHAVIOR_EVIDENCE" && subject === "workflow.runtime.agent",
    ),
  );
});

test("release gate requires auditable coverage for every stable authoring surface", () => {
  const diagnostics = checkWorkflowRelease({
    root: ROOT,
    publishableFiles: publishableFiles(),
    authoringCoverage: [],
  });

  assert.ok(
    diagnostics.some(
      ({ code, severity, subject }) =>
        code === "MISSING_AUTHORING_COVERAGE" && severity === "error" && subject === "workflow.runtime.agent",
    ),
  );
  assert.ok(
    diagnostics.some(
      ({ code, subject }) => code === "MISSING_AUTHORING_COVERAGE" && subject === "workflow.pattern.tournament",
    ),
  );
});

test("release gate blocks drift in guidance frozen outside provider-backed comprehension", () => {
  const patternPath = "skills/workflow-authoring/references/pattern-selection.md";
  const patternSelection = readFileSync(new URL(`../${patternPath}`, import.meta.url), "utf8");
  const withoutTournament = patternSelection.replace(
    "| Pairwise comparison beats absolute scoring | Tournament | Let JavaScript run the bounded bracket and byes; agents compare one pair; ledger match failures | [Adapt](../examples/tournament.js) |",
    "",
  );
  assert.notEqual(withoutTournament, patternSelection);

  const diagnostics = checkWorkflowRelease({
    root: ROOT,
    publishableFiles: publishableFiles(),
    guidanceOverrides: { [patternPath]: withoutTournament },
  });

  const drift = diagnostics.find(
    ({ code, severity, subject }) =>
      code === "PROTECTED_GUIDANCE_DRIFT" && severity === "error" && subject === "workflow.pattern.tournament",
  );
  assert.ok(drift);
  assert.match(drift.message, /skills\/workflow-authoring\/references\/pattern-selection\.md/);
  assert.match(drift.message, /required text/i);
  assert.match(drift.message, /Restore.*accidental/i);
  assert.match(drift.message, /intentional.*coverage manifest.*behavioral\/provider evidence/is);
  assert.match(drift.message, /src\/workflow-authoring-coverage\.ts/);
  assert.match(drift.message, /CONTRIBUTING\.md#protected-workflow-authoring-guidance/);
});

test("release gate requires explicit acceptance for mixed guidance files with partial behavioral coverage", () => {
  const patternPath = "skills/workflow-authoring/references/pattern-selection.md";
  const patternSelection = readFileSync(new URL(`../${patternPath}`, import.meta.url), "utf8");
  const contradictory = `${patternSelection}\nTournament workflows should skip brackets and compare every candidate at once.\n`;

  const diagnostics = checkWorkflowRelease({
    root: ROOT,
    publishableFiles: publishableFiles(),
    guidanceOverrides: { [patternPath]: contradictory },
  });

  const drift = diagnostics.find(({ code, subject }) => code === "PROTECTED_GUIDANCE_DRIFT" && subject === patternPath);
  assert.ok(drift);
  assert.match(drift.message, /skills\/workflow-authoring\/references\/pattern-selection\.md/);
  assert.match(drift.message, /SHA-256.*explicit review checkpoint.*partial behavioral coverage/i);
  assert.match(drift.message, /Revert accidental changes/i);
  assert.match(drift.message, /intentional change.*npm run guidance:accept --.*pattern-selection\.md/is);
  assert.doesNotMatch(drift.message, /anti-overfitting|autoresearch|manually update/i);
  assert.match(drift.message, /WORKFLOW_AUTHORING_FROZEN_FILES/);
  assert.match(drift.message, /src\/workflow-authoring-coverage\.ts/);
  assert.match(drift.message, /CONTRIBUTING\.md#protected-workflow-authoring-guidance/);
});

test("release gate blocks deletion of routing to guidance-frozen capabilities", () => {
  const skillPath = "skills/workflow-authoring/SKILL.md";
  const skill = readFileSync(new URL(`../${skillPath}`, import.meta.url), "utf8");
  const withoutPatternRoute = skill.replace(
    "- **Write or edit:** start with [runtime](references/runtime.md). Add [pattern selection](references/pattern-selection.md) for topology, [lifecycle](references/lifecycle.md) for limits or resume, and [focused recipes](references/focused-recipes.md) for the matching concern.",
    "",
  );
  assert.notEqual(withoutPatternRoute, skill);

  const diagnostics = checkWorkflowRelease({
    root: ROOT,
    publishableFiles: publishableFiles(),
    guidanceOverrides: { [skillPath]: withoutPatternRoute },
  });

  assert.ok(
    diagnostics.some(
      ({ code, subject }) => code === "PROTECTED_GUIDANCE_DRIFT" && subject === "workflow.pattern.tournament",
    ),
  );
});

test("contributor docs explain the protected workflow-authoring guidance gate", () => {
  const contributing = readFileSync(new URL("../CONTRIBUTING.md", import.meta.url), "utf8");

  assert.match(contributing, /^## Protected workflow-authoring guidance$/m);
  assert.match(contributing, /keep.*guidance accurate.*runtime.*changes/is);
  assert.match(contributing, /detailed.*on-demand.*skill.*permanent.*prompt/is);
  assert.match(contributing, /context checks.*growing unnoticed/is);
  assert.match(contributing, /full-file SHA-256 hashes.*explicit review checkpoints/is);
  assert.match(contributing, /mixed or partially behavior-covered guidance/i);
  assert.match(contributing, /WORKFLOW_AUTHORING_FROZEN_FILES.*src\/workflow-authoring-coverage\.ts/is);
  assert.match(contributing, /housekeeping.*deterministic checks and review/is);
  assert.match(contributing, /semantic guidance change.*behavioral tests.*provider evidence when needed/is);
  assert.match(contributing, /required anchors.*required text.*deliberate updates/is);
  assert.match(contributing, /npm run guidance:accept --.*skills\/workflow-authoring/is);
  assert.match(contributing, /updates only explicitly named frozen files/is);
  assert.match(contributing, /guidance:generate.*does not update protected hashes/is);
  assert.doesNotMatch(contributing, /anti-overfitting|autoresearch/i);
  assert.match(contributing, /npm run docs:check/);
  assert.match(contributing, /npm run context:check/);
  assert.match(contributing, /npm run guidance:check/);
  assert.match(contributing, /npm run release:verify/);
});

test("repository instructions route agents to workflow guidance maintenance rules", () => {
  const agentInstructions = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

  assert.match(agentInstructions, /CONTRIBUTING\.md#protected-workflow-authoring-guidance/);
  assert.match(agentInstructions, /workflow runtime.*tool API.*workflow-authoring.*skill/is);
  assert.match(agentInstructions, /stable capability facts.*executable capability contract/is);
  assert.match(agentInstructions, /detailed authoring guidance.*on-demand skill.*always-on prompt/is);
  assert.match(agentInstructions, /npm run context:check/);
  assert.match(agentInstructions, /npm run guidance:accept -- <path>/);
});

test("release gate rejects unprotected guidance and invented comprehension coverage", () => {
  const authoringCoverage = structuredClone(WORKFLOW_AUTHORING_COVERAGE);
  const tournament = authoringCoverage.find(({ id }) => id === "workflow.pattern.tournament");
  const judgePanel = authoringCoverage.find(({ id }) => id === "workflow.runtime.judgePanel");
  assert.ok(tournament);
  assert.ok(judgePanel);
  tournament.protectedGuidance = [];
  judgePanel.comprehensionScenarios = ["not-a-real-scenario"];

  const diagnostics = checkWorkflowRelease({
    root: ROOT,
    publishableFiles: publishableFiles(),
    authoringCoverage,
  });

  assert.ok(
    diagnostics.some(({ code, subject }) => code === "UNPROTECTED_AUTHORING_GUIDANCE" && subject === tournament.id),
  );
  assert.ok(
    diagnostics.some(({ code, subject }) => code === "UNKNOWN_COMPREHENSION_SCENARIO" && subject === judgePanel.id),
  );
});

test("release gate names omitted package resources and stale generated surfaces", () => {
  const files = publishableFiles().filter((path) => path !== "skills/workflow-authoring/examples/tournament.js");
  const diagnostics = checkWorkflowRelease({
    root: ROOT,
    publishableFiles: files,
    publicationOverrides: { "README.md": "stale" },
    contextMeasurement: "stale",
    guidanceBaseline: "stale",
  });

  assert.ok(
    diagnostics.some(
      ({ code, subject }) =>
        code === "MISSING_PACKAGE_RESOURCE" && subject === "skills/workflow-authoring/examples/tournament.js",
    ),
  );
  assert.ok(diagnostics.some(({ code, subject }) => code === "STALE_GENERATED_SURFACE" && subject === "README.md"));
  assert.ok(
    diagnostics.some(
      ({ code, subject }) => code === "STALE_GENERATED_SURFACE" && subject === "docs/workflow-context-surfaces.json",
    ),
  );
  assert.ok(
    diagnostics.some(
      ({ code, severity, subject }) =>
        code === "NON_CONTRACTUAL_PROSE_DRIFT" &&
        severity === "error" &&
        subject === "docs/workflow-guidance-baseline.json",
    ),
  );
});

test("release gate reports unresolved behavior and reference paths precisely", () => {
  const definition = structuredClone(WORKFLOW_CAPABILITY_DEFINITION);
  const capabilities = [...definition.capabilities];
  capabilities[0] = {
    ...capabilities[0],
    behaviorEvidence: ["tests/does-not-exist.test.ts"],
    staticReference: { path: "skills/workflow-authoring/references/capabilities.md", anchor: "does-not-exist" },
  };
  definition.capabilities = capabilities;

  const diagnostics = checkWorkflowRelease({ root: ROOT, definition, publishableFiles: publishableFiles() });

  assert.ok(
    diagnostics.some(
      ({ code, subject }) => code === "UNRESOLVED_BEHAVIOR_EVIDENCE" && subject === "tests/does-not-exist.test.ts",
    ),
  );
  assert.ok(
    diagnostics.some(
      ({ code, subject }) =>
        code === "BROKEN_CONTRACT_REFERENCE" &&
        subject === "skills/workflow-authoring/references/capabilities.md#does-not-exist",
    ),
  );
});

test("release gate reports missing generated artifacts instead of crashing", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "workflow-release-missing-"));
  try {
    const diagnostics = checkWorkflowRelease({ root: tmpRoot, publishableFiles: [] });

    assert.ok(
      diagnostics.some(
        ({ code, severity, subject, message }) =>
          code === "STALE_GENERATED_SURFACE" &&
          severity === "error" &&
          subject === "docs/workflow-guidance-baseline.json" &&
          /missing/i.test(message),
      ),
    );
    assert.ok(
      diagnostics.some(
        ({ code, severity, subject, message }) =>
          code === "STALE_GENERATED_SURFACE" &&
          severity === "error" &&
          subject === "docs/workflow-context-surfaces.json" &&
          /missing/i.test(message),
      ),
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("release gate flags publishable skill resources and installed-skill version when the repository omits them", () => {
  // Exercises three defensive existsSync guards that the missing-baseline/context
  // test does not cover: validatePackage's listed-but-absent skill .md loop,
  // skillVersion's absent SKILL.md path, and checkWorkflowCapabilityPublications'
  // missing detail file. Each would silently disappear if refactored away.
  const tmpRoot = mkdtempSync(join(tmpdir(), "workflow-release-missing-skill-"));
  try {
    const phantomSkillMd = "skills/workflow-authoring/references/does-not-exist.md";
    const diagnostics = checkWorkflowRelease({
      root: tmpRoot,
      publishableFiles: [phantomSkillMd],
    });

    assert.ok(
      diagnostics.some(
        ({ code, severity, subject, message }) =>
          code === "MISSING_PACKAGE_RESOURCE" &&
          severity === "error" &&
          subject === phantomSkillMd &&
          /missing from the repository/i.test(message),
      ),
    );
    assert.ok(
      diagnostics.some(
        ({ code, severity, subject, message }) =>
          code === "INCOMPATIBLE_VERSION" &&
          severity === "error" &&
          subject === "installed skill" &&
          /<missing>/.test(message),
      ),
    );
    assert.ok(
      diagnostics.some(
        ({ code, severity, subject, message }) =>
          code === "STALE_GENERATED_SURFACE" &&
          severity === "error" &&
          subject === CAPABILITY_DETAIL_PATH &&
          /stale/i.test(message),
      ),
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("release gate flags frozen entries that claim comprehension coverage or unknown scenarios", () => {
  const authoringCoverage = structuredClone(WORKFLOW_AUTHORING_COVERAGE);
  const tournament = authoringCoverage.find(({ id }) => id === "workflow.pattern.tournament");
  const classifyAndAct = authoringCoverage.find(({ id }) => id === "workflow.pattern.classify-and-act");
  assert.ok(tournament);
  assert.ok(classifyAndAct);
  tournament.comprehensionScenarios = ["quick-write"];
  classifyAndAct.comprehensionScenarios = ["not-a-real-scenario"];

  const diagnostics = checkWorkflowRelease({
    root: ROOT,
    publishableFiles: publishableFiles(),
    authoringCoverage,
  });

  assert.ok(
    diagnostics.some(
      ({ code, subject, message }) =>
        code === "UNKNOWN_COMPREHENSION_SCENARIO" &&
        subject === "workflow.pattern.tournament" &&
        /frozen.*comprehension|comprehension.*frozen/i.test(message),
    ),
  );
  assert.ok(
    diagnostics.some(
      ({ code, subject }) =>
        code === "UNKNOWN_COMPREHENSION_SCENARIO" && subject === "workflow.pattern.classify-and-act",
    ),
  );
});

test("release gate guidance drift checks are LF-basis", () => {
  const patternPath = "skills/workflow-authoring/references/pattern-selection.md";
  const patternSelection = readFileSync(new URL(`../${patternPath}`, import.meta.url), "utf8");
  // CRLF round-trip of matching content must not create false drift…
  const crlfMatching = patternSelection.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const matching = checkWorkflowRelease({
    root: ROOT,
    publishableFiles: publishableFiles(),
    guidanceOverrides: { [patternPath]: crlfMatching },
  });
  assert.equal(
    matching.some(
      ({ code, severity, subject }) =>
        code === "PROTECTED_GUIDANCE_DRIFT" &&
        severity === "error" &&
        (subject === "workflow.pattern.tournament" || subject === patternPath),
    ),
    false,
    "CRLF-basis content must still satisfy the LF-normalized drift checks",
  );

  // …but removing the protected tournament row is real drift regardless of basis.
  const withoutTournament = patternSelection.replace(
    "| Pairwise comparison beats absolute scoring | Tournament | Let JavaScript run the bounded bracket and byes; agents compare one pair; ledger match failures | [Adapt](../examples/tournament.js) |",
    "",
  );
  const crlfDrifted = withoutTournament.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const drifted = checkWorkflowRelease({
    root: ROOT,
    publishableFiles: publishableFiles(),
    guidanceOverrides: { [patternPath]: crlfDrifted },
  });
  assert.ok(
    drifted.some(
      ({ code, severity, subject }) =>
        code === "PROTECTED_GUIDANCE_DRIFT" && severity === "error" && subject === "workflow.pattern.tournament",
    ),
    "removing the protected tournament row must still be caught on CRLF-basis overrides",
  );
});

test("prose drift in the guidance baseline is a hard error", () => {
  const diagnostics = checkWorkflowRelease({
    root: ROOT,
    publishableFiles: publishableFiles(),
    guidanceBaseline: "stale",
  });
  const prose = diagnostics.find(
    ({ code, subject }) => code === "NON_CONTRACTUAL_PROSE_DRIFT" && subject === "docs/workflow-guidance-baseline.json",
  );
  assert.ok(prose);
  assert.equal(prose.severity, "error");
});
