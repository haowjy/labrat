import {
  expectEnum,
  expectIsoDateTime,
  expectNonEmptyString,
  expectRecord,
  expectString,
  expectStringArray,
  failure,
  type ValidationResult,
  success,
} from "./validation.js";

export const TASK_STATES = [
  "queued",
  "running",
  "paused",
  "done",
  "failed",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** task.json — harness-owned per-task state (design §5). */
export type TaskJson = {
  readonly id: string;
  readonly protocol: string;
  readonly input: string;
  readonly state: TaskState;
  readonly currentPhase: string | null;
  readonly phasesComplete: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when state is paused or failed (design §12). */
  readonly reason?: string;
};

const TASK_ID_RE = /^task-\d{4}-\d{2}-\d{2}-\d{3}$/;

export function isValidTaskId(id: string): boolean {
  return TASK_ID_RE.test(id);
}

export function validateTaskJson(value: unknown): ValidationResult<TaskJson> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const id = expectNonEmptyString(rec.value["id"], "$.id");
  if (!id.ok) return id;
  if (!isValidTaskId(id.value)) {
    return failure([
      {
        path: "$.id",
        message: "expected task id format task-YYYY-MM-DD-NNN",
      },
    ]);
  }

  const protocol = expectNonEmptyString(rec.value["protocol"], "$.protocol");
  if (!protocol.ok) return protocol;

  const input = expectNonEmptyString(rec.value["input"], "$.input");
  if (!input.ok) return input;

  const state = expectEnum(rec.value["state"], "$.state", TASK_STATES);
  if (!state.ok) return state;

  let currentPhase: string | null = null;
  const cp = rec.value["currentPhase"];
  if (cp !== null && cp !== undefined) {
    const cpStr = expectString(cp, "$.currentPhase");
    if (!cpStr.ok) return cpStr;
    currentPhase = cpStr.value;
  }

  const phasesComplete = expectStringArray(
    rec.value["phasesComplete"],
    "$.phasesComplete",
  );
  if (!phasesComplete.ok) return phasesComplete;

  const createdAt = expectIsoDateTime(rec.value["createdAt"], "$.createdAt");
  if (!createdAt.ok) return createdAt;

  const updatedAt = expectIsoDateTime(rec.value["updatedAt"], "$.updatedAt");
  if (!updatedAt.ok) return updatedAt;

  const reason =
    rec.value["reason"] === undefined
      ? undefined
      : expectString(rec.value["reason"], "$.reason");
  if (reason !== undefined && !reason.ok) return reason;

  const task: TaskJson = {
    id: id.value,
    protocol: protocol.value,
    input: input.value,
    state: state.value,
    currentPhase,
    phasesComplete: phasesComplete.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    ...(reason?.ok && reason.value !== undefined
      ? { reason: reason.value }
      : {}),
  };

  return success(task);
}
