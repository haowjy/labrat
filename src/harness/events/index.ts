import type { SseEvent } from "../../schema/index.js";

/**
 * Cross-process SSE notify seam (design §4, §13).
 *
 * The harness (Process A) and dashboard (Process B) are separate processes
 * sharing only disk. After the harness lands an atomic write, it calls
 * {@link notifyEvent} here, which POSTs the event to the dashboard's
 * `/internal/events` endpoint (see `src/dashboard/server.ts`); the dashboard
 * forwards it to its own `publishEvent()`, fanning it out to connected
 * `/events` clients. The event itself never carries primary data — clients
 * re-read disk on every state event. Fire-and-forget: if the dashboard is
 * unreachable, the notification is dropped (logged) and the harness keeps
 * running. Disk, not this channel, is the source of truth.
 */

const DASHBOARD_URL =
  process.env["LABRAT_DASHBOARD_URL"] ?? "http://localhost:4600";
const NOTIFY_PATH = "/internal/events";

/** POST an SSE event to the dashboard. Never throws. */
export function notifyEvent(event: SseEvent): void {
  const url = `${DASHBOARD_URL}${NOTIFY_PATH}`;
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  }).catch((err: unknown) => {
    console.warn(
      `[harness] dashboard notify failed for ${event.type} (${event.taskId}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}
