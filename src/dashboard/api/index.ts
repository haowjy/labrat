import type { TaskJson, GateFile, ProvenanceManifest } from "../../schema/index.js";

/** TODO(wave-3): GET task list / task / phase / manifest (reads disk) */
export async function listTasks(_tasksRoot: string): Promise<readonly string[]> {
  // TODO(wave-3)
  return [];
}

export async function getTaskJson(
  _taskDir: string,
): Promise<TaskJson | null> {
  // TODO(wave-3)
  return null;
}

export async function getGateFile(
  _taskDir: string,
  _phase: string,
): Promise<GateFile | null> {
  // TODO(wave-3)
  return null;
}

export async function getManifest(
  _taskDir: string,
): Promise<ProvenanceManifest | null> {
  // TODO(wave-3)
  return null;
}
