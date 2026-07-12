/**
 * Deterministic collapsed view of persisted session logs
 * (review-provenance design §3C — `read_past_history`).
 *
 * The collapse is extractive, NOT an LLM: phase `summary.md`, the gate
 * headline/decision, message-type counts, tool names/status, and at most the
 * first/last 240 visible characters of assistant messages. Inputs are the
 * sanitized `SessionMessageV1` JSONL files written by session-log.ts; on top
 * of that, `expand` re-sanitizes stored payloads before returning them, so
 * thinking blocks, secrets, and binary blobs can never surface even if a
 * foreign writer produced the file.
 *
 * Kept separate from the MCP handler so the sensitive dashboard endpoint can
 * later reuse the exact same pagination/content (design §5 invariant).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeCursor, encodeCursor } from "../../util/cursor.js";
import {
  parseSessionLog,
  sanitizeSdkMessage,
  type SessionMessageV1,
  type SessionRole,
} from "./session-log.js";

const SESSION_ROLES: readonly SessionRole[] = [
  "worker",
  "gate-reviewer",
  "review-artifact-author",
];

/** First/last visible characters retained per assistant message (design §3C). */
const ASSISTANT_EXCERPT_CHARS = 240;
/** Shorter excerpt for non-assistant material (tool results, prompts). */
const CONTEXT_EXCERPT_CHARS = 120;
/** summary.md excerpt length in the per-session assistant_summary. */
const SUMMARY_EXCERPT_CHARS = 480;
/** Design estimate: ~4 characters per token. */
const CHARS_PER_TOKEN = 4;
/** Approximate JSON envelope overhead outside sessions/expanded arrays. */
const ENVELOPE_OVERHEAD_CHARS = 96;

export type CollapsedToolCall = {
  readonly name: string;
  readonly count: number;
  readonly error_count: number;
};

export type CollapsedMessage = {
  readonly id: string;
  readonly at: string;
  readonly kind: string;
  readonly excerpt: string;
};

export type CollapsedSession = {
  readonly phase: string;
  readonly attempt: number;
  readonly role: SessionRole;
  readonly source_path: string;
  readonly session_id: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly message_count: number;
  readonly outcome: string | null;
  readonly assistant_summary: string;
  readonly tool_calls: readonly CollapsedToolCall[];
  readonly messages: readonly CollapsedMessage[];
};

export type PastHistoryView = {
  readonly schema_version: 1;
  readonly sessions: readonly CollapsedSession[];
  readonly expanded: ReadonlyArray<{ readonly id: string; readonly content: unknown }>;
  readonly next_cursor: string | null;
  readonly truncated: boolean;
};

export type PastHistoryOptions = {
  readonly taskDir: string;
  /** Author-visible phases in protocol declaration order (≤ current phase). */
  readonly visiblePhases: readonly string[];
  readonly phase?: string;
  readonly role?: SessionRole;
  readonly cursor?: string;
  readonly maxTokens: number;
  readonly expand?: readonly string[];
};

export type PastHistoryResult =
  | { readonly ok: true; readonly view: PastHistoryView }
  | { readonly ok: false; readonly error: string };

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

