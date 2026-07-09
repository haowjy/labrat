import {
  expectArray,
  expectIsoDateTime,
  expectNonEmptyString,
  expectRecord,
  expectString,
  type ValidationResult,
  success,
} from "./validation.js";
import { isValidTaskId } from "./task.js";

/** Single suggestions.json entry (design §17). */
export type SuggestionEntry = {
  readonly id: string;
  readonly taskId: string;
  readonly protocol: string;
  readonly phase: string;
  readonly text: string;
  readonly createdAt: string;
  readonly author: string;
};

export type SuggestionsJson = readonly SuggestionEntry[];

export function validateSuggestionEntry(
  value: unknown,
): ValidationResult<SuggestionEntry> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const id = expectNonEmptyString(rec.value["id"], "$.id");
  if (!id.ok) return id;

  const taskId = expectNonEmptyString(rec.value["taskId"], "$.taskId");
  if (!taskId.ok) return taskId;
  if (!isValidTaskId(taskId.value)) {
    return {
      ok: false,
      errors: [
        {
          path: "$.taskId",
          message: "expected task id format task-YYYY-MM-DD-NNN",
        },
      ],
    };
  }

  const protocol = expectNonEmptyString(rec.value["protocol"], "$.protocol");
  if (!protocol.ok) return protocol;

  const phase = expectNonEmptyString(rec.value["phase"], "$.phase");
  if (!phase.ok) return phase;

  const text = expectString(rec.value["text"], "$.text");
  if (!text.ok) return text;

  const createdAt = expectIsoDateTime(rec.value["createdAt"], "$.createdAt");
  if (!createdAt.ok) return createdAt;

  const author = expectNonEmptyString(rec.value["author"], "$.author");
  if (!author.ok) return author;

  return success({
    id: id.value,
    taskId: taskId.value,
    protocol: protocol.value,
    phase: phase.value,
    text: text.value,
    createdAt: createdAt.value,
    author: author.value,
  });
}

export function validateSuggestionsJson(
  value: unknown,
): ValidationResult<SuggestionsJson> {
  const arr = expectArray(value, "$");
  if (!arr.ok) return arr;

  const out: SuggestionEntry[] = [];
  for (let i = 0; i < arr.value.length; i++) {
    const entry = validateSuggestionEntry(arr.value[i]);
    if (!entry.ok) {
      return {
        ok: false,
        errors: entry.errors.map((e) => ({
          path: `$[${i}]${e.path === "$" ? "" : e.path.slice(1)}`,
          message: e.message,
        })),
      };
    }
    out.push(entry.value);
  }
  return success(out);
}
