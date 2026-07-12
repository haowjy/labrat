import {
  expectBoolean,
  expectEnum,
  expectNonEmptyString,
  expectOptional,
  expectRecord,
  expectString,
  expectStringArray,
  singleError,
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

// ---------------------------------------------------------------------------
// review-artifact-author read-only tools (review-provenance design §3C)
// ---------------------------------------------------------------------------

/** Session roles whose persisted logs `read_past_history` may collapse.
 * Mirrors `SessionRole` (harness/session/session-log.ts) — duplicated here so
 * the schema layer stays a leaf without a harness import. */
export const HISTORY_ROLES = [
  "worker",
  "gate-reviewer",
  "review-artifact-author",
] as const;
export type HistoryRole = (typeof HISTORY_ROLES)[number];

export const HISTORY_MAX_TOKENS_MIN = 500;
export const HISTORY_MAX_TOKENS_MAX = 6000;
export const HISTORY_MAX_TOKENS_DEFAULT = 3000;
/** Hard cap on `expand` message IDs per read_past_history call. */
export const HISTORY_EXPAND_CAP = 12;

function validateMaxTokens(value: unknown): ValidationResult<number> {
  if (value === undefined || value === null) {
    return success(HISTORY_MAX_TOKENS_DEFAULT);
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < HISTORY_MAX_TOKENS_MIN ||
    value > HISTORY_MAX_TOKENS_MAX
  ) {
    return singleError(
      "$.max_tokens",
      `expected integer in ${HISTORY_MAX_TOKENS_MIN}..${HISTORY_MAX_TOKENS_MAX}`,
    );
  }
  return success(value);
}

/** MCP read_past_history tool input (author-only). */
export type ReadPastHistoryInput = {
  readonly phase?: string;
  readonly role?: HistoryRole;
  readonly cursor?: string;
  /** Validated + defaulted — always present after validation. */
  readonly max_tokens: number;
  readonly expand?: readonly string[];
};

export function validateReadPastHistoryInput(
  value: unknown,
): ValidationResult<ReadPastHistoryInput> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const phase = expectOptional(rec.value["phase"], "$.phase", expectNonEmptyString);
  if (!phase.ok) return phase;

  const role = expectOptional(rec.value["role"], "$.role", (v, p) =>
    expectEnum(v, p, HISTORY_ROLES),
  );
  if (!role.ok) return role;

  const cursor = expectOptional(rec.value["cursor"], "$.cursor", expectNonEmptyString);
  if (!cursor.ok) return cursor;

  const max_tokens = validateMaxTokens(rec.value["max_tokens"]);
  if (!max_tokens.ok) return max_tokens;

  const expand = expectOptional(rec.value["expand"], "$.expand", expectStringArray);
  if (!expand.ok) return expand;
  if (expand.value !== undefined && expand.value.length > HISTORY_EXPAND_CAP) {
    return singleError(
      "$.expand",
      `at most ${HISTORY_EXPAND_CAP} message IDs per call`,
    );
  }

  return success({
    ...(phase.value !== undefined ? { phase: phase.value } : {}),
    ...(role.value !== undefined ? { role: role.value } : {}),
    ...(cursor.value !== undefined ? { cursor: cursor.value } : {}),
    max_tokens: max_tokens.value,
    ...(expand.value !== undefined ? { expand: expand.value } : {}),
  });
}

/** MCP view_human_feedback tool input (author-only). */
export type ViewHumanFeedbackInput = {
  readonly phase?: string;
  readonly include_archived: boolean;
  readonly cursor?: string;
  /** Validated + defaulted — always present after validation. */
  readonly max_tokens: number;
};

export function validateViewHumanFeedbackInput(
  value: unknown,
): ValidationResult<ViewHumanFeedbackInput> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const phase = expectOptional(rec.value["phase"], "$.phase", expectNonEmptyString);
  if (!phase.ok) return phase;

  const include_archived = expectOptional(
    rec.value["include_archived"],
    "$.include_archived",
    expectBoolean,
  );
  if (!include_archived.ok) return include_archived;

  const cursor = expectOptional(rec.value["cursor"], "$.cursor", expectNonEmptyString);
  if (!cursor.ok) return cursor;

  const max_tokens = validateMaxTokens(rec.value["max_tokens"]);
  if (!max_tokens.ok) return max_tokens;

  return success({
    ...(phase.value !== undefined ? { phase: phase.value } : {}),
    include_archived: include_archived.value ?? false,
    ...(cursor.value !== undefined ? { cursor: cursor.value } : {}),
    max_tokens: max_tokens.value,
  });
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
