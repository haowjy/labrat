import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_DASHBOARD_URL } from "../../config/index.js";
import {
  EVENTS_LOG_REL,
  SSE_ENVELOPE_SCHEMA_VERSION,
  uuidv7,
  validateSseEvent,
  type PersistedSseEvent,
  type SseEvent,
} from "../../schema/index.js";

/**
 * Disk-backed SSE producer (review-provenance §3B): append, then best-effort
 * wake.
 *
 * The harness (Process A) and dashboard (Process B) are separate processes
 * sharing only disk. Every notification event is validated, wrapped in a
 * {@link PersistedSseEvent} envelope, and appended to the task's own event log
 * `<taskDir>/events/events.jsonl` — that log is AUTHORITATIVE and is what the
 * dashboard's disk broker replays/tails. Only after the append lands does the
 * harness POST a `{taskId, id}` wake hint to `/internal/events` so a running
 * dashboard picks the line up immediately instead of on its next poll. The
 * hint is fire-and-forget: if the dashboard is down, nothing is lost — its
 * periodic scan recovers the events from disk on restart.
 *
 * `notifyEvent()` is called from deep inside worker/review/gate sessions, so
 * rather than threading a URL through every call, the run entrypoint calls
 * {@link configureEvents} once with the resolved `LabratConfig.dashboard.url`
 * before any events fire.
 */

let dashboardUrl = DEFAULT_DASHBOARD_URL;

/** Set the dashboard base URL for this process. Call once, at the run entrypoint. */
export function configureEvents(url: string): void {
  dashboardUrl = url;
}

const NOTIFY_PATH = "/internal/events";

/** Whether we've already warned that the dashboard is unreachable. After one
 *  warning we go silent — the harness keeps running regardless (disk is the
 *  contract), so repeating the message on every event is just noise. */
let notifyFailureWarned = false;

/** Per-log-file append chains: JSONL integrity requires that two in-flight
 *  events for the same task never interleave their writes. Keyed by absolute
 *  log path; each append awaits the previous one for that file. */
const appendQueues = new Map<string, Promise<void>>();

/**
 * Persist an SSE event to `<taskDir>/events/events.jsonl`, then best-effort
 * wake the dashboard. Resolves once the append has landed (the durable part);
 * the wake hint never blocks or throws. Throws on an invalid event or a
 * failed disk append — disk, not the notification channel, is the contract.
 */
export async function notifyEvent(
  taskDir: string,
  event: SseEvent,
): Promise<PersistedSseEvent> {
  const validated = validateSseEvent(event);
  if (!validated.ok) {
    throw new Error(
      `notifyEvent: invalid SSE event: ${validated.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ")}`,
    );
  }

  const envelope: PersistedSseEvent = {
    schemaVersion: SSE_ENVELOPE_SCHEMA_VERSION,
    id: uuidv7(),
    emittedAt: new Date().toISOString(),
    event: validated.value,
  };

  const logPath = join(taskDir, EVENTS_LOG_REL);
  const prev = appendQueues.get(logPath) ?? Promise.resolve();
  const append = prev.then(async () => {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(envelope)}\n`, "utf8");
  });
  // Keep the chain alive even if this append rejects, so one disk error
  // doesn't wedge every later event for the task.
  appendQueues.set(
    logPath,
    append.catch(() => {}),
  );
  await append;

  // Best-effort wake hint — the log line above is already the source of truth.
  fetch(`${dashboardUrl}${NOTIFY_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: validated.value.taskId, id: envelope.id }),
  }).catch((_err: unknown) => {
    if (!notifyFailureWarned) {
      notifyFailureWarned = true;
      console.warn(
        `[harness] dashboard unreachable at ${dashboardUrl} — wake hints will be skipped (event log on disk remains authoritative)`,
      );
    }
  });

  return envelope;
}
