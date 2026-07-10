import { resolve } from "node:path";
import { checkReviewSite, type CheckReviewSiteOptions } from "./check.js";

/**
 * `labrat check-review-site <site-dir> [--results <path>] [--cdn-allowlist a,b]
 * [--sample-id <id>]` — the review-site linter as a runnable command. It is the
 * SAME check the gate-reviewer runs (its `## Verification` invokes this) and the
 * worker's self-check. Prints the findings report as JSON; exits 0 when every
 * gate passes, 1 when any gate fails, 2 on a usage error.
 */
export async function runCheckReviewSiteCli(args: readonly string[]): Promise<number> {
  const positional: string[] = [];
  let resultsPath: string | undefined;
  let sampleId: string | undefined;
  let cdnAllowlist: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--results") {
      resultsPath = args[++i];
    } else if (arg === "--sample-id") {
      sampleId = args[++i];
    } else if (arg === "--cdn-allowlist") {
      cdnAllowlist = (args[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  const siteDir = positional[0];
  if (!siteDir) {
    console.error(
      "Usage: labrat check-review-site <site-dir> [--results <measurements/results.json>] [--cdn-allowlist origin1,origin2] [--sample-id <id>]",
    );
    return 2;
  }

  const opts: CheckReviewSiteOptions = {
    siteDir: resolve(siteDir),
    cdnAllowlist,
    ...(resultsPath !== undefined ? { resultsPath: resolve(resultsPath) } : {}),
    ...(sampleId !== undefined ? { expectedSampleId: sampleId } : {}),
  };

  const report = await checkReviewSite(opts);
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}
