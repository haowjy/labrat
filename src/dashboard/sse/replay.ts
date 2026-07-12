import { listTasks, type TaskSummary } from "../api/index.js";
import type { SseEvent } from "../../schema/index.js";

/**
 * Dev-only scripted SSE source. With no harness attached, this replays a
 * narrated run of a real task already on disk under `tasksDir` through the
 * broker's `publishLive` seam so the live ticker + ephemeral log strip can be
 * exercised end to end. Live envelopes reach the client exactly the way
 * tailed disk events do, which is the point. (The real harness does NOT use
 * this seam — it appends to `<taskDir>/events/events.jsonl` and sends a wake
 * hint.)
 *
 * Protocol-agnostic by construction: the task id, protocol, and phase
 * sequence are read from disk (task.json via {@link listTasks}), never
 * hardcoded. Set `LABRAT_REPLAY_TASK` to pick a specific task id; otherwise
 * the most-recently-updated task under `tasksDir` is used.
 */

function pickTask(
  tasks: readonly TaskSummary[],
  requestedId: string | undefined,
): TaskSummary | null {
  if (requestedId) {
    return tasks.find((t) => t.id === requestedId) ?? null;
  }
  if (tasks.length === 0) return null;
  return [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

/** Build a narrated event script from a task's real state on disk. */
function buildScript(task: TaskSummary): SseEvent[] {
  const phases = [...task.phasesComplete, ...(task.currentPhase ? [task.currentPhase] : [])];
  const script: SseEvent[] = [{ type: "task-started", taskId: task.id, protocol: task.protocol }];
  for (const phase of phases) {
    const isCurrent = phase === task.currentPhase && !task.phasesComplete.includes(phase);
    script.push({ type: "phase-started", taskId: task.id, phase });
    script.push({
      type: "log",
      taskId: task.id,
      line: `${phase}: replaying recorded task state`,
      ephemeral: true,
    });
    if (!isCurrent) {
      script.push({ type: "phase-complete", taskId: task.id, phase });
      script.push({ type: "gate-result", taskId: task.id, phase, decision: "pass" });
    }
  }
  if (task.state === "paused") {
    script.push({ type: "task-paused", taskId: task.id, reason: task.reason ?? "paused" });
  } else if (task.state === "done") {
    script.push({ type: "task-done", taskId: task.id });
  } else if (task.state === "failed") {
    script.push({ type: "task-failed", taskId: task.id, reason: task.reason ?? "failed" });
  }
  return script;
}

/**
 * Start replaying a real task's event script on an interval, looping.
 * Returns a stop function. `intervalMs` is the gap between events.
 *
 * No-ops (with a log message) if no task can be found on disk — dev replay
 * never fabricates a fake task.
 */
export async function startDevReplay(
  tasksDir: string,
  publish: (event: SseEvent) => void,
  intervalMs = 2500,
): Promise<() => void> {
  const tasks = await listTasks(tasksDir);
  const task = pickTask(tasks, process.env["LABRAT_REPLAY_TASK"]);
  if (!task) {
    console.log(
      `[labrat] dev SSE replay: no task found under ${tasksDir} (set LABRAT_REPLAY_TASK or seed a task); skipping replay`,
    );
    return () => {};
  }
  console.log(`[labrat] dev SSE replay: narrating ${task.id} (${task.protocol})`);
  const script = buildScript(task);
  let i = 0;
  const timer = setInterval(() => {
    const event = script[i % script.length];
    if (event) publish(event);
    i++;
  }, intervalMs);
  return () => clearInterval(timer);
}
