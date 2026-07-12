import {
  query,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type HookCallback,
} from "@anthropic-ai/claude-agent-sdk";
import type { LabratConfig } from "../../config/index.js";
import type { SubmitGateDecisionInput } from "../../schema/index.js";
import { notifyEvent } from "../events/index.js";
import type { RuntimeHandle } from "../runtime-setup/types.js";
import {
  assembleReviewerPrompt,
  mergeReviewerAllowedTools,
  type LoadedPhase,
  type LoadedProtocol,
  type ReviewerPromptContext,
} from "../protocol-loader/index.js";
import { buildSessionEnv } from "./worker.js";
import {
  allowedLabratTools,
  createLabratToolServer,
  createOrchestratorSignals,
  type LabratToolContext,
} from "./signals.js";
import { extractAssistantText, extractSessionId } from "./sdk-messages.js";
import {
  createSessionLogger,
  isSessionLogPath,
  type SessionLogger,
} from "./session-log.js";

export type ReviewSessionConfig = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly protocol: LoadedProtocol;
  readonly loadedPhase: LoadedPhase;
  /** Phase attempt number (1 on first run) — threaded from GateContext so
   * session logs carry it explicitly, never inferred from archives. */
  readonly attempt: number;
  readonly runtime: RuntimeHandle;
  /** Resolved harness-wide config (src/config) — the base layer under
   * protocol.yaml/agent-def precedence for model + permission mode. */
  readonly runSettings: LabratConfig;
};

export type ReviewSessionResult = {
  readonly sessionId: string;
  readonly decision: SubmitGateDecisionInput;
  /** True when the reviewer never called submit_gate_decision and the
   * harness applied the design §12 default (pass-with-concerns, low). */
  readonly defaulted: boolean;
};

const DEFAULT_DECISION: SubmitGateDecisionInput = {
  decision: "pass-with-concerns",
  feedback:
    "Reviewer did not call submit_gate_decision after 2 attempts — harness default per design §12.",
};

/**
 * Independence guard: deny direct reviewer access to worker/author session
 * logs under `phases/<phase>/sessions/` (live or archived). This is guidance
 * with a clear error, NOT a security sandbox — a same-UID `Bash` command can
 * still read the files; the design's bubblewrap profile (out of scope for
 * this piece) is the actual boundary.
 */
export function reviewerToolTargetsSessionLog(
  toolName: string,
  toolInput: unknown,
): boolean {
  if (toolName !== "Read" && toolName !== "Grep" && toolName !== "Glob") {
    return false;
  }
  if (typeof toolInput !== "object" || toolInput === null) {
    return false;
  }
  const record = toolInput as Record<string, unknown>;
  return ["file_path", "path", "pattern"].some((key) => {
    const value = record[key];
    return typeof value === "string" && isSessionLogPath(value);
  });
}

const denySessionLogAccess: HookCallback = async (input) => {
  if (
    input.hook_event_name !== "PreToolUse" ||
    !reviewerToolTargetsSessionLog(input.tool_name, input.tool_input)
  ) {
    return {};
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "Session logs under phases/**/sessions/ are off-limits to the gate reviewer — review the on-disk artifacts, not the worker's transcript.",
    },
  };
};

function reviewerUserPrompt(phaseId: string, taskId: string, isReminder: boolean): string {
  const reminder = isReminder
    ? "\n\nREMINDER: Your previous turn ended without calling submit_gate_decision. Finish your verification and call submit_gate_decision now."
    : "";
  return `Independently review the **${phaseId}** phase for task ${taskId}.

You are a fresh reviewer session — you were not the worker and you have no access to its
conversation. Everything you need is on disk under the task directory (your cwd).
Evaluate against the Verification section(s) of the phase skill(s) above, compute your
own checks, and call submit_gate_decision when done.${reminder}`;
}

async function runOneReviewQuery(
  config: ReviewSessionConfig,
  systemPromptParts: readonly string[],
  toolCtx: LabratToolContext,
  isReminder: boolean,
  sessionLog: SessionLogger,
  queryOrdinal: number,
): Promise<string> {
  const mcpServer = createLabratToolServer({ ctx: toolCtx, role: "gate-reviewer" });
  const labratTools = allowedLabratTools("gate-reviewer", toolCtx.subphaseIds);
  const allowedTools = mergeReviewerAllowedTools(
    config.protocol.yaml,
    config.loadedPhase.skills,
    labratTools,
  );

  const systemPrompt = [
    systemPromptParts[0] ?? "",
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    systemPromptParts[1] ?? "",
  ];

  const model =
    config.protocol.yaml.agents["gate-reviewer"].model ?? config.runSettings.defaultModel;
  const permissionMode =
    config.protocol.yaml.agents["gate-reviewer"].permissions ??
    config.runSettings.defaultPermissionMode;

  const q = query({
    prompt: reviewerUserPrompt(config.loadedPhase.phase.id, config.taskId, isReminder),
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
      hooks: {
        PreToolUse: [{ matcher: "Read|Grep|Glob", hooks: [denySessionLogAccess] }],
      },
      ...(isReminder ? { continue: true } : {}),
    },
  });

  let sessionId = "";
  for await (const msg of q) {
    // Persist the sanitized projection BEFORE any message-derived side effect
    // (review-provenance §3A).
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
    if (toolCtx.signals.gateDecision) {
      break;
    }
  }

  return sessionId;
}

/**
 * Run a FRESH gate-reviewer `query()` for one phase (design §10). The
 * reviewer never receives the worker's session — only disk access via
 * Bash/Read/Grep/Glob and scratch write access enforced by the trust
 * boundary (see trust-boundary.ts, invoked by the caller around this call).
 */
export async function runGateReview(
  config: ReviewSessionConfig,
): Promise<ReviewSessionResult> {
  const reviewerCtx: ReviewerPromptContext = {
    taskId: config.taskId,
    taskDir: config.taskDir,
    runtime: config.runtime,
  };

  const systemPromptParts = await assembleReviewerPrompt(
    config.protocol,
    config.loadedPhase,
    reviewerCtx,
  );

  const toolCtx: LabratToolContext = {
    taskId: config.taskId,
    taskDir: config.taskDir,
    currentPhase: config.loadedPhase.phase.id,
    phaseOutputs: config.loadedPhase.phaseOutputs,
    subphaseIds: config.loadedPhase.subphaseIds,
    signals: createOrchestratorSignals(),
  };

  const sessionLog = createSessionLogger({
    taskDir: config.taskDir,
    taskId: config.taskId,
    phase: config.loadedPhase.phase.id,
    attempt: config.attempt,
    role: "gate-reviewer",
    // TODO(review-provenance): source exact secret values from loadConfig()
    // when the config carries any — LabratConfig currently holds no secret
    // material. Never read process.env here.
    secrets: [],
  });

  let sessionId = "";
  const maxAttempts = config.runSettings.retries.reviewAttempts;

  for (let queryAttempt = 1; queryAttempt <= maxAttempts; queryAttempt++) {
    const isReminder = queryAttempt > 1;
    const sid = await runOneReviewQuery(
      config,
      systemPromptParts,
      toolCtx,
      isReminder,
      sessionLog,
      queryAttempt,
    );
    if (sid) {
      sessionId = sid;
    }

    if (toolCtx.signals.gateDecision) {
      return { sessionId, decision: toolCtx.signals.gateDecision, defaulted: false };
    }
  }

  return { sessionId, decision: DEFAULT_DECISION, defaulted: true };
}
