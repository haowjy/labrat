import {
  expectBoolean,
  expectEnum,
  expectIsoDateTime,
  expectNonEmptyString,
  expectNumber,
  expectOptional,
  expectRecord,
  expectString,
  type ValidationResult,
  success,
} from "./validation.js";

/**
 * The HUMAN reviewer's verdict on a phase reviewed through the interactive
 * review site (design/review-loop-and-roles.md "trust line"), written via the
 * scoped `POST /api/tasks/:id/review/finish` and read back by the chain view.
 *
 * This is a DIFFERENT concept from `VerdictJson` (gate.ts): that one is the
 * task-wide status the harness DERIVES from `review/gates/*.json` and
 * rewrites on every phase gate (`rebuildVerdict`/`writeVerdict` in
 * `harness/orchestrator/gate.ts`) — an aggregate `in-progress | pass |
 * pass-with-concerns | failed` with no per-phase human fields. Reusing its
 * shape or its `review/verdict.json` path for the human record would (a)
 * silently corrupt/be corrupted by the harness's own derived writes on the
 * next gate, and (b) force one file to represent two incompatible things: an
 * aggregate machine status vs. a per-phase human sign-off with adjustments.
 * So this is a genuinely distinct, per-phase record, written to
 * `review/verdict/{phase}.json` (a sibling of `review/gates/{phase}.json`
 * and `review/verification/{phase}/`, not a collision with either).
 */

/**
 * `changes_requested` is the human "send back" verdict. Unlike `pass`/`fail`
 * (which the chain view records but the harness does not act on), a
 * `changes_requested` verdict is the on-disk MARK that `labrat rerun` reads to
 * re-run the phase (harness/orchestrator `findSendBackPhase`/`rerunTask`),
 * threading the human's `notes` into the re-run worker's prompt.
 */
export const HUMAN_VERDICTS = ["pass", "fail", "changes_requested"] as const;
export type HumanVerdict = (typeof HUMAN_VERDICTS)[number];

export type Point3D = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

export type LandmarkAdjustment = {
  readonly id: string;
  /**
   * The pre-drag position, or `null` when the review-site's `interaction`
   * postMessage doesn't carry one (known gap, gh #20) — never backfilled
   * from disk.
   */
  readonly proposed: Point3D | null;
  readonly corrected: Point3D;
};

function validatePoint3D(value: unknown, path: string): ValidationResult<Point3D> {
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;
  const x = expectNumber(rec.value["x"], `${path}.x`);
  if (!x.ok) return x;
  const y = expectNumber(rec.value["y"], `${path}.y`);
  if (!y.ok) return y;
  const z = expectNumber(rec.value["z"], `${path}.z`);
  if (!z.ok) return z;
  return success({ x: x.value, y: y.value, z: z.value });
}

function validateNullablePoint3D(
  value: unknown,
  path: string,
): ValidationResult<Point3D | null> {
  if (value === undefined || value === null) {
    return success(null);
  }
  return validatePoint3D(value, path);
}

function validateLandmarkAdjustment(
  value: unknown,
  path: string,
): ValidationResult<LandmarkAdjustment> {
  const rec = expectRecord(value, path);
  if (!rec.ok) return rec;
  const id = expectNonEmptyString(rec.value["id"], `${path}.id`);
  if (!id.ok) return id;
  const proposed = validateNullablePoint3D(rec.value["proposed"], `${path}.proposed`);
  if (!proposed.ok) return proposed;
  const corrected = validatePoint3D(rec.value["corrected"], `${path}.corrected`);
  if (!corrected.ok) return corrected;
  return success({ id: id.value, proposed: proposed.value, corrected: corrected.value });
}

function validateAdjustments(
  value: unknown,
  path: string,
): ValidationResult<readonly LandmarkAdjustment[]> {
  if (!Array.isArray(value)) {
    return { ok: false, errors: [{ path, message: "expected array" }] };
  }
  const out: LandmarkAdjustment[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = validateLandmarkAdjustment(value[i], `${path}[${i}]`);
    if (!item.ok) return item;
    out.push(item.value);
  }
  return success(out);
}

