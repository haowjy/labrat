/*
 * Hand-authored types for review-bridge.js, the trust-critical F1 module.
 * This repo doesn't compile the browser-loaded static assets (no `allowJs`
 * in tsconfig.json — they ship as plain ESM, no build step), so a sibling
 * .d.ts is how review-bridge.test.ts gets a real, statically-checked
 * `import` of the actual file Node/the browser run, instead of a `vm`
 * reimplementation that could drift from it. Keep in sync with the .js
 * exports by hand; the test file will fail to typecheck (missing export) if
 * this drifts out of sync with an added/removed export.
 */

export type ReviewVerdictLogEntry = {
  readonly text: string;
  readonly at: string;
};

export type ReviewVerdictStatus = "pass" | "fail" | null;

export type ReviewInteractionEvidence = {
  readonly action: "landmark-moved";
  readonly id: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
};

export type ReviewVerdict = {
  readonly status: ReviewVerdictStatus;
  readonly corrected: boolean;
  readonly evidence: readonly ReviewInteractionEvidence[];
  readonly log: readonly ReviewVerdictLogEntry[];
  readonly logWindowStart: number;
  readonly logWindowCount: number;
  readonly logSuppressed: number;
};

export type ReviewAdjustment = {
  readonly id: string;
  readonly proposed: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly corrected: { readonly x: number; readonly y: number; readonly z: number };
};

export const REVIEW_MSG_TYPES: Readonly<Record<string, 1>>;
export const REVIEW_INTERACTION_ACTIONS: Readonly<Record<string, 1>>;
export const REVIEW_ID_RE: RegExp;
export const REVIEW_LOG_CAP: number;
export const REVIEW_EVIDENCE_CAP: number;
export const REVIEW_LOG_RATE_WINDOW_MS: number;
export const REVIEW_LOG_RATE_MAX: number;
export const REVIEW_METRICS_MAX_KEYS: number;

export function newReviewVerdict(): ReviewVerdict;
export function isFiniteNumber(n: unknown): n is number;
export function hasOnlyKeys(obj: Record<string, unknown>, allowed: Readonly<Record<string, 1>>): boolean;
export function isReviewId(id: unknown): id is string;
export function validateInteraction(d: unknown): ReviewInteractionEvidence | null;
export function validateMetrics(
  d: unknown,
): (Readonly<Record<string, number | string>> & { readonly id: string }) | null;
export function appendVerdictLog(verdict: ReviewVerdict, text: string, now?: number): ReviewVerdict;
export function applyReviewMessage(verdict: ReviewVerdict, data: unknown, now?: number): ReviewVerdict;
export function revokeEvidence(verdict: ReviewVerdict, reason: string, now?: number): ReviewVerdict;
export function withStatus(verdict: ReviewVerdict, status: ReviewVerdictStatus): ReviewVerdict;
export function verdictLabel(verdict: ReviewVerdict): string;
export function verdictPillClass(label: string): string;
export function adjustmentsFromEvidence(
  evidence: readonly ReviewInteractionEvidence[],
): ReviewAdjustment[];
