import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  validateProtocolYaml,
  type ProtocolPhase,
  type ProtocolYaml,
  type RuntimeDep,
  type ValidationResult,
} from "../../schema/index.js";
import { mergeRuntimeDeps } from "../runtime-setup/deps.js";
import {
  buildReviewerSystemPrompt,
  buildWorkerSystemPrompt,
  mergeWorkerAllowedTools,
  type ReviewerPromptContext,
  type TaskPromptContext,
} from "./prompt.js";
import {
  collectSkillRuntimeDeps,
  findProtocolSkillDir,
  resolveSkillRef,
  type ResolvedSkill,
} from "./resolve.js";

export type LoadedProtocol = {
  readonly yaml: ProtocolYaml;
  readonly skillDir: string;
  readonly claudeScienceHome: string;
};

export type LoadedPhase = {
  readonly phase: ProtocolPhase;
  readonly skills: readonly ResolvedSkill[];
  readonly subphaseIds: readonly string[];
  readonly phaseOutputs: readonly string[];
  readonly skillRuntimeDeps: readonly RuntimeDep[];
};

export {
  buildReviewerSystemPrompt,
  buildWorkerSystemPrompt,
  mergeReviewerAllowedTools,
  mergeWorkerAllowedTools,
  type ReviewerPromptContext,
  type TaskPromptContext,
} from "./prompt.js";
export {
  findProtocolSkillDir,
  resolveSkillRef,
  type ResolvedSkill,
} from "./resolve.js";

/**
 * `claudeScienceHome` is always the caller's resolved config value — there's
 * no fallback here. Single source of truth is `LabratConfig.scienceHome`
 * (src/config), loaded once at the run entrypoint and threaded down.
 */
export async function loadProtocolFromFile(
  protocolYamlPath: string,
  claudeScienceHome: string,
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
      claudeScienceHome,
    },
  };
}

export async function loadProtocolByName(
  protocolName: string,
  claudeScienceHome: string,
): Promise<LoadedProtocol> {
  const skillDir = await findProtocolSkillDir(protocolName, claudeScienceHome);
  const loaded = await loadProtocolFromFile(
    join(skillDir, "protocol.yaml"),
    claudeScienceHome,
  );
  if (!loaded.ok) {
    throw new Error(
      `Invalid protocol.yaml for ${protocolName}: ${loaded.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return loaded.value;
}

export async function loadPhase(
  protocol: LoadedProtocol,
  phaseId: string,
): Promise<LoadedPhase> {
  const phase = protocol.yaml.phases.find((p) => p.id === phaseId);
  if (!phase) {
    throw new Error(
      `Phase "${phaseId}" not found in protocol ${protocol.yaml.name}`,
    );
  }

  const skills: ResolvedSkill[] = [];
  for (const ref of phase.skills) {
    skills.push(
      await resolveSkillRef(ref, protocol.skillDir, protocol.claudeScienceHome),
    );
  }

  return {
    phase,
    skills,
    subphaseIds: phase.subphases?.map((sp) => sp.id) ?? [],
    phaseOutputs: phase.outputs ?? [],
    skillRuntimeDeps: collectSkillRuntimeDeps(skills),
  };
}

export function mergeRuntimeRequirements(
  protocol: ProtocolYaml,
  phaseSkillDeps?: readonly RuntimeDep[],
): readonly import("../runtime-setup/deps.js").NormalizedRuntimeDep[] {
  return mergeRuntimeDeps(protocol, phaseSkillDeps);
}

export async function assembleWorkerPrompt(
  protocol: LoadedProtocol,
  loadedPhase: LoadedPhase,
  taskCtx: TaskPromptContext,
): Promise<readonly string[]> {
  return buildWorkerSystemPrompt(
    protocol.yaml,
    protocol.skillDir,
    protocol.claudeScienceHome,
    loadedPhase.phase,
    loadedPhase.skills,
    taskCtx,
  );
}

export async function assembleReviewerPrompt(
  protocol: LoadedProtocol,
  loadedPhase: LoadedPhase,
  reviewerCtx: ReviewerPromptContext,
): Promise<readonly string[]> {
  return buildReviewerSystemPrompt(
    protocol.yaml,
    protocol.skillDir,
    protocol.claudeScienceHome,
    loadedPhase.phase,
    loadedPhase.skills,
    reviewerCtx,
  );
}