type LoadedSession = {
  readonly phase: string;
  readonly attempt: number;
  readonly role: SessionRole;
  readonly archived: boolean;
  /** Relative to taskDir, e.g. phases/seg.attempt-1/sessions/worker.jsonl */
  readonly sourcePath: string;
  /** Relative phase dir holding summary.md for this attempt. */
  readonly phaseDirRel: string;
  readonly messages: readonly SessionMessageV1[];
  readonly truncatedFinalLine: boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * All parseable session logs for one phase: archived attempts ascending,
 * live attempt last (design: newest attempt last). Unreadable or malformed
 * logs are skipped — a corrupt historical file must not break the view.
 */
async function loadPhaseSessions(
  taskDir: string,
  phase: string,
  roleFilter: SessionRole | undefined,
): Promise<LoadedSession[]> {
  const phasesRoot = join(taskDir, "phases");
  let entries: string[];
  try {
    entries = await readdir(phasesRoot);
  } catch {
    return [];
  }

  const archivedRe = new RegExp(`^${escapeRegExp(phase)}\\.attempt-(\\d+)$`);
  const dirs: Array<{ readonly dir: string; readonly archivedAttempt: number | null }> = [];
  for (const entry of entries) {
    const match = archivedRe.exec(entry);
    if (match) {
      dirs.push({ dir: entry, archivedAttempt: Number(match[1]) });
    }
  }
  dirs.sort((a, b) => (a.archivedAttempt ?? 0) - (b.archivedAttempt ?? 0));
  if (entries.includes(phase)) {
    dirs.push({ dir: phase, archivedAttempt: null });
  }

  const sessions: LoadedSession[] = [];
  for (const { dir, archivedAttempt } of dirs) {
    const sessionsDir = join(phasesRoot, dir, "sessions");
    let files: string[];
    try {
      files = await readdir(sessionsDir);
    } catch {
      continue;
    }
    for (const role of SESSION_ROLES) {
      if (roleFilter !== undefined && role !== roleFilter) {
        continue;
      }
      const file = `${role}.jsonl`;
      if (!files.includes(file)) {
        continue;
      }
      let parsed: ReturnType<typeof parseSessionLog>;
      try {
        parsed = parseSessionLog(await readFile(join(sessionsDir, file), "utf8"));
      } catch {
        continue;
      }
      const first = parsed.messages[0];
      if (!first) {
        continue;
      }
      sessions.push({
        phase,
        attempt: archivedAttempt ?? first.phase_attempt,
        role,
        archived: archivedAttempt !== null,
        sourcePath: `phases/${dir}/sessions/${file}`,
        phaseDirRel: `phases/${dir}`,
        messages: parsed.messages,
        truncatedFinalLine: parsed.truncatedFinalLine,
      });
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Deterministic extraction from sanitized SDK messages
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(rec: Record<string, unknown> | null, key: string): string | null {
  const value = rec?.[key];
  return typeof value === "string" ? value : null;
}

/** Collapse whitespace and keep at most the first/last `n` characters. */
function firstLastExcerpt(text: string, n: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 2 * n + 3) {
    return clean;
  }
  return `${clean.slice(0, n)} … ${clean.slice(-n)}`;
}

function messageKind(sdk: Record<string, unknown> | null): string {
  const type = stringField(sdk, "type") ?? "unknown";
  const subtype = stringField(sdk, "subtype");
  return subtype ? `${type}:${subtype}` : type;
}

function contentBlocks(sdk: Record<string, unknown> | null): readonly unknown[] {
  const message = asRecord(sdk?.["message"]);
  const content = message?.["content"] ?? sdk?.["content"];
  return Array.isArray(content) ? content : [];
}

function visibleText(blocks: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const rec = asRecord(block);
    if (stringField(rec, "type") === "text") {
      const text = stringField(rec, "text");
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

function toolUseNames(blocks: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const block of blocks) {
    const rec = asRecord(block);
    if (stringField(rec, "type") === "tool_use") {
      names.push(stringField(rec, "name") ?? "unknown");
    }
  }
  return names;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content) ? visibleText(content) : "";
}

function messageExcerpt(sdk: Record<string, unknown> | null): string {
  const type = stringField(sdk, "type");
  const blocks = contentBlocks(sdk);

  if (type === "assistant") {
    const text = firstLastExcerpt(visibleText(blocks), ASSISTANT_EXCERPT_CHARS);
    const names = toolUseNames(blocks);
    const suffix = names.length > 0 ? `[tool_use: ${names.join(", ")}]` : "";
    return [text, suffix].filter((s) => s.length > 0).join(" ");
  }

  if (type === "user") {
    const parts: string[] = [];
    for (const block of blocks) {
      const rec = asRecord(block);
      if (stringField(rec, "type") !== "tool_result") {
        continue;
      }
      const isError = rec?.["is_error"] === true;
      const text = firstLastExcerpt(toolResultText(rec?.["content"]), CONTEXT_EXCERPT_CHARS);
      parts.push(`[tool_result${isError ? " error" : ""}] ${text}`.trim());
    }
    if (parts.length > 0) {
      return parts.join("; ");
    }
    return firstLastExcerpt(visibleText(blocks), CONTEXT_EXCERPT_CHARS);
  }

  if (type === "result") {
    const result = stringField(asRecord(sdk), "result");
    return result ? firstLastExcerpt(result, ASSISTANT_EXCERPT_CHARS) : "";
  }

  return "";
}

function aggregateToolCalls(messages: readonly SessionMessageV1[]): CollapsedToolCall[] {
  const byName = new Map<string, { count: number; error_count: number }>();
  const idToName = new Map<string, string>();

  for (const msg of messages) {
    const sdk = asRecord(msg.sdk_message);
    for (const block of contentBlocks(sdk)) {
      const rec = asRecord(block);
      const type = stringField(rec, "type");
      if (type === "tool_use") {
        const name = stringField(rec, "name") ?? "unknown";
        const id = stringField(rec, "id");
        if (id) {
          idToName.set(id, name);
        }
        const entry = byName.get(name) ?? { count: 0, error_count: 0 };
        entry.count += 1;
        byName.set(name, entry);
      } else if (type === "tool_result" && rec?.["is_error"] === true) {
        const useId = stringField(rec, "tool_use_id");
        const name = (useId ? idToName.get(useId) : undefined) ?? "unknown";
        const entry = byName.get(name) ?? { count: 0, error_count: 0 };
        entry.error_count += 1;
        byName.set(name, entry);
      }
    }
  }

  return [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { count, error_count }]) => ({ name, count, error_count }));
}

function messageTypeCounts(messages: readonly SessionMessageV1[]): string {
  const counts = new Map<string, number>();
  for (const msg of messages) {
    const type = stringField(asRecord(msg.sdk_message), "type") ?? "unknown";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type}=${count}`)
    .join(" ");
}

function lastAssistantExcerpt(messages: readonly SessionMessageV1[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const sdk = asRecord(messages[i]?.sdk_message);
    if (stringField(sdk, "type") !== "assistant") {
      continue;
    }
    const text = visibleText(contentBlocks(sdk));
    if (text.trim().length > 0) {
      return firstLastExcerpt(text, ASSISTANT_EXCERPT_CHARS);
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Per-session collapse
// ---------------------------------------------------------------------------

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Gate headline for the attempt: `review/gates/<phase>.json` for the live
 * attempt, `<phase>.attempt-N.json` for archived ones (invalidation idiom). */
async function readGateHeadline(
  taskDir: string,
  session: LoadedSession,
): Promise<{ decision: string | null; summary: string | null }> {
  const name = session.archived
    ? `${session.phase}.attempt-${session.attempt}.json`
    : `${session.phase}.json`;
  const raw = await readOptionalText(join(taskDir, "review", "gates", name));
  if (raw === null) {
    return { decision: null, summary: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { decision: null, summary: null };
  }
  const rec = asRecord(parsed);
  return {
    decision: stringField(rec, "decision"),
    summary: stringField(rec, "summary"),
  };
}

function messageId(session: LoadedSession, ordinal: number): string {
  return `${session.phase}:${session.attempt}:${session.role}:${ordinal}`;
}

async function collapseSession(
  taskDir: string,
  session: LoadedSession,
): Promise<CollapsedSession> {
  const { messages } = session;
  const first = messages[0] as SessionMessageV1;
  const last = messages[messages.length - 1] as SessionMessageV1;

  const gate = await readGateHeadline(taskDir, session);
  const summaryMd = await readOptionalText(
    join(taskDir, session.phaseDirRel, "summary.md"),
  );

  const summaryParts: string[] = [];
  if (summaryMd !== null && summaryMd.trim().length > 0) {
    summaryParts.push(
      `summary.md: ${firstLastExcerpt(summaryMd, SUMMARY_EXCERPT_CHARS / 2)}`,
    );
  } else {
    const excerpt = lastAssistantExcerpt(messages);
    if (excerpt.length > 0) {
      summaryParts.push(`last assistant: ${excerpt}`);
    }
  }
  if (gate.decision !== null) {
    const headline = gate.summary
      ? ` — ${firstLastExcerpt(gate.summary, ASSISTANT_EXCERPT_CHARS)}`
      : "";
    summaryParts.push(`gate: ${gate.decision}${headline}`);
  }
  summaryParts.push(`messages: ${messageTypeCounts(messages)}`);

  return {
    phase: session.phase,
    attempt: session.attempt,
    role: session.role,
    source_path: session.sourcePath,
    session_id: messages.find((m) => m.session_id !== null)?.session_id ?? null,
    started_at: first.captured_at,
    ended_at: session.truncatedFinalLine ? null : last.captured_at,
    message_count: messages.length,
    outcome: gate.decision,
    assistant_summary: summaryParts.join("\n"),
    tool_calls: aggregateToolCalls(messages),
    messages: messages.map((m) => ({
      id: messageId(session, m.message_ordinal),
      at: m.captured_at,
      kind: messageKind(asRecord(m.sdk_message)),
      excerpt: messageExcerpt(asRecord(m.sdk_message)),
    })),
  };
}

// ---------------------------------------------------------------------------
// Expand
// ---------------------------------------------------------------------------

type ParsedMessageId = {
  readonly phase: string;
  readonly attempt: number;
  readonly role: SessionRole;
  readonly ordinal: number;
};

function parseMessageId(id: string): ParsedMessageId | null {
  const parts = id.split(":");
  if (parts.length < 4) {
    return null;
  }
  const ordinal = Number(parts[parts.length - 1]);
  const role = parts[parts.length - 2] as SessionRole;
  const attempt = Number(parts[parts.length - 3]);
  const phase = parts.slice(0, -3).join(":");
  if (
    phase.length === 0 ||
    !SESSION_ROLES.includes(role) ||
    !Number.isInteger(attempt) ||
    attempt < 0 ||
    !Number.isInteger(ordinal) ||
    ordinal < 1
  ) {
    return null;
  }
  return { phase, attempt, role, ordinal };
}

// ---------------------------------------------------------------------------
// View assembly
// ---------------------------------------------------------------------------

/**
 * Build the collapsed, size-bounded history view. Pure disk read — never
 * writes, never sets signals. Scope is the caller-computed visible phase
 * list; an explicit `phase` or any `expand` ID outside it is an error.
 */
export async function buildPastHistoryView(
  options: PastHistoryOptions,
): Promise<PastHistoryResult> {
  const { taskDir, visiblePhases, maxTokens } = options;

  if (options.phase !== undefined && !visiblePhases.includes(options.phase)) {
    return {
      ok: false,
      error: `phase "${options.phase}" is not in the author-visible scope (${visiblePhases.join(", ") || "none"})`,
    };
  }

  let startSession = 0;
  let startMessage = 0;
  if (options.cursor !== undefined) {
    const decoded = decodeCursor(options.cursor);
    if (decoded === null || typeof decoded["s"] !== "number" || typeof decoded["m"] !== "number") {
      return { ok: false, error: "invalid cursor" };
    }
    startSession = decoded["s"];
    startMessage = decoded["m"];
  }

  // Lazy per-phase cache so expand and listing share one read per phase.
  const cache = new Map<string, Promise<LoadedSession[]>>();
  const loadPhase = (phase: string, roleFilter?: SessionRole): Promise<LoadedSession[]> => {
    const key = `${phase} ${roleFilter ?? "*"}`;
    let promise = cache.get(key);
    if (!promise) {
      promise = loadPhaseSessions(taskDir, phase, roleFilter);
      cache.set(key, promise);
    }
    return promise;
  };

  // Resolve expansions first — explicitly requested, capped upstream.
  const expanded: Array<{ id: string; content: unknown }> = [];
  for (const id of options.expand ?? []) {
    const parsedId = parseMessageId(id);
    if (parsedId === null) {
      return { ok: false, error: `invalid message id: "${id}"` };
    }
    if (!visiblePhases.includes(parsedId.phase)) {
      return {
        ok: false,
        error: `message id "${id}" targets a phase outside the author-visible scope`,
      };
    }
    const sessions = await loadPhase(parsedId.phase);
    const session = sessions.find(
      (s) => s.attempt === parsedId.attempt && s.role === parsedId.role,
    );
    const message = session?.messages.find(
      (m) => m.message_ordinal === parsedId.ordinal,
    );
    expanded.push({
      id,
      // Stored content is sanitized at write; re-sanitize defensively so a
      // foreign/hand-written log line still cannot surface thinking/secrets.
      content: message ? sanitizeSdkMessage(message.sdk_message, []) : { error: "message not found" },
    });
  }

  // Ordered session list across the scoped phases.
  const scopePhases = options.phase !== undefined ? [options.phase] : visiblePhases;
  const loaded: LoadedSession[] = [];
  for (const phase of scopePhases) {
    loaded.push(...(await loadPhase(phase, options.role)));
  }

  const budgetChars = maxTokens * CHARS_PER_TOKEN;
  let usedChars = ENVELOPE_OVERHEAD_CHARS + JSON.stringify(expanded).length;

  const sessions: Array<CollapsedSession & { messages: CollapsedMessage[] }> = [];
  let nextCursor: string | null = null;
  let truncated = false;

  outer: for (let i = startSession; i < loaded.length; i++) {
    const collapsed = await collapseSession(taskDir, loaded[i] as LoadedSession);
    const header = { ...collapsed, messages: [] as CollapsedMessage[] };
    const headerCost = JSON.stringify(header).length + 1;
    if (sessions.length > 0 && usedChars + headerCost > budgetChars) {
      nextCursor = encodeCursor({ s: i, m: 0 });
      truncated = true;
      break;
    }
    usedChars += headerCost;
    sessions.push(header);

    const firstMessage = i === startSession ? startMessage : 0;
    for (let j = firstMessage; j < collapsed.messages.length; j++) {
      const entry = collapsed.messages[j] as CollapsedMessage;
      const cost = JSON.stringify(entry).length + 1;
      const emittedAnything = sessions.length > 1 || header.messages.length > 0;
      if (usedChars + cost > budgetChars && emittedAnything) {
        nextCursor = encodeCursor({ s: i, m: j });
        truncated = true;
        break outer;
      }
      usedChars += cost;
      header.messages.push(entry);
    }
  }

  return {
    ok: true,
    view: {
      schema_version: 1,
      sessions,
      expanded,
      next_cursor: nextCursor,
      truncated,
    },
  };
}
