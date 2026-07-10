import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

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
