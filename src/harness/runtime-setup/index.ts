import type { ProtocolYaml, RuntimeDep } from "../../schema/index.js";

/** TODO(wave-1): ensure python env — imaging deps + microct_analysis importable */
export type RuntimeSetupResult = {
  readonly ok: boolean;
  readonly errors: readonly string[];
};

export async function ensureRuntime(
  _protocol: ProtocolYaml,
  _mergedDeps: readonly RuntimeDep[],
): Promise<RuntimeSetupResult> {
  // TODO(wave-1)
  return { ok: true, errors: [] };
}
