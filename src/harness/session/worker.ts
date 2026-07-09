import type { ProtocolPhase, ProtocolYaml } from "../../schema/index.js";

/** TODO(wave-2): build phase worker agent and run SDK query turn loop */
export type WorkerSessionConfig = {
  readonly taskDir: string;
  readonly protocol: ProtocolYaml;
  readonly phase: ProtocolPhase;
};

export type WorkerSessionResult = {
  readonly sessionId: string;
  readonly phaseComplete: boolean;
};

export async function runWorkerPhase(
  _config: WorkerSessionConfig,
): Promise<WorkerSessionResult> {
  // TODO(wave-2)
  throw new Error("worker session not implemented");
}
