import { dirname } from "node:path";
import {
  query,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type AgentDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { LabratConfig } from "../../config/index.js";
import type { ProtocolYaml } from "../../schema/index.js";
import { notifyEvent } from "../events/index.js";
import { readHumanFeedbackNote } from "../review-verdict/index.js";
import type { RuntimeHandle } from "../runtime-setup/types.js";
import {
  assembleWorkerPrompt,
  loadPhase,
  mergeWorkerAllowedTools,
  type LoadedProtocol,
  type TaskPromptContext,
} from "../protocol-loader/index.js";
import {
  allowedLabratTools,
  createLabratToolServer,
  createOrchestratorSignals,
  type LabratToolContext,
} from "./signals.js";
import {
  extractAssistantText,
  extractBackgroundTasks,
  extractSessionId,
} from "./sdk-messages.js";
import { createSessionLogger, type SessionLogger } from "./session-log.js";
import { SESSION_ENV_HARDENING } from "./session-env.js";
import { isPhaseRecordable } from "../tools/handlers.js";
import {
  classifyTurnOutcome,
  snapshotPhaseDir,
  snapshotsEqual,
  WORKER_ITERATION_CAP,
  type StallExhaustedReason,
  type TurnLimits,
} from "./worker-stall.js";

export { type StallExhaustedReason } from "./worker-stall.js";

export type WorkerSessionConfig = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly inputRel: string;
  readonly protocol: LoadedProtocol;
  readonly phaseId: string;
  /** Phase attempt number (1 on first run) — threaded from runTask's retry
   * counter so session logs carry it explicitly, never inferred from archives. */
  readonly attempt: number;
  readonly runtime: RuntimeHandle;
  readonly priorPhaseSummaries: Readonly<Record<string, string>>;
  /** Resolved harness-wide config (src/config) — the base layer under
   * protocol.yaml/agent-def precedence for model + permission mode. */
  readonly runSettings: LabratConfig;
};

export type WorkerSessionResult = {
  readonly sessionId: string;
  readonly phaseComplete: boolean;
  readonly blockedReason: string | null;
  readonly stallExhausted: boolean;
  /** Set when stallExhausted is true — distinguishes genuine stalls from
   *  background-grace / time-budget / iteration-cap exhaustion for accurate
   *  error reporting. */
  readonly stallExhaustedReason: StallExhaustedReason | null;
  /** How completion was detected when phaseComplete is true: the explicit
   *  record_phase tool call, or the harness's completion fallback (all
   *  declared outputs present on disk — record_phase's acceptance check
   *  passes — but the tool call never landed, e.g. dropped MCP tool). */
  readonly completedVia: "record_phase" | "outputs-present" | null;
};

function buildSdkAgents(
  protocol: ProtocolYaml,
): Record<string, AgentDefinition> | undefined {
  const reviewer = protocol.agents.worker.subagents?.["reviewer"];
  if (!reviewer) {
    return undefined;
  }
  return {
    reviewer: {
      description: reviewer.description,
      tools: [...reviewer.tools],
      prompt:
        "You are an independent subphase verifier. Read artifacts from disk, run quantitative checks from the Verification sections, and report pass/fail with evidence.",
    },
  };
}

/**
 * The environment for a worker/reviewer session: process env + the runtime's
 * python on PATH. It deliberately does NOT export a harness-root handle
 * (formerly `LABRAT_HOME`): the review-site linter is bound and run by the
 * HARNESS as part of the gate (orchestrator/review-artifact-check.ts), so no
 * session needs to reach into the harness checkout to run it — removing the
 * seam that exposed the harness root + `tsx` to session Bash (Lane C, T1).
 */
export function buildSessionEnv(runtime: RuntimeHandle): Record<string, string> {
  const pythonBinDir = dirname(runtime.pythonPath);
  const pathKey = process.env["PATH"] ?? "";
  const mergedPath = pathKey.includes(pythonBinDir)
    ? pathKey
    : `${pythonBinDir}:${pathKey}`;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(runtime.env)) {
    env[key] = value;
  }
  env["PATH"] = mergedPath;
  // Rationale for ENABLE_TOOL_SEARCH=false lives on SESSION_ENV_HARDENING.
  Object.assign(env, SESSION_ENV_HARDENING);
  return env;
}

type PromptMode = "initial" | "stall-reminder" | "background-continue";

