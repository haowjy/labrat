import type { SubmitGateDecisionInput } from "../../schema/index.js";

/** Mutable signals the orchestrator reads after each worker/reviewer query loop. */
export type OrchestratorSignals = {
  phaseComplete: boolean;
  blockedReason: string | null;
  gateDecision: SubmitGateDecisionInput | null;
};

export function createOrchestratorSignals(): OrchestratorSignals {
  return {
    phaseComplete: false,
    blockedReason: null,
    gateDecision: null,
  };
}

export type LabratToolRole = "worker" | "gate-reviewer";

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
