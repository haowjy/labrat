import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { stringify } from "yaml";
import { getTask, getTaskExport } from "./index.js";

const FIXTURES_TASKS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "tasks",
);

/*
 * getTask()'s per-phase `reviewArtifact` descriptor is the signal the
 * chain/provenance views use to render the review artifact as a first-class
 * node. The harness-owned `review/artifact-author/<phase>/status.json` wins;
 * absent, the LEGACY fallback applies (contract-based match on the recorded
 * `artifacts/review-site/` output path, not a hardcoded phase-id check), so
 * these tests prove the general rule, not one protocol's phase name.
 */

async function withTaskDir<T>(
  fn: (tasksDir: string, id: string) => Promise<T>,
): Promise<T> {
  const tasksDir = await mkdtemp(join(tmpdir(), "labrat-dashboard-api-"));
  try {
    return await fn(tasksDir, "task-2026-07-10-099");
  } finally {
    await rm(tasksDir, { recursive: true, force: true });
  }
}

function manifestEntry(overrides: Record<string, unknown>) {
  return {
    phase: "phase",
    attempt: 1,
    started: "2026-07-10T10:00:00.000Z",
    completed: "2026-07-10T10:05:00.000Z",
    skills_loaded: [{ name: "resources/x", hash: "abc123" }],
    agent: "worker",
    inputs: [],
    outputs: [],
    subphases: null,
    sessions: { worker: "sess_worker", gate: "sess_gate" },
    gate_decision: "pass",
    verification: {
      code: "review/verification/phase/",
      results: "review/gates/phase.json",
    },
    ...overrides,
  };
}

