import type { InspectionResult } from "../inspector/index.js";
import type { ProtocolYaml } from "../../schema/index.js";

/**
 * SUPERSEDED for folder-watch ingestion (watcher contract rev v2, R11): the
 * per-protocol `watchRoot` folder IS the routing — a drop's folder decides
 * its protocol, and NO content auto-detection/router runs on that path.
 * This inspector→router idea remains only as a stretch seam for the manual
 * `enqueue` flow.
 *
 * TODO(wave-stretch): Haiku confirms protocol selection from inspector output */
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
