import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Request, Response } from "express";
import {
  EVENTS_LOG_REL,
  SSE_ENVELOPE_SCHEMA_VERSION,
  uuidv7,
  validatePersistedSseEvent,
  validateSseEvent,
  type PersistedSseEvent,
  type SseEvent,
} from "../../schema/index.js";

/**
 * Disk-backed SSE broker (review-provenance §3B) — replay-and-tail, not fan-out.
 *
 * Direction of control (design §4): the dashboard OWNS this broker; the
 * per-task event logs `<tasksDir>/<taskId>/events/events.jsonl` written by the
 * harness are AUTHORITATIVE. The harness's POST to `/internal/events` is only
 * a wake hint that triggers an immediate scan — a periodic ~500 ms poll
 * recovers anything written while the dashboard was down or the hint was
 * lost. Events never carry primary data — clients still re-read disk via the
 * HTTP API on every state event (design §3, §13).
 *
 * Per connection: subscribe/buffer live first, snapshot every event log,
 * replay after `Last-Event-ID` (or all retained, bounded by
 * `maxReplayEvents`, on a first connect), then flush buffered live envelopes
 * — a bounded per-connection seen-id LRU guarantees no id is ever sent twice
 * on one connection, so the replay/live race and duplicate wake hints are
 * harmless.
 *
 * Corruption policy: a malformed INTERIOR line stops that task's tail at the
 * corruption with a server warning — never skip ahead and reorder. An
 * incomplete FINAL line (a write in flight) is simply not consumed until it
 * completes.
 */

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_HEARTBEAT_MS = 15_000;
/** Replay retention cap per connection — retention/compaction of the logs
 *  themselves is an operator concern (design §3B). */
const DEFAULT_MAX_REPLAY_EVENTS = 5_000;
const SEEN_IDS_LRU_CAP = 8_192;

export type SseBrokerOptions = {
  readonly tasksDir: string;
  /** Maximum envelopes replayed to one connecting client (newest kept). */
  readonly maxReplayEvents?: number;
  readonly pollIntervalMs?: number;
  readonly heartbeatMs?: number;
};

export type SseBroker = {
  /** GET /events — subscribe a client to the replay-and-tail stream. */
  handleSse(req: Request, res: Response): void;
  /** Wake hint (POST /internal/events) — triggers an immediate tail scan. */
  scanNow(): void;
  /**
   * Dev-replay seam: publish a synthetic event to LIVE subscribers only
   * (in-memory envelope, never persisted). The harness does NOT use this —
   * it appends to disk and sends a wake hint.
   */
  publishLive(event: SseEvent): void;
  /** Number of connected clients — for diagnostics/tests. */
  subscriberCount(): number;
  /** Stop the poll timer. Connections close via their own req close events. */
  close(): void;
};

/** Bounded insertion-order LRU of envelope ids already sent on a connection. */
class SeenIds {
  private readonly ids = new Set<string>();

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    this.ids.add(id);
    if (this.ids.size > SEEN_IDS_LRU_CAP) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }
}

/** Per-task tail cursor: byte offset of the last fully consumed line. */
type TailState = {
  offset: number;
  /** Once a malformed interior line is seen, the tail stops here for good. */
  corrupt: boolean;
};

function byEmittedAtThenId(a: PersistedSseEvent, b: PersistedSseEvent): number {
  if (a.emittedAt !== b.emittedAt) return a.emittedAt < b.emittedAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Parse the COMPLETE lines of an event-log chunk. Returns the envelopes, the
 * byte length actually consumed (never includes an incomplete final line),
 * and whether a malformed interior line was hit (parsing stops there).
 */
function parseLogChunk(chunk: string): {
  envelopes: PersistedSseEvent[];
  consumedBytes: number;
  corrupt: boolean;
} {
  const envelopes: PersistedSseEvent[] = [];
  let consumedBytes = 0;
  let rest = chunk;
  for (;;) {
    const nl = rest.indexOf("\n");
    if (nl === -1) break; // incomplete final line — wait for it to complete
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    if (line.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return { envelopes, consumedBytes, corrupt: true };
      }
      const validated = validatePersistedSseEvent(parsed);
      if (!validated.ok) {
        return { envelopes, consumedBytes, corrupt: true };
      }
      envelopes.push(validated.value);
    }
    consumedBytes += Buffer.byteLength(line, "utf8") + 1;
  }
  return { envelopes, consumedBytes, corrupt: false };
}

