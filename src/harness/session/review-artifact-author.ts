import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  query,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type HookCallback,
} from "@anthropic-ai/claude-agent-sdk";
import type { LabratConfig } from "../../config/index.js";
import type { ProtocolPhase, ReviewArtifactType } from "../../schema/index.js";
import { notifyEvent } from "../events/index.js";
import type { RuntimeHandle } from "../runtime-setup/types.js";
import type { LoadedProtocol } from "../protocol-loader/index.js";
import { buildSessionEnv } from "./worker.js";
import { reviewerToolTargetsSessionLog } from "./review.js";
import {
  allowedLabratTools,
  createLabratToolServer,
  createOrchestratorSignals,
  type LabratToolContext,
} from "./signals.js";
import { extractAssistantText, extractSessionId } from "./sdk-messages.js";
import { createSessionLogger } from "./session-log.js";

/**
 * Fresh review-artifact-author session (review-provenance design §3.D).
 *
 * Runs AFTER the scientific gate is accepted and BEFORE the phase settles: a
 * disk-only author that turns already-verified evidence into one phase-scoped
 * interactive review artifact. It performs no science and cannot change the
 * gate verdict; its writable scope is the assigned STAGING dir only — the
 * harness (artifact-settlement.ts) copies the template in, runs the
 * deterministic linter, and owns publication. Author/linter retries get a
 * FRESH session each (`authorAttempt` is the query ordinal in the shared
 * per-phase-attempt role log).
 */
export type AuthorSessionConfig = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly protocol: LoadedProtocol;
  readonly phase: ProtocolPhase;
  /** Scientific phase attempt (1 on first run) — threads into the session log. */
  readonly attempt: number;
  /** Author attempt within this scientific attempt (1 on first author run). */
  readonly authorAttempt: number;
  /** Absolute path of the staging dir the author may write (already seeded
   * with the resolved template by the settlement layer). */
  readonly stagingDir: string;
  readonly artifactType: Exclude<ReviewArtifactType, "none">;
  /** Resolved review-artifact-builder skill dir — its SKILL.md guides the author. */
  readonly authorSkillDir: string;
  readonly runtime: RuntimeHandle;
  readonly runSettings: LabratConfig;
};

export type AuthorSessionResult = {
  readonly sessionId: string;
};

/** The role's author-only MCP tool names; everything else in the profile's
 * `tools` list is a built-in SDK tool name passed through as-is. */
const AUTHOR_MCP_TOOLS = new Set(["read_past_history", "view_human_feedback"]);

export function authorAllowedTools(profileTools: readonly string[]): string[] {
  return [
    ...profileTools.filter((t) => !AUTHOR_MCP_TOOLS.has(t)),
    ...allowedLabratTools("review-artifact-author", []),
  ];
}

function isUnder(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * PreToolUse hooks enforcing the author's scope (design §3.D): `Write`/`Edit`
 * targets must stay under the assigned staging root, and direct
 * `Read`/`Grep`/`Glob` of session logs or `review/verdict/**` is denied — those
 * sources are available only through the scoped MCP tools. Guidance with a
 * clear error, not the security boundary (same caveat as the reviewer hook).
 */
export function buildAuthorHooks(taskDir: string, stagingDir: string): HookCallback {
  const stagingRoot = resolve(stagingDir);
  const verdictRoot = resolve(taskDir, "review", "verdict");

  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const { tool_name: toolName, tool_input: toolInput } = input;

    if (toolName === "Write" || toolName === "Edit") {
      const record =
        typeof toolInput === "object" && toolInput !== null
          ? (toolInput as Record<string, unknown>)
          : {};
      const target = record["file_path"];
      const abs =
        typeof target === "string"
          ? isAbsolute(target)
            ? resolve(target)
            : resolve(taskDir, target)
          : null;
      if (abs === null || !isUnder(stagingRoot, abs)) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `The review-artifact author may write only inside its staging dir: ${stagingRoot}`,
          },
        };
      }
      return {};
    }

    if (reviewerToolTargetsSessionLog(toolName, toolInput)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Session logs under phases/**/sessions/ are off-limits to direct reads — use read_past_history for sanitized prior-session context.",
        },
      };
    }

    if (toolName === "Read" || toolName === "Grep" || toolName === "Glob") {
      const record =
        typeof toolInput === "object" && toolInput !== null
          ? (toolInput as Record<string, unknown>)
          : {};
      const targetsVerdict = ["file_path", "path", "pattern"].some((key) => {
        const value = record[key];
        if (typeof value !== "string") return false;
        const abs = isAbsolute(value) ? resolve(value) : resolve(taskDir, value);
        return isUnder(verdictRoot, abs) || /(^|\/)review\/verdict(\/|$)/.test(value);
      });
      if (targetsVerdict) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "review/verdict/ is off-limits to direct reads — use view_human_feedback for validated human verdicts and notes.",
          },
        };
      }
    }

    return {};
  };
}

