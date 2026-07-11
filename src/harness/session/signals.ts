/**
 * Orchestrator ↔ MCP tool signal contract (design §9, §11; POC Q1).
 *
 * The orchestrator owns the SDK query loop. Tool handlers mutate `signals` on
 * `LabratToolContext`; the orchestrator breaks the `for await` loop when a
 * signal is set — tool return alone is NOT terminal (see poc-results.md Q1).
 */

export {
  createOrchestratorSignals,
  type BackgroundTaskInfo,
  type CreateLabratToolServerOptions,
  type LabratToolContext,
  type LabratToolRole,
  type OrchestratorSignals,
} from "../tools/context.js";

export {
  allowedLabratTools,
  createLabratToolServer,
} from "../tools/server.js";

export {
  handleBlocked,
  handleMarkSubphase,
  handleRecordPhase,
  handleSubmitGateDecision,
  handleSubmitMonitorVerdict,
} from "../tools/handlers.js";
