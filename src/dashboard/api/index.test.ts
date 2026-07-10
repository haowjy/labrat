import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stringify } from "yaml";
import { getTask } from "./index.js";

/*
 * getTask()'s `hasReviewSite` is the signal the chain/provenance views use to
 * render the review site as a first-class node (design/review-template.md
 * vocabulary: "review site" = the folder under artifacts/review-site/). It is
 * contract-based (matches on the recorded output path), not a hardcoded
 * phase-id check, so this test proves the general rule, not one protocol's
 * phase name.
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

describe("getTask — hasReviewSite (design/review-template.md vocabulary)", () => {
  it("is true only for the phase whose outputs include artifacts/review-site/", async () => {
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
      assert.equal(byPhase.get("measurement")?.hasReviewSite, false);
      assert.equal(byPhase.get("review-artifact")?.hasReviewSite, true);
    });
  });

  it("is false for a phase with no manifest entry yet (currently running)", async () => {
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
      assert.equal(detail.timeline[0]?.hasReviewSite, false);
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
      assert.equal(detail.timeline[0]?.hasReviewSite, false);
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
