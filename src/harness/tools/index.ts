import type { McpToolName } from "../../schema/index.js";

/** TODO(wave-2): in-proc MCP server — record_phase, mark_subphase, submit_gate_decision, blocked */
export type ToolHandlerContext = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly currentPhase: string;
};

export type ToolHandlers = Record<
  McpToolName,
  (input: unknown, ctx: ToolHandlerContext) => Promise<{ readonly content: string }>
>;

export function createLabratMcpServer(_handlers: ToolHandlers): unknown {
  // TODO(wave-2): createSdkMcpServer()
  return {};
}
