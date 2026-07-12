import {
  expectEnum,
  expectIsoDateTime,
  expectNonEmptyString,
  expectNumber,
  expectOptional,
  expectRecord,
  success,
  type ValidationResult,
} from "./validation.js";
import { REVIEW_ARTIFACT_TYPES, type ReviewArtifactType } from "./protocol.js";

/**
 * Per-phase review-artifact settlement status (review-provenance design §3.D),
 * persisted at `review/artifact-author/<phase>/status.json`.
 *
 * The scientific gate and the artifact are two ORDERED substates of phase
 * settlement: this file records only the artifact half, and its absence for a
 * legacy phase is meaningful (the dashboard falls back to the worker-authored
 * `artifacts/review-site/` inference). States:
 *
 * - `none`       — the phase's resolved type is `none`: nothing to author.
 * - `authoring`  — a fresh author session is (or was, before a crash) working
 *                  in the staging dir; the phase is NOT settled.
 * - `failed`     — author/linter retries exhausted; the SCIENCE stays accepted
 *                  and resume re-enters authoring only.
 * - `published`  — the linter passed and the harness atomically renamed the
 *                  staging dir to `artifacts/review-sites/<phase>/`.
 */
export const REVIEW_ARTIFACT_STATUSES = [
  "none",
  "authoring",
  "failed",
  "published",
] as const;

export type ReviewArtifactStatusState = (typeof REVIEW_ARTIFACT_STATUSES)[number];

export type ReviewArtifactStatus = {
  readonly status: ReviewArtifactStatusState;
  readonly type: ReviewArtifactType;
  readonly template?: string;
  /** Author attempt counter (1 on first author run). Absent for `none`. */
  readonly author_attempt?: number;
  readonly author_session_id?: string;
  readonly staging_path?: string;
  readonly published_path?: string;
  readonly check_report_path?: string;
  readonly check_report_hash?: string;
  /** sha256 of review/gates/<phase>.json at settlement time — binds the
   * artifact to the exact accepted scientific gate. */
  readonly scientific_gate_hash?: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export function validateReviewArtifactStatus(
  value: unknown,
): ValidationResult<ReviewArtifactStatus> {
  const rec = expectRecord(value, "$");
  if (!rec.ok) return rec;

  const status = expectEnum(rec.value["status"], "$.status", REVIEW_ARTIFACT_STATUSES);
  if (!status.ok) return status;

  const type = expectEnum(rec.value["type"], "$.type", REVIEW_ARTIFACT_TYPES);
  if (!type.ok) return type;

  const template = expectOptional(rec.value["template"], "$.template", (v, p) =>
    expectNonEmptyString(v, p),
  );
  if (!template.ok) return template;

  const author_attempt = expectOptional(
    rec.value["author_attempt"],
    "$.author_attempt",
    (v, p) => expectNumber(v, p),
  );
  if (!author_attempt.ok) return author_attempt;

  const optionalString = (key: string) =>
    expectOptional(rec.value[key], `$.${key}`, (v, p) => expectNonEmptyString(v, p));

  const author_session_id = optionalString("author_session_id");
  if (!author_session_id.ok) return author_session_id;
  const staging_path = optionalString("staging_path");
  if (!staging_path.ok) return staging_path;
  const published_path = optionalString("published_path");
  if (!published_path.ok) return published_path;
  const check_report_path = optionalString("check_report_path");
  if (!check_report_path.ok) return check_report_path;
  const check_report_hash = optionalString("check_report_hash");
  if (!check_report_hash.ok) return check_report_hash;
  const scientific_gate_hash = optionalString("scientific_gate_hash");
  if (!scientific_gate_hash.ok) return scientific_gate_hash;

  const created_at = expectIsoDateTime(rec.value["created_at"], "$.created_at");
  if (!created_at.ok) return created_at;
  const updated_at = expectIsoDateTime(rec.value["updated_at"], "$.updated_at");
  if (!updated_at.ok) return updated_at;

  return success({
    status: status.value,
    type: type.value,
    ...(template.value !== undefined ? { template: template.value } : {}),
    ...(author_attempt.value !== undefined
      ? { author_attempt: author_attempt.value }
      : {}),
    ...(author_session_id.value !== undefined
      ? { author_session_id: author_session_id.value }
      : {}),
    ...(staging_path.value !== undefined ? { staging_path: staging_path.value } : {}),
    ...(published_path.value !== undefined
      ? { published_path: published_path.value }
      : {}),
    ...(check_report_path.value !== undefined
      ? { check_report_path: check_report_path.value }
      : {}),
    ...(check_report_hash.value !== undefined
      ? { check_report_hash: check_report_hash.value }
      : {}),
    ...(scientific_gate_hash.value !== undefined
      ? { scientific_gate_hash: scientific_gate_hash.value }
      : {}),
    created_at: created_at.value,
    updated_at: updated_at.value,
  });
}