describe("getTask — reviewArtifact descriptor (legacy fallback from outputs)", () => {
  it("is legacy only for the phase whose outputs include artifacts/review-site/", async () => {
    await withTaskDir(async (tasksDir, id) => {
      const dir = join(tasksDir, id);
      await mkdir(join(dir, "provenance"), { recursive: true });
      await writeFile(
        join(dir, "task.json"),
        JSON.stringify({
          id,
          protocol: "microct-oa-mouse-knee",
          input: "input/x/",
          state: "done",
          currentPhase: null,
          phasesComplete: ["measurement", "review-artifact"],
          createdAt: "2026-07-10T09:00:00.000Z",
          updatedAt: "2026-07-10T10:05:00.000Z",
        }),
      );
      await writeFile(
        join(dir, "provenance", "manifest.yaml"),
        stringify([
          manifestEntry({
            phase: "measurement",
            outputs: [{ path: "artifacts/measurements/results.json", hash: "h1" }],
          }),
          manifestEntry({
            phase: "review-artifact",
            outputs: [
              { path: "artifacts/review-site/index.html", hash: "h2" },
              { path: "artifacts/review-site/data/manifest.js", hash: "h3" },
            ],
          }),
        ]),
      );

      const detail = await getTask(tasksDir, id);
      assert.ok(detail);
      const byPhase = new Map(detail.timeline.map((e) => [e.phase, e]));
      assert.deepEqual(byPhase.get("measurement")?.reviewArtifact, { status: "none", type: null });
      assert.deepEqual(byPhase.get("review-artifact")?.reviewArtifact, { status: "legacy", type: null });
    });
  });

  it("is none for a phase with no manifest entry yet (currently running)", async () => {
    await withTaskDir(async (tasksDir, id) => {
      const dir = join(tasksDir, id);
      await mkdir(join(dir, "provenance"), { recursive: true });
      await writeFile(
        join(dir, "task.json"),
        JSON.stringify({
          id,
          protocol: "microct-oa-mouse-knee",
          input: "input/x/",
          state: "running",
          currentPhase: "measurement",
          phasesComplete: [],
          createdAt: "2026-07-10T09:00:00.000Z",
          updatedAt: "2026-07-10T09:00:00.000Z",
        }),
      );
      await writeFile(join(dir, "provenance", "manifest.yaml"), stringify([]));

      const detail = await getTask(tasksDir, id);
      assert.ok(detail);
      assert.equal(detail.timeline.length, 1);
      assert.deepEqual(detail.timeline[0]?.reviewArtifact, { status: "none", type: null });
    });
  });

  it("does not match an unrelated output path that merely contains the string", async () => {
    await withTaskDir(async (tasksDir, id) => {
      const dir = join(tasksDir, id);
      await mkdir(join(dir, "provenance"), { recursive: true });
      await writeFile(
        join(dir, "task.json"),
        JSON.stringify({
          id,
          protocol: "microct-oa-mouse-knee",
          input: "input/x/",
          state: "done",
          currentPhase: null,
          phasesComplete: ["measurement"],
          createdAt: "2026-07-10T09:00:00.000Z",
          updatedAt: "2026-07-10T09:00:00.000Z",
        }),
      );
      await writeFile(
        join(dir, "provenance", "manifest.yaml"),
        stringify([
          manifestEntry({
            phase: "measurement",
            outputs: [{ path: "artifacts/notes/artifacts/review-site/decoy.txt", hash: "h1" }],
          }),
        ]),
      );

      const detail = await getTask(tasksDir, id);
      assert.ok(detail);
      assert.deepEqual(detail.timeline[0]?.reviewArtifact, { status: "none", type: null });
    });
  });

  it("reads the harness-owned status.json over any output inference", async () => {
    await withTaskDir(async (tasksDir, id) => {
      const dir = join(tasksDir, id);
      await mkdir(join(dir, "provenance"), { recursive: true });
      await writeFile(
        join(dir, "task.json"),
        JSON.stringify({
          id,
          protocol: "microct-oa-mouse-knee",
          input: "input/x/",
          state: "paused",
          reason: "review-artifact-author-failed",
          currentPhase: null,
          phasesComplete: ["segmentation", "measurement", "intake"],
          createdAt: "2026-07-10T09:00:00.000Z",
          updatedAt: "2026-07-10T10:05:00.000Z",
        }),
      );
      await writeFile(
        join(dir, "provenance", "manifest.yaml"),
        stringify([
          manifestEntry({ phase: "segmentation" }),
          manifestEntry({ phase: "measurement" }),
          manifestEntry({ phase: "intake" }),
        ]),
      );
      const statusBase = {
        created_at: "2026-07-10T10:00:00.000Z",
        updated_at: "2026-07-10T10:05:00.000Z",
      };
      await mkdir(join(dir, "review", "artifact-author", "segmentation"), { recursive: true });
      await writeFile(
        join(dir, "review", "artifact-author", "segmentation", "status.json"),
        JSON.stringify({ status: "published", type: "spatial-3d", ...statusBase }),
      );
      await mkdir(join(dir, "review", "artifact-author", "measurement"), { recursive: true });
      await writeFile(
        join(dir, "review", "artifact-author", "measurement", "status.json"),
        JSON.stringify({ status: "failed", type: "quantitative", ...statusBase }),
      );
      await mkdir(join(dir, "review", "artifact-author", "intake"), { recursive: true });
      await writeFile(
        join(dir, "review", "artifact-author", "intake", "status.json"),
        JSON.stringify({ status: "none", type: "none", ...statusBase }),
      );

      const detail = await getTask(tasksDir, id);
      assert.ok(detail);
      const byPhase = new Map(detail.timeline.map((e) => [e.phase, e]));
      assert.deepEqual(byPhase.get("segmentation")?.reviewArtifact, {
        status: "published",
        type: "spatial-3d",
      });
      // failed is DISTINCT from none — the client must never render the
      // clean empty state for an unavailable artifact.
      assert.deepEqual(byPhase.get("measurement")?.reviewArtifact, {
        status: "failed",
        type: "quantitative",
      });
      assert.deepEqual(byPhase.get("intake")?.reviewArtifact, {
        status: "none",
        type: "none",
      });
    });
  });
});

