import type { ProtocolPhase, ProtocolYaml } from "../../schema/index.js";
import type { SubmitGateDecisionInput } from "../../schema/index.js";

/** TODO(wave-3): fresh gate reviewer session per phase */
export type ReviewSessionConfig = {
  readonly taskDir: string;
  readonly protocol: ProtocolYaml;
  readonly phase: ProtocolPhase;
};

export type ReviewSessionResult = {
  readonly sessionId: string;
  readonly decision: SubmitGateDecisionInput;
};

export async function runGateReview(
  _config: ReviewSessionConfig,
): Promise<ReviewSessionResult> {
  // TODO(wave-3)
  throw new Error("gate review session not implemented");
}
