import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  latestMarksBySubphase,
  validateSubphasesJson,
  type ProtocolPhase,
  type ProtocolYaml,
  type SubphasesJson,
} from "../../schema/index.js";
import type { RuntimeHandle } from "../runtime-setup/types.js";
import type { ResolvedSkill } from "./resolve.js";
import { loadSkillMarkdown } from "./resolve.js";

export type TaskPromptContext = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly inputRel: string;
  readonly runtime: RuntimeHandle;
  readonly priorPhaseSummaries: Readonly<Record<string, string>>;
  /**
   * The human reviewer's send-back note for THIS phase, when it is being
   * re-run because a human sent it back (review/verdict/{phase}.json,
   * human_verdict=changes_requested). Null on a normal first run. Rendered
   * as a distinct, high-priority section so the re-run worker acts on the
   * correction. WORKER-only — the independent reviewer never receives it
   * (trust boundary).
   */
  readonly humanFeedback?: string | null;
};

/** Fresh gate-reviewer session context — no worker transcript, disk only. */
export type ReviewerPromptContext = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly runtime: RuntimeHandle;
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

async function buildStaticPrefix(
  protocol: ProtocolYaml,
  protocolSkillDir: string,
  claudeScienceHome: string,
): Promise<string> {
  const parentBlocks: string[] = [];
  for (const parent of protocol.parent_skills) {
    const body = await loadSkillMarkdown(parent, claudeScienceHome);
    parentBlocks.push(`# Parent skill: ${parent}\n\n${body}`);
  }

  const protocolOverview = await loadSkillMarkdown(
    protocol.name,
    claudeScienceHome,
  ).catch(() => readFile(join(protocolSkillDir, "SKILL.md"), "utf8"));

  return [
    parentBlocks.join("\n\n---\n\n"),
    `# Protocol: ${protocol.name}\n\n${protocolOverview.trim()}`,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n---\n\n");
}

export async function buildWorkerSystemPrompt(
  protocol: ProtocolYaml,
  protocolSkillDir: string,
  claudeScienceHome: string,
  phase: ProtocolPhase,
  resolvedSkills: readonly ResolvedSkill[],
  taskCtx: TaskPromptContext,
): Promise<readonly string[]> {
  const staticPrefix = await buildStaticPrefix(
    protocol,
    protocolSkillDir,
    claudeScienceHome,
  );

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
${phase.cdn_allowlist !== undefined ? `\nPhase \`cdn_allowlist\` (external origins your review site may load, review-site linter G6): ${JSON.stringify(phase.cdn_allowlist)}` : ""}

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

  const humanFeedbackBlock = taskCtx.humanFeedback
    ? `## Human reviewer feedback (this phase was sent back)

A human reviewer rejected the previous attempt at this phase and requested changes. Address this feedback directly in your re-run before calling record_phase:

${taskCtx.humanFeedback.trim()}`
    : null;

  const dynamicTail = [
    phaseSkillBlocks.join("\n\n---\n\n"),
    roleInstruction,
    taskContext,
    humanFeedbackBlock,
  ]
    .filter((s): s is string => s !== null)
    .join("\n\n");

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

async function readSubphasesLogForPrompt(
  taskDir: string,
  phaseId: string,
): Promise<SubphasesJson> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(taskDir, "phases", phaseId, "subphases.json"), "utf8"),
    );
    const validated = validateSubphasesJson(raw);
    return validated.ok ? validated.value : [];
  } catch {
    return [];
  }
}

/**
 * Fresh gate-reviewer system prompt (design §10). Same static prefix + phase
 * skills as the worker, but the role instruction says "evaluate against
 * Verification, not Methodology" and the reviewer gets disk-only context —
 * never the worker's session transcript.
 */