function phaseUserPrompt(
  phaseId: string,
  taskId: string,
  inputRel: string,
  mode: PromptMode,
): string {
  const suffix =
    mode === "stall-reminder"
      ? "\n\nREMINDER: Your previous turn ended without calling record_phase. Finish remaining work and call record_phase when the phase is complete."
      : mode === "background-continue"
        ? "\n\nYour background work has completed (or is still running). Check your background task output, continue any remaining work, and call record_phase when the phase is complete."
        : "";
  return `Execute the **${phaseId}** phase for task ${taskId}.

Input DICOM (relative to task dir): ${inputRel}
Work in the task directory as cwd. Follow methodology, write phase records and artifacts, mark subphases as needed, then call record_phase for phase "${phaseId}".${suffix}`;
}

async function runOneQuery(
  config: WorkerSessionConfig,
  loadedPhase: Awaited<ReturnType<typeof loadPhase>>,
  systemPromptParts: readonly string[],
  toolCtx: LabratToolContext,
  userPrompt: string,
  continueSession: boolean,
  sessionLog: SessionLogger,
  queryOrdinal: number,
): Promise<string> {
  const mcpServer = createLabratToolServer({ ctx: toolCtx, role: "worker" });
  const labratTools = allowedLabratTools("worker", loadedPhase.subphaseIds);
  const allowedTools = mergeWorkerAllowedTools(
    config.protocol.yaml,
    loadedPhase.skills,
    labratTools,
  );

  const systemPrompt = [
    systemPromptParts[0] ?? "",
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    systemPromptParts[1] ?? "",
  ];

  const sdkAgents = buildSdkAgents(config.protocol.yaml);

  const model = config.protocol.yaml.agents.worker.model ?? config.runSettings.defaultModel;
  const permissionMode =
    config.protocol.yaml.agents.worker.permissions ??
    config.runSettings.defaultPermissionMode;

  const q = query({
    prompt: userPrompt,
    options: {
      model,
      cwd: config.taskDir,
      env: buildSessionEnv(config.runtime),
      permissionMode,
      ...(permissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      systemPrompt,
      allowedTools,
      mcpServers: { labrat: mcpServer },
      ...(sdkAgents ? { agents: sdkAgents } : {}),
      ...(continueSession ? { continue: true } : {}),
    },
  });

  // Reset per-process state: background_tasks_changed is process-scoped and
  // emits nothing at startup. Stale entries from a previous query() process
  // would appear as phantom tasks. See SDK docs: "consumers must reset to the
  // empty set whenever the session's CLI process (re)starts."
  toolCtx.signals.activeBackgroundTasks = [];

  let sessionId = "";
  for await (const msg of q) {
    // Persist the sanitized projection BEFORE any message-derived side effect
    // (review-provenance §3A) — the log is the audit trail for what the
    // harness reacted to.
    await sessionLog.append(msg, { queryOrdinal });
    const sid = extractSessionId(msg);
    if (sid) {
      sessionId = sid;
    }
    const text = extractAssistantText(msg);
    if (text) {
      await notifyEvent(config.taskDir, {
        type: "log",
        taskId: config.taskId,
        line: text.slice(0, 300),
        ephemeral: true,
      });
    }
    // Track background tasks (REPLACE semantics — each payload is the full set).
    const bgTasks = extractBackgroundTasks(msg);
    if (bgTasks) {
      toolCtx.signals.activeBackgroundTasks = bgTasks;
    }
    if (toolCtx.signals.phaseComplete || toolCtx.signals.blockedReason) {
      break;
    }
  }

  return sessionId;
}

export async function runWorkerPhase(
  config: WorkerSessionConfig,
): Promise<WorkerSessionResult> {
  const loadedPhase = await loadPhase(config.protocol, config.phaseId);

  const taskCtx: TaskPromptContext = {
    taskId: config.taskId,
    taskDir: config.taskDir,
    inputRel: config.inputRel,
    runtime: config.runtime,
    priorPhaseSummaries: config.priorPhaseSummaries,
    humanFeedback: await readHumanFeedbackNote(config.taskDir, config.phaseId),
  };

  const systemPromptParts = await assembleWorkerPrompt(
    config.protocol,
    loadedPhase,
    taskCtx,
  );

  const toolCtx: LabratToolContext = {
    taskId: config.taskId,
    taskDir: config.taskDir,
    currentPhase: config.phaseId,
    phaseOutputs: loadedPhase.phaseOutputs,
    subphaseIds: loadedPhase.subphaseIds,
    signals: createOrchestratorSignals(),
  };

  const sessionLog = createSessionLogger({
    taskDir: config.taskDir,
    taskId: config.taskId,
    phase: config.phaseId,
    attempt: config.attempt,
    role: "worker",
    // TODO(review-provenance): source exact secret values from loadConfig()
    // when the config carries any — LabratConfig currently holds no secret
    // material. Never read process.env here.
    secrets: [],
  });

  const limits: TurnLimits = {
    workerStall: config.runSettings.retries.workerStall,
    backgroundGraceRetries: config.runSettings.retries.backgroundGraceRetries,
    wallClockMs: config.runSettings.timeouts.workerPhaseWallClockMs,
    iterationCap: WORKER_ITERATION_CAP,
  };

  let sessionId = "";
  let noProgressCount = 0;
  let bgGraceCount = 0;
  let iteration = 0;
  const startedAt = Date.now();
  // Baseline BEFORE the first query so turn-1 progress (usually the phase
  // record itself) registers. Missing dir → empty snapshot.
  let priorSnapshot = await snapshotPhaseDir(config.taskDir, config.phaseId);

  // Progress/quiescence loop (see worker-stall.ts): no re-invocation ceiling —
  // a worker producing on-disk progress keeps running; only consecutive
  // no-progress idle turns, expired background grace, or a backstop
  // (wall-clock / iteration cap) end the phase without record_phase.
  while (true) {
    iteration += 1;

    const mode: PromptMode =
      iteration === 1
        ? "initial"
        : toolCtx.signals.activeBackgroundTasks.length > 0
          ? "background-continue"
          : "stall-reminder";

    const userPrompt = phaseUserPrompt(
      config.phaseId,
      config.taskId,
      config.inputRel,
      mode,
    );

    const sid = await runOneQuery(
      config,
      loadedPhase,
      systemPromptParts,
      toolCtx,
      userPrompt,
      iteration > 1,
      sessionLog,
      iteration,
    );

    if (sid) {
      sessionId = sid;
    }

    // Gather the turn's observable facts, then let the pure classifier decide.
    const blocked = toolCtx.signals.blockedReason !== null;
    const phaseComplete = toolCtx.signals.phaseComplete;
    const hasActiveBackgroundTasks =
      toolCtx.signals.activeBackgroundTasks.length > 0;

    // Completion fallback probe: would record_phase's acceptance check pass?
    let recordable = false;
    if (!blocked && !phaseComplete) {
      try {
        recordable = (await isPhaseRecordable(toolCtx)).ok;
      } catch {
        // e.g. malformed subphases.json — not recordable, fall through to
        // the stall/grace decision (record_phase itself would also error).
      }
    }

    // Progress snapshot only matters on genuinely idle, unfinished turns.
    let progressed = false;
    if (!blocked && !phaseComplete && !recordable && !hasActiveBackgroundTasks) {
      const snapshot = await snapshotPhaseDir(config.taskDir, config.phaseId);
      progressed = !snapshotsEqual(priorSnapshot, snapshot);
      priorSnapshot = snapshot;
    }

    const decision = classifyTurnOutcome({
      blocked,
      phaseComplete,
      recordable,
      hasActiveBackgroundTasks,
      progressed,
      noProgressCount,
      bgGraceCount,
      elapsedMs: Date.now() - startedAt,
      iteration,
      limits,
    });

    switch (decision.action) {
      case "return-blocked":
        return {
          sessionId,
          phaseComplete: false,
          blockedReason: toolCtx.signals.blockedReason,
          stallExhausted: false,
          stallExhaustedReason: null,
          completedVia: null,
        };

      case "return-complete":
        if (decision.completedVia === "outputs-present") {
          // The load-bearing fix: the work is done (record_phase's validation
          // passes) but the tool call never landed — complete instead of
          // mis-reporting a finished phase as a stall.
          toolCtx.signals.phaseComplete = true;
          await notifyEvent(config.taskDir, {
            type: "log",
            taskId: config.taskId,
            line: `[harness] phase ${config.phaseId} auto-completed: all declared outputs present on disk (no explicit record_phase — likely a finalize-tool hiccup)`,
            ephemeral: true,
          });
        }
        return {
          sessionId,
          phaseComplete: true,
          blockedReason: null,
          stallExhausted: false,
          stallExhaustedReason: null,
          completedVia: decision.completedVia,
        };

      case "grace-continue":
        bgGraceCount = decision.bgGraceCount;
        // Fresh stall budget after a grace period (review finding 4): waiting
        // on observable background work must not erode the no-progress clock.
        noProgressCount = decision.noProgressCount;
        await notifyEvent(config.taskDir, {
          type: "log",
          taskId: config.taskId,
          line: `[harness] background work active (${toolCtx.signals.activeBackgroundTasks.length} task(s)), grace ${bgGraceCount}/${limits.backgroundGraceRetries} — not counting as stall`,
          ephemeral: true,
        });
        continue;

      case "reminder-continue":
        noProgressCount = decision.noProgressCount;
        continue;

      case "fail":
        return {
          sessionId,
          phaseComplete: false,
          blockedReason: null,
          stallExhausted: true,
          stallExhaustedReason: decision.reason,
          completedVia: null,
        };
    }
  }
}
