import {
  expectEnum,
  expectNonEmptyString,
  expectRecord,
  expectString,
  singleError,
  type ValidationResult,
  success,
} from "./validation.js";

/**
 * Send-back feedback routing (review-provenance design §3E) — the first
 * bounded decision-plane contract. A confined LLM session may PROPOSE one
 * restart phase for a human send-back via the `submit_feedback_route` MCP
 * tool; this module owns the proposal's shape and the append-only route /
 * invalidation records HARNESS CODE writes under `review/routing/`.
 *
 * The proposal is exactly that — a proposal. Code alone validates it,
 * selects the accepted phase, computes the downstream invalidation closure,
 * and re-enters the hard-gated loop (harness/orchestrator
 * `invalidateForSendBack`). The router can never waive a gate, change the
 * protocol, choose retry counts, or pick a phase downstream of the earliest
 * live `changes_requested` mark.
 */

export const FEEDBACK_ROUTE_CONFIDENCES = ["high", "medium", "low"] as const;
export type FeedbackRouteConfidence = (typeof FEEDBACK_ROUTE_CONFIDENCES)[number];

/** Concise audit rationale, not hidden chain-of-thought. */
export const FEEDBACK_ROUTE_JUSTIFICATION_MAX = 600;
export const FEEDBACK_ROUTE_ALTERNATIVES_MAX = 3;

export type FeedbackRouteAlternative = {
  readonly phase: string;
  readonly reason: string;
};

/**
 * submit_feedback_route MCP tool input. `restart_phase: null` means the
 * model cannot route the feedback — the harness falls back to the earliest
 * live marked phase (never a later one).
 */
export type SubmitFeedbackRouteInput = {
  readonly restart_phase: string | null;
  readonly confidence: FeedbackRouteConfidence;
  readonly justification: string;
  readonly implicated_feedback_phases: readonly string[];
  readonly alternatives: readonly FeedbackRouteAlternative[];
};

function validateAlternatives(
  value: unknown,
  path: string,
): ValidationResult<readonly FeedbackRouteAlternative[]> {
  if (value === undefined) {
    return success([]);
  }
  if (!Array.isArray(value)) {
    return singleError(path, "expected array");
  }
  if (value.length > FEEDBACK_ROUTE_ALTERNATIVES_MAX) {
    return singleError(
      path,
      `at most ${FEEDBACK_ROUTE_ALTERNATIVES_MAX} alternatives`,
    );
  }
  const out: FeedbackRouteAlternative[] = [];
  for (let i = 0; i < value.length; i++) {
    const rec = expectRecord(value[i], `${path}[${i}]`);
    if (!rec.ok) return rec;
    const phase = expectNonEmptyString(rec.value["phase"], `${path}[${i}].phase`);
    if (!phase.ok) return phase;
    const reason = expectString(rec.value["reason"], `${path}[${i}].reason`);
    if (!reason.ok) return reason;
    out.push({ phase: phase.value, reason: reason.value });
  }
  return success(out);
}

function validateImplicatedPhases(
  value: unknown,
  path: string,
): ValidationResult<readonly string[]> {
  if (value === undefined) {
    return success([]);
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    return singleError(path, "expected array of strings");
  }
  return success(value as string[]);
}

export function validateSubmitFeedbackRouteInput(
  value: unknown,
): ValidationResult<SubmitFeedbackRouteInput> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const rawPhase = rec.value["restart_phase"];
  let restart_phase: string | null;
  if (rawPhase === null || rawPhase === undefined) {
    restart_phase = null;
  } else {
    const phase = expectNonEmptyString(rawPhase, "$.restart_phase");
    if (!phase.ok) return phase;
    restart_phase = phase.value;
  }

  const confidence = expectEnum(
    rec.value["confidence"],
    "$.confidence",
    FEEDBACK_ROUTE_CONFIDENCES,
  );
  if (!confidence.ok) return confidence;

  const justification = expectString(rec.value["justification"], "$.justification");
  if (!justification.ok) return justification;
  if (justification.value.length > FEEDBACK_ROUTE_JUSTIFICATION_MAX) {
    return singleError(
      "$.justification",
      `at most ${FEEDBACK_ROUTE_JUSTIFICATION_MAX} characters`,
    );
  }

  const implicated = validateImplicatedPhases(
    rec.value["implicated_feedback_phases"],
    "$.implicated_feedback_phases",
  );
  if (!implicated.ok) return implicated;

  const alternatives = validateAlternatives(rec.value["alternatives"], "$.alternatives");
  if (!alternatives.ok) return alternatives;

  return success({
    restart_phase,
    confidence: confidence.value,
    justification: justification.value,
    implicated_feedback_phases: implicated.value,
    alternatives: alternatives.value,
  });
}

// ---------------------------------------------------------------------------
// Append-only routing records — written by HARNESS code, never by the router
// ---------------------------------------------------------------------------

/** Who determined the accepted phase. */
export type SendBackRouteSource =
  | "human-override"
  | "llm"
  | "deterministic-fallback";

/** Why the accepted phase was adopted. */
export type SendBackRouteAcceptance = "auto-high" | "human-override" | "fallback";

export type SendBackRouteModel = {
  readonly name: string;
  readonly session_id: string | null;
  readonly prompt_version: string;
};

export type SendBackRouteProposal = {
  readonly restart_phase: string | null;
  readonly confidence: string;
  readonly justification: string;
  readonly alternatives: readonly unknown[];
};

/** `review/routing/send-back/<route-id>.json` (design §3E). */
export type SendBackRouteRecord = {
  readonly schema_version: 1;
  readonly route_id: string;
  readonly created_at: string;
  readonly source: SendBackRouteSource;
  readonly feedback_files: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
  }>;
  readonly protocol: {
    readonly name: string;
    readonly version: number;
    readonly phase_ids: readonly string[];
  };
  readonly model: SendBackRouteModel | null;
  readonly proposal: SendBackRouteProposal | null;
  readonly accepted_phase: string;
  readonly acceptance: SendBackRouteAcceptance;
  readonly validation_errors: readonly string[];
  /** Predetermined path of the paired invalidation record. */
  readonly invalidation_record: string;
};

/**
 * `review/routing/invalidation/<route-id>.json` — the code-computed
 * invalidation intent, written with status "prepared" BEFORE any phase state
 * mutates, then rewritten "applied" with the archive paths the reset
 * actually produced.
 */
export type SendBackInvalidationRecord = {
  readonly schema_version: 1;
  readonly route_id: string;
  readonly created_at: string;
  readonly accepted_phase: string;
  /** Exact closure: accepted phase + everything after it, declaration order. */
  readonly downstream_phases: readonly string[];
  readonly status: "prepared" | "applied";
  /** Phase-dir archives this route's reset produced (`phases/<id>.attempt-N`);
   * phases with nothing live to archive are omitted. Empty until applied. */
  readonly archived: ReadonlyArray<{
    readonly phase: string;
    readonly attempt: number;
    readonly path: string;
  }>;
};
