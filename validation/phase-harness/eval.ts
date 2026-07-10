#!/usr/bin/env -S npx tsx
/**
 * Phase-harness eval: proves a single protocol phase can be reset,
 * re-run in isolation, and resumed — without touching the rest of the
 * pipeline — against the toy-stats fixture in `validation/fixtures/`.
 *
 * This is a LIVE run: `run-phase` invokes the real worker via the Claude
 * Agent SDK against the toy-stats skill/runtime, so it needs the same
 * environment `labrat enqueue` needs (API auth, `~/.claude-science` with
 * the toy-stats skill + conda env provisioned). See README.md.
 *
 * Usage: npx tsx validation/phase-harness/eval.ts
 */
import { mkdtemp, cp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resetTaskToPhase,
  runPhaseInIsolation,
} from "../../src/harness/orchestrator/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "fixtures", "toy-stats-task");
const TASK_ID = "task-2026-07-10-002";
const TARGET_PHASE = "regression";
const TARGET_ARTIFACT = join("artifacts", TARGET_PHASE, "regression.json");

async function existsAt(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const tasksRoot = await mkdtemp(join(tmpdir(), "labrat-phase-harness-eval-"));
  const taskDir = join(tasksRoot, TASK_ID);

  console.log(`[eval] fixture: ${FIXTURE_DIR}`);
  console.log(`[eval] scratch tasks root: ${tasksRoot}`);
  await cp(FIXTURE_DIR, taskDir, { recursive: true });

  try {
    // 1. reset-to: truncate the fixture back to just before `regression` —
    // deletes phases/regression + artifacts/regression, which the fixture
    // ships already populated (it's a completed run).
    console.log(`[eval] reset-to ${TASK_ID} ${TARGET_PHASE}`);
    const resetTask = await resetTaskToPhase(TASK_ID, TARGET_PHASE, tasksRoot);
    assertTrue(
      !resetTask.phasesComplete.includes(TARGET_PHASE),
      `reset-to should drop "${TARGET_PHASE}" from phasesComplete`,
    );
    assertTrue(
      resetTask.phasesComplete.includes("classify"),
      `reset-to should leave upstream "classify" in phasesComplete`,
    );
    assertTrue(
      !(await existsAt(join(taskDir, "artifacts", TARGET_PHASE))),
      `reset-to should delete artifacts/${TARGET_PHASE}/`,
    );
    assertTrue(
      !(await existsAt(join(taskDir, TARGET_ARTIFACT))),
      `${TARGET_ARTIFACT} should not exist after reset-to`,
    );

    // 2. run-phase: run ONLY the regression phase's worker, in isolation,
    // against the untouched upstream classify artifacts already on disk.
    console.log(`[eval] run-phase ${TASK_ID} ${TARGET_PHASE}`);
    const result = await runPhaseInIsolation(TASK_ID, TARGET_PHASE, false, tasksRoot);
    assertTrue(result.phaseComplete, "run-phase should report phaseComplete");
    assertTrue(
      result.task.phasesComplete.includes(TARGET_PHASE),
      `run-phase should re-add "${TARGET_PHASE}" to phasesComplete`,
    );

    // 3. assert the output artifact is back on disk with the shape the
    // regression skill is expected to produce.
    const artifactPath = join(taskDir, TARGET_ARTIFACT);
    assertTrue(
      await existsAt(artifactPath),
      `expected output artifact missing: ${TARGET_ARTIFACT}`,
    );
    const regression = JSON.parse(await readFile(artifactPath, "utf8")) as Record<
      string,
      unknown
    >;
    for (const key of ["slope", "intercept", "r_squared", "n"]) {
      assertTrue(key in regression, `${TARGET_ARTIFACT} missing key "${key}"`);
    }

    console.log("[eval] PASS — isolated run-phase reproduced the output artifact");
  } finally {
    await rm(tasksRoot, { recursive: true, force: true });
  }
}

function assertTrue(cond: boolean, message: string): void {
  if (!cond) {
    throw new Error(`[eval] FAIL — ${message}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
