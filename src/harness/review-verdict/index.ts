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
 * These reads are WORKER/ORCHESTRATOR-side only: the independent reviewer
 * session never sees the human verdict (trust boundary,
 * session/trust-boundary.ts).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  validateReviewVerdictRecord,
  type ReviewVerdictRecord,
} from "../../schema/index.js";

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
