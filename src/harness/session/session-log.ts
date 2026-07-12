/**
 * Sanitized per-role session logs (review-provenance design §3A).
 *
 * Appends one JSON line per yielded SDK message to
 * `phases/<phase>/sessions/<role>.jsonl` under the task dir. The live attempt
 * always uses the stable role filename; `archiveAndResetPhase` renames the
 * whole `phases/<phase>/` directory to `<phase>.attempt-N`, so session logs
 * are one file per role per phase attempt without embedding the attempt
 * number in the live path.
 *
 * Sanitization is part of the schema, not a best-effort UI filter: it runs
 * BEFORE append, so raw thinking blocks, secrets, and binary blobs never
 * touch disk. The writer never reads `process.env` — configured secret
 * values are supplied by the caller from `loadConfig()`.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SessionRole = "worker" | "gate-reviewer" | "review-artifact-author";

export type SessionMessageV1 = {
  readonly schema_version: 1;
  readonly captured_at: string;
  readonly task_id: string;
  readonly phase: string;
  readonly phase_attempt: number;
  readonly role: SessionRole;
  readonly query_ordinal: number;
  readonly message_ordinal: number;
  readonly session_id: string | null;
  /** Sanitized SDK payload — kept forward-compatible as unknown. */
  readonly sdk_message: unknown;
};

export type SessionLogger = {
  append(sdkMessage: unknown, opts: { queryOrdinal: number }): Promise<void>;
};

export type SessionLoggerOptions = {
  readonly taskDir: string;
  readonly taskId: string;
  readonly phase: string;
  /** Phase attempt number — threaded explicitly, never inferred from archives. */
  readonly attempt: number;
  readonly role: SessionRole;
  /** Exact secret string values (from loadConfig()) to redact wherever they
   * appear. The writer never reads process.env itself. */
  readonly secrets: readonly string[];
};

/** Live session-log path for a role within a phase. */
export function sessionLogPath(
  taskDir: string,
  phase: string,
  role: SessionRole,
): string {
  return join(taskDir, "phases", phase, "sessions", `${role}.jsonl`);
}

/**
 * True when a path targets a session log (live `phases/<phase>/sessions/` or
 * archived `phases/<phase>.attempt-N/sessions/`). Used by the reviewer's
 * PreToolUse deny hook to preserve reviewer independence.
 */
export function isSessionLogPath(path: string): boolean {
  return /(^|\/)phases\/[^/]+\/sessions(\/|$)/.test(path);
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

const SECRET_KEY_RE = /authorization|cookie|token|secret|password|api[_-]?key/i;

/** Keys whose values are hidden reasoning, config/env dumps, or cache
 * payloads — dropped entirely rather than redacted. */
const DROPPED_KEY_RE = /^(signature|thinking|redacted_thinking|reasoning|env|environment|cache_control)$/;

/** Content-block types that carry hidden model reasoning. */
const THINKING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

const MAX_RETAINED_STRING_BYTES = 256 * 1024;

/** Strings at least this long that look like pure base64 are treated as
 * binary blobs and dropped (design: no binary/base64 payloads on disk). */
const BASE64_BLOB_MIN_LENGTH = 4096;
const BASE64_BODY_RE = /^[A-Za-z0-9+/=\r\n]+$/;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function looksLikeBase64Blob(value: string): boolean {
  if (value.startsWith("data:") && value.includes(";base64,")) {
    return true;
  }
  return value.length >= BASE64_BLOB_MIN_LENGTH && BASE64_BODY_RE.test(value);
}

function sanitizeString(value: string, secrets: readonly string[]): unknown {
  let out = value;
  for (const secret of secrets) {
    if (secret.length > 0 && out.includes(secret)) {
      out = out.split(secret).join("[REDACTED]");
    }
  }

  if (looksLikeBase64Blob(out)) {
    return {
      omitted: "binary/base64",
      bytes: Buffer.byteLength(out, "utf8"),
      sha256: sha256Hex(out),
    };
  }

  const bytes = Buffer.byteLength(out, "utf8");
  if (bytes > MAX_RETAINED_STRING_BYTES) {
    return {
      truncated: true,
      text: Buffer.from(out, "utf8")
        .subarray(0, MAX_RETAINED_STRING_BYTES)
        .toString("utf8"),
      truncated_bytes: bytes - MAX_RETAINED_STRING_BYTES,
      sha256: sha256Hex(out),
    };
  }

  return out;
}

function isThinkingBlock(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string" &&
    THINKING_BLOCK_TYPES.has((value as { type: string }).type)
  );
}

function sanitizeValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return sanitizeString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry) => !isThinkingBlock(entry))
      .map((entry) => sanitizeValue(entry, secrets));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (DROPPED_KEY_RE.test(key)) {
        continue;
      }
      // Redact secret-keyed values, but only types that can carry secret
      // material — numbers/booleans stay so `usage.input_tokens` etc. survive.
      if (SECRET_KEY_RE.test(key) && (typeof entry === "string" || typeof entry === "object")) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = sanitizeValue(entry, secrets);
    }
    return out;
  }
  return value;
}

/** Init messages are a config/environment dump — retain only identity. */
const INIT_RETAINED_KEYS = ["type", "subtype", "session_id", "uuid", "model", "cwd"] as const;

/**
 * Sanitize one SDK message for persistence. Retains assistant visible text,
 * tool name/input/result, message subtype, errors, and usage; drops hidden
 * thinking, signatures, env/init/config dumps, cache payloads, binary blobs,
 * and anything under a secret-looking key.
 */
export function sanitizeSdkMessage(
  sdkMessage: unknown,
  secrets: readonly string[],
): unknown {
  if (
    typeof sdkMessage === "object" &&
    sdkMessage !== null &&
    (sdkMessage as { type?: unknown }).type === "system" &&
    (sdkMessage as { subtype?: unknown }).subtype === "init"
  ) {
    const record = sdkMessage as Record<string, unknown>;
    const retained: Record<string, unknown> = {};
    for (const key of INIT_RETAINED_KEYS) {
      if (key in record) {
        retained[key] = record[key];
      }
    }
    return sanitizeValue(retained, secrets);
  }
  return sanitizeValue(sdkMessage, secrets);
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Per-path promise queue: appends to the same file always land in yield
 * order, even across logger instances (e.g. continuation queries). */
const appendQueues = new Map<string, Promise<void>>();

function enqueueAppend(path: string, write: () => Promise<void>): Promise<void> {
  const prior = appendQueues.get(path) ?? Promise.resolve();
  const next = prior.then(write);
  // Keep the chain alive after a failed write; the caller still sees the
  // rejection via the returned promise.
  appendQueues.set(
    path,
    next.catch(() => undefined),
  );
  return next;
}

function extractSessionIdField(sdkMessage: unknown): string | null {
  if (
    typeof sdkMessage === "object" &&
    sdkMessage !== null &&
    typeof (sdkMessage as { session_id?: unknown }).session_id === "string"
  ) {
    return (sdkMessage as { session_id: string }).session_id;
  }
  return null;
}

/**
 * Create a session logger for one role within one phase attempt. Tracks
 * `message_ordinal` internally (monotonic across the whole file for this
 * logger); callers pass `queryOrdinal`, incrementing it per continuation
 * query — continuations append to the SAME file, never truncate.
 */
export function createSessionLogger(options: SessionLoggerOptions): SessionLogger {
  const path = sessionLogPath(options.taskDir, options.phase, options.role);
  let dirReady: Promise<unknown> | null = null;
  let messageOrdinal = 0;

  return {
    append(sdkMessage: unknown, opts: { queryOrdinal: number }): Promise<void> {
      messageOrdinal += 1;
      const line: SessionMessageV1 = {
        schema_version: 1,
        captured_at: new Date().toISOString(),
        task_id: options.taskId,
        phase: options.phase,
        phase_attempt: options.attempt,
        role: options.role,
        query_ordinal: opts.queryOrdinal,
        message_ordinal: messageOrdinal,
        session_id: extractSessionIdField(sdkMessage),
        sdk_message: sanitizeSdkMessage(sdkMessage, options.secrets),
      };
      return enqueueAppend(path, async () => {
        dirReady ??= mkdir(dirname(path), { recursive: true });
        await dirReady;
        await appendFile(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export type SessionLogReadResult = {
  readonly messages: readonly SessionMessageV1[];
  /** True when a crash left an unterminated partial final line (tolerated
   * and skipped). Malformed INTERIOR lines are an error, not tolerated. */
  readonly truncatedFinalLine: boolean;
};

/**
 * Parse session-log JSONL content. Tolerates a truncated (unterminated)
 * final line — the expected shape of a crash mid-append — but throws on a
 * malformed interior line, reporting its 1-based line number.
 */
export function parseSessionLog(content: string): SessionLogReadResult {
  const endsWithNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (endsWithNewline) {
    lines.pop();
  }

  const messages: SessionMessageV1[] = [];
  let truncatedFinalLine = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.length === 0) {
      continue;
    }
    try {
      messages.push(JSON.parse(raw) as SessionMessageV1);
    } catch {
      const isFinalLine = i === lines.length - 1;
      if (isFinalLine && !endsWithNewline) {
        truncatedFinalLine = true;
        continue;
      }
      throw new Error(`Malformed session log line ${i + 1}`);
    }
  }

  return { messages, truncatedFinalLine };
}
