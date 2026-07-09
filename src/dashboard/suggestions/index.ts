import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  isValidTaskId,
  validateSuggestionEntry,
  validateSuggestionsJson,
  validateTaskJson,
  type SuggestionEntry,
} from "../../schema/index.js";
import { taskDir } from "../api/index.js";

/**
 * Suggestions POST handler (design §17). Appends a scientist's note for the
 * protocol author to suggestions/suggestions.json, atomically (temp → fsync →
 * rename, matching the disk-contract atomicity rule in design §3). The id and
 * createdAt are assigned server-side; the author is the configured user.
 */

export type NewSuggestion = {
  readonly phase: string;
  readonly text: string;
};

async function readSuggestions(file: string): Promise<SuggestionEntry[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
  const res = validateSuggestionsJson(raw);
  return res.ok ? [...res.value] : [];
}

/** Next `sg-NNN` id, scanning existing ids for the max numeric suffix. */
function nextId(existing: readonly SuggestionEntry[]): string {
  let max = 0;
  for (const s of existing) {
    const m = /^sg-(\d+)$/.exec(s.id);
    if (m && m[1]) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `sg-${String(max + 1).padStart(3, "0")}`;
}

async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

/**
 * Append a suggestion for a task. Returns the stored entry, or null if the task
 * id is invalid, the task has no valid task.json, or the entry fails schema
 * validation.
 */
export async function appendSuggestion(
  tasksDir: string,
  id: string,
  input: NewSuggestion,
  author: string,
): Promise<SuggestionEntry | null> {
  if (!isValidTaskId(id)) return null;

  const dir = taskDir(tasksDir, id);
  let taskRaw: unknown;
  try {
    taskRaw = JSON.parse(await readFile(path.join(dir, "task.json"), "utf8"));
  } catch {
    return null;
  }
  const task = validateTaskJson(taskRaw);
  if (!task.ok) return null;

  const file = path.join(dir, "suggestions", "suggestions.json");
  const existing = await readSuggestions(file);

  const entry: SuggestionEntry = {
    id: nextId(existing),
    taskId: id,
    protocol: task.value.protocol,
    phase: input.phase,
    text: input.text,
    createdAt: new Date().toISOString(),
    author,
  };

  const validated = validateSuggestionEntry(entry);
  if (!validated.ok) return null;

  await atomicWriteJson(file, [...existing, validated.value]);
  return validated.value;
}
