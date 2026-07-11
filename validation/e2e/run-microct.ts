/**
 * Full end-to-end run: microct-oa-mouse-knee protocol against real DICOM data.
 *
 * DICOM in → 6 phases (intake, segmentation, seed-review, landmarks,
 * measurement, review-artifact) → independent reviewer verifies each →
 * dashboard-ready task tree with provenance + review chain.
 *
 * Usage:
 *   DICOM_INPUT=/path/to/dicom/dir npx tsx validation/e2e/run-microct.ts
 *
 * Defaults to the OA6-1RK specimen in the microct-analysis repo.
 */
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../../src/config/index.js";
import { enqueueAndRun } from "../../src/harness/orchestrator/index.js";

const PROTOCOL = "microct-oa-mouse-knee";

const EXPECTED_PHASES = [
  "intake",
  "segmentation",
  "seed-review",
  "landmarks",
  "measurement",
  "review-artifact",
] as const;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`E2E ASSERT FAILED: ${msg}`);
  console.log(`  ok  ${msg}`);
}

async function main(): Promise<void> {
  // Try repo-local sample first (data/OA7-4L extracted), then the external
  // microct-analysis repo's OA6-1RK specimen.
  const repoSample = join(resolve(process.cwd(), "data", "OA7-4L"));
  const externalSample = join(
    resolve(process.env.HOME ?? "~"),
    "gitrepos/prompts/microct-analysis/data/OA6-1RK/OA6-1RK",
  );
  const inputDir =
    process.env.DICOM_INPUT ??
    (await exists(repoSample) ? repoSample : externalSample);

  if (!(await exists(inputDir))) {
    throw new Error(`DICOM input not found: ${inputDir}`);
  }

  const config = loadConfig();
  // Tasks go under the project's tasks/ dir (gitignored)
  const tasksRoot = join(resolve(process.cwd(), "tasks"));

  console.log(`[e2e] protocol: ${PROTOCOL}`);
  console.log(`[e2e] input:    ${inputDir}`);
  console.log(`[e2e] tasks:    ${tasksRoot}`);
  console.log(`[e2e] scienceHome: ${config.scienceHome}\n`);

  const started = Date.now();
  const result = await enqueueAndRun(inputDir, PROTOCOL, tasksRoot, config);
  const elapsed = ((Date.now() - started) / 1000 / 60).toFixed(1);
  console.log(
    `\n[e2e] run finished in ${elapsed}m  taskDir=${result.taskDir}\n`,
  );

  const { taskDir } = result;

  // --- Assertions ---

  assert(
    result.task.state === "done",
    `task reached state=done (got ${result.task.state})`,
  );

  // Verdict
  const verdictRaw = await readFile(
    join(taskDir, "review", "verdict.json"),
    "utf8",
  );
  const verdict = JSON.parse(verdictRaw) as { status?: string };
  assert(
    verdict.status === "pass" || verdict.status === "pass-with-concerns",
    `review/verdict.json status is a pass variant (got ${verdict.status})`,
  );

  // Provenance
  const manifestRaw = await readFile(
    join(taskDir, "provenance", "manifest.yaml"),
    "utf8",
  );
  const manifest = parseYaml(manifestRaw) as { phase?: string }[];
  for (const phase of EXPECTED_PHASES) {
    assert(
      Array.isArray(manifest) && manifest.some((e) => e.phase === phase),
      `provenance manifest has entry for "${phase}"`,
    );
  }

  // Gate decisions
  for (const phase of EXPECTED_PHASES) {
    const gatePath = join(taskDir, "review", "gates", `${phase}.json`);
    assert(await exists(gatePath), `gate recorded for "${phase}"`);
  }

  // Monitor verdicts
  for (const phase of EXPECTED_PHASES) {
    const monitorPath = join(taskDir, "review", "monitor", `${phase}.json`);
    assert(
      await exists(monitorPath),
      `independent monitor recorded "${phase}"`,
    );
  }

  // Review site + linter
  const reviewSitePath = join(taskDir, "artifacts", "review-site", "index.html");
  assert(await exists(reviewSitePath), "review-site/index.html produced");

  const linterPath = join(
    taskDir,
    "review",
    "verification",
    "review-artifact",
    "check_review_site.json",
  );
  if (await exists(linterPath)) {
    const linter = JSON.parse(await readFile(linterPath, "utf8")) as {
      ok?: boolean;
    };
    assert(linter.ok === true, "review-site linter (G1-G9) passed");
  }

  // Key artifacts
  assert(
    await exists(join(taskDir, "labels.nii.gz")),
    "segmentation labels produced",
  );
  assert(
    await exists(join(taskDir, "landmarks.json")),
    "landmarks produced",
  );
  assert(
    await exists(join(taskDir, "measurements", "results.json")),
    "measurement results produced",
  );

  console.log(
    `\n[e2e] PASS — ${PROTOCOL} ran end-to-end: DICOM in → ` +
      `${EXPECTED_PHASES.length} phases → reviewer verified → ` +
      `review chain complete (${elapsed}m)`,
  );
  console.log(`[e2e] taskDir: ${taskDir}`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(
      `\n[e2e] FAIL: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  });
