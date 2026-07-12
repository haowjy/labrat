import {
  expectEnum,
  expectIsoDateTime,
  expectNonEmptyString,
  expectOptional,
  expectRecord,
  expectString,
  expectStringMap,
  type ValidationResult,
  success,
} from "./validation.js";

export const GATE_DECISIONS = [
  "pass",
  "fail",
  "fail-upstream",
  "pass-with-concerns",
] as const;

export type GateDecision = (typeof GATE_DECISIONS)[number];

/** submit_gate_decision MCP tool input (design §10, §11). */
export type SubmitGateDecisionInput = {
  readonly decision: GateDecision;
  readonly summary?: string | null;
  readonly rewind_to?: string | null;
  readonly feedback?: string | null;
  readonly subphase_assessments?: Readonly<Record<string, string>>;
};

export function validateSubmitGateDecisionInput(
  value: unknown,
): ValidationResult<SubmitGateDecisionInput> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const decision = expectEnum(rec.value["decision"], "$.decision", GATE_DECISIONS);
  if (!decision.ok) return decision;

  let summary: string | null | undefined;
  const sm = rec.value["summary"];
  if (sm === null) {
    summary = null;
  } else if (sm !== undefined) {
    const smStr = expectString(sm, "$.summary");
    if (!smStr.ok) return smStr;
    summary = smStr.value;
  }

  let rewind_to: string | null | undefined;
  const rt = rec.value["rewind_to"];
  if (rt === null) {
    rewind_to = null;
  } else if (rt !== undefined) {
    const rtStr = expectNonEmptyString(rt, "$.rewind_to");
    if (!rtStr.ok) return rtStr;
    rewind_to = rtStr.value;
  }

  let feedback: string | null | undefined;
  const fb = rec.value["feedback"];
  if (fb === null) {
    feedback = null;
  } else if (fb !== undefined) {
    const fbStr = expectString(fb, "$.feedback");
    if (!fbStr.ok) return fbStr;
    feedback = fbStr.value;
  }

  const subphase_assessments = expectOptional(
    rec.value["subphase_assessments"],
    "$.subphase_assessments",
    (v, p) => expectStringMap(v, p),
  );
  if (!subphase_assessments.ok) return subphase_assessments;

  if (
    decision.value === "fail-upstream" &&
    (rewind_to === undefined || rewind_to === null)
  ) {
    return {
      ok: false,
      errors: [
        {
          path: "$.rewind_to",
          message: "rewind_to required for fail-upstream decision",
        },
      ],
    };
  }

  return success({
    decision: decision.value,
    ...(summary !== undefined ? { summary } : {}),
    ...(rewind_to !== undefined ? { rewind_to } : {}),
    ...(feedback !== undefined ? { feedback } : {}),
    ...(subphase_assessments.value !== undefined
      ? { subphase_assessments: subphase_assessments.value }
      : {}),
  });
}

/** Written to review/gates/{phase}.json by harness after gate (design §10). */
export type GateFile = SubmitGateDecisionInput & {
  readonly phase: string;
  readonly decidedAt: string;
  /** Present when reviewer stalls — design §12 default. */
  readonly confidence?: "low";
};

export function validateGateFile(value: unknown): ValidationResult<GateFile> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const phase = expectNonEmptyString(rec.value["phase"], "$.phase");
  if (!phase.ok) return phase;

  const decidedAt = expectIsoDateTime(rec.value["decidedAt"], "$.decidedAt");
  if (!decidedAt.ok) return decidedAt;

  const input = validateSubmitGateDecisionInput(rec.value);
  if (!input.ok) return input;

  const confidence = expectOptional(
    rec.value["confidence"],
    "$.confidence",
    (v, p) => expectEnum(v, p, ["low"] as const),
  );
  if (!confidence.ok) return confidence;

  return success({
    phase: phase.value,
    decidedAt: decidedAt.value,
    decision: input.value.decision,
    ...(input.value.summary !== undefined
      ? { summary: input.value.summary }
      : {}),
    ...(input.value.rewind_to !== undefined
      ? { rewind_to: input.value.rewind_to }
      : {}),
    ...(input.value.feedback !== undefined
      ? { feedback: input.value.feedback }
      : {}),
    ...(input.value.subphase_assessments !== undefined
      ? { subphase_assessments: input.value.subphase_assessments }
      : {}),
    ...(confidence.value !== undefined ? { confidence: confidence.value } : {}),
  });
}

/** review/verdict.json — design §10 + task-directory (underspecified). */
export const VERDICT_STATUSES = [
  "in-progress",
  "pass",
  "pass-with-concerns",
  "failed",
] as const;

export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

export type VerdictJson = {
  readonly status: VerdictStatus;
  readonly flags: readonly string[];
  readonly gated_measurements?: Readonly<Record<string, unknown>>;
  readonly updatedAt?: string;
};

export function validateVerdictJson(
  value: unknown,
): ValidationResult<VerdictJson> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const status = expectEnum(rec.value["status"], "$.status", VERDICT_STATUSES);
  if (!status.ok) return status;

  const flagsRaw = rec.value["flags"];
  const flags =
    flagsRaw === undefined
      ? success([] as string[])
      : (() => {
          if (!Array.isArray(flagsRaw)) {
            return {
              ok: false as const,
              errors: [{ path: "$.flags", message: "expected array" }],
            };
          }
          for (let i = 0; i < flagsRaw.length; i++) {
            if (typeof flagsRaw[i] !== "string") {
              return {
                ok: false as const,
                errors: [
                  { path: `$.flags[${i}]`, message: "expected string" },
                ],
              };
            }
          }
          return success(flagsRaw as string[]);
        })();
  if (!flags.ok) return flags;

  let gated_measurements: Readonly<Record<string, unknown>> | undefined;
  if (rec.value["gated_measurements"] !== undefined) {
    const gm = expectRecord(rec.value["gated_measurements"], "$.gated_measurements");
    if (!gm.ok) return gm;
    gated_measurements = gm.value;
  }

  const updatedAt = expectOptional(
    rec.value["updatedAt"],
    "$.updatedAt",
    (v, p) => expectIsoDateTime(v, p),
  );
  if (!updatedAt.ok) return updatedAt;

  return success({
    status: status.value,
    flags: flags.value,
    ...(gated_measurements !== undefined ? { gated_measurements } : {}),
    ...(updatedAt.value !== undefined ? { updatedAt: updatedAt.value } : {}),
  });
}