async function loadAuthorSkillBody(authorSkillDir: string): Promise<string> {
  const raw = await readFile(join(authorSkillDir, "SKILL.md"), "utf8");
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  return (match?.[1] ?? raw).trim();
}

function authorUserPrompt(config: AuthorSessionConfig): string {
  return `Author the **${config.artifactType}** review artifact for the **${config.phase.id}** phase of task ${config.taskId}.

You are a fresh review-artifact-author session. The scientific gate for this phase has
ALREADY been accepted — you perform no science and cannot change that verdict. Build a
single self-contained interactive review artifact a human uses to confirm the phase's
result, from the verified files on disk under the task directory (your cwd).

Your staging directory (the ONLY place you may write) is:

    ${config.stagingDir}

It has been seeded with the selected template. Customize the information hierarchy,
titles, annotations, thresholds, units, and views for this phase from verified disk
evidence only; preserve the template's security shell, REVIEW_MANIFEST schema, bridge
contract, and required controls. The site's sample_id must be exactly "${config.taskId}".
Every displayed claim must cite a disk source (path + field/hash); label missing
evidence as absent rather than inferring it. The harness will run the deterministic
linter and publish — never write to the published path.`;
}

/**
 * Run ONE fresh author `query()` against the staging dir. The settlement layer
 * owns retries (each retry calls this again with a fresh staging dir and a
 * higher `authorAttempt`) and the deterministic linter gate afterward.
 */
export async function runReviewArtifactAuthor(
  config: AuthorSessionConfig,
): Promise<AuthorSessionResult> {
  const profile = config.protocol.yaml.agents["review-artifact-author"];
  if (!profile) {
    // Schema validation rejects protocols that need an author without a
    // profile, so this is an internal invariant, not a user-facing path.
    throw new Error(
      "protocol has no agents.review-artifact-author profile (schema validation should have rejected this)",
    );
  }

  const skillBody = await loadAuthorSkillBody(config.authorSkillDir);
  const systemPrompt = [
    skillBody,
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    `Task: ${config.taskId}\nPhase: ${config.phase.id}\nReview type: ${config.artifactType}\nStaging dir (your only writable path): ${config.stagingDir}`,
  ];

  const toolCtx: LabratToolContext = {
    taskId: config.taskId,
    taskDir: config.taskDir,
    currentPhase: config.phase.id,
    phaseOutputs: config.phase.outputs ?? [],
    subphaseIds: (config.phase.subphases ?? []).map((s) => s.id),
    // Bounds read_past_history/view_human_feedback to phases at/before this
    // one (design §3C) — the author never sees downstream context.
    phaseOrder: config.protocol.yaml.phases.map((p) => p.id),
    signals: createOrchestratorSignals(),
  };
  const mcpServer = createLabratToolServer({ ctx: toolCtx, role: "review-artifact-author" });

  const sessionLog = createSessionLogger({
    taskDir: config.taskDir,
    taskId: config.taskId,
    phase: config.phase.id,
    attempt: config.attempt,
    role: "review-artifact-author",
    secrets: [],
  });

  const model = profile.model ?? config.runSettings.defaultModel;
  const permissionMode = profile.permissions ?? config.runSettings.defaultPermissionMode;
  const authorHook = buildAuthorHooks(config.taskDir, config.stagingDir);

  const q = query({
    prompt: authorUserPrompt(config),
    options: {
      model,
      cwd: config.taskDir,
      env: buildSessionEnv(config.runtime),
      permissionMode,
      ...(permissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      systemPrompt,
      allowedTools: authorAllowedTools(profile.tools),
      mcpServers: { labrat: mcpServer },
      hooks: {
        PreToolUse: [{ matcher: "Write|Edit|Read|Grep|Glob", hooks: [authorHook] }],
      },
    },
  });

  let sessionId = "";
  for await (const msg of q) {
    // Persist the sanitized projection BEFORE any message-derived side effect
    // (review-provenance §3A). queryOrdinal = author attempt: retries within
    // one scientific attempt append to the same role file.
    await sessionLog.append(msg, { queryOrdinal: config.authorAttempt });
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
  }

  return { sessionId };
}
