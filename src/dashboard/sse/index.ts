import type { Request, Response } from "express";
import { validateSseEvent, type SseEvent } from "../../schema/index.js";

/**
 * SSE event hub — the dashboard's notification fan-out.
 *
 * Direction of control (design §4): the dashboard OWNS this hub; the harness
 * (Process A) calls {@link publishEvent} to announce that disk changed. The hub
 * never carries primary data — clients re-read disk via the HTTP API on every
 * state event (design §3, §13). If the harness is dead, no events fire and the
 * API keeps serving the last good state, so nothing here couples the dashboard
 * to a live harness.
 */

type Subscriber = (event: SseEvent) => void;

const subscribers = new Set<Subscriber>();

/**
 * SSE PUBLISH SEAM — the single function the harness calls to publish an event.
 *
 *     import { publishEvent } from "labrat/dashboard";
 *     publishEvent({ type: "gate-result", taskId, phase, decision });
 *
 * The event is validated against `src/schema/sse.ts` (the 8-type union) and
 * fanned out to every connected `/events` client. Invalid events are dropped
 * with a warning rather than propagated. Safe to call when no client is
 * connected (no-op).
 */
export function publishEvent(event: SseEvent): void {
  const res = validateSseEvent(event);
  if (!res.ok) {
    console.warn("[sse] dropping invalid event:", res.errors);
    return;
  }
  for (const sub of subscribers) sub(res.value);
}

/** GET /events — subscribe a client to the notification stream. */
export function handleSse(req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // Opening comment so the client's onopen fires immediately.
  res.write(": connected\n\n");

  const write: Subscriber = (event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  subscribers.add(write);

  // Heartbeat keeps intermediaries from closing an idle stream.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    subscribers.delete(write);
    res.end();
  });
}

/** Number of connected clients — for diagnostics/tests. */
export function subscriberCount(): number {
  return subscribers.size;
}
