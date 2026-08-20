/**
 * Cross-run task knowledge layer (V2-P02) + lineage query & evidence
 * freshness/decay (V2-P04).
 *
 * V2-P02: at run completion, the workflow manager distills the run's
 * findings/decisions/constraints into structured durable KB entries under
 * `getAgentDir()/task-knowledge/<projectKey>.json` (a DurableStore-backed,
 * project-scoped knowledge base shared by every run of the project). A
 * `recall` runtime global then ranks prior knowledge (KB entries + run-report
 * artifacts) into context a future run can seed from — opt-in via the run's
 * `seedKnowledge` option (default OFF), which registers the recalled context
 * as a shared ctx() blob so agent instructions carry it under FRESH resume
 * hashes (the blob text folds into the shared-context fingerprint; a KB
 * change invalidates stale cached replays instead of replaying identity).
 *
 * Privacy gate: distillation NEVER includes agent results, thinking, tool
 * output, or raw logs. It carries structured metadata (run summary, phase/
 * agent labels, models, outcomes, spend, approvals, budgets, truncation
 * counts) plus machine-gate ledger `detail` payloads (claim text + cited
 * URLs + evidence hashes, testGate verdicts, spec-conformance scores) — the
 * same surface the run report already publishes.
 *
 * V2-P04: `queryLineage` reads the project's cross-run provenance ledger
 * (the shared durable-store file) + report artifacts, filters entries by
 * run/source/file/phase/agent/pattern, and applies a DETERMINISTIC decay
 * policy: ledger timestamps come from the durable-store's deterministic
 * clock (BASE_EPOCH_MS + write seq), so "age" is measured in write-sequence
 * units, never the wall clock. Stale claim-verify evidence can be re-verified
 * (`verify: true`) by re-fetching the cited URLs through journaled agent
 * steps (N02 mechanics — see claim-verify.ts's reusable composition) and
 * diffing the FNV-1a evidence hash.
 *
 * Replay/resume invariants:
 *   - KB writes are idempotent: entry ids are content-derived
 *     (`provenanceContentId`) and persistence merges by id, so re-distilling
 *     a resumed-and-completed run is a no-op.
 *   - recall/lineage are READ-ONLY query surfaces; the only side-effecting
 *     path is lineage's `verify` flag, which issues regular journaled agent()
 *     calls (positional, resume-replayable) exactly like deep-research's
 *     claim verification.
 *   - No wall-clock timestamps or nondeterministic RNG anywhere in the query
 *     globals; results are pure functions of the persisted KB/ledger/reports.
 */

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ClaimEvidencePage, verifyClaimAgainstPages } from "./claim-verify.js";
import {
  DurableStore,
  deterministicRunClock,
  type ProvenanceEntry,
  projectDurableStorePath,
  provenanceContentId,
  readDurableStoreFile,
} from "./durable-store.js";
import type { PersistenceFsLayer } from "./fs-persistence.js";
import type { PersistedRunState } from "./run-persistence.js";
import { listRunReports, readRunReport } from "./run-report.js";
import { workflowProjectKey, workflowProjectPaths } from "./workflow-paths.js";

/** On-disk schema version of the project knowledge base. */
export const TASK_KNOWLEDGE_SCHEMA_VERSION = 1 as const;

/** Subdirectory under getAgentDir() where per-project KB files live. */
export const TASK_KNOWLEDGE_SUBDIR = "task-knowledge";

/** The single store key holding the KB entry list (one JSON array). */
export const TASK_KNOWLEDGE_ENTRIES_KEY = "kb:entries";

/**
 * Default evidence-decay window (ms over the durable-store's DETERMINISTIC
 * clock — BASE_EPOCH_MS + write seq, where 1ms = 1 ledger write). An entry is
 * "fresh" while its age against the newest entry in the query result stays
 * within this window; 1000 ledger writes past an entry marks it stale (≈ a
 * few research runs). Not wall-clock time — deterministic for a fixed ledger.
 */
export const EVIDENCE_DECAY_TTL_DEFAULT_MS = 1_000;

/** Cap on report artifacts scanned by one recall/lineage query. */
export const TASK_KNOWLEDGE_REPORT_SCAN_LIMIT = 50;

/** Default hit limit for recall/lineage queries. */
export const TASK_KNOWLEDGE_DEFAULT_LIMIT = 25;

/** Cap on the context text block a recall result assembles. */
export const TASK_KNOWLEDGE_CONTEXT_MAX_CHARS = 8_000;

/** The distilled-content categories a run contributes to the KB. */
export type TaskKnowledgeKind = "finding" | "decision" | "constraint" | "summary";

/**
 * One structured KB entry: a privacy-safe, content-identified knowledge item
 * distilled from a completed run (or its provenance ledger).
 */
