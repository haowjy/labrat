/**
 * Reconstruct the worker session id for an already-recorded phase, for the
 * standalone `gate <task-id> <phase>` CLI (design §6/§14 — the full loop
 * calls runGate inline and already has this id from runWorkerPhase; the
 * standalone path re-derives it from the SDK's own on-disk conversation
 * history instead of re-running the ~20min worker session).
 *
 * The SDK persists one JSONL transcript per session under
 * `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`, where cwd-slug is the
 * task dir with `/` and `.` replaced by `-`. Each transcript's `last-prompt`
 * entry contains the exact worker user prompt
 * (`Execute the **{phase}** phase for task {taskId}.` — see
 * session/worker.ts `phaseUserPrompt`), which is enough to identify it.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

type LastPromptEntry = {
  readonly type: "last-prompt";
  readonly lastPrompt: string;
  readonly sessionId: string;
};

function isLastPromptEntry(value: unknown): value is LastPromptEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "last-prompt" &&
    typeof (value as { lastPrompt?: unknown }).lastPrompt === "string" &&
    typeof (value as { sessionId?: unknown }).sessionId === "string"
  );
}

async function firstTimestamp(filePath: string): Promise<string | undefined> {
  const raw = await readFile(filePath, "utf8");
  const firstLine = raw.split("\n", 1)[0];
  if (!firstLine) return undefined;
  try {
    const parsed: unknown = JSON.parse(firstLine);
    const ts = (parsed as { timestamp?: unknown }).timestamp;
    return typeof ts === "string" ? ts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find the most recent worker session for `phaseId`/`taskId` in `taskDir`'s
 * SDK conversation history. Returns undefined if none is found (e.g. a task
 * dir moved, or run under a different SDK project root).
 */
export async function findRecordedWorkerSessionId(
  taskDir: string,
  taskId: string,
  phaseId: string,
): Promise<string | undefined> {
  const projectDir = join(homedir(), ".claude", "projects", claudeProjectSlug(taskDir));

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return undefined;
  }

  // Must match ONLY the worker's phaseUserPrompt (session/worker.ts), not the
  // reviewer's "Independently review the **{phase}** phase..." prompt, which
  // shares the "**{phase}** phase for task {taskId}" substring.
  const marker = `Execute the **${phaseId}** phase for task ${taskId}`;
  const candidates: { readonly sessionId: string; readonly ts: string }[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const filePath = join(projectDir, entry);
    const raw = await readFile(filePath, "utf8").catch(() => "");
    if (!raw.includes(marker)) continue;

    let sessionId: string | undefined;
    for (const line of raw.split("\n")) {
      if (!line.includes('"last-prompt"')) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isLastPromptEntry(parsed) && parsed.lastPrompt.includes(marker)) {
          sessionId = parsed.sessionId;
        }
      } catch {
        // ignore malformed line
      }
    }
    if (!sessionId) continue;

    const ts = (await firstTimestamp(filePath)) ?? "";
    candidates.push({ sessionId, ts });
  }

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return candidates[0]?.sessionId;
}
