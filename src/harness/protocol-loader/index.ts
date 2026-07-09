import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  validateProtocolYaml,
  type ProtocolYaml,
  type ValidationResult,
} from "../../schema/index.js";

/** TODO(wave-2): read protocol.yaml, resolve skills, merge requirements */
export type LoadedProtocol = {
  readonly yaml: ProtocolYaml;
  readonly skillDir: string;
};

export async function loadProtocolFromFile(
  protocolYamlPath: string,
): Promise<ValidationResult<LoadedProtocol>> {
  const raw = await readFile(protocolYamlPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = validateProtocolYaml(parsed);
  if (!validated.ok) {
    return validated;
  }
  return {
    ok: true,
    value: {
      yaml: validated.value,
      skillDir: protocolYamlPath.replace(/\/protocol\.yaml$/, ""),
    },
  };
}

export function mergeRuntimeRequirements(
  _protocol: ProtocolYaml,
): readonly string[] {
  // TODO(wave-2): union protocol.runtime.deps + skill requires
  return [];
}
