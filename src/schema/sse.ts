import {
  expectEnum,
  expectNonEmptyString,
  expectRecord,
  expectString,
  type ValidationResult,
  success,
} from "./validation.js";
import { GATE_DECISIONS, type GateDecision } from "./gate.js";

export type TaskStartedEvent = {
  readonly type: "task-started";
  readonly taskId: string;
  readonly protocol: string;
};

export type PhaseStartedEvent = {
  readonly type: "phase-started";
  readonly taskId: string;
  readonly phase: string;
};

export type PhaseCompleteEvent = {
  readonly type: "phase-complete";
  readonly taskId: string;
  readonly phase: string;
};

export type GateResultEvent = {
  readonly type: "gate-result";
  readonly taskId: string;
  readonly phase: string;
  readonly decision: GateDecision;
};

export type TaskDoneEvent = {
  readonly type: "task-done";
  readonly taskId: string;
};

export type TaskFailedEvent = {
  readonly type: "task-failed";
  readonly taskId: string;
  readonly reason: string;
};

export type TaskPausedEvent = {
  readonly type: "task-paused";
  readonly taskId: string;
  readonly reason: string;
};

export type LogEvent = {
  readonly type: "log";
  readonly taskId: string;
  readonly line: string;
  readonly ephemeral: true;
};

/** SSE notification union — exactly 8 event types (design §13). */
export type SseEvent =
  | TaskStartedEvent
  | PhaseStartedEvent
  | PhaseCompleteEvent
  | GateResultEvent
  | TaskDoneEvent
  | TaskFailedEvent
  | TaskPausedEvent
  | LogEvent;

/**
 * Disk-persisted transport envelope (review-provenance §3B). Each SSE event is
 * appended to `<taskDir>/events/events.jsonl` as one JSON line of this shape;
 * the wrapped {@link SseEvent} payload stays byte-identical to what the browser
 * receives in `data:` — the envelope exists only for replay/dedup ordering.
 */
export type PersistedSseEvent = {
  readonly schemaVersion: 1;
  /** UUIDv7 — globally sortable + dedup-able without a cross-process counter. */
  readonly id: string;
  /** Harness-stamped ISO time at append. */
  readonly emittedAt: string;
  readonly event: SseEvent;
};

export const SSE_ENVELOPE_SCHEMA_VERSION = 1 as const;

/** Per-task event-log path, relative to the task dir — written by the harness
 *  producer, replayed/tailed by the dashboard broker. */
export const EVENTS_LOG_REL = "events/events.jsonl";

export function validatePersistedSseEvent(
  value: unknown,
): ValidationResult<PersistedSseEvent> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  if (rec.value["schemaVersion"] !== SSE_ENVELOPE_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        {
          path: "$.schemaVersion",
          message: `expected ${SSE_ENVELOPE_SCHEMA_VERSION}`,
        },
      ],
    };
  }

  const id = expectNonEmptyString(rec.value["id"], "$.id");
  if (!id.ok) return id;

  const emittedAt = expectNonEmptyString(rec.value["emittedAt"], "$.emittedAt");
  if (!emittedAt.ok) return emittedAt;

  const event = validateSseEvent(rec.value["event"]);
  if (!event.ok) return event;

  return success({
    schemaVersion: SSE_ENVELOPE_SCHEMA_VERSION,
    id: id.value,
    emittedAt: emittedAt.value,
    event: event.value,
  });
}

export const SSE_EVENT_TYPES = [
  "task-started",
  "phase-started",
  "phase-complete",
  "gate-result",
  "task-done",
  "task-failed",
  "task-paused",
  "log",
] as const;

export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

export function validateSseEvent(value: unknown): ValidationResult<SseEvent> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const type = expectEnum(rec.value["type"], "$.type", SSE_EVENT_TYPES);
  if (!type.ok) return type;

  const taskId = expectNonEmptyString(rec.value["taskId"], "$.taskId");
  if (!taskId.ok) return taskId;

  switch (type.value) {
    case "task-started": {
      const protocol = expectNonEmptyString(rec.value["protocol"], "$.protocol");
      if (!protocol.ok) return protocol;
      return success({
        type: "task-started",
        taskId: taskId.value,
        protocol: protocol.value,
      });
    }
    case "phase-started":
    case "phase-complete": {
      const phase = expectNonEmptyString(rec.value["phase"], "$.phase");
      if (!phase.ok) return phase;
      return success({
        type: type.value,
        taskId: taskId.value,
        phase: phase.value,
      } as PhaseStartedEvent | PhaseCompleteEvent);
    }
    case "gate-result": {
      const phase = expectNonEmptyString(rec.value["phase"], "$.phase");
      if (!phase.ok) return phase;
      const decision = expectEnum(
        rec.value["decision"],
        "$.decision",
        GATE_DECISIONS,
      );
      if (!decision.ok) return decision;
      return success({
        type: "gate-result",
        taskId: taskId.value,
        phase: phase.value,
        decision: decision.value,
      });
    }
    case "task-done":
      return success({ type: "task-done", taskId: taskId.value });
    case "task-failed":
    case "task-paused": {
      const reason = expectNonEmptyString(rec.value["reason"], "$.reason");
      if (!reason.ok) return reason;
      return success({
        type: type.value,
        taskId: taskId.value,
        reason: reason.value,
      } as TaskFailedEvent | TaskPausedEvent);
    }
    case "log": {
      const line = expectString(rec.value["line"], "$.line");
      if (!line.ok) return line;
      if (rec.value["ephemeral"] !== true) {
        return {
          ok: false,
          errors: [{ path: "$.ephemeral", message: "expected true" }],
        };
      }
      return success({
        type: "log",
        taskId: taskId.value,
        line: line.value,
        ephemeral: true,
      });
    }
    default: {
      const _exhaustive: never = type.value;
      return _exhaustive;
    }
  }
}
