import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import packageJson from "../package.json" with { type: "json" };
import {
  checkWorkflowContextMeasurement,
  measureWorkflowContextSurfaces,
  renderWorkflowContextMeasurement,
  WORKFLOW_CONTEXT_MEASUREMENT_PATH,
} from "../src/workflow-context-measurement.js";
import { createWorkflowTool } from "../src/workflow-tool.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const ROOT = join(import.meta.dirname, "..");

test("workflow context measurement reports Pi-rendered prompt and provider tool definition separately", async () => {
  const artifact = measureWorkflowContextSurfaces(ROOT);
  assert.deepEqual(JSON.parse(renderWorkflowContextMeasurement()), artifact);

  assert.equal(artifact.formatVersion, 3);
  assert.equal(artifact.encoding, "utf8");
  assert.deepEqual(artifact.sources, ["src/workflow-tool.ts", "skills/workflow-authoring", "package.json#pi.skills"]);
  assert.equal(artifact.surfaces.permanentWorkflowPrompt.serialization, "UTF-8 bytes of LF-joined Pi prompt lines");
  assert.equal(
    artifact.surfaces.providerVisibleWorkflowToolDefinition.serialization,
    "UTF-8 bytes of JSON.stringify({ name, description, parameters })",
  );
  // Every skill in package.json's pi.skills contributes to the always-on
  // discovery tally — not just workflow-authoring — so adding a new skill
  // can't silently go untracked (see the workflow-patterns skill).
  assert.match(artifact.surfaces.registeredSkillsDiscovery.serialization, /pi\.skills/i);
  assert.ok(artifact.surfaces.registeredSkillsDiscovery.bytes > 0);
  assert.deepEqual(
    artifact.surfaces.registeredSkillsDiscovery.skills.map(({ root }) => root).sort(),
    [...packageJson.pi.skills].sort(),
  );
  assert.equal(
    artifact.surfaces.registeredSkillsDiscovery.bytes,
    artifact.surfaces.registeredSkillsDiscovery.skills.reduce((sum, skill) => sum + skill.bytes, 0),
    "the total must be the exact sum of each registered skill's own discovery bytes",
  );
  for (const skill of artifact.surfaces.registeredSkillsDiscovery.skills) {
    assert.ok(skill.bytes > 0, `${skill.root} should report a positive discovery byte count`);
  }
  assert.equal(artifact.surfaces.workflowAuthoringSkillCorpus.files, 29);
  assert.ok(artifact.surfaces.workflowAuthoringSkillCorpus.bytes > 0);
  assert.equal(artifact.surfaces.representativeAuthoringProfiles.profiles.length, 6);
  assert.deepEqual(
    artifact.surfaces.representativeAuthoringProfiles.profiles.map(({ name }) => name),
    ["write", "edit", "review", "debug", "loop", "retry"],
  );
  for (const profile of artifact.surfaces.representativeAuthoringProfiles.profiles) {
    const expected = profile.files.reduce(
      (sum, path) => sum + Buffer.byteLength(readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n")),
      0,
    );
    assert.equal(profile.bytes, expected, `${profile.name} profile must sum its LF-normalized files`);
  }
  const profileBytes = artifact.surfaces.representativeAuthoringProfiles.profiles
    .map(({ bytes }) => bytes)
    .sort((a, b) => a - b);
  assert.equal(artifact.surfaces.representativeAuthoringProfiles.medianBytes, (profileBytes[2] + profileBytes[3]) / 2);

  await withRenderedWorkflow(async ({ systemPrompt, promptLines, wrappedWorkflow }) => {
    const expectedLines = new Set(promptLines);
    const renderedLines = systemPrompt.split("\n").filter((line) => expectedLines.has(line));
    assert.deepEqual(renderedLines, promptLines, "Pi should render each workflow prompt line exactly once");

    const providerDefinition = JSON.stringify({
      name: wrappedWorkflow.name,
      description: wrappedWorkflow.description,
      parameters: wrappedWorkflow.parameters,
    });
    assert.equal(artifact.surfaces.permanentWorkflowPrompt.bytes, Buffer.byteLength(renderedLines.join("\n"), "utf8"));
    assert.equal(
      artifact.surfaces.providerVisibleWorkflowToolDefinition.bytes,
      Buffer.byteLength(providerDefinition, "utf8"),
    );
  });
});

test("workflow context measurement generation is deterministic and committed artifact is fresh", () => {
  const first = renderWorkflowContextMeasurement();
  const second = renderWorkflowContextMeasurement();

  assert.equal(first, second);
  // Line-ending normalization keeps the committed artifact comparison identical
  // on CRLF (Windows) and LF (CI) checkouts.
  assert.equal(readFileSync(join(ROOT, WORKFLOW_CONTEXT_MEASUREMENT_PATH), "utf8").replace(/\r\n/g, "\n"), first);
  assert.equal(checkWorkflowContextMeasurement(ROOT), true);
  assert.equal(checkWorkflowContextMeasurement(ROOT, `${first}stale`), false);
  assert.equal(packageJson.scripts["context:check"], "tsx scripts/generate-workflow-context-measurement.ts --check");
  assert.match(packageJson.scripts.test, /release:check/);
  assert.match(packageJson.scripts["release:check"], /context:check/);
});

test("workflow context byte counts are LF-basis and count corpus files once", () => {
  const artifact = measureWorkflowContextSurfaces(ROOT);
  const corpusFiles = artifact.surfaces.workflowAuthoringSkillCorpus;
  assert.equal(corpusFiles.files, 29);
  const corpusPaths = readdirRecursive(ROOT, "skills/workflow-authoring");
  const lfCorpusBytes = corpusPaths.reduce(
    (sum, path) => sum + Buffer.byteLength(readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n")),
    0,
  );
  assert.equal(corpusFiles.bytes, lfCorpusBytes, "corpus bytes must count LF-normalized file content");
  const rawDiskBytes = corpusPaths.reduce((sum, path) => sum + Buffer.byteLength(readFileSync(join(ROOT, path))), 0);
  // In LF-only checkouts (e.g. CI with core.autocrlf=false) the raw disk bytes
  // already match the LF-normalized count, so this distinguishing assertion only
  // holds where any corpus file actually carries CRLF line endings.
  const anyCorpusHasCrlf = corpusPaths.some((path) => readFileSync(join(ROOT, path)).includes("\r\n"));
  if (anyCorpusHasCrlf) {
    assert.notEqual(
      corpusFiles.bytes,
      rawDiskBytes,
      "raw disk bytes (CRLF on Windows checkouts) must not equal the LF-basis count",
    );
  } else {
    assert.equal(
      corpusFiles.bytes,
      rawDiskBytes,
      "LF-only checkouts must report identical raw and normalized corpus bytes",
    );
  }
});

test("context freshness command prints both current byte counts", () => {
  const output = runNpm(["run", "context:check"]);

  assert.match(output, /Permanent workflow prompt: \d+ bytes/);
  assert.match(output, /Provider-visible workflow tool definition: \d+ bytes/);
  assert.match(output, /Registered skills discovery \(all \d+\): \d+ bytes/);
  assert.match(output, /- skills\/workflow-authoring: \d+ bytes/);
  assert.match(output, /- skills\/workflow-patterns: \d+ bytes/);
  assert.match(output, /Workflow-authoring skill corpus: \d+ bytes across \d+ files/);
  assert.match(output, /Representative authoring profile median: \d+(?:\.5)? bytes/);
  assert.match(output, /measurement is fresh/i);
});

/** Invoke npm portably: Windows requires cmd.exe /c for the npm.cmd shim. */
function runNpm(args: string[]): string {
  if (process.platform === "win32") {
    return execFileSync("cmd.exe", ["/d", "/s", "/c", "npm", ...args], { cwd: ROOT, encoding: "utf8" });
  }
  return execFileSync("npm", args, { cwd: ROOT, encoding: "utf8" });
}

/** Package-relative file list under a root directory (sorted, forward slashes). */
function readdirRecursive(root: string, relativeRoot: string): string[] {
  const pending: Array<{ absolute: string; relative: string }> = [
    { absolute: join(root, relativeRoot), relative: relativeRoot },
  ];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    for (const entry of readdirSync(current.absolute, { withFileTypes: true })) {
      const absolute = join(current.absolute, entry.name);
      const relative = join(current.relative, entry.name);
      if (entry.isDirectory()) pending.push({ absolute, relative });
      else if (entry.isFile()) files.push(relative.replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

async function withRenderedWorkflow(
  inspect: (surface: {
    systemPrompt: string;
    promptLines: string[];
    wrappedWorkflow: { name: string; description: string; parameters: unknown };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "workflow-context-measurement-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.PI_CODING_AGENT_DIR = root;
    await withFakeHomeAsync(root, async () => {
      const workflow = createWorkflowTool({ cwd: root });
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        appendSystemPromptOverride: () => [],
      });
      await loader.reload();

      const { session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        tools: ["workflow"],
        customTools: [workflow],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(root),
        settingsManager: SettingsManager.inMemory(),
      });

      try {
        const wrappedWorkflow = session.agent.state.tools.find((tool) => tool.name === "workflow");
        assert.ok(wrappedWorkflow, "Pi should expose the wrapped workflow tool");
        await inspect({
          systemPrompt: session.agent.state.systemPrompt,
          promptLines: [
            `- workflow: ${workflow.promptSnippet}`,
            ...(workflow.promptGuidelines ?? []).map((guideline) => `- ${guideline}`),
          ],
          wrappedWorkflow,
        });
      } finally {
        session.dispose();
      }
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}
