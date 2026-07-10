import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProtocolPhase } from "../../schema/index.js";
import { checkReviewSite, type ReviewSiteReport } from "../../review-site/check.js";
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
 * (Lane A) contain external subresource loads and network connections; the
 * linter (G5) contains navigation + inline-handler exfil, which the CSP cannot
 * block under the `'unsafe-inline'` the inlined site requires (R4). A failing
 * report here means the STRUCTURAL/self-containment layer rejected the site.
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
 * Run the deterministic linter and persist its report for the reviewer to read.
 * No-op (returns null) for phases that don't produce a review site. Idempotent:
 * safe to run before every gate.
 */
export async function runReviewArtifactCheck(
  taskId: string,
  taskDir: string,
  phase: ProtocolPhase,
): Promise<ReviewSiteReport | null> {
  if (!phaseProducesReviewSite(phase)) return null;

  const report = await checkReviewSite({
    siteDir: join(taskDir, "artifacts", REVIEW_SITE_DIR),
    cdnAllowlist: phase.cdn_allowlist ?? [],
    measurementsRoot: join(taskDir, "artifacts"),
    // The harness's authoritative run identity — the site's sample_id must
    // equal it (H1b), independent of anything the producer wrote.
    expectedSampleId: taskId,
    requireFidelity: true,
  });

  const outPath = reviewArtifactCheckPath(taskDir, phase.id);
  await mkdir(dirname(outPath), { recursive: true });
  await atomicWriteJson(outPath, report);
  return report;
}
