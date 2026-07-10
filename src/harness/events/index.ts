import { DEFAULT_DASHBOARD_URL } from "../../config/index.js";
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

/** POST an SSE event to the dashboard. Never throws. */
export function notifyEvent(event: SseEvent): void {
  const url = `${dashboardUrl}${NOTIFY_PATH}`;
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