/**
 * `POST /api/tasks/:id/review/finish` request body (pinned contract,
 * GOAL-finish-e2e-review-chain.md). `human_verdict` is the sole source of
 * truth for the persisted verdict — it comes ONLY from this body (an
 * explicit human action in the trusted shell), never derived from a raw
 * iframe postMessage or from the agent's own confidence/gate decision.
 */
export type ReviewFinishInput = {
  readonly phase: string;
  readonly human_verdict: HumanVerdict;
  readonly corrected: boolean;
  readonly notes: string;
  readonly adjustments: readonly LandmarkAdjustment[];
};

export function validateReviewFinishInput(
  value: unknown,
): ValidationResult<ReviewFinishInput> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const phase = expectNonEmptyString(rec.value["phase"], "$.phase");
  if (!phase.ok) return phase;

  const human_verdict = expectEnum(
    rec.value["human_verdict"],
    "$.human_verdict",
    HUMAN_VERDICTS,
  );
  if (!human_verdict.ok) return human_verdict;

  const corrected = expectBoolean(rec.value["corrected"], "$.corrected");
  if (!corrected.ok) return corrected;

  const notes = expectString(rec.value["notes"], "$.notes");
  if (!notes.ok) return notes;

  const adjustmentsRaw = rec.value["adjustments"];
  const adjustments =
    adjustmentsRaw === undefined
      ? success([] as readonly LandmarkAdjustment[])
      : validateAdjustments(adjustmentsRaw, "$.adjustments");
  if (!adjustments.ok) return adjustments;

  return success({
    phase: phase.value,
    human_verdict: human_verdict.value,
    corrected: corrected.value,
    notes: notes.value,
    adjustments: adjustments.value,
  });
}

/**
 * `review/verdict/{phase}.json` — the request body plus the agent's
 * confidence/notes read off the phase's review chain at write time
 * (`phases/{phase}/confidence.json`, `review/gates/{phase}.json`) and a
 * server-stamped `reviewed_at`. Holding agent-confidence + human-verdict +
 * adjustments together in one record (design/review-loop-and-roles.md) is so
 * a later feedback store can append proposed-vs-corrected entries without a
 * reshape.
 */
export type ReviewVerdictRecord = ReviewFinishInput & {
  /** Raw `phases/{phase}/confidence.json` contents, or null if absent/invalid.
   * Untyped like `PhaseDetail.confidence` (dashboard/api/index.ts) — no
   * schema for that file exists yet; this reads through, it doesn't invent one. */
  readonly agent_confidence: unknown;
  readonly agent_gate_decision: string | null;
  readonly agent_gate_feedback: string | null;
  readonly reviewed_at: string;
};

export function validateReviewVerdictRecord(
  value: unknown,
): ValidationResult<ReviewVerdictRecord> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const input = validateReviewFinishInput(rec.value);
  if (!input.ok) return input;

  const reviewed_at = expectIsoDateTime(rec.value["reviewed_at"], "$.reviewed_at");
  if (!reviewed_at.ok) return reviewed_at;

  const agent_gate_decision = expectOptional(
    rec.value["agent_gate_decision"],
    "$.agent_gate_decision",
    (v, p) => expectString(v, p),
  );
  if (!agent_gate_decision.ok) return agent_gate_decision;

  const agent_gate_feedback = expectOptional(
    rec.value["agent_gate_feedback"],
    "$.agent_gate_feedback",
    (v, p) => expectString(v, p),
  );
  if (!agent_gate_feedback.ok) return agent_gate_feedback;

  return success({
    ...input.value,
    agent_confidence: rec.value["agent_confidence"] ?? null,
    agent_gate_decision: agent_gate_decision.value ?? null,
    agent_gate_feedback: agent_gate_feedback.value ?? null,
    reviewed_at: reviewed_at.value,
  });
}