export interface TaskKnowledgeEntry {
  /** Content-derived stable id — re-distillation of the same content dedupes. */
  id: string;
  /** The run the knowledge came from. */
  runId: string;
  /** The originating workflow's name. */
  workflowName: string;
  kind: TaskKnowledgeKind;
  /** The workflow phase the knowledge belongs to, when known. */
  phase?: string;
  /** Short human-readable headline. */
  title: string;
  /** The distilled text (privacy-safe — never thinking/tool-output/results). */
  text: string;
  /** Searchable tokens derived from title + text + phase. */
  keywords: string[];
  /** Machine-derived strength, when one exists (e.g. verified evidence = 1). */
  score?: number;
  /** Deterministic provenance references (agent labels, ledger ids, URLs). */
  sources: Array<{ label: string; ref?: string }>;
  /** Deterministic creation stamp (the originating run's startedAt / ledger ts). */
  createdAt: string;
}

/** Keyword-search options for {@link recall} (script-facing surface). */
export interface RecallOptions {
  /** Free-text query — tokenized and matched against titles/text/keywords. */
  query?: string;
  /** Explicit keyword list (tokenized, ranked like query tokens). */
  keywords?: string[];
  /** Restrict to entries/reports mentioning this phase name. */
  phase?: string;
  /** Regex pattern searched over entry text / report document text. */
  pattern?: string;
  /** Max ranked hits returned. Default 25. */
  limit?: number;
}

/** One ranked recall hit — a KB entry or a run-report artifact row. */
export interface RecallHit {
  kind: "knowledge" | "report";
  id: string;
  runId: string;
  workflowName: string;
  /** The KB entry kind, for knowledge hits. */
  kindLabel?: string;
  phase?: string;
  /** The privacy-safe context text for this hit. */
  text: string;
  keywords: string[];
  score: number;
  /** Deterministic recency stamp (entry createdAt / report startedAt). */
  at: string;
}

/** The script-facing recall result. */
export interface RecallResult {
  hits: RecallHit[];
  /** A compact, privacy-safe, ready-to-embed context block over the hits. */
  context: string;
}

/** Lineage query filters (script-facing surface). */
export interface LineageQueryOptions {
  /** Restrict to ledger entries observed in this run's report snapshot. */
  runId?: string;
  /** Provenance source kind filter ("claim-verify", "testGate", "agent", ...). */
  source?: string;
  /** File-path (or claim-text) filter. */
  file?: string;
  /** Phase filter. */
  phase?: string;
  /** Agent-label filter. */
  agent?: string;
  /** Regex searched over the entry's file/agent/phase + serialized detail. */
  pattern?: string;
  /** Max entries returned. Default 25. */
  limit?: number;
  /**
   * Re-verify STALE claim-verify evidence (deterministic decay window —
   * see {@link EVIDENCE_DECAY_TTL_DEFAULT_MS}) by re-fetching the cited URLs
   * through journaled agent steps and diffing the FNV-1a evidence hash.
   */
  verify?: boolean;
  /** Decay window in deterministic write-sequence ms. Default 1000. */
  ttlMs?: number;
}

/** One ledger entry hit with its deterministic decay verdict. */
export interface LineageEntryHit {
  id?: string;
  source?: string;
  file?: string;
  agent?: string;
  phase?: string;
  detail?: unknown;
  timestamp?: string;
  /** Position within its ledger (stable ordering). */
  seq: number;
  /** The run(s) whose report snapshots contain this entry. */
  runIds: string[];
  /** Decay verdict: age against the newest entry in the result set. */
  fresh: boolean;
  /** Deterministic age in write-sequence ms (0 = newest entry in the set). */
  ageMs: number;
}

/** A re-verification outcome for one stale claim-verify entry. */
export interface LineageVerification {
  id: string;
  claim: string;
  previousHash: string;
  currentHash: string;
  /** True when the re-fetched evidence still hashes identically. */
  fresh: boolean;
  detail: string;
}

/** Run context attached to a lineage result (from report artifacts). */
export interface LineageRunContext {
  runId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  reportPath: string;
}

/** The script-facing lineage result. */
export interface LineageResult {
  entries: LineageEntryHit[];
  runs: LineageRunContext[];
  decay: { ttlMs: number; staleCount: number; staleIds: string[] };
  verification?: LineageVerification[];
}

/** The injected re-fetch mechanism for lineage `verify` (N02 mechanics). */
export interface LineageVerifyContext {
  /**
   * Re-fetch a claim's cited URLs through ONE journaled agent step. Supplied
   * by the runtime binding (wraps the run's agent() with the claim-verify
   * prompt contract); deterministic call identity (claim + sorted sources).
   */
  fetchClaimPages(claim: string, sources: readonly string[]): Promise<readonly ClaimEvidencePage[]>;
}