export async function buildReviewerSystemPrompt(
  protocol: ProtocolYaml,
  protocolSkillDir: string,
  claudeScienceHome: string,
  phase: ProtocolPhase,
  resolvedSkills: readonly ResolvedSkill[],
  reviewerCtx: ReviewerPromptContext,
): Promise<readonly string[]> {
  const staticPrefix = await buildStaticPrefix(
    protocol,
    protocolSkillDir,
    claudeScienceHome,
  );

  const phaseSkillBlocks = resolvedSkills.map(
    (s) => `# Phase skill: ${s.ref}\n\n${s.body.trim()}`,
  );

  const subphaseIds = phase.subphases?.map((sp) => sp.id) ?? [];
  const outputs = phase.outputs ?? [];

  const log = await readSubphasesLogForPrompt(reviewerCtx.taskDir, phase.id);
  const latest = latestMarksBySubphase(log);
  const subphaseReviewTopics =
    subphaseIds.length === 0
      ? ""
      : `\n\nWorker's subphase marks — explicit review topics (recompute, don't just agree):\n${subphaseIds
          .map((id) => {
            const entry = latest.get(id);
            if (!entry) return `- ${id}: (unmarked)`;
            const scrutiny =
              entry.mark === "human-review"
                ? " — flagged human-review by the worker; give this particular scrutiny: was the uncertainty warranted, and is the output actually correct?"
                : "";
            return `- ${id}: ${entry.mark} (confidence: ${entry.confidence ?? "n/a"})${entry.notes ? ` — "${entry.notes}"` : ""}${scrutiny}`;
          })
          .join("\n")}`;

  const roleInstruction = `## Role: Gate Reviewer (independent, not the worker)

You are a FRESH, independent reviewer. You did not do this work and you have
no access to the worker's session — only what is on disk.

Evaluate phase "${phase.id}" against the **Verification** sections of the
phase skills above. Do NOT follow the Methodology sections — those describe
the worker's job, not yours.

**Do computational verification, not visual inspection alone.** Write and run
your own verification code (e.g. Python via Bash, using the interpreter
below) under \`review/verification/${phase.id}/\`. Recompute the checks the
Verification sections describe yourself (e.g. connected-components counts,
measurement thresholds) against the actual artifact files — do not restate
the worker's prose as your evidence. Quote your own computed values in your
\`submit_gate_decision\` feedback.

**Trust boundary (enforced by the harness, not just requested):**
- You may READ anything under \`artifacts/\` and \`phases/${phase.id}/\`.
- You may WRITE ONLY under \`review/verification/${phase.id}/\` — your
  scratch space for verification code and its output.
- You must NOT modify anything under \`artifacts/\` or \`phases/\`. The
  harness hashes both before and after this session; any change is treated
  as a review-integrity failure independent of your gate decision.
${subphaseReviewTopics}

Declared artifact outputs for this phase (relative to \`artifacts/\`):
${outputs.map((o) => `- artifacts/${o}`).join("\n") || "(none)"}
${phase.cdn_allowlist !== undefined ? `\nPhase \`cdn_allowlist\` (external origins this review site may load, review-site linter G6): ${JSON.stringify(phase.cdn_allowlist)}` : ""}

When finished, call \`submit_gate_decision\` **exactly once** with:
- \`decision\`: one of \`pass\`, \`fail\`, \`fail-upstream\`, \`pass-with-concerns\`
- \`summary\`: one or two sentence verdict headline (under 140 chars) — states the decision and the single most important reason. Shown collapsed in the dashboard.
- \`rewind_to\`: required (an upstream phase id) if decision is \`fail-upstream\`
- \`feedback\`: structured markdown report (## Confirmed, ## Concerns, ## Blocking sections). Use **bold** for values, \`code\` for paths/thresholds, - bullet lists. Under 800 words.
- \`subphase_assessments\`: map of subphase id → short assessment string (if this phase has subphases)`;

  const taskContext = `## Task context

- Task id: ${reviewerCtx.taskId}
- Task directory (cwd): ${reviewerCtx.taskDir}
- Python interpreter: ${reviewerCtx.runtime.pythonPath}
- Required subprocess env: PYTHONPATH=${reviewerCtx.runtime.env["PYTHONPATH"] ?? ""}, MPLBACKEND=${reviewerCtx.runtime.env["MPLBACKEND"] ?? "Agg"}

Every Bash/Python invocation is a fresh process — persist any intermediate
state to disk under \`review/verification/${phase.id}/\` if you need it
across invocations.`;

  const dynamicTail = [
    phaseSkillBlocks.join("\n\n---\n\n"),
    roleInstruction,
    taskContext,
  ].join("\n\n");

  return [staticPrefix, dynamicTail];
}

/** Allowed SDK tools for the gate-reviewer profile, scoped by phase skills. */
export function mergeReviewerAllowedTools(
  protocol: ProtocolYaml,
  resolvedSkills: readonly ResolvedSkill[],
  labratMcpTools: readonly string[],
): string[] {
  const profileTools = protocol.agents["gate-reviewer"].tools;
  const skillTools = collectSkillReviewerTools(resolvedSkills);
  const sdkTools = intersectTools(profileTools, skillTools);
  return [...sdkTools, ...labratMcpTools];
}

function collectSkillReviewerTools(skills: readonly ResolvedSkill[]): string[] {
  const out = new Set<string>();
  for (const skill of skills) {
    const tools = skill.requires?.reviewer?.tools;
    if (!tools) continue;
    for (const t of tools) {
      out.add(t);
    }
  }
  return [...out];
}