describe("getTask — humanVerdict (per-phase, mirrors getPhase's field)", () => {
  it("attaches the persisted review/verdict/{phase}.json to its matching timeline entry", async () => {
    await withTaskDir(async (tasksDir, id) => {
      const dir = join(tasksDir, id);
      await mkdir(join(dir, "provenance"), { recursive: true });
      await mkdir(join(dir, "review", "verdict"), { recursive: true });
      await writeFile(
        join(dir, "task.json"),
        JSON.stringify({
          id,
          protocol: "microct-oa-mouse-knee",
          input: "input/x/",
          state: "done",
          currentPhase: null,
          phasesComplete: ["measurement", "segmentation"],
          createdAt: "2026-07-10T09:00:00.000Z",
          updatedAt: "2026-07-10T10:05:00.000Z",
        }),
      );
      await writeFile(
        join(dir, "provenance", "manifest.yaml"),
        stringify([
          manifestEntry({ phase: "measurement", outputs: [] }),
          manifestEntry({ phase: "segmentation", outputs: [] }),
        ]),
      );
      await writeFile(
        join(dir, "review", "verdict", "segmentation.json"),
        JSON.stringify({
          phase: "segmentation",
          human_verdict: "pass",
          corrected: true,
          notes: "Adjusted the femur landmark.",
          adjustments: [],
          agent_confidence: null,
          agent_gate_decision: null,
          agent_gate_feedback: null,
          reviewed_at: "2026-07-10T10:10:00.000Z",
        }),
      );

      const detail = await getTask(tasksDir, id);
      assert.ok(detail);
      const byPhase = new Map(detail.timeline.map((e) => [e.phase, e]));
      assert.equal(byPhase.get("measurement")?.humanVerdict, null);
      assert.equal(byPhase.get("segmentation")?.humanVerdict?.human_verdict, "pass");
      assert.equal(byPhase.get("segmentation")?.humanVerdict?.notes, "Adjusted the femur landmark.");
    });
  });
});

/*
 * getTaskExport() composes the downloadable review-chain bundle from the
 * existing read loaders over a real fixture tree — the demo sign-off surface.
 * The fixture's segmentation phase carries a gate, measurements, a filed
 * suggestion, AND a human verdict, so this proves every per-phase slice lands
 * in the bundle (not just the shape, but that a persisted human verdict is
 * threaded through).
 */
describe("getTaskExport — review-chain bundle (fixtures/tasks)", () => {
  const id = "task-2026-07-09-001";

  it("composes task.json, provenance, and per-phase gate/verdict/measurements/suggestions", async () => {
    const bundle = await getTaskExport(FIXTURES_TASKS_DIR, id);
    assert.ok(bundle);

    // Task-level shape.
    assert.equal(bundle.taskId, id);
    assert.equal(bundle.task.protocol, "microct-oa-mouse-knee");
    assert.equal(bundle.taskDir, join(FIXTURES_TASKS_DIR, id));
    assert.ok(bundle.taskDir.startsWith("/"), "taskDir is absolute for hand-off");
    assert.match(bundle.exportedAt, /^\d{4}-\d{2}-\d{2}T/);

    // Provenance manifest is the real parsed array.
    assert.equal(bundle.provenance.length, 2);
    assert.deepEqual(
      bundle.provenance.map((e) => e.phase),
      ["intake", "segmentation"],
    );

    // Per-phase slices, keyed for lookup.
    const byPhase = new Map(bundle.phases.map((p) => [p.phase, p]));
    const seg = byPhase.get("segmentation");
    assert.ok(seg);

    // Gate decision + feedback.
    assert.equal(seg.gate?.decision, "pass-with-concerns");
    assert.match(seg.gate?.feedback ?? "", /connected-component/);

    // Human verdict + notes (the phase with a persisted verdict).
    assert.equal(seg.humanVerdict?.human_verdict, "pass");
    assert.match(seg.humanVerdict?.notes ?? "", /femur speckle/);

    // Declared measurement artifacts.
    assert.equal((seg.measurements as { femurVoxels?: number }).femurVoxels, 142789);

    // Suggestions filed against this phase.
    assert.equal(seg.suggestions.length, 1);
    assert.equal(seg.suggestions[0]?.id, "sg-001");

    // The intake phase has a gate but no human verdict — bundle carries null,
    // not a fabricated verdict.
    const intake = byPhase.get("intake");
    assert.ok(intake);
    assert.equal(intake.humanVerdict, null);
    assert.equal(intake.gate?.decision, "pass");
  });

  it("returns null for an unknown task id (read-only, no crash)", async () => {
    assert.equal(await getTaskExport(FIXTURES_TASKS_DIR, "task-2026-01-01-999"), null);
  });
});
