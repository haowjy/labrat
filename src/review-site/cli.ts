import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { checkReviewSite, type CheckReviewSiteOptions } from "./check.js";

/**
 * `labrat check-review-site <site-dir> [--results <path>]
 * [--measurements-root <dir>] [--cdn-allowlist a,b] [--sample-id <id>]` — the
 * review-site linter as a runnable command, for a HUMAN driving the linter by
 * hand. Prints the findings report as JSON; exits 0 when every gate passes, 1
 * when any gate fails, 2 on a usage error.
 *
 * The GATE path does NOT go through this CLI: the harness binds and runs
 * `checkReviewSite` itself and writes the result to
 * `review/verification/<phase>/check_review_site.json` (see
 * orchestrator/review-artifact-check.ts). This CLI stays a thin, correct
 * wrapper so `check.ts` has exactly one authoritative caller shape.
 */
export async function runCheckReviewSiteCli(args: readonly string[]): Promise<number> {
  const positional: string[] = [];
  let resultsPath: string | undefined;
  let measurementsRoot: string | undefined;
  let sampleId: string | undefined;
  let cdnAllowlist: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--results") {
      resultsPath = args[++i];
    } else if (arg === "--measurements-root") {
      measurementsRoot = args[++i];
    } else if (arg === "--sample-id") {
      sampleId = args[++i];
    } else if (arg === "--cdn-allowlist") {
      cdnAllowlist = (args[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (arg === "check-review-site") {
      // Tolerate the documented `… cli.ts check-review-site <dir>` subcommand.
      continue;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  const siteDir = positional[0];
  if (!siteDir) {
    console.error(
      "Usage: labrat check-review-site <site-dir> [--results <measurement.json>] [--measurements-root <dir>] [--cdn-allowlist origin1,origin2] [--sample-id <id>]",
    );
    return 2;
  }

  const opts: CheckReviewSiteOptions = {
    siteDir: resolve(siteDir),
    cdnAllowlist,
    ...(resultsPath !== undefined ? { resultsPath: resolve(resultsPath) } : {}),
    ...(measurementsRoot !== undefined ? { measurementsRoot: resolve(measurementsRoot) } : {}),
    ...(sampleId !== undefined ? { expectedSampleId: sampleId } : {}),
  };

  const report = await checkReviewSite(opts);
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

// Real invocation when run directly (`tsx src/review-site/cli.ts …`). Setting
// process.exitCode (not process.exit) lets stdout flush before the process
// ends — a bare process.exit right after console.log can truncate piped output.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCheckReviewSiteCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exitCode = 2;
    });
}
