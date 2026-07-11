import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundTaskInfo } from "./signals.js";

/** Pull the SDK session id off any message that carries one. */
export function extractSessionId(msg: SDKMessage): string | undefined {
  if (
    typeof msg === "object" &&
    msg !== null &&
    "session_id" in msg &&
    typeof (msg as { session_id?: unknown }).session_id === "string"
  ) {
    return (msg as { session_id: string }).session_id;
  }
  return undefined;
}

/**
 * Extract concatenated text blocks from an assistant message, for the
 * ephemeral `log` SSE event (design §13) — a real transcript snippet, not a
 * synthetic status line. Returns undefined for non-assistant messages or
 * assistant turns with no text content (e.g. tool-use only).
 */
export function extractAssistantText(msg: SDKMessage): string | undefined {
  if (typeof msg !== "object" || msg === null) return undefined;
  if ((msg as { type?: unknown }).type !== "assistant") return undefined;

  const message = (msg as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return undefined;

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }

  const text = parts.join(" ").trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Extract background task list from a `background_tasks_changed` system
 * message. Returns undefined for any other message type.
 *
 * The SDK emits these with REPLACE semantics: the `tasks` array is the
 * full set of live background tasks after the change.
 */
export function extractBackgroundTasks(
  msg: SDKMessage,
): BackgroundTaskInfo[] | undefined {
  if (typeof msg !== "object" || msg === null) return undefined;
  const m = msg as { type?: unknown; subtype?: unknown; tasks?: unknown };
  if (m.type !== "system" || m.subtype !== "background_tasks_changed")
    return undefined;
  if (!Array.isArray(m.tasks)) return undefined;

  return m.tasks.map(
    (t: { task_id?: string; task_type?: string; description?: string }) => ({
      taskId: t.task_id ?? "",
      taskType: t.task_type ?? "",
      description: t.description ?? "",
    }),
  );
}
