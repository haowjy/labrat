import type { TaskJson } from "../../schema/index.js";

/**
 * SUPERSEDED (watcher contract rev v2, R11): the folder-watch path needs no
 * separate queue/ledger — the per-protocol state folders
 * (`incoming → in-progress → done | failed`) ARE the durable queue, moved by
 * atomic rename, ordered by claim-timestamp names (strict FIFO is not
 * promised). See `src/harness/watcher/supervisor.ts`.
 *
 * TODO(wave-4): FIFO queue, one task at a time, persists to disk */
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
