import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { after, describe, it } from "node:test";
import { finishReview, reviewVerdictPath } from "./index.js";

// The committed fixture (not the gitignored tasks/ tree) — a real task.json,
// phases/segmentation/confidence.json, and review/gates/segmentation.json,
// so the agent-confidence read-through is exercised against real disk state.
const FIXTURE = fileURLToPath(
  new URL("../../../fixtures/tasks/task-2026-07-09-001", import.meta.url),
);
const TASK_ID = "task-2026-07-09-001";

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function makeTasksDir(): Promise<string> {
  const tasksDir = await mkdtemp(path.join(tmpdir(), "labrat-review-finish-"));
  dirs.push(tasksDir);
  await cp(FIXTURE, path.join(tasksDir, TASK_ID), { recursive: true });
  return tasksDir;
}

const validBody = {
  phase: "segmentation",
  human_verdict: "pass",
  corrected: true,
  notes: "Cleaned the femur speckle islands; measurements confirmed.",
  adjustments: [
    {
      id: "lm-femur-condyle",
      proposed: { x: 10, y: 20, z: 30 },
      corrected: { x: 10.4, y: 20, z: 30 },
    },
  ],
};

describe("finishReview — POST /api/tasks/:id/review/finish write path", () => {
  it("happy path: writes review/verdict/{phase}.json with the merged shape", async () => {
    const tasksDir = await makeTasksDir();
    const result = await finishReview(tasksDir, TASK_ID, validBody);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // Assert on the ACTUAL on-disk file, not just the returned value.
    const onDisk = JSON.parse(
      await readFile(reviewVerdictPath(tasksDir, TASK_ID, "segmentation"), "utf8"),
    );
    assert.equal(onDisk.phase, "segmentation");
    assert.equal(onDisk.human_verdict, "pass");
    assert.equal(onDisk.corrected, true);
    assert.equal(onDisk.notes, validBody.notes);
    assert.deepEqual(onDisk.adjustments, validBody.adjustments);
    assert.match(onDisk.reviewed_at, /^\d{4}-\d{2}-\d{2}T/);

    // Agent-confidence/gate read-through, populated from the fixture's
    // phases/segmentation/confidence.json and review/gates/segmentation.json
    // — never from the request body.
    assert.equal(onDisk.agent_confidence.overall, "medium");
    assert.match(onDisk.agent_confidence.notes, /fragmented/);
    assert.equal(onDisk.agent_gate_decision, "pass-with-concerns");
    assert.match(onDisk.agent_gate_feedback, /seed replay/);
  });

  it("human_verdict comes only from the body, never derived from the gate decision", async () => {
    // The gate decision for "segmentation" is pass-with-concerns; the human
    // verdict here is fail — they must not collapse into one value.
    const tasksDir = await makeTasksDir();
    const result = await finishReview(tasksDir, TASK_ID, {
      ...validBody,
      human_verdict: "fail",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.human_verdict, "fail");
    assert.equal(result.value.agent_gate_decision, "pass-with-concerns");
  });

  it("rejects a malformed body (missing human_verdict)", async () => {
    const tasksDir = await makeTasksDir();
    const { human_verdict: _drop, ...bad } = validBody;
    const result = await finishReview(tasksDir, TASK_ID, bad);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  it("rejects a non-object body", async () => {
    const tasksDir = await makeTasksDir();
    const result = await finishReview(tasksDir, TASK_ID, "not an object");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  it("rejects a traversal task id", async () => {
    const tasksDir = await makeTasksDir();
    const result = await finishReview(tasksDir, "../evil", validBody);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  it("rejects a traversal phase", async () => {
    const tasksDir = await makeTasksDir();
    const result = await finishReview(tasksDir, TASK_ID, {
      ...validBody,
      phase: "../../etc",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  it("rejects an unknown task id (no task.json on disk)", async () => {
    const tasksDir = await makeTasksDir();
    const result = await finishReview(tasksDir, "task-2026-07-09-999", validBody);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 404);
  });

  it("agent fields read through as null when no confidence.json/gate exists for the phase", async () => {
    const tasksDir = await makeTasksDir();
    const result = await finishReview(tasksDir, TASK_ID, {
      ...validBody,
      phase: "unreviewed-phase",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.agent_confidence, null);
    assert.equal(result.value.agent_gate_decision, null);
    assert.equal(result.value.agent_gate_feedback, null);
  });
});