export function createSseBroker(options: SseBrokerOptions): SseBroker {
  const {
    tasksDir,
    maxReplayEvents = DEFAULT_MAX_REPLAY_EVENTS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
  } = options;

  const subscribers = new Set<(envelope: PersistedSseEvent) => void>();
  const tails = new Map<string, TailState>();

  async function listEventLogs(): Promise<{ taskId: string; path: string }[]> {
    let entries;
    try {
      entries = await readdir(tasksDir, { withFileTypes: true });
    } catch {
      return []; // tasks dir absent — nothing to replay/tail yet
    }
    const logs: { taskId: string; path: string }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(tasksDir, entry.name, EVENTS_LOG_REL);
      try {
        const s = await stat(path);
        if (s.isFile()) logs.push({ taskId: entry.name, path });
      } catch {
        // no event log for this task
      }
    }
    return logs;
  }

  /**
   * Full snapshot for a connecting client: every log read from byte 0,
   * complete+valid lines only (each file stops at its first corruption),
   * merged by (emittedAt, id). Independent of the shared tail cursors so a
   * connect never disturbs live tailing.
   */
  async function snapshotAll(): Promise<PersistedSseEvent[]> {
    const all: PersistedSseEvent[] = [];
    for (const log of await listEventLogs()) {
      let content: string;
      try {
        content = await readFile(log.path, "utf8");
      } catch {
        continue;
      }
      const { envelopes, corrupt } = parseLogChunk(content);
      if (corrupt) {
        console.warn(
          `[sse] malformed line in ${log.path} — replaying only events before the corruption`,
        );
      }
      all.push(...envelopes);
    }
    all.sort(byEmittedAtThenId);
    return all;
  }

  /** Tail scan: fan out lines appended past each task's cursor. Serialized —
   *  overlapping triggers coalesce into one pending re-scan. */
  let scanning = false;
  let rescanRequested = false;

  async function scanOnce(): Promise<void> {
    for (const log of await listEventLogs()) {
      let tail = tails.get(log.taskId);
      if (!tail) {
        tail = { offset: 0, corrupt: false };
        tails.set(log.taskId, tail);
      }
      if (tail.corrupt) continue;

      let size: number;
      try {
        size = (await stat(log.path)).size;
      } catch {
        continue;
      }
      if (size < tail.offset) {
        // The append-only log shrank — treat as corruption, never re-send.
        console.warn(
          `[sse] event log ${log.path} shrank (${size} < ${tail.offset}) — stopping this task's tail`,
        );
        tail.corrupt = true;
        continue;
      }
      if (size === tail.offset) continue;

      // Read ONLY the new bytes past the cursor — never the whole file. The
      // cursor always sits on a line boundary (it only ever advances past
      // complete lines), and a multi-byte UTF-8 char split at the END of the
      // read can only fall inside the incomplete final line, which
      // parseLogChunk never consumes — so decoding the raw byte slice is safe.
      let chunk: string;
      try {
        const handle = await open(log.path, "r");
        try {
          const length = size - tail.offset;
          const buf = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buf, 0, length, tail.offset);
          // A short read just leaves bytes for the next scan — the cursor
          // only advances past complete lines actually parsed below.
          chunk = buf.subarray(0, bytesRead).toString("utf8");
        } finally {
          await handle.close();
        }
      } catch {
        continue;
      }
      const { envelopes, consumedBytes, corrupt } = parseLogChunk(chunk);
      tail.offset += consumedBytes;
      if (corrupt) {
        console.warn(
          `[sse] malformed line in ${log.path} at byte ${tail.offset} — stopping this task's tail (never skipping ahead)`,
        );
        tail.corrupt = true;
      }
      for (const envelope of envelopes) {
        for (const sub of subscribers) sub(envelope);
      }
    }
  }

  function scan(): void {
    if (scanning) {
      rescanRequested = true;
      return;
    }
    scanning = true;
    void scanOnce()
      .catch((err: unknown) => {
        console.warn("[sse] tail scan failed:", err);
      })
      .finally(() => {
        scanning = false;
        if (rescanRequested) {
          rescanRequested = false;
          scan();
        }
      });
  }

  const pollTimer = setInterval(scan, pollIntervalMs);
  pollTimer.unref?.();

  function handleSse(req: Request, res: Response): void {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    // Opening comment so the client's onopen fires immediately.
    res.write(": connected\n\n");

    const seen = new SeenIds();
    let closed = false;

    function send(envelope: PersistedSseEvent): void {
      if (closed || seen.has(envelope.id)) return;
      seen.add(envelope.id);
      res.write(`id: ${envelope.id}\n`);
      res.write(`event: ${envelope.event.type}\n`);
      res.write(`data: ${JSON.stringify(envelope.event)}\n\n`);
    }

    // Subscribe FIRST, buffering, so nothing published during the snapshot
    // read is lost; the seen-id LRU dedups the replay/live overlap.
    let buffering = true;
    const buffer: PersistedSseEvent[] = [];
    const subscriber = (envelope: PersistedSseEvent): void => {
      if (buffering) buffer.push(envelope);
      else send(envelope);
    };
    subscribers.add(subscriber);

    const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
    heartbeat.unref?.();

    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      subscribers.delete(subscriber);
      res.end();
    });

    const lastEventIdHeader = req.headers["last-event-id"];
    const lastEventId =
      typeof lastEventIdHeader === "string" && lastEventIdHeader !== ""
        ? lastEventIdHeader
        : null;

    void (async () => {
      try {
        let replay = await snapshotAll();
        if (!closed) {
          if (lastEventId !== null) {
            const idx = replay.findIndex((e) => e.id === lastEventId);
            replay =
              idx !== -1
                ? replay.slice(idx + 1)
                : // Unknown id (e.g. a compacted log): UUIDv7 strings sort by
                  // time, so fall back to a lexicographic cut.
                  replay.filter((e) => e.id > lastEventId);
          }
          if (replay.length > maxReplayEvents) {
            replay = replay.slice(replay.length - maxReplayEvents);
          }
          for (const envelope of replay) send(envelope);
        }
      } catch (err: unknown) {
        console.warn("[sse] replay snapshot failed:", err);
      }
      // Flip + flush in ONE synchronous block: nothing can enqueue between
      // the flush and the flag change, so no envelope is dropped.
      buffering = false;
      for (const envelope of buffer) send(envelope);
      buffer.length = 0;
    })();
  }

  function publishLive(event: SseEvent): void {
    const validated = validateSseEvent(event);
    if (!validated.ok) {
      console.warn("[sse] dropping invalid dev event:", validated.errors);
      return;
    }
    const envelope: PersistedSseEvent = {
      schemaVersion: SSE_ENVELOPE_SCHEMA_VERSION,
      id: uuidv7(),
      emittedAt: new Date().toISOString(),
      event: validated.value,
    };
    for (const sub of subscribers) sub(envelope);
  }

  return {
    handleSse,
    scanNow: scan,
    publishLive,
    subscriberCount: () => subscribers.size,
    close: () => clearInterval(pollTimer),
  };
}
