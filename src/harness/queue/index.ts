import type { TaskJson } from "../../schema/index.js";

/** TODO(wave-4): FIFO queue, one task at a time, persists to disk */
export type QueuedTask = {
  readonly taskId: string;
  readonly inputPath: string;
  readonly protocol: string;
};

export async function enqueueTask(
  _inputPath: string,
  _protocol: string,
): Promise<QueuedTask> {
  // TODO(wave-4)
  throw new Error("queue not implemented");
}

export async function dequeueNext(): Promise<QueuedTask | null> {
  // TODO(wave-4)
  return null;
}

export async function updateTaskState(
  _taskId: string,
  _patch: Partial<Pick<TaskJson, "state" | "currentPhase" | "phasesComplete" | "reason">>,
): Promise<void> {
  // TODO(wave-2)
}
