import {
  query,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from "@anthropic-ai/claude-agent-sdk";
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

export type ReviewSessionConfig = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly protocol: LoadedProtocol;
  readonly loadedPhase: LoadedPhase;
  readonly runtime: RuntimeHandle;
};

export type ReviewSessionResult = {
  readonly sessionId: string;
  readonly decision: SubmitGateDecisionInput;
  /** True when the reviewer never called submit_gate_decision and the
   * harness applied the design §12 default (pass-with-concerns, low). */
  readonly defaulted: boolean;
};

const MAX_ATTEMPTS = 2;

const DEFAULT_DECISION: SubmitGateDecisionInput = {
  decision: "pass-with-concerns",
  feedback:
    "Reviewer did not call submit_gate_decision after 2 attempts — harness default per design §12.",
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

  const q = query({
    prompt: reviewerUserPrompt(config.loadedPhase.phase.id, config.taskId, isReminder),
    options: {
      model: config.protocol.yaml.agents["gate-reviewer"].model ?? "sonnet",
      cwd: config.taskDir,
      env: buildSessionEnv(config.runtime),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt,
      allowedTools,
      mcpServers: { labrat: mcpServer },
      ...(isReminder ? { continue: true } : {}),
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

  let sessionId = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const isReminder = attempt > 1;
    const sid = await runOneReviewQuery(config, systemPromptParts, toolCtx, isReminder);
    if (sid) {
      sessionId = sid;
    }

    if (toolCtx.signals.gateDecision) {
      return { sessionId, decision: toolCtx.signals.gateDecision, defaulted: false };
    }
  }

  return { sessionId, decision: DEFAULT_DECISION, defaulted: true };
}
