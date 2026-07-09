import {
  expectNonEmptyString,
  expectRecord,
  expectString,
  type ValidationResult,
  success,
} from "./validation.js";
import {
  validateMarkSubphaseInput,
  type MarkSubphaseInput,
} from "./subphases.js";
import {
  validateSubmitGateDecisionInput,
  type SubmitGateDecisionInput,
} from "./gate.js";

/** MCP record_phase tool input (design §11). */
export type RecordPhaseInput = {
  readonly phase: string;
};

export function validateRecordPhaseInput(
  value: unknown,
): ValidationResult<RecordPhaseInput> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const phase = expectNonEmptyString(rec.value["phase"], "$.phase");
  if (!phase.ok) return phase;

  return success({ phase: phase.value });
}

/** MCP blocked tool input (design §11). */
export type BlockedInput = {
  readonly reason: string;
};

export function validateBlockedInput(
  value: unknown,
): ValidationResult<BlockedInput> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const reason = expectString(rec.value["reason"], "$.reason");
  if (!reason.ok) return reason;

  return success({ reason: reason.value });
}

export type McpToolName =
  | "record_phase"
  | "mark_subphase"
  | "submit_gate_decision"
  | "blocked";

export function validateMcpToolInput(
  tool: McpToolName,
  value: unknown,
): ValidationResult<
  RecordPhaseInput | MarkSubphaseInput | SubmitGateDecisionInput | BlockedInput
> {
  switch (tool) {
    case "record_phase":
      return validateRecordPhaseInput(value);
    case "mark_subphase":
      return validateMarkSubphaseInput(value);
    case "submit_gate_decision":
      return validateSubmitGateDecisionInput(value);
    case "blocked":
      return validateBlockedInput(value);
    default: {
      const _exhaustive: never = tool;
      return _exhaustive;
    }
  }
}

export { validateMarkSubphaseInput, type MarkSubphaseInput } from "./subphases.js";
export {
  validateSubmitGateDecisionInput,
  type SubmitGateDecisionInput,
} from "./gate.js";
