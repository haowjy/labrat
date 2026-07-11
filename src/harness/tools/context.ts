import type {
  SubmitGateDecisionInput,
  SubmitMonitorVerdictInput,
} from "../../schema/index.js";

/** Summary of a live background task reported by the SDK. */
export type BackgroundTaskInfo = {
  readonly taskId: string;
  readonly taskType: string;
  readonly description: string;
};

/** Mutable signals the orchestrator reads after each worker/reviewer query loop. */
export type OrchestratorSignals = {
  phaseComplete: boolean;
  blockedReason: string | null;
  gateDecision: SubmitGateDecisionInput | null;
  monitorVerdict: SubmitMonitorVerdictInput | null;
  /**
   * Live background tasks at the end of the most recent SDK turn.
   * Updated with REPLACE semantics from `background_tasks_changed` messages.
   * Non-empty means the worker has outstanding background work (e.g. a long
   * Python script) — the harness should wait-and-continue rather than count
   * a stall.
   */
  activeBackgroundTasks: BackgroundTaskInfo[];
};

export function createOrchestratorSignals(): OrchestratorSignals {
  return {
    phaseComplete: false,
    blockedReason: null,
    gateDecision: null,
    monitorVerdict: null,
    activeBackgroundTasks: [],
  };
}

export type LabratToolRole = "worker" | "gate-reviewer" | "monitor";

/** Context passed to createLabratToolServer — closure over task dir + phase scope. */
export type LabratToolContext = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly currentPhase: string;
  /** Declared artifact outputs for the current phase (paths relative to artifacts/). */
  readonly phaseOutputs: readonly string[];
  /** Declared subphase ids — drives mark_subphase injection and record_phase checks. */
  readonly subphaseIds: readonly string[];
  /** Shared mutable signals — orchestrator polls after breaking the query loop. */
  readonly signals: OrchestratorSignals;
};

export type CreateLabratToolServerOptions = {
  readonly ctx: LabratToolContext;
  readonly role: LabratToolRole;
};