// ── keyword extraction ──────────────────────────────────────────────────────

const KNOWLEDGE_STOPWORDS = new Set(
  "a,an,the,and,or,but,of,for,to,in,on,at,by,with,from,as,is,are,was,were,be,been,being,it,its,this,that,these,those,he,she,they,we,you,i,not,no,yes,do,does,did,has,have,had,will,would,can,could,should,may,might,than,then,so,such,too,very,just,only,also,more,most,about,into,over,under,up,down,out,off,per,via,their,there,them,his,her,our,your,my,me,us,what,which,who,whom,when,where,why,how,all,any,both,each,few,many,much,some,every,own,same,other,another,run,runs,workflow,agent,agents,phase,phases,result,results,report".split(
    ",",
  ),
);

/**
 * Deterministic keyword extraction: lowercase, split on non-alphanumerics,
 * drop stopwords + tokens shorter than 3 chars, rank by frequency (stable
 * alphabetical tiebreak), cap at 12. A pure function of the input — recall
 * ranking and KB entry ids never depend on wall clock or RNG.
 */
export function extractKnowledgeKeywords(...texts: string[]): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const raw of String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)) {
      if (raw.length < 3 || KNOWLEDGE_STOPWORDS.has(raw)) continue;
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 12)
    .map(([token]) => token);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── KB storage ─────────────────────────────────────────────────────────────

/**
 * The project KB file path: `getAgentDir()/task-knowledge/<projectKey>.json`.
 */
export function taskKnowledgeStorePath(cwd: string): string {
  return join(getAgentDir(), TASK_KNOWLEDGE_SUBDIR, `${workflowProjectKey(cwd)}.json`);
}

/**
 * Open the project KB as a standalone DurableStore (same atomic-write + lock
 * machinery as the run store; NOT registered in the run registry). The file
 * is reloaded from disk per open, so host-side writers and in-script readers
 * always see the freshest persisted state.
 */
export function openTaskKnowledgeStore(cwd: string, fs?: Partial<PersistenceFsLayer>): DurableStore {
  return new DurableStore({
    projectKey: workflowProjectKey(cwd),
    dir: join(getAgentDir(), TASK_KNOWLEDGE_SUBDIR),
    fs,
    now: deterministicRunClock(undefined),
  });
}

/** Read the KB entry list (empty when the KB does not exist yet). */
export function readKnowledgeEntries(cwd: string, fs?: Partial<PersistenceFsLayer>): TaskKnowledgeEntry[] {
  const raw = openTaskKnowledgeStore(cwd, fs).get(TASK_KNOWLEDGE_ENTRIES_KEY);
  return Array.isArray(raw) ? (raw as TaskKnowledgeEntry[]) : [];
}

// ── distillation (V2-P02) ──────────────────────────────────────────────────

/**
 * Build one KB entry with its content-derived id + extracted keywords.
 * Deterministic given its inputs: same content always yields the same entry
 * (re-distillation after a resume dedupes on id).
 */
function makeKnowledgeEntry(input: {
  runId: string;
  workflowName: string;
  kind: TaskKnowledgeKind;
  phase?: string;
  title: string;
  text: string;
  score?: number;
  sources: Array<{ label: string; ref?: string }>;
  createdAt: string;
}): TaskKnowledgeEntry {
  const keywords = extractKnowledgeKeywords(input.title, input.text, input.phase ?? "");
  return {
    id: provenanceContentId({
      kind: input.kind,
      runId: input.runId,
      title: input.title,
      text: input.text,
    }),
    runId: input.runId,
    workflowName: input.workflowName,
    kind: input.kind,
    ...(input.phase !== undefined ? { phase: input.phase } : {}),
    title: input.title,
    text: input.text,
    keywords,
    ...(input.score !== undefined ? { score: input.score } : {}),
    sources: input.sources,
    createdAt: input.createdAt,
  };
}

function safeTokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Distill a completed run's persisted state + durable snapshot into
 * privacy-safe KB entries:
 *
 *   - summary   — status/termination/phases/agent outcomes/spend
 *   - constraint— token budget + phase budgets + output budget + result cap
 *   - decision  — human-approval checkpoint verdicts (taskId + verdict)
 *   - finding   — machine-gate ledger records (claim-verify evidence envelope,
 *                 testGate verdicts, spec-conformance scores)
 *
 * PRIVACY: only structured metadata + machine-gate `detail` payloads. Agent
 * results, thinking, tool output, and raw logs are NEVER included. A pure
 * function of `state` + `durable` — deterministic distillation.
 */
