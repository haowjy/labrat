import { publishEvent } from "./index.js";
import type { SseEvent } from "../../schema/index.js";

/**
 * Dev-only scripted SSE source. With no harness attached, this replays a
 * realistic run of the fixture task through the {@link publishEvent} seam so
 * the live ticker + ephemeral log strip can be exercised end to end. It uses
 * exactly the same seam the harness will use — the client cannot tell the
 * difference, which is the point.
 */

const TASK_ID = "task-2026-07-09-001";
const PROTOCOL = "bonemorph-oa-mouse-knee";

/** One narrated pass over all 8 event types (design §13). */
const SCRIPT: readonly SseEvent[] = [
  { type: "task-started", taskId: TASK_ID, protocol: PROTOCOL },
  { type: "phase-started", taskId: TASK_ID, phase: "intake" },
  { type: "log", taskId: TASK_ID, line: "intake: loaded 877 DICOM slices", ephemeral: true },
  { type: "phase-complete", taskId: TASK_ID, phase: "intake" },
  { type: "gate-result", taskId: TASK_ID, phase: "intake", decision: "pass" },
  { type: "phase-started", taskId: TASK_ID, phase: "segmentation" },
  { type: "log", taskId: TASK_ID, line: "segmentation: needs-seeds — replaying operator seeds", ephemeral: true },
  { type: "log", taskId: TASK_ID, line: "reviewer: connected-components check — femur has 4 components", ephemeral: true },
  { type: "phase-complete", taskId: TASK_ID, phase: "segmentation" },
  { type: "gate-result", taskId: TASK_ID, phase: "segmentation", decision: "pass-with-concerns" },
  { type: "phase-started", taskId: TASK_ID, phase: "seed-review" },
  { type: "task-paused", taskId: TASK_ID, reason: "awaiting operator seed confirmation" },
];

/**
 * Start replaying the script on an interval, looping. Returns a stop function.
 * `intervalMs` is the gap between events.
 */
export function startDevReplay(intervalMs = 2500): () => void {
  let i = 0;
  const timer = setInterval(() => {
    const event = SCRIPT[i % SCRIPT.length];
    if (event) publishEvent(event);
    i++;
  }, intervalMs);
  return () => clearInterval(timer);
}
