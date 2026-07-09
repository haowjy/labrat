import type { SseEvent } from "../../schema/index.js";

/** TODO(wave-3): in-proc event bus → SSE */
export type EventListener = (event: SseEvent) => void;

const listeners = new Set<EventListener>();

export function subscribe(listener: EventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emit(event: SseEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}
