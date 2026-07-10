import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  isValidTaskId,
  latestMarksBySubphase,
  validateGateFile,
  validateProvenanceManifest,
  validateSubphasesJson,
  validateSuggestionsJson,
  validateTaskJson,
  type GateFile,
  type ProvenanceArtifactRef,
  type ProvenanceManifest,
  type SubphaseMark,
  type SubphaseConfidence,
  type SuggestionEntry,
  type TaskJson,
} from "../../schema/index.js";

/**
 * All disk reads for the dashboard. Pure I/O against the task tree — nothing
 * here touches the harness. Every file is validated against the schema on read;
 * malformed files are reported as null / skipped rather than crashing a request
 * (design §3: the dashboard serves the last good state on disk).
 */

/** Reject path segments that could escape the task tree. */
function isSafeSegment(seg: string): boolean {
  return seg.length > 0 && !seg.includes("/") && !seg.includes("\\") && seg !== "." && seg !== "..";
}

async function readJsonFile(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readTextFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function taskDir(tasksDir: string, id: string): string {
  return path.join(tasksDir, id);
}

async function readTaskJson(tasksDir: string, id: string): Promise<TaskJson | null> {
  const raw = await readJsonFile(path.join(taskDir(tasksDir, id), "task.json"));
  if (raw === null) return null;
  const res = validateTaskJson(raw);
  return res.ok ? res.value : null;
}

async function readGateFile(
  tasksDir: string,
  id: string,
  phase: string,
): Promise<GateFile | null> {
  const raw = await readJsonFile(
    path.join(taskDir(tasksDir, id), "review", "gates", `${phase}.json`),
  );
  if (raw === null) return null;
  const res = validateGateFile(raw);
  return res.ok ? res.value : null;
}

async function readManifest(
  tasksDir: string,
  id: string,
): Promise<ProvenanceManifest | null> {
  const text = await readTextFile(
    path.join(taskDir(tasksDir, id), "provenance", "manifest.yaml"),
  );
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return null;
  }
  const res = validateProvenanceManifest(parsed ?? []);
  return res.ok ? res.value : null;
}

export type TaskSummary = {
  readonly id: string;
  readonly protocol: string;
  readonly state: TaskJson["state"];
  readonly currentPhase: string | null;
  readonly phasesComplete: readonly string[];
  readonly updatedAt: string;
  readonly reason?: string;
};

