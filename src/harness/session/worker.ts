import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validateReviewVerdictRecord } from "../../schema/index.js";
import {
  query,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type AgentDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { LabratConfig } from "../../config/index.js";
import type { ProtocolYaml } from "../../schema/index.js";
import { notifyEvent } from "../events/index.js";
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
import { extractAssistantText, extractSessionId } from "./sdk-messages.js";

export type WorkerSessionConfig = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly inputRel: string;
  readonly protocol: LoadedProtocol;
  readonly phaseId: string;
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
  return env;
}

function phaseUserPrompt(
  phaseId: string,
  taskId: string,
  inputRel: string,
  isReminder: boolean,
): string {
  const reminder = isReminder
    ? "\n\nREMINDER: Your previous turn ended without calling record_phase. Finish remaining work and call record_phase when the phase is complete."
    : "";
  return `Execute the **${phaseId}** phase for task ${taskId}.

Input DICOM (relative to task dir): ${inputRel}
Work in the task directory as cwd. Follow methodology, write phase records and artifacts, mark subphases as needed, then call record_phase for phase "${phaseId}".${reminder}`;
}

async function runOneQuery(
  config: WorkerSessionConfig,
  loadedPhase: Awaited<ReturnType<typeof loadPhase>>,
  systemPromptParts: readonly string[],
  toolCtx: LabratToolContext,
  userPrompt: string,
  continueSession: boolean,
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

  let sessionId = "";
  for await (const msg of q) {
    const sid = extractSessionId(msg);
    if (sid) {
      sessionId = sid;
    }
    const text = extractAssistantText(msg);
    if (text) {
      notifyEvent({
        type: "log",
        taskId: config.taskId,
        line: text.slice(0, 300),
        ephemeral: true,
      });
    }
    if (toolCtx.signals.phaseComplete || toolCtx.signals.blockedReason) {
      break;
    }
  }

  return sessionId;
}

/**
 * The human reviewer's send-back note for this phase, when the phase is being
 * re-run because a human sent it back (review/verdict/{phase}.json,
 * human_verdict=changes_requested). Threaded into the worker's prompt so the
 * re-run acts on the correction. WORKER-only: this read is deliberately NOT
 * mirrored into the reviewer session (session/review.ts) — the independent
 * reviewer must re-gate without seeing the human verdict (trust boundary).
 * Read inline (not via orchestrator/index.ts) to avoid an import cycle.
 */
async function readHumanFeedbackNote(
  taskDir: string,
  phaseId: string,
): Promise<string | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await readFile(join(taskDir, "review", "verdict", `${phaseId}.json`), "utf8"),
    );
  } catch {
    return null;
  }
  const validated = validateReviewVerdictRecord(raw);
  if (!validated.ok || validated.value.human_verdict !== "changes_requested") {
    return null;
  }
  const note = validated.value.notes.trim();
  return note.length > 0 ? note : null;
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

  let sessionId = "";
  let stallCount = 0;
  const maxStallRetries = config.runSettings.retries.workerStall;

  while (stallCount <= maxStallRetries) {
    const isReminder = stallCount > 0;
    const userPrompt = phaseUserPrompt(
      config.phaseId,
      config.taskId,
      config.inputRel,
      isReminder,
    );

    const sid = await runOneQuery(
      config,
      loadedPhase,
      systemPromptParts,
      toolCtx,
      userPrompt,
      isReminder,
    );

    if (sid) {
      sessionId = sid;
    }

    if (toolCtx.signals.blockedReason) {
      return {
        sessionId,
        phaseComplete: false,
        blockedReason: toolCtx.signals.blockedReason,
        stallExhausted: false,
      };
    }

    if (toolCtx.signals.phaseComplete) {
      return {
        sessionId,
        phaseComplete: true,
        blockedReason: null,
        stallExhausted: false,
      };
    }

    stallCount += 1;
  }

  return {
    sessionId,
    phaseComplete: false,
    blockedReason: null,
    stallExhausted: true,
  };
}
