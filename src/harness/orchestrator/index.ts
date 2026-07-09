import type { ProtocolYaml } from "../../schema/index.js";
import type { GateDecision } from "../../schema/index.js";

/** TODO(wave-2): hybrid code-loop walking protocol phases */
export type OrchestratorConfig = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly protocol: ProtocolYaml;
};

export type PhaseRunResult = {
  readonly phase: string;
  readonly gateDecision: GateDecision;
};

export async function runTask(_config: OrchestratorConfig): Promise<void> {
  // TODO(wave-2)
  throw new Error("orchestrator not implemented");
}