export function distillRunKnowledge(
  state: PersistedRunState,
  durable: { entries: Record<string, unknown>; ledger: unknown[] } | null,
): TaskKnowledgeEntry[] {
  const entries: TaskKnowledgeEntry[] = [];
  const { runId, workflowName } = state;
  const createdAt = state.startedAt;
  const phaseList = Array.isArray(state.phases) ? state.phases : [];
  const agents = Array.isArray(state.agents) ? state.agents : [];

  // ── summary ──
  const done = agents.filter((a) => a.status === "done").length;
  const failed = agents.filter((a) => a.status === "error").length;
  const skipped = agents.filter((a) => a.status === "skipped").length;
  const spend = safeTokens(state.tokenUsage?.total);
  const summaryText = [
    `status: ${state.status}`,
    state.completedAt !== undefined ? `completed: ${state.completedAt}` : "",
    `phases: ${phaseList.join(", ") || "none"}`,
    `agents: ${agents.length} (${done} done, ${failed} failed, ${skipped} skipped)`,
    `spent ${spend} tokens total`,
    state.tokenBudget !== undefined ? `budget limit: ${String(state.tokenBudget)}` : "",
  ]
    .filter((part) => part.length > 0)
    .join("; ");
  entries.push(
    makeKnowledgeEntry({
      runId,
      workflowName,
      kind: "summary",
      title: `Run summary: ${workflowName}`,
      text: summaryText,
      score: 1,
      sources: [{ label: "run record" }],
      createdAt,
    }),
  );

  // ── constraints ──
  const constraintLines: string[] = [];
  if (state.tokenUsage !== undefined) {
    constraintLines.push(
      `token spend ${spend}${state.tokenBudget !== undefined ? ` of a ${String(state.tokenBudget)} limit` : ""}`,
    );
  }
  const durableEntries = durable && isRecord(durable.entries) ? (durable.entries as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(durableEntries)) {
    // V2-QW2: persisted phase budgets (`phaseBudgets:<runId>:<title>`) and
    // V2-QW3: the run-level output ceiling (`outputBudget:<runId>`) — both
    // already surface in the run report, and both are cross-run constraints.
    if (key.startsWith("phaseBudgets:") && typeof value === "number") {
      const phaseName = key.slice(key.lastIndexOf(":") + 1);
      constraintLines.push(`phase budget "${phaseName}": ${value} tokens`);
    } else if (key.startsWith("outputBudget:") && isRecord(value)) {
      const limit = typeof value.limit === "number" ? String(value.limit) : "null";
      const spent = safeTokens(value.spent);
      constraintLines.push(`total-output ceiling: ${limit} chars (spent ${spent})`);
    }
  }
  if (constraintLines.length > 0) {
    entries.push(
      makeKnowledgeEntry({
        runId,
        workflowName,
        kind: "constraint",
        title: `Constraints: ${workflowName}`,
        text: constraintLines.join("; "),
        score: 1,
        sources: [{ label: "run record" }],
        createdAt,
      }),
    );
  }

  // ── decisions (human-approval checkpoints) ──
  const checkpoints = Array.isArray(state.checkpoints) ? state.checkpoints : [];
  for (const checkpoint of checkpoints) {
    if (!checkpoint || typeof checkpoint.taskId !== "string" || !checkpoint.taskId.trim()) continue;
    const headline = checkpoint.taskId.trim().slice(0, 160);
    entries.push(
      makeKnowledgeEntry({
        runId,
        workflowName,
        kind: "decision",
        title: `Approval: ${headline}`,
        text: `checkpoint "${headline}" resolved: ${checkpoint.status ?? "unknown"}`,
        sources: [{ label: "checkpoint", ref: checkpoint.taskId }],
        createdAt: checkpoint.timestamp ?? createdAt,
      }),
    );
  }

  // ── findings (machine-gate ledger records) ──
  const ledger = durable && Array.isArray(durable.ledger) ? (durable.ledger as unknown[]) : [];
  for (const raw of ledger) {
    if (!isRecord(raw) || typeof raw.source !== "string") continue;
    const source = raw.source;
    const phase = typeof raw.phase === "string" ? raw.phase : undefined;
    const detail = raw.detail;
    if (source === "claim-verify" && isRecord(detail)) {
      const claim = typeof detail.claim === "string" ? detail.claim : typeof raw.file === "string" ? raw.file : "";
      if (!claim.trim()) continue;
      const verified = detail.verified === true;
      const sources = Array.isArray(detail.sources) ? detail.sources.filter((s) => typeof s === "string") : [];
      const matched = Array.isArray(detail.matchedSources)
        ? detail.matchedSources.filter((s) => typeof s === "string")
        : [];
      const evidenceHash = typeof detail.evidenceHash === "string" ? detail.evidenceHash : "";
      entries.push(
        makeKnowledgeEntry({
          runId,
          workflowName,
          kind: "finding",
          phase,
          title: `Evidence: ${claim.slice(0, 120)}`,
          text: `claim "${claim}" ${verified ? "verified" : "UNVERIFIED"} against ${matched.length} of ${sources.length} cited page(s) (evidence hash ${evidenceHash || "n/a"})`,
          score: verified ? 1 : 0,
          sources: [...sources.slice(0, 4).map((url) => ({ label: "source", ref: url as string }))],
          createdAt: typeof raw.timestamp === "string" ? raw.timestamp : createdAt,
        }),
      );
    } else if (source === "testGate" && isRecord(detail)) {
      const verdict = detail.passed === true ? "passed" : detail.passed === false ? "failed" : "unknown";
      const command = typeof detail.command === "string" ? detail.command : undefined;
      const target = typeof raw.file === "string" ? raw.file : command ? `command ${command}` : undefined;
      if (!target) continue;
      entries.push(
        makeKnowledgeEntry({
          runId,
          workflowName,
          kind: "finding",
          phase,
          title: `Gate: ${target.slice(0, 120)}`,
          text: `testGate ${verdict}${command ? ` (${command.slice(0, 120)})` : ""}${typeof detail.detail === "string" ? ` — ${detail.detail.slice(0, 200)}` : ""}`,
          score: verdict === "passed" ? 1 : 0,
          sources: [{ label: "testGate" }],
          createdAt: typeof raw.timestamp === "string" ? raw.timestamp : createdAt,
        }),
      );
    } else if (source === "spec-conformance" && isRecord(detail)) {
      const requirement = typeof detail.requirement === "string" ? detail.requirement : undefined;
      const score = typeof detail.score === "number" ? detail.score : undefined;
      const target = requirement ?? (typeof raw.file === "string" ? raw.file : undefined);
      if (!target) continue;
      entries.push(
        makeKnowledgeEntry({
          runId,
          workflowName,
          kind: "finding",
          phase,
          title: `Spec: ${target.slice(0, 120)}`,
          text: `spec-conformance requirement "${target}" scored ${score !== undefined ? String(score) : "n/a"}${typeof detail.verdict === "string" ? ` (${detail.verdict})` : ""}`,
          score: typeof score === "number" ? score : undefined,
          sources: [{ label: "spec-conformance" }],
          createdAt: typeof raw.timestamp === "string" ? raw.timestamp : createdAt,
        }),
      );
    }
    // "agent" settle records carry only labels/phases (no content) and would
    // add noise — deliberately not distilled into findings.
  }

  return entries;
}

