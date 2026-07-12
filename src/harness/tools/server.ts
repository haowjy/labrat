import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type {
  CreateLabratToolServerOptions,
  LabratToolContext,
} from "./context.js";
import {
  handleBlocked,
  handleMarkSubphase,
  handleRecordPhase,
  handleSubmitGateDecision,
  handleSubmitMonitorVerdict,
} from "./handlers.js";
import { MONITOR_VERDICTS } from "../../schema/index.js";

const recordPhaseSchema = {
  phase: z.string().describe("Phase id to record"),
};

const markSubphaseSchema = {
  subphase: z.string().describe("Subphase id"),
  mark: z
    .enum(["pass", "fail", "human-review"])
    .describe("Assessment mark"),
  confidence: z
    .enum(["high", "medium", "low"])
    .optional()
    .describe("Required for pass and human-review"),
  notes: z.string().optional().describe("Optional notes"),
};

const submitGateDecisionSchema = {
  decision: z
    .enum(["pass", "fail", "fail-upstream", "pass-with-concerns"])
    .describe("Gate decision"),
  summary: z
    .string()
    .nullable()
    .optional()
    .describe("One or two sentence verdict shown as the collapsed headline in the dashboard"),
  rewind_to: z
    .string()
    .nullable()
    .optional()
    .describe("Upstream phase to rewind to (required for fail-upstream)"),
  feedback: z.string().nullable().optional().describe("Reviewer feedback (full structured markdown report)"),
  subphase_assessments: z
    .record(z.string(), z.string())
    .optional()
    .describe("Per-subphase assessment strings"),
};

const blockedSchema = {
  reason: z.string().describe("Why the worker cannot proceed"),
};

const submitMonitorVerdictSchema = {
  verdict: z
    .enum(MONITOR_VERDICTS as unknown as [string, ...string[]])
    .describe(
      "ok | rubber_stamp | insufficient_evidence — the monitor's audit of the reviewer's independence",
    ),
  reasons: z
    .array(z.string())
    .describe("Short, concrete reasons citing what was found"),
};

function workerTools(ctx: LabratToolContext) {
  const recordPhase = tool(
    "record_phase",
    "Validate phase dir and artifacts, then signal phase complete for gate review.",
    recordPhaseSchema,
    async (args) => handleRecordPhase(ctx, args),
  );
  const blocked = tool(
    "blocked",
    "Signal that the worker cannot proceed; harness pauses and escalates.",
    blockedSchema,
    async (args) => handleBlocked(ctx, args),
  );

  if (ctx.subphaseIds.length === 0) {
    return [recordPhase, blocked];
  }

  const markSubphase = tool(
    "mark_subphase",
    "Record a subphase checkpoint assessment (append-only log).",
    markSubphaseSchema,
    async (args) => handleMarkSubphase(ctx, args),
  );
  return [recordPhase, markSubphase, blocked];
}

function gateReviewerTools(ctx: LabratToolContext) {
  return [
    tool(
      "submit_gate_decision",
      "Submit structured gate decision after verification.",
      submitGateDecisionSchema,
      async (args) => handleSubmitGateDecision(ctx, args),
    ),
  ];
}

function monitorTools(ctx: LabratToolContext) {
  return [
    tool(
      "submit_monitor_verdict",
      "Submit the independent monitor's audit verdict of the gate reviewer's independence.",
      submitMonitorVerdictSchema,
      async (args) => handleSubmitMonitorVerdict(ctx, args),
    ),
  ];
}

/** In-process MCP server for worker, gate-reviewer, or monitor role (design §11). */
export function createLabratToolServer(
  options: CreateLabratToolServerOptions,
): McpSdkServerConfigWithInstance {
  const { ctx, role } = options;
  const tools =
    role === "worker"
      ? workerTools(ctx)
      : role === "monitor"
        ? monitorTools(ctx)
        : gateReviewerTools(ctx);

  return createSdkMcpServer({
    name: "labrat",
    version: "1.0.0",
    tools,
  });
}

/** Allowed tool names for SDK options.allowedTools. */
export function allowedLabratTools(
  role: CreateLabratToolServerOptions["role"],
  subphaseIds: readonly string[],
): string[] {
  if (role === "gate-reviewer") {
    return ["mcp__labrat__submit_gate_decision"];
  }

  if (role === "monitor") {
    return ["mcp__labrat__submit_monitor_verdict"];
  }

  const names = ["mcp__labrat__record_phase", "mcp__labrat__blocked"];
  if (subphaseIds.length > 0) {
    names.splice(1, 0, "mcp__labrat__mark_subphase");
  }
  return names;
}
