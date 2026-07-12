/**
 * Disk reads of the HUMAN review verdict, `review/verdict/{phase}.json`
 * (written by the dashboard's `POST /api/tasks/:id/review/finish`; schema in
 * src/schema/review-verdict.ts).
 *
 * A leaf below both the orchestrator and the worker session: the orchestrator
 * reads the verdict to find a pending send-back (`findSendBackPhase`), and the
 * worker reads the note to thread it into the re-run prompt. Keeping the read
 * here (not in orchestrator/index.ts) lets the worker import it without an
 * orchestrator → session → orchestrator cycle.
 *
 * These reads are WORKER/ORCHESTRATOR/AUTHOR-side only: the independent
 * reviewer session never sees the human verdict (trust boundary,
 * session/trust-boundary.ts).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  validateReviewVerdictRecord,
  type LandmarkAdjustment,
  type ReviewVerdictRecord,
} from "../../schema/index.js";
import { decodeCursor, encodeCursor } from "../../util/cursor.js";

/** The live human verdict for a phase, or null if absent/invalid. Archived
 * `{phase}.attempt-N.json` verdicts (consumed send-backs) are never read. */
export async function readHumanVerdict(
  taskDir: string,
  phaseId: string,
): Promise<ReviewVerdictRecord | null> {
  const path = join(taskDir, "review", "verdict", `${phaseId}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  const validated = validateReviewVerdictRecord(raw);
  return validated.ok ? validated.value : null;
}

/**
 * The human's send-back note for a phase, ready to thread into the re-run
 * worker's prompt — only when the phase's verdict is `changes_requested`
 * (the re-run signal). Empty notes read through as null so the prompt
 * builder can omit the section entirely.
 */
export async function readHumanFeedbackNote(
  taskDir: string,
  phaseId: string,
): Promise<string | null> {
  const record = await readHumanVerdict(taskDir, phaseId);
  if (record?.human_verdict !== "changes_requested") {
    return null;
  }
  const note = record.notes.trim();
  return note.length > 0 ? note : null;
}

// ---------------------------------------------------------------------------
// view_human_feedback — author-only collapsed view (design §3C)
// ---------------------------------------------------------------------------

/** Design estimate: ~4 characters per token. */
const CHARS_PER_TOKEN = 4;
/** Approximate JSON envelope overhead outside the feedback array. */
const ENVELOPE_OVERHEAD_CHARS = 96;

/** One validated human feedback record, preserved for faithful presentation. */
export type HumanFeedbackEntry = {
  readonly phase: string;
  /** Archive attempt number, or null for the live record. */
  readonly attempt: number | null;
  readonly status: "live" | "archived";
  readonly source_path: string;
  readonly verdict: string;
  readonly corrected: boolean;
  readonly notes: string;
  readonly adjustments: readonly LandmarkAdjustment[];
  readonly agent_gate_decision: string | null;
  readonly reviewed_at: string;
  /** Routing-decision reference (design §3E), when the record carries one. */
  readonly routing_decision: string | null;
};

export type HumanFeedbackView = {
  readonly schema_version: 1;
  readonly feedback: readonly HumanFeedbackEntry[];
  readonly errors: ReadonlyArray<{
    readonly source_path: string;
    readonly error: string;
  }>;
  readonly next_cursor: string | null;
  readonly truncated: boolean;
};

export type HumanFeedbackViewOptions = {
  readonly taskDir: string;
  /** Author-visible phases in protocol declaration order (≤ current phase). */
  readonly visiblePhases: readonly string[];
  readonly phase?: string;
  readonly includeArchived: boolean;
  readonly cursor?: string;
  readonly maxTokens: number;
};

export type HumanFeedbackViewResult =
  | { readonly ok: true; readonly view: HumanFeedbackView }
  | { readonly ok: false; readonly error: string };

type VerdictFile = {
  readonly phase: string;
  readonly attempt: number | null;
  readonly fileName: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Verdict files for the scoped phases: per phase, archived attempts
 * ascending then the live record last (newest last, matching history). */
function listVerdictFiles(
  entries: readonly string[],
  scopePhases: readonly string[],
  includeArchived: boolean,
): VerdictFile[] {
  const files: VerdictFile[] = [];
  for (const phase of scopePhases) {
    if (includeArchived) {
      const re = new RegExp(`^${escapeRegExp(phase)}\\.attempt-(\\d+)\\.json$`);
      const archived: Array<{ attempt: number; fileName: string }> = [];
      for (const entry of entries) {
        const match = re.exec(entry);
        if (match) {
          archived.push({ attempt: Number(match[1]), fileName: entry });
        }
      }
      archived.sort((a, b) => a.attempt - b.attempt);
      for (const { attempt, fileName } of archived) {
        files.push({ phase, attempt, fileName });
      }
    }
    const live = `${phase}.json`;
    if (entries.includes(live)) {
      files.push({ phase, attempt: null, fileName: live });
    }
  }
  return files;
}

/**
 * Build the validated, size-bounded human-feedback view. Pure disk read —
 * never writes, never sets signals. Every record passes through
 * `validateReviewVerdictRecord`; malformed records surface in `errors`,
 * never as pass-through prompt text.
 */
export async function buildHumanFeedbackView(
  options: HumanFeedbackViewOptions,
): Promise<HumanFeedbackViewResult> {
  const { taskDir, visiblePhases, maxTokens } = options;

  if (options.phase !== undefined && !visiblePhases.includes(options.phase)) {
    return {
      ok: false,
      error: `phase "${options.phase}" is not in the author-visible scope (${visiblePhases.join(", ") || "none"})`,
    };
  }

  let startIndex = 0;
  if (options.cursor !== undefined) {
    const decoded = decodeCursor(options.cursor);
    if (decoded === null || typeof decoded["i"] !== "number") {
      return { ok: false, error: "invalid cursor" };
    }
    startIndex = decoded["i"];
  }

  const verdictDir = join(taskDir, "review", "verdict");
  let entries: string[];
  try {
    entries = await readdir(verdictDir);
  } catch {
    entries = [];
  }

  const scopePhases = options.phase !== undefined ? [options.phase] : visiblePhases;
  const files = listVerdictFiles(entries, scopePhases, options.includeArchived);

  const errors: Array<{ source_path: string; error: string }> = [];
  const records: HumanFeedbackEntry[] = [];

  for (const file of files) {
    const sourcePath = `review/verdict/${file.fileName}`;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(verdictDir, file.fileName), "utf8"));
    } catch {
      // No err.message here: JSON.parse errors embed a snippet of the raw
      // file, which must never pass through as prompt text.
      errors.push({ source_path: sourcePath, error: "unreadable or invalid JSON" });
      continue;
    }
    const validated = validateReviewVerdictRecord(raw);
    if (!validated.ok) {
      // Paths only — validator messages can echo raw record values
      // (expectEnum's `got ...`), which would pass malformed content
      // through as prompt text.
      errors.push({
        source_path: sourcePath,
        error: `validation failed at ${validated.errors.map((e) => e.path).join(", ")}`,
      });
      continue;
    }
    if (validated.value.phase !== file.phase) {
      errors.push({
        source_path: sourcePath,
        error: `record phase "${validated.value.phase}" does not match file phase "${file.phase}"`,
      });
      continue;
    }
    const routingDecision = (raw as Record<string, unknown>)["routing_decision"];
    records.push({
      phase: validated.value.phase,
      attempt: file.attempt,
      status: file.attempt === null ? "live" : "archived",
      source_path: sourcePath,
      verdict: validated.value.human_verdict,
      corrected: validated.value.corrected,
      notes: validated.value.notes,
      adjustments: validated.value.adjustments,
      agent_gate_decision: validated.value.agent_gate_decision,
      reviewed_at: validated.value.reviewed_at,
      routing_decision: typeof routingDecision === "string" ? routingDecision : null,
    });
  }

  const budgetChars = maxTokens * CHARS_PER_TOKEN;
  let usedChars = ENVELOPE_OVERHEAD_CHARS + JSON.stringify(errors).length;

  const feedback: HumanFeedbackEntry[] = [];
  let nextCursor: string | null = null;
  let truncated = false;

  for (let i = startIndex; i < records.length; i++) {
    const entry = records[i] as HumanFeedbackEntry;
    const cost = JSON.stringify(entry).length + 1;
    if (usedChars + cost > budgetChars && feedback.length > 0) {
      nextCursor = encodeCursor({ i });
      truncated = true;
      break;
    }
    usedChars += cost;
    feedback.push(entry);
  }

  return {
    ok: true,
    view: {
      schema_version: 1,
      feedback,
      errors,
      next_cursor: nextCursor,
      truncated,
    },
  };
}