/**
 * Persist distilled entries into the project KB (idempotent merge: entries
 * whose content-derived id already exists are skipped). Returns the number of
 * NEW entries written. Replay-safe by construction — re-distilling the same
 * run (e.g. a resumed run completing twice) writes nothing.
 */
export async function persistDistilledKnowledge(
  cwd: string,
  entries: readonly TaskKnowledgeEntry[],
  fs?: Partial<PersistenceFsLayer>,
): Promise<number> {
  if (entries.length === 0) return 0;
  const store = openTaskKnowledgeStore(cwd, fs);
  const existing = readKnowledgeEntries(cwd, fs);
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  let added = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || byId.has(entry.id)) continue;
    byId.set(entry.id, entry);
    added++;
  }
  if (added === 0) return 0;
  await store.put(TASK_KNOWLEDGE_ENTRIES_KEY, [...byId.values()]);
  return added;
}

/**
 * The manager's completion hook body (see workflow-manager emitRunReport):
 * distill the freshly-persisted run + its durable snapshot and merge into the
 * project KB. Returns the number of new KB entries written (0 = dedupe no-op).
 */
export async function distillAndPersistRunKnowledge(
  cwd: string,
  state: PersistedRunState,
  durable: { entries: Record<string, unknown>; ledger: unknown[] } | null,
): Promise<number> {
  return persistDistilledKnowledge(cwd, distillRunKnowledge(state, durable));
}

// ── recall / ranking (V2-P02 query surface) ────────────────────────────────

