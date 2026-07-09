import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createOrchestratorSignals,
  type LabratToolContext,
} from "./context.js";
import {
  handleBlocked,
  handleMarkSubphase,
  handleRecordPhase,
  handleSubmitGateDecision,
} from "./handlers.js";
import { allowedLabratTools, createLabratToolServer } from "./server.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((c) => c.type === "text");
  return block?.text ?? "";
}

async function setupTaskDir(): Promise<{
  taskDir: string;
  cleanup: () => Promise<void>;
}> {
  const taskDir = await mkdtemp(path.join(tmpdir(), "labrat-tools-"));
  const cleanup = async () => {
    await rm(taskDir, { recursive: true, force: true });
  };
  return { taskDir, cleanup };
}

function makeCtx(
  taskDir: string,
  overrides: Partial<LabratToolContext> = {},
): LabratToolContext {
  return {
    taskId: "task-test-001",
    taskDir,
    currentPhase: "segmentation",
    phaseOutputs: ["labels.nii.gz"],
    subphaseIds: ["threshold", "watershed"],
    signals: createOrchestratorSignals(),
    ...overrides,
  };
}

async function main(): Promise<void> {
  const { taskDir, cleanup } = await setupTaskDir();
  try {
    await mkdir(path.join(taskDir, "phases", "segmentation"), {
      recursive: true,
    });
    await mkdir(path.join(taskDir, "artifacts"), { recursive: true });
    await writeFile(
      path.join(taskDir, "artifacts", "labels.nii.gz"),
      "fake-nii",
    );

    const ctx = makeCtx(taskDir);

    // record_phase — missing subphase marks
    let result = await handleRecordPhase(ctx, { phase: "segmentation" });
    assert.match(textOf(result), /subphase threshold is unmarked/);
    assert.equal(ctx.signals.phaseComplete, false);
    console.log("OK record_phase rejects unmarked subphases");

    // mark_subphase — invalid (pass without confidence)
    result = await handleMarkSubphase(ctx, {
      subphase: "threshold",
      mark: "pass",
    });
    assert.match(textOf(result), /confidence required/);
    console.log("OK mark_subphase rejects pass without confidence");

    // mark_subphase — valid
    result = await handleMarkSubphase(ctx, {
      subphase: "threshold",
      mark: "pass",
      confidence: "high",
      notes: "clean histogram",
    });
    assert.match(textOf(result), /Marked subphase threshold/);
    console.log("OK mark_subphase appends mark");

    result = await handleMarkSubphase(ctx, {
      subphase: "watershed",
      mark: "human-review",
      confidence: "medium",
    });
    assert.match(textOf(result), /Marked subphase watershed/);
    console.log("OK mark_subphase second mark");

    // record_phase — success
    result = await handleRecordPhase(ctx, { phase: "segmentation" });
    assert.equal(textOf(result), "Phase recorded. Stopping for review.");
    assert.equal(ctx.signals.phaseComplete, true);
    console.log("OK record_phase sets phaseComplete signal");

    // blocked
    const blockedCtx = makeCtx(taskDir, {
      signals: createOrchestratorSignals(),
    });
    result = await handleBlocked(blockedCtx, {
      reason: "missing reference volume",
    });
    assert.match(textOf(result), /blocked/i);
    assert.equal(
      blockedCtx.signals.blockedReason,
      "missing reference volume",
    );
    console.log("OK blocked sets blockedReason signal");

    // submit_gate_decision
    const gateCtx = makeCtx(taskDir, {
      signals: createOrchestratorSignals(),
      subphaseIds: [],
    });
    result = await handleSubmitGateDecision(gateCtx, {
      decision: "pass-with-concerns",
      feedback: "minor artifact",
    });
    assert.match(textOf(result), /pass-with-concerns/);
    assert.equal(gateCtx.signals.gateDecision?.decision, "pass-with-concerns");
    console.log("OK submit_gate_decision captures decision");

    result = await handleSubmitGateDecision(gateCtx, {
      decision: "fail-upstream",
    });
    assert.match(textOf(result), /rewind_to required/);
    console.log("OK submit_gate_decision rejects fail-upstream without rewind_to");

    // server factory — role-scoped tools
    const workerServer = createLabratToolServer({ ctx, role: "worker" });
    const reviewerServer = createLabratToolServer({
      ctx: gateCtx,
      role: "gate-reviewer",
    });
    assert.equal(workerServer.name, "labrat");
    assert.equal(reviewerServer.name, "labrat");

    const workerAllowed = allowedLabratTools("worker", ctx.subphaseIds);
    assert.deepEqual(workerAllowed, [
      "mcp__labrat__record_phase",
      "mcp__labrat__mark_subphase",
      "mcp__labrat__blocked",
    ]);
    const reviewerAllowed = allowedLabratTools("gate-reviewer", []);
    assert.deepEqual(reviewerAllowed, ["mcp__labrat__submit_gate_decision"]);
    console.log("OK createLabratToolServer role-scoped tool lists");

    console.log("\nAll direct-call harness tool tests passed.");
  } finally {
    await cleanup();
  }
}

await main();
