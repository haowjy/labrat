import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProtocolPhase } from "../../schema/index.js";
import { checkReviewSite, type ReviewSiteReport } from "../../review-site/check.js";
import { buildReviewSiteCsp } from "../../review-site/csp.js";
import { atomicWriteJson } from "../../util/atomic-write.js";

/**
 * The harness-bound review-site gate check (Lane C, fixes C1/H1/H1b).
 *
 * The reviewer used to hand-run a Bash CLI that only exported its function and
 * never invoked it — so the documented gate command exited 0 with no output and
 * "exit 0 ⇒ pass" passed ANY site. The fix moves the deterministic check into
 * the HARNESS: for any phase that produces `artifacts/review-site/` (generic —
 * no phase-name check), the harness runs `check_review_site` with the inputs it
 * authoritatively holds — the phase `cdn_allowlist`, the run's `artifacts/` root
 * for the G8 hash, and the task id as the expected `sample_id` — and writes the
 * report to `review/verification/<phase>/check_review_site.json`. The reviewer
 * READS that file and gates on `ok`; it does not run the linter or re-type the
 * policy. This matches the codebase's "harness runs deterministic checks, model
 * reads + signals" seam.
 */

const REVIEW_SITE_DIR = "review-site";

/** A phase produces the review site when it declares an output under it. */
export function phaseProducesReviewSite(phase: ProtocolPhase): boolean {
  return (phase.outputs ?? []).some(
    (o) => o === REVIEW_SITE_DIR || o.startsWith(`${REVIEW_SITE_DIR}/`),
  );
}

export function reviewArtifactCheckPath(taskDir: string, phaseId: string): string {
  return join(taskDir, "review", "verification", phaseId, "check_review_site.json");
}

/**
 * The deterministic floor (pure, testable): a produced review site whose linter
 * report is not `ok` FAILs the gate regardless of what the LLM reviewer decides.
 * This is what makes a failing site gated OUT deterministically — the reviewer
 * reading the file is the primary path, this is the harness backstop. Returns
 * the failure feedback, or null when there's nothing to block on.
 *
 * The linter is best-effort structural + self-containment analysis; it is ONE
 * of the two boundary layers, not the whole story. The opaque sandbox + CSP
 * (Lane A) contain external subresource loads and the `connect-src`-owned
 * network class; the linter (G5) hard-fails the sinks the CSP cannot own under
 * the `'unsafe-inline'` the inlined site requires (R4) — navigation, download/
 * self-export, dynamic image, WebRTC, inline handlers — and downgrades the
 * network class to a warning ONLY when the canonical served CSP is confirmed
 * exactly `connect-src 'none'` (F4/F5). A failing report here means the
 * STRUCTURAL/self-containment layer rejected the site.
 */
export function reviewSiteGateFailure(report: ReviewSiteReport | null): string | null {
  if (report === null || report.ok) return null;
  const failed = report.findings
    .filter((f) => !f.ok)
    .map((f) => `${f.gate}: ${f.detail}`)
    .join("; ");
  return `Harness review-site check FAILED (fidelity: ${report.fidelity}): ${failed}`;
}

/**
 * Run the deterministic G1–G9 linter against an ARBITRARY site directory and
 * persist the report at `outPath` (review-provenance design §3.D step 5). The
 * generalized core both the legacy pre-review check and the per-phase
 * artifact-settlement gate call: same authoritative inputs (phase
 * `cdn_allowlist`, `artifacts/` measurement root, task id as `sample_id`,
 * canonical served CSP), different site dir + report location.
 */
export async function runReviewArtifactCheckAtPath(
  taskId: string,
  taskDir: string,
  phase: ProtocolPhase,
  siteDir: string,
  outPath: string,
): Promise<ReviewSiteReport> {
  const cdnAllowlist = phase.cdn_allowlist ?? [];
  const report = await checkReviewSite({
    siteDir,
    cdnAllowlist,
    measurementsRoot: join(taskDir, "artifacts"),
    // The harness's authoritative run identity — the site's sample_id must
    // equal it (H1b), independent of anything the producer wrote.
    expectedSampleId: taskId,
    requireFidelity: true,
    // The EXACT policy the dashboard route will serve for this site, from the
    // canonical builder (F4) — so G5 can confirm connect-src 'none' before it
    // downgrades a network sink to a warning, and fail closed otherwise.
    contentSecurityPolicy: buildReviewSiteCsp(cdnAllowlist),
  });

  await mkdir(dirname(outPath), { recursive: true });
  await atomicWriteJson(outPath, report);
  return report;
}

/**
 * Run the deterministic linter and persist its report for the reviewer to read.
 * No-op (returns null) for phases that don't produce a review site. Idempotent:
 * safe to run before every gate. LEGACY worker-authored single-site path only —
 * per-phase author artifacts gate through `runReviewArtifactCheckAtPath`
 * against their staging dir instead.
 */
export async function runReviewArtifactCheck(
  taskId: string,
  taskDir: string,
  phase: ProtocolPhase,
): Promise<ReviewSiteReport | null> {
  if (!phaseProducesReviewSite(phase)) return null;

  return runReviewArtifactCheckAtPath(
    taskId,
    taskDir,
    phase,
    join(taskDir, "artifacts", REVIEW_SITE_DIR),
    reviewArtifactCheckPath(taskDir, phase.id),
  );
}
