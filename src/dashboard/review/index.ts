import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  isValidTaskId,
  validateGateFile,
  validateReviewFinishInput,
  validateReviewVerdictRecord,
  type ReviewVerdictRecord,
} from "../../schema/index.js";
import { atomicWriteJson } from "../../util/atomic-write.js";
import { isSafeSegment, taskDir } from "../api/index.js";

/**
 * `POST /api/tasks/:id/review/finish` write path (design/review-loop-and-
 * roles.md "trust line"): the trusted shell writes `review/verdict/{phase}.json`
 * — never the iframe. Mirrors `dashboard/suggestions/index.ts`'s scoping and
 * validation style: validate the id, validate the body against the schema,
 * merge in disk-read state the client cannot supply, write atomically.
 */

export type FinishReviewError =
  | { readonly ok: false; readonly status: 400; readonly error: string }
  | { readonly ok: false; readonly status: 404; readonly error: string };

export type FinishReviewResult =
  | { readonly ok: true; readonly value: ReviewVerdictRecord }
  | FinishReviewError;

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * The agent's side of the chain for this phase, read off disk at write time:
 * `phases/{phase}/confidence.json` (the same file `getPhase()` surfaces) and
 * `review/gates/{phase}.json` (the independent reviewer's gate decision +
 * feedback). Best-effort — a missing or malformed file reads through as
 * null rather than blocking the human's verdict from being recorded.
 */
async function readAgentReview(
  tasksDir: string,
  id: string,
  phase: string,
): Promise<{
  agent_confidence: unknown;
  agent_gate_decision: string | null;
  agent_gate_feedback: string | null;
}> {
  const dir = taskDir(tasksDir, id);
  const agent_confidence = await readJson(
    path.join(dir, "phases", phase, "confidence.json"),
  );

  let agent_gate_decision: string | null = null;
  let agent_gate_feedback: string | null = null;
  const gateRaw = await readJson(path.join(dir, "review", "gates", `${phase}.json`));
  if (gateRaw !== null) {
    const gate = validateGateFile(gateRaw);
    if (gate.ok) {
      agent_gate_decision = gate.value.decision;
      agent_gate_feedback = gate.value.feedback ?? null;
    }
  }

  return { agent_confidence, agent_gate_decision, agent_gate_feedback };
}

export function reviewVerdictPath(tasksDir: string, id: string, phase: string): string {
  return path.join(taskDir(tasksDir, id), "review", "verdict", `${phase}.json`);
}

/**
 * Validate + write a human review verdict. `body` is the raw (untyped)
 * request body — validated here, not trusted from the route. Returns the
 * written record on success, or a status+error pair the route maps straight
 * to the HTTP response.
 */
export async function finishReview(
  tasksDir: string,
  id: string,
  body: unknown,
): Promise<FinishReviewResult> {
  if (!isValidTaskId(id)) {
    return { ok: false, status: 400, error: "invalid task id" };
  }

  const input = validateReviewFinishInput(body);
  if (!input.ok) {
    return {
      ok: false,
      status: 400,
      error: input.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
    };
  }

  // The phase becomes a path segment (review/verdict/{phase}.json) — guard
  // traversal the same way every other phase-scoped route does.
  if (!isSafeSegment(input.value.phase)) {
    return { ok: false, status: 400, error: "invalid phase" };
  }

  const dir = taskDir(tasksDir, id);
  try {
    await readFile(path.join(dir, "task.json"), "utf8");
  } catch {
    return { ok: false, status: 404, error: "task not found" };
  }

  const agentReview = await readAgentReview(tasksDir, id, input.value.phase);

  const record = {
    ...input.value,
    ...agentReview,
    reviewed_at: new Date().toISOString(),
  };

  const validated = validateReviewVerdictRecord(record);
  if (!validated.ok) {
    // Internal error: our own merge produced something the schema rejects.
    throw new Error(
      `Internal error building review/verdict/${input.value.phase}.json: ${validated.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ")}`,
    );
  }

  await atomicWriteJson(reviewVerdictPath(tasksDir, id, input.value.phase), validated.value);
  return { ok: true, value: validated.value };
}
