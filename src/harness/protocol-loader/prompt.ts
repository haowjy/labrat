import type { ProtocolPhase, ProtocolYaml } from "../../schema/index.js";
import type { RuntimeHandle } from "../runtime-setup/types.js";
import type { ResolvedSkill } from "./resolve.js";
import { loadSkillMarkdown } from "./resolve.js";

export type TaskPromptContext = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly inputRel: string;
  readonly runtime: RuntimeHandle;
  readonly priorPhaseSummaries: Readonly<Record<string, string>>;
};

const LABRAT_MCP_TOOLS = new Set([
  "record_phase",
  "mark_subphase",
  "blocked",
  "submit_gate_decision",
]);

function intersectTools(
  profileTools: readonly string[],
  skillTools: readonly string[],
): string[] {
  const skillSet = new Set(skillTools);
  const merged = profileTools.filter((t) => !LABRAT_MCP_TOOLS.has(t));
  if (skillSet.size === 0) {
    return merged;
  }
  return merged.filter((t) => skillSet.has(t));
}

export async function buildWorkerSystemPrompt(
  protocol: ProtocolYaml,
  protocolSkillDir: string,
  claudeScienceHome: string,
  phase: ProtocolPhase,
  resolvedSkills: readonly ResolvedSkill[],
  taskCtx: TaskPromptContext,
): Promise<readonly string[]> {
  const parentBlocks: string[] = [];
  for (const parent of protocol.parent_skills) {
    const body = await loadSkillMarkdown(parent, claudeScienceHome);
    parentBlocks.push(`# Parent skill: ${parent}\n\n${body}`);
  }

  const protocolOverview = await loadSkillMarkdown(
    protocol.name,
    claudeScienceHome,
  ).catch(async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    return readFile(join(protocolSkillDir, "SKILL.md"), "utf8");
  });

  const phaseSkillBlocks = resolvedSkills.map(
    (s) => `# Phase skill: ${s.ref}\n\n${s.body.trim()}`,
  );

  const subphaseIds =
    phase.subphases?.map((sp) => sp.id) ?? ([] as readonly string[]);

  const outputs = phase.outputs ?? [];
  const inputs = phase.inputs ?? [];

  const priorSummaryText =
    Object.keys(taskCtx.priorPhaseSummaries).length === 0
      ? "(none — first phase)"
      : Object.entries(taskCtx.priorPhaseSummaries)
          .map(([p, s]) => `### ${p}\n${s.trim()}`)
          .join("\n\n");

  const roleInstruction = `## Role: Worker

Follow the **Methodology** sections of the phase skills above.
When a subphase completes, call \`mark_subphase\` with an appropriate mark and confidence.
When the entire phase is complete:
1. Write \`phases/${phase.id}/summary.md\` (prose summary for downstream phases)
2. Write \`phases/${phase.id}/measurements.json\` (key numeric facts)
3. Save evidence PNGs under \`phases/${phase.id}/evidence/\`
4. Ensure every declared artifact output exists under \`artifacts/\` (paths below are relative to \`artifacts/\`)
5. Call \`record_phase\` with phase="${phase.id}"

Declared artifact outputs for this phase:
${outputs.map((o) => `- artifacts/${o}`).join("\n") || "(none)"}

${subphaseIds.length > 0 ? `Subphases (mark each before record_phase): ${subphaseIds.join(", ")}` : ""}`;

  const taskContext = `## Task context

- Task id: ${taskCtx.taskId}
- Task directory (cwd): ${taskCtx.taskDir}
- Input path (relative to task dir): ${taskCtx.inputRel}
- Python interpreter: ${taskCtx.runtime.pythonPath}
- Required subprocess env: PYTHONPATH=${taskCtx.runtime.env["PYTHONPATH"] ?? ""}, MPLBACKEND=${taskCtx.runtime.env["MPLBACKEND"] ?? "Agg"}

Every Bash/Python invocation is a fresh process — persist state to disk under the task directory.
The \`mc_*\` kernel helpers do NOT exist; use \`microct_analysis\` stage drivers via the Python above.

Phase inputs (relative to task dir):
${inputs.map((i) => `- ${i}`).join("\n") || "(none)"}

Prior phase summaries:
${priorSummaryText}`;

  const staticPrefix = [
    parentBlocks.join("\n\n---\n\n"),
    `# Protocol: ${protocol.name}\n\n${protocolOverview.trim()}`,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n---\n\n");

  const dynamicTail = [
    phaseSkillBlocks.join("\n\n---\n\n"),
    roleInstruction,
    taskContext,
  ].join("\n\n");

  return [staticPrefix, dynamicTail];
}

export function mergeWorkerAllowedTools(
  protocol: ProtocolYaml,
  resolvedSkills: readonly ResolvedSkill[],
  labratMcpTools: readonly string[],
): string[] {
  const profileTools = protocol.agents.worker.tools;
  const skillTools = collectSkillWorkerTools(resolvedSkills);
  const sdkTools = intersectTools(profileTools, skillTools);
  return [...sdkTools, ...labratMcpTools];
}

function collectSkillWorkerTools(skills: readonly ResolvedSkill[]): string[] {
  const out = new Set<string>();
  for (const skill of skills) {
    const tools = skill.requires?.worker?.tools;
    if (!tools) continue;
    for (const t of tools) {
      out.add(t);
    }
  }
  return [...out];
}