/** GET /api/tasks — one summary per task dir that holds a valid task.json. */
export async function listTasks(tasksDir: string): Promise<TaskSummary[]> {
  let names: string[];
  try {
    const entries = await readdir(tasksDir, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory() && isValidTaskId(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  const summaries: TaskSummary[] = [];
  for (const id of names.sort()) {
    const task = await readTaskJson(tasksDir, id);
    if (!task) continue;
    summaries.push({
      id: task.id,
      protocol: task.protocol,
      state: task.state,
      currentPhase: task.currentPhase,
      phasesComplete: task.phasesComplete,
      updatedAt: task.updatedAt,
      ...(task.reason !== undefined ? { reason: task.reason } : {}),
    });
  }
  return summaries;
}

export type GateSummary = {
  readonly decision: GateFile["decision"];
  readonly feedback: string | null;
  readonly confidence: "low" | null;
  readonly hasSubphaseAssessments: boolean;
};

export type TimelineEntry = {
  readonly phase: string;
  readonly status: "complete" | "running" | "paused" | "failed" | "pending";
  readonly attempt: number | null;
  readonly started: string | null;
  readonly completed: string | null;
  readonly gate: GateSummary | null;
  /**
   * True when this phase's recorded outputs include the review-site contract
   * folder (design/review-template.md vocabulary: "review site — the concrete
   * produced folder instance under artifacts/review-site/"). Contract-based,
   * not a hardcoded phase-id check, so any protocol's review-producing phase
   * lights up the same way — the dashboard renders it as a first-class node
   * in the chain (an "Open review site" link into the Reviews view) with no
   * per-protocol wiring.
   */
  readonly hasReviewSite: boolean;
};

/** The one path prefix the dashboard treats as "this phase made a review site". */
const REVIEW_SITE_OUTPUT_PREFIX = "artifacts/review-site/";

function producesReviewSite(outputs: readonly ProvenanceArtifactRef[]): boolean {
  return outputs.some((o) => o.path.startsWith(REVIEW_SITE_OUTPUT_PREFIX));
}

export type TaskDetail = {
  readonly task: TaskJson;
  readonly timeline: readonly TimelineEntry[];
};

/** Latest manifest entry for a phase (append-only; last write wins). */
function latestManifestEntry(manifest: ProvenanceManifest | null, phase: string) {
  if (!manifest) return null;
  let found: ProvenanceManifest[number] | null = null;
  for (const entry of manifest) {
    if (entry.phase === phase) found = entry;
  }
  return found;
}

function currentPhaseStatus(state: TaskJson["state"]): TimelineEntry["status"] {
  switch (state) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

/**
 * GET /api/tasks/:id — task.json plus a derived review chain. The chain is
 * built purely from disk: completed phases (in order) carry their gate decision
 * and provenance timing; the current phase reflects task.state.
 */
export async function getTask(
  tasksDir: string,
  id: string,
): Promise<TaskDetail | null> {
  if (!isValidTaskId(id)) return null;
  const task = await readTaskJson(tasksDir, id);
  if (!task) return null;

  const manifest = await readManifest(tasksDir, id);

  const order = [...task.phasesComplete];
  if (task.currentPhase && !order.includes(task.currentPhase)) {
    order.push(task.currentPhase);
  }

  const timeline: TimelineEntry[] = [];
  for (const phase of order) {
    const isComplete = task.phasesComplete.includes(phase);
    const entry = latestManifestEntry(manifest, phase);
    const gate = await readGateFile(tasksDir, id, phase);
    timeline.push({
      phase,
      status: isComplete ? "complete" : currentPhaseStatus(task.state),
      attempt: entry?.attempt ?? null,
      started: entry?.started ?? null,
      completed: entry?.completed ?? null,
      gate: gate
        ? {
            decision: gate.decision,
            feedback: gate.feedback ?? null,
            confidence: gate.confidence ?? null,
            hasSubphaseAssessments: gate.subphase_assessments !== undefined,
          }
        : null,
      hasReviewSite: producesReviewSite(entry?.outputs ?? []),
    });
  }

  return { task, timeline };
}

export type SubphaseLatestMark = {
  readonly subphase: string;
  readonly mark: SubphaseMark;
  readonly confidence: SubphaseConfidence | null;
  readonly notes: string | null;
  readonly attempt: number;
};

export type PhaseDetail = {
  readonly phase: string;
  readonly summary: string | null;
  readonly measurements: unknown | null;
  readonly confidence: unknown | null;
  /** Latest mark per subphase, derived from the append-only marks log. */
  readonly subphases: readonly SubphaseLatestMark[] | null;
  readonly gate: GateFile | null;
  /** Evidence image filenames under phases/{phase}/evidence/. */
  readonly evidence: readonly string[];
  /** Reviewer verification filenames under review/verification/{phase}/. */
  readonly verification: readonly string[];
};

/**
 * GET /api/tasks/:id/phases/:phase — the human-facing surface for one phase:
 * summary prose, measurements, latest subphase marks, gate decision, and the
 * lists of evidence + reviewer-verification files.
 */
export async function getPhase(
  tasksDir: string,
  id: string,
  phase: string,
): Promise<PhaseDetail | null> {
  if (!isValidTaskId(id) || !isSafeSegment(phase)) return null;
  const dir = taskDir(tasksDir, id);
  const phaseDir = path.join(dir, "phases", phase);

  // A phase "exists" if it has a directory or a gate on disk.
  const gate = await readGateFile(tasksDir, id, phase);
  let phaseDirExists = false;
  try {
    phaseDirExists = (await stat(phaseDir)).isDirectory();
  } catch {
    phaseDirExists = false;
  }
  if (!phaseDirExists && !gate) return null;

  const summary = await readTextFile(path.join(phaseDir, "summary.md"));
  const measurements = await readJsonFile(path.join(phaseDir, "measurements.json"));
  const confidence = await readJsonFile(path.join(phaseDir, "confidence.json"));

  let subphases: SubphaseLatestMark[] | null = null;
  const spRaw = await readJsonFile(path.join(phaseDir, "subphases.json"));
  if (spRaw !== null) {
    const res = validateSubphasesJson(spRaw);
    if (res.ok) {
      subphases = [...latestMarksBySubphase(res.value).values()].map((e) => ({
        subphase: e.subphase,
        mark: e.mark,
        confidence: e.confidence ?? null,
        notes: e.notes ?? null,
        attempt: e.attempt,
      }));
    }
  }

  const evidence = await listDir(path.join(phaseDir, "evidence"));
  const verification = await listDir(
    path.join(dir, "review", "verification", phase),
  );

  return { phase, summary, measurements, confidence, subphases, gate, evidence, verification };
}

/** GET /api/tasks/:id/suggestions — the append-only suggestions log (design §17). */
export async function getSuggestions(
  tasksDir: string,
  id: string,
): Promise<SuggestionEntry[] | null> {
  if (!isValidTaskId(id)) return null;
  const raw = await readJsonFile(
    path.join(taskDir(tasksDir, id), "suggestions", "suggestions.json"),
  );
  if (raw === null) return [];
  const res = validateSuggestionsJson(raw);
  return res.ok ? [...res.value] : [];
}

/** GET /api/tasks/:id/manifest — parsed + validated provenance manifest. */
export async function getManifest(
  tasksDir: string,
  id: string,
): Promise<ProvenanceManifest | null> {
  if (!isValidTaskId(id)) return null;
  return readManifest(tasksDir, id);
}

/**
 * Resolve a path to a file the dashboard is allowed to serve verbatim
 * (evidence images, verification scratch). Returns null if any segment is
 * unsafe, keeping serving inside the task tree.
 */
export function resolveTaskFile(
  tasksDir: string,
  id: string,
  segments: readonly string[],
): string | null {
  if (!isValidTaskId(id)) return null;
  for (const seg of segments) {
    if (!isSafeSegment(seg)) return null;
  }
  return path.join(taskDir(tasksDir, id), ...segments);
}
