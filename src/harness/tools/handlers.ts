import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  allSubphasesCloseable,
  type ValidationError,
  validateBlockedInput,
  validateMarkSubphaseInput,
  validateRecordPhaseInput,
  validateSubphasesJson,
  validateSubmitGateDecisionInput,
  validateSubmitMonitorVerdictInput,
  type SubphaseMarkEntry,
  type SubphasesJson,
} from "../../schema/index.js";
import { atomicWriteJson } from "../../util/atomic-write.js";
import type { LabratToolContext } from "./context.js";

function formatValidationErrors(errors: readonly ValidationError[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join("; ");
}

function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function existsAt(taskPath: string): Promise<boolean> {
  try {
    await access(taskPath);
    return true;
  } catch {
    return false;
  }
}

function artifactPath(taskDir: string, output: string): string {
  const normalized = output.replace(/\/+$/, "");
  return path.join(taskDir, "artifacts", normalized);
}

async function validateArtifactOutputs(
  ctx: LabratToolContext,
): Promise<string | null> {
  const missing: string[] = [];

  for (const output of ctx.phaseOutputs) {
    const fullPath = artifactPath(ctx.taskDir, output);
    if (!(await existsAt(fullPath))) {
      missing.push(`artifacts/${output}`);
      continue;
    }

    if (output.endsWith("/")) {
      const info = await stat(fullPath);
      if (!info.isDirectory()) {
        missing.push(`artifacts/${output} (expected directory)`);
      }
    }
  }

  if (missing.length === 0) {
    return null;
  }
  return `Missing required artifact outputs: ${missing.join(", ")}`;
}

async function readSubphasesLog(
  taskDir: string,
  phase: string,
): Promise<SubphasesJson> {
  const filePath = path.join(taskDir, "phases", phase, "subphases.json");
  if (!(await existsAt(filePath))) {
    return [];
  }

  const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
  const validated = validateSubphasesJson(raw);
  if (!validated.ok) {
    throw new Error(
      `Invalid subphases.json: ${formatValidationErrors(validated.errors)}`,
    );
  }
  return validated.value;
}

function nextAttempt(log: SubphasesJson, subphase: string): number {
  let max = 0;
  for (const entry of log) {
    if (entry.subphase === subphase && entry.attempt > max) {
      max = entry.attempt;
    }
  }
  return max + 1;
}

export async function handleRecordPhase(
  ctx: LabratToolContext,
  input: unknown,
): Promise<CallToolResult> {
  const validated = validateRecordPhaseInput(input);
  if (!validated.ok) {
    return textResult(
      `Invalid record_phase input: ${formatValidationErrors(validated.errors)}`,
      true,
    );
  }

  const { phase } = validated.value;
  if (phase !== ctx.currentPhase) {
    return textResult(
      `Phase mismatch: tool called with "${phase}" but current phase is "${ctx.currentPhase}".`,
      true,
    );
  }

  const phaseDir = path.join(ctx.taskDir, "phases", phase);
  if (!(await existsAt(phaseDir))) {
    return textResult(
      `Cannot record phase: phases/${phase}/ does not exist. Write your phase record first.`,
      true,
    );
  }

  const phaseDirStat = await stat(phaseDir);
  if (!phaseDirStat.isDirectory()) {
    return textResult(`phases/${phase}/ is not a directory.`, true);
  }

  const artifactError = await validateArtifactOutputs(ctx);
  if (artifactError) {
    return textResult(artifactError, true);
  }

  if (ctx.subphaseIds.length > 0) {
    const log = await readSubphasesLog(ctx.taskDir, phase);
    const closeable = allSubphasesCloseable(ctx.subphaseIds, log);
    if (!closeable.ok) {
      return textResult(
        `Cannot record phase: ${closeable.reason}. Mark all subphases pass or human-review before recording.`,
        true,
      );
    }
  }

  ctx.signals.phaseComplete = true;
  return textResult("Phase recorded. Stopping for review.");
}

export async function handleMarkSubphase(
  ctx: LabratToolContext,
  input: unknown,
): Promise<CallToolResult> {
  const validated = validateMarkSubphaseInput(input);
  if (!validated.ok) {
    return textResult(
      `Invalid mark_subphase input: ${formatValidationErrors(validated.errors)}`,
      true,
    );
  }

  const { subphase, mark, confidence, notes } = validated.value;
  if (!ctx.subphaseIds.includes(subphase)) {
    return textResult(
      `Unknown subphase "${subphase}". Declared subphases: ${ctx.subphaseIds.join(", ") || "(none)"}.`,
      true,
    );
  }

  const filePath = path.join(
    ctx.taskDir,
    "phases",
    ctx.currentPhase,
    "subphases.json",
  );
  const log = await readSubphasesLog(ctx.taskDir, ctx.currentPhase);
  const entry: SubphaseMarkEntry = {
    subphase,
    mark,
    attempt: nextAttempt(log, subphase),
    timestamp: new Date().toISOString(),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };

  const nextLog: SubphasesJson = [...log, entry];
  const fileValidated = validateSubphasesJson(nextLog);
  if (!fileValidated.ok) {
    return textResult(
      `Internal error building subphases log: ${formatValidationErrors(fileValidated.errors)}`,
      true,
    );
  }

  await atomicWriteJson(filePath, fileValidated.value);
  return textResult(
    `Marked subphase ${subphase} as ${mark} (attempt ${entry.attempt}).`,
  );
}

export async function handleSubmitGateDecision(
  ctx: LabratToolContext,
  input: unknown,
): Promise<CallToolResult> {
  const validated = validateSubmitGateDecisionInput(input);
  if (!validated.ok) {
    return textResult(
      `Invalid submit_gate_decision input: ${formatValidationErrors(validated.errors)}`,
      true,
    );
  }

  // Validate feedback_file exists on disk when provided
  if (validated.value.feedback_file) {
    const feedbackPath = path.join(ctx.taskDir, validated.value.feedback_file);
    if (!(await existsAt(feedbackPath))) {
      return textResult(
        `feedback_file not found: ${validated.value.feedback_file}. Write the report file before submitting the gate decision.`,
        true,
      );
    }
  }

  ctx.signals.gateDecision = validated.value;
  return textResult(`Gate decision recorded: ${validated.value.decision}.`);
}

export async function handleSubmitMonitorVerdict(
  ctx: LabratToolContext,
  input: unknown,
): Promise<CallToolResult> {
  const validated = validateSubmitMonitorVerdictInput(input);
  if (!validated.ok) {
    return textResult(
      `Invalid submit_monitor_verdict input: ${formatValidationErrors(validated.errors)}`,
      true,
    );
  }

  ctx.signals.monitorVerdict = validated.value;
  return textResult(`Monitor verdict recorded: ${validated.value.verdict}.`);
}

export async function handleBlocked(
  ctx: LabratToolContext,
  input: unknown,
): Promise<CallToolResult> {
  const validated = validateBlockedInput(input);
  if (!validated.ok) {
    return textResult(
      `Invalid blocked input: ${formatValidationErrors(validated.errors)}`,
      true,
    );
  }

  ctx.signals.blockedReason = validated.value.reason;
  return textResult("Task blocked. Harness will pause and escalate.");
}
