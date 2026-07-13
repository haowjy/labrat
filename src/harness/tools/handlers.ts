import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  allSubphasesCloseable,
  type ValidationError,
  validateBlockedInput,
  validateMarkSubphaseInput,
  validateReadPastHistoryInput,
  validateSubmitFeedbackRouteInput,
  validateRecordPhaseInput,
  validateSubphasesJson,
  validateSubmitGateDecisionInput,
  validateSubmitMonitorVerdictInput,
  validateViewHumanFeedbackInput,
  type SubphaseMarkEntry,
  type SubphasesJson,
} from "../../schema/index.js";
import { atomicWriteJson } from "../../util/atomic-write.js";
import { buildHumanFeedbackView } from "../review-verdict/index.js";
import { buildPastHistoryView } from "../session/history-view.js";
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

export type PhaseRecordableResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * record_phase's acceptance check, factored out so the worker loop can ask
 * "would record_phase succeed right now?" without mutating ctx.signals:
 * (1) phases/<phase>/ exists and is a directory, (2) all declared artifact
 * outputs are present on disk, (3) all declared subphases are closeable.
 * Single source of truth — handleRecordPhase delegates here.
 */
export async function isPhaseRecordable(
  ctx: LabratToolContext,
): Promise<PhaseRecordableResult> {
  const phase = ctx.currentPhase;
  const phaseDir = path.join(ctx.taskDir, "phases", phase);
  if (!(await existsAt(phaseDir))) {
    return {
      ok: false,
      reason: `Cannot record phase: phases/${phase}/ does not exist. Write your phase record first.`,
    };
  }

  const phaseDirStat = await stat(phaseDir);
  if (!phaseDirStat.isDirectory()) {
    return { ok: false, reason: `phases/${phase}/ is not a directory.` };
  }

  const artifactError = await validateArtifactOutputs(ctx);
  if (artifactError) {
    return { ok: false, reason: artifactError };
  }

  if (ctx.subphaseIds.length > 0) {
    const log = await readSubphasesLog(ctx.taskDir, phase);
    const closeable = allSubphasesCloseable(ctx.subphaseIds, log);
    if (!closeable.ok) {
      return {
        ok: false,
        reason: `Cannot record phase: ${closeable.reason}. Mark all subphases pass or human-review before recording.`,
      };
    }
  }

  return { ok: true };
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

  const recordable = await isPhaseRecordable(ctx);
  if (!recordable.ok) {
    return textResult(recordable.reason, true);
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

  // Validate feedback_file: must be under review/verification/{phase}/ and exist on disk.
  if (validated.value.feedback_file) {
    const feedbackRel = validated.value.feedback_file;
    const allowedPrefix = `review/verification/${ctx.currentPhase}/`;
    const normalized = path.posix.normalize(feedbackRel);
    if (
      normalized.startsWith("..") ||
      path.isAbsolute(feedbackRel) ||
      !normalized.startsWith(allowedPrefix)
    ) {
      return textResult(
        `feedback_file must be a relative path under ${allowedPrefix}. Got: ${feedbackRel}`,
        true,
      );
    }
    const feedbackPath = path.join(ctx.taskDir, normalized);
    // Resolve symlinks and confirm the real path is still inside the task dir.
    let realFeedbackPath: string;
    try {
      realFeedbackPath = await realpath(feedbackPath);
    } catch {
      return textResult(
        `feedback_file not found: ${feedbackRel}. Write the report file before submitting the gate decision.`,
        true,
      );
    }
    const realTaskDir = await realpath(ctx.taskDir);
    if (!realFeedbackPath.startsWith(realTaskDir + path.sep)) {
      return textResult(
        `feedback_file resolves outside the task directory (symlink escape). Got: ${feedbackRel}`,
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

/**
 * feedback-router role ONLY (design §3E). The router SIGNALS its proposed
 * restart route through this tool — it never writes review/routing/ itself.
 * Harness code (orchestrator invalidateForSendBack) validates the proposal,
 * selects the accepted phase, and writes the append-only route records.
 */
export async function handleSubmitFeedbackRoute(
  ctx: LabratToolContext,
  input: unknown,
): Promise<CallToolResult> {
  const validated = validateSubmitFeedbackRouteInput(input);
  if (!validated.ok) {
    return textResult(
      `Invalid submit_feedback_route input: ${formatValidationErrors(validated.errors)}`,
      true,
    );
  }

  ctx.signals.feedbackRoute = validated.value;
  return textResult(
    `Route proposal recorded: ${validated.value.restart_phase ?? "null"} (${validated.value.confidence}). The harness will validate and may reject or fall back.`,
  );
}

/**
 * Author-visible phase scope: protocol phases at or before the current phase
 * (design §3C). Falls back to the current phase alone when the context
 * carries no phase order. Phase params are validated against THIS list —
 * never joined into paths raw — so traversal input can never resolve a path.
 */
function authorVisiblePhases(ctx: LabratToolContext): readonly string[] {
  const order = ctx.phaseOrder ?? [];
  const idx = order.indexOf(ctx.currentPhase);
  if (idx === -1) {
    return [ctx.currentPhase];
  }
  return order.slice(0, idx + 1);
}

/** read_past_history — PURE read; never writes files or sets signals. */
export async function handleReadPastHistory(
  ctx: LabratToolContext,
  input: unknown,
): Promise<CallToolResult> {
  const validated = validateReadPastHistoryInput(input);
  if (!validated.ok) {
    return textResult(
      `Invalid read_past_history input: ${formatValidationErrors(validated.errors)}`,
      true,
    );
  }

  const result = await buildPastHistoryView({
    taskDir: ctx.taskDir,
    visiblePhases: authorVisiblePhases(ctx),
    ...(validated.value.phase !== undefined ? { phase: validated.value.phase } : {}),
    ...(validated.value.role !== undefined ? { role: validated.value.role } : {}),
    ...(validated.value.cursor !== undefined ? { cursor: validated.value.cursor } : {}),
    maxTokens: validated.value.max_tokens,
    ...(validated.value.expand !== undefined ? { expand: validated.value.expand } : {}),
  });
  if (!result.ok) {
    return textResult(`read_past_history: ${result.error}`, true);
  }
  return textResult(JSON.stringify(result.view));
}

/** view_human_feedback — PURE read; never writes files or sets signals. */
export async function handleViewHumanFeedback(
  ctx: LabratToolContext,
  input: unknown,
): Promise<CallToolResult> {
  const validated = validateViewHumanFeedbackInput(input);
  if (!validated.ok) {
    return textResult(
      `Invalid view_human_feedback input: ${formatValidationErrors(validated.errors)}`,
      true,
    );
  }

  const result = await buildHumanFeedbackView({
    taskDir: ctx.taskDir,
    visiblePhases: authorVisiblePhases(ctx),
    ...(validated.value.phase !== undefined ? { phase: validated.value.phase } : {}),
    includeArchived: validated.value.include_archived,
    ...(validated.value.cursor !== undefined ? { cursor: validated.value.cursor } : {}),
    maxTokens: validated.value.max_tokens,
  });
  if (!result.ok) {
    return textResult(`view_human_feedback: ${result.error}`, true);
  }
  return textResult(JSON.stringify(result.view));
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
