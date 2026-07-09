import type { InspectionResult } from "../inspector/index.js";
import type { ProtocolYaml } from "../../schema/index.js";

/** TODO(wave-stretch): Haiku confirms protocol selection from inspector output */
export type RouterResult = {
  readonly protocolName: string;
  readonly confidence: "high" | "medium" | "low";
  readonly rationale?: string;
};

export async function selectProtocol(
  _inspection: InspectionResult,
  _available: readonly ProtocolYaml[],
): Promise<RouterResult> {
  // TODO(wave-stretch)
  throw new Error("router not implemented");
}