function tokenizeQuery(query: string | undefined, keywords: readonly string[] | undefined): string[] {
  const tokens = new Set<string>();
  for (const keyword of keywords ?? []) {
    if (typeof keyword === "string" && keyword.trim().length > 0) tokens.add(keyword.toLowerCase().trim());
  }
  for (const raw of String(query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (raw.length >= 3) tokens.add(raw);
  }
  return [...tokens];
}

function safeRegExp(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function scoreKnowledgeHit(
  entry: TaskKnowledgeEntry,
  queryTokens: string[],
  phase: string | undefined,
  pattern: RegExp | null,
): number {
  let score = 0;
  for (const token of queryTokens) {
    if (entry.keywords.includes(token)) score += 3;
    if (entry.title.toLowerCase().includes(token) || entry.text.toLowerCase().includes(token)) score += 1;
  }
  if (phase && (entry.phase === phase || entry.workflowName.toLowerCase().includes(phase.toLowerCase()))) score += 5;
  if (pattern && (pattern.test(entry.title) || pattern.test(entry.text))) score += 4;
  return score;
}

/** The privacy-safe context line for one KB entry. */
function knowledgeHitContext(entry: TaskKnowledgeEntry): string {
  const phase = entry.phase !== undefined ? ` · phase ${entry.phase}` : "";
  return `[${entry.kind}] ${entry.workflowName} (${entry.runId})${phase}: ${entry.text}`;
}

/**
 * Search the project KB (ranked recall — V2-P02). Keyword/phase/pattern
 * matching over entry keywords + title/text; deterministic ranking (score
 * desc, recency desc, id tiebreak).
 */
export function queryTaskKnowledge(cwd: string, options: RecallOptions = {}): RecallHit[] {
  const queryTokens = tokenizeQuery(options.query, options.keywords);
  const pattern = safeRegExp(options.pattern);
  const limit = Math.max(1, Math.floor(options.limit ?? TASK_KNOWLEDGE_DEFAULT_LIMIT));
  const scored: Array<{ entry: TaskKnowledgeEntry; score: number }> = [];
  for (const entry of readKnowledgeEntries(cwd)) {
    const score = scoreKnowledgeHit(entry, queryTokens, options.phase, pattern);
    if (queryTokens.length > 0 || options.phase !== undefined || pattern !== null) {
      if (score === 0) continue;
    }
    scored.push({ entry, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.entry.createdAt < b.entry.createdAt ? 1 : a.entry.createdAt > b.entry.createdAt ? -1 : 0) ||
      (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
  );
  return scored.slice(0, limit).map(({ entry, score }) => ({
    kind: "knowledge" as const,
    id: entry.id,
    runId: entry.runId,
    workflowName: entry.workflowName,
    kindLabel: entry.kind,
    ...(entry.phase !== undefined ? { phase: entry.phase } : {}),
    text: knowledgeHitContext(entry),
    keywords: entry.keywords,
    score,
    at: entry.createdAt,
  }));
}

interface ReportDocument {
  runId: string;
  workflowName: string;
  status: string;
  phases: string[];
  agentLabels: string[];
  termination: string;
  spend: number;
  startedAt: string;
  reportPath: string;
}

function reportDocumentText(doc: ReportDocument): string {
  return [doc.workflowName, doc.status, doc.termination, ...doc.phases, ...doc.agentLabels].join(" ");
}

/**
 * Search run-report artifacts (the second recall surface). Matches the same
 * keyword/phase/pattern vocabulary over the report's structured fields
 * (workflowName, status, phases, agent labels, termination reason) — NEVER
 * agent results or raw logs (privacy gate applies to reports too).
 */
export async function queryRunReports(cwd: string, options: RecallOptions = {}): Promise<RecallHit[]> {
  const runsDir = workflowProjectPaths(cwd).runsDir;
  const queryTokens = tokenizeQuery(options.query, options.keywords);
  const pattern = safeRegExp(options.pattern);
  const limit = Math.max(1, Math.floor(options.limit ?? TASK_KNOWLEDGE_DEFAULT_LIMIT));
  const summaries = await listRunReports(runsDir, TASK_KNOWLEDGE_REPORT_SCAN_LIMIT);
  const hits: Array<{ hit: RecallHit; score: number }> = [];
  for (const summary of summaries) {
    const report = await readRunReport(runsDir, summary.runId);
    if (report === null) continue;
    const doc: ReportDocument = {
      runId: report.runId,
      workflowName: report.workflowName,
      status: report.status,
      phases: (report.phases ?? []).map((p) => p.name),
      agentLabels: (report.agents ?? []).map((a) => a.label),
      termination: report.terminationReason,
      spend: safeTokens(report.budget?.spent),
      startedAt: report.startedAt,
      reportPath: summary.reportPath,
    };
    const documentText = reportDocumentText(doc);
    let score = 0;
    for (const token of queryTokens) {
      if (documentText.toLowerCase().includes(token)) score += 2;
    }
    if (
      options.phase &&
      (doc.phases.some((p) => p.toLowerCase() === options.phase?.toLowerCase()) ||
        doc.phases.some((p) => p.toLowerCase().includes(options.phase?.toLowerCase() ?? "")))
    ) {
      score += 5;
    }
    if (pattern?.test(documentText)) score += 4;
    if (queryTokens.length > 0 || options.phase !== undefined || pattern !== null) {
      if (score === 0) continue;
    }
    const phaseText = doc.phases.length > 0 ? ` · phases ${doc.phases.join(", ")}` : "";
    const hit: RecallHit = {
      kind: "report",
      id: `report:${report.runId}`,
      runId: report.runId,
      workflowName: report.workflowName,
      text: `Run ${report.runId} ("${report.workflowName}") ${report.status}: ${report.terminationReason}${phaseText} · ${report.agents?.length ?? 0} agent(s) · spent ${doc.spend} tokens`,
      keywords: extractKnowledgeKeywords(documentText),
      score,
      at: report.startedAt,
    };
    hits.push({ hit, score });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score || (a.hit.at < b.hit.at ? 1 : a.hit.at > b.hit.at ? -1 : 0) || (a.hit.id < b.hit.id ? -1 : 1),
  );
  return hits.slice(0, limit).map(({ hit }) => hit);
}

/**
 * The script-facing recall composition: ranked KB hits + report hits, plus a
 * compact privacy-safe context block ready for embedding/seeding. Deterministic
 * for a fixed KB + reports set.
 */
export async function buildRecallResult(cwd: string, options: RecallOptions = {}): Promise<RecallResult> {
  const limit = Math.max(1, Math.floor(options.limit ?? TASK_KNOWLEDGE_DEFAULT_LIMIT));
  const [knowledge, reports] = await Promise.all([
    Promise.resolve(queryTaskKnowledge(cwd, { ...options, limit })),
    queryRunReports(cwd, { ...options, limit }),
  ]);
  const hits = [...knowledge, ...reports]
    .sort(
      (a, b) =>
        b.score - a.score || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, limit);
  let context = `Cross-run task knowledge for project "${workflowProjectKey(cwd)}":\n`;
  for (const hit of hits) {
    const line = `- ${hit.text}`;
    if (context.length + line.length + 1 > TASK_KNOWLEDGE_CONTEXT_MAX_CHARS) break;
    context += `${line}\n`;
  }
  if (hits.length === 0) context = "";
  return { hits, context };
}

// ── lineage query + freshness/decay (V2-P04) ───────────────────────────────

/**
 * Read the project's cross-run provenance ledger from disk (the durable-store
 * file shared by every run of the project). Missing/corrupt → empty list.
 */
export function readProjectLedger(cwd: string): ProvenanceEntry[] {
  const projectKey = workflowProjectKey(cwd);
  const file = readDurableStoreFile(projectDurableStorePath(projectKey));
  return file ? file.ledger : [];
}

function entryMatchesPattern(entry: ProvenanceEntry, pattern: RegExp): boolean {
  const haystack = [entry.file, entry.agent, entry.phase, entry.source, JSON.stringify(entry.detail ?? null)]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  return pattern.test(haystack);
}

/**
 * The deterministic decay verdict for a ledger entry: its age in write-seq ms
 * against the newest entry of the result set. `fresh` = age within `ttlMs`.
 * Never wall-clock — ledger timestamps come from the store's deterministic
 * clock, so the verdict is a pure function of the ledger's own ordering.
 */
export function decayVerdict(
  timestamp: string | undefined,
  newestTimestamp: string | undefined,
  ttlMs: number,
): {
  fresh: boolean;
  ageMs: number;
} {
  if (timestamp === undefined || newestTimestamp === undefined) {
    return { fresh: true, ageMs: 0 };
  }
  const entryMs = Date.parse(timestamp);
  const newestMs = Date.parse(newestTimestamp);
  if (!Number.isFinite(entryMs) || !Number.isFinite(newestMs)) {
    return { fresh: true, ageMs: 0 };
  }
  const ageMs = Math.max(0, newestMs - entryMs);
  return { fresh: ageMs <= ttlMs, ageMs };
}

/**
 * Cross-run lineage query (V2-P04): filter the project ledger by
 * run/source/file/phase/agent/pattern, sort by deterministic timestamp, and
 * apply the decay policy. Runs are attributed to entries via the report
 * artifacts' `durable.ledger` snapshots (an entry observed in a report
 * snapshot belongs to that run). Optional `verify` re-verifies stale
 * claim-verify evidence through the injected N02 re-fetch mechanism.
 */
export async function queryLineage(
  cwd: string,
  options: LineageQueryOptions = {},
  verifyContext?: LineageVerifyContext,
): Promise<LineageResult> {
  const ttlMs =
    Number.isFinite(options.ttlMs) && (options.ttlMs as number) >= 0
      ? (options.ttlMs as number)
      : EVIDENCE_DECAY_TTL_DEFAULT_MS;
  const limit = Math.max(1, Math.floor(options.limit ?? TASK_KNOWLEDGE_DEFAULT_LIMIT));
  const pattern = safeRegExp(options.pattern);

  const ledger = readProjectLedger(cwd);
  const runsDir = workflowProjectPaths(cwd).runsDir;
  // Deterministic decay reference: the NEWEST entry of the FULL project
  // ledger (not the filtered result set) — an entry's freshness is its
  // distance behind the latest provenance write, independent of the query's
  // filters, so filtering by source never makes old evidence look fresh.
  const newestTimestamp = ledger.length > 0 ? ledger[ledger.length - 1]?.timestamp : undefined;
  const runContexts: LineageRunContext[] = [];
  const attribution = new Map<string, string[]>();
  const reportSummaries = await listRunReports(runsDir, TASK_KNOWLEDGE_REPORT_SCAN_LIMIT);
  for (const summary of reportSummaries) {
    runContexts.push({
      runId: summary.runId,
      workflowName: summary.workflowName,
      status: summary.status,
      startedAt: summary.startedAt,
      reportPath: summary.reportPath,
    });
    const report = await readRunReport(runsDir, summary.runId);
    if (!report || !isRecord(report.durable) || !Array.isArray(report.durable.ledger)) continue;
    for (const raw of report.durable.ledger) {
      if (!isRecord(raw) || typeof raw.id !== "string") continue;
      const seen = attribution.get(raw.id);
      if (seen === undefined) {
        attribution.set(raw.id, [summary.runId]);
      } else if (!seen.includes(summary.runId)) {
        seen.push(summary.runId);
      }
    }
  }

  const entries: LineageEntryHit[] = [];
  for (let seq = 0; seq < ledger.length; seq++) {
    const entry = ledger[seq];
    const runIds = entry.id !== undefined ? (attribution.get(entry.id) ?? []) : [];
    if (options.runId !== undefined && !runIds.includes(options.runId)) continue;
    if (options.source !== undefined && entry.source !== options.source) continue;
    if (options.file !== undefined && entry.file !== options.file) continue;
    if (options.phase !== undefined && entry.phase !== options.phase) continue;
    if (options.agent !== undefined && entry.agent !== options.agent) continue;
    if (pattern !== null && !entryMatchesPattern(entry, pattern)) continue;
    entries.push({ ...entry, seq, runIds, fresh: true, ageMs: 0 });
  }
  entries.sort((a, b) =>
    a.timestamp === b.timestamp
      ? a.seq - b.seq
      : (a.timestamp ?? "") < (b.timestamp ?? "")
        ? -1
        : (a.timestamp ?? "") > (b.timestamp ?? "")
          ? 1
          : a.seq - b.seq,
  );
  const staleIds: string[] = [];
  for (const hit of entries) {
    const { fresh, ageMs } = decayVerdict(hit.timestamp, newestTimestamp, ttlMs);
    hit.fresh = fresh;
    hit.ageMs = ageMs;
  }
  const resultEntries = entries.slice(0, limit);
  for (const hit of resultEntries) {
    if (!hit.fresh && hit.id !== undefined) staleIds.push(hit.id);
  }
  const staleCount = resultEntries.filter((e) => !e.fresh).length;

  // Re-verify stale claim-verify evidence (N02 mechanics via the injected
  // fetch mechanism — journaled agent steps, resume-replayable).
  let verification: LineageVerification[] | undefined;
  if (options.verify === true && verifyContext) {
    const staleClaimEntries = resultEntries.filter(
      (entry) => entry.source === "claim-verify" && !entry.fresh && isRecord(entry.detail),
    );
    if (staleClaimEntries.length > 0) {
      verification = [];
      for (const entry of staleClaimEntries) {
        const detail = entry.detail as Record<string, unknown>;
        const claim =
          typeof entry.file === "string" ? entry.file : typeof detail.claim === "string" ? detail.claim : "";
        const sources = Array.isArray(detail.sources) ? detail.sources.filter((s) => typeof s === "string") : [];
        const previousHash = typeof detail.evidenceHash === "string" ? detail.evidenceHash : "";
        if (!claim || sources.length === 0 || !previousHash) continue;
        const pages = await verifyContext.fetchClaimPages(claim, sources as string[]);
        const verdict = verifyClaimAgainstPages(claim, sources as string[], pages);
        const fresh = verdict.evidenceHash === previousHash;
        verification.push({
          id: entry.id ?? previousHash,
          claim,
          previousHash,
          currentHash: verdict.evidenceHash,
          fresh,
          detail: fresh
            ? `re-fetched cited pages still produce evidence hash ${verdict.evidenceHash}`
            : `re-fetched pages changed the evidence (${previousHash} → ${verdict.evidenceHash}); ${verdict.verified ? "claim still corroborated by current pages" : "claim is no longer corroborated"}`,
        });
      }
      if (verification.length === 0) verification = undefined;
    }
  }

  return {
    entries: resultEntries,
    runs: runContexts,
    decay: { ttlMs, staleCount, staleIds },
    ...(verification !== undefined ? { verification } : {}),
  };
}
