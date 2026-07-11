import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ProtocolYaml, ReviewVerdictRecord, TaskJson } from "../../schema/index.js";
import {
  findSendBackPhase,
  invalidateForSendBack,
  readHumanFeedbackNote,
} from "./index.js";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Two downstream phases so we can prove a send-back invalidates the target
// AND everything built on its now-invalid output — the same rewind semantics
// the agent-FAIL fail-upstream path uses, but human-initiated.
const protocolYaml = {
  kind: "protocol",
  name: "test-protocol",
  version: 1,
  expects: { modality: "microct", species: "mouse" },
  agents: { worker: { model: "test" }, reviewer: { model: "test" } },
  phases: [
    { id: "intake", skills: [], inputs: [], outputs: ["spacing.json"] },
    {
      id: "segmentation",
      skills: [],
      inputs: ["spacing.json"],
      outputs: ["labels.nii.gz"],
    },
    {
      id: "measure",
      skills: [],
      inputs: ["labels.nii.gz"],
      outputs: ["measurements/thickness.json"],
    },
  ],
} as unknown as ProtocolYaml;

function humanVerdict(
  phase: string,
  verdict: ReviewVerdictRecord["human_verdict"],
  notes: string,
): ReviewVerdictRecord {
  return {
    phase,
    human_verdict: verdict,
    corrected: false,
    notes,
    adjustments: [],
    agent_confidence: null,
    agent_gate_decision: null,
    agent_gate_feedback: null,
    reviewed_at: "2026-07-10T00:00:00.000Z",
  };
}

async function makeCompletedRun(): Promise<string> {
  const taskDir = await mkdtemp(join(tmpdir(), "labrat-send-back-"));
  const art = (rel: string) => join(taskDir, "artifacts", rel);
  await mkdir(join(taskDir, "artifacts", "measurements"), { recursive: true });
  await writeFile(art("spacing.json"), '{"spacing":[1,1,1]}');
  await writeFile(art("labels.nii.gz"), "LABELS");
  await writeFile(art("measurements/thickness.json"), '{"t":0.1}');
  for (const id of ["intake", "segmentation", "measure"]) {
    await mkdir(join(taskDir, "phases", id), { recursive: true });
    await writeFile(join(taskDir, "phases", id, "summary.md"), `# ${id}\n`);
  }
  await mkdir(join(taskDir, "review", "verdict"), { recursive: true });

  const task: TaskJson = {
    id: "task-2026-07-10-001",
    protocol: "test-protocol",
    input: "input/scan",
    state: "done",
    currentPhase: null,
    phasesComplete: ["intake", "segmentation", "measure"],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
  await writeFile(join(taskDir, "task.json"), JSON.stringify(task));
  return taskDir;
}

describe("send-back seam — a human changes_requested verdict re-runs the phase", () => {
  it("invalidateForSendBack archives the sent-back phase + downstream and rewinds task.json", async () => {
    const taskDir = await makeCompletedRun();
    try {
      // Human sends `segmentation` back through the dashboard: a
      // changes_requested verdict lands on disk (the re-run MARK).
      await writeFile(
        join(taskDir, "review", "verdict", "segmentation.json"),
        JSON.stringify(humanVerdict("segmentation", "changes_requested", "Fix the femur speckle.")),
      );

      const { phase, task } = await invalidateForSendBack(taskDir, protocolYaml);
      assert.equal(phase, "segmentation");

      // Target + downstream phase dirs archived (attempt-1), upstream intact.
      const phaseEntries = await readdir(join(taskDir, "phases"));
      assert.ok(phaseEntries.includes("intake"), "upstream intake untouched");
      assert.ok(phaseEntries.includes("segmentation.attempt-1"), "segmentation archived");
      assert.ok(phaseEntries.includes("measure.attempt-1"), "downstream measure archived");
      assert.equal(await exists(join(taskDir, "phases", "segmentation")), false);
      assert.equal(await exists(join(taskDir, "phases", "measure")), false);

      // Declared outputs: upstream survives, target + downstream cleared.
      assert.equal(await exists(join(taskDir, "artifacts", "spacing.json")), true);
      assert.equal(await exists(join(taskDir, "artifacts", "labels.nii.gz")), false);
      assert.equal(
        await exists(join(taskDir, "artifacts", "measurements", "thickness.json")),
        false,
      );

      // task.json rewound to the sent-back phase so a subsequent runTask resumes there.
      assert.deepEqual(task.phasesComplete, ["intake"]);
      assert.equal(task.currentPhase, "segmentation");
      assert.equal(task.state, "running");

      // The human verdict itself is NEVER archived/reset — it must survive so
      // the re-run worker's prompt can still read the note (and so the human's
      // decision is auditable). This is the read the reviewer must never do.
      assert.equal(
        await exists(join(taskDir, "review", "verdict", "segmentation.json")),
        true,
      );
      assert.equal(
        await readHumanFeedbackNote(taskDir, "segmentation"),
        "Fix the femur speckle.",
      );
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("only changes_requested triggers a rerun — pass/fail are terminal marks", async () => {
    const taskDir = await makeCompletedRun();
    try {
      // A plain human "fail" (terminal reject) is recorded but is NOT a
      // send-back: findSendBackPhase ignores it and readHumanFeedbackNote
      // returns null, so no rerun mark exists.
      await writeFile(
        join(taskDir, "review", "verdict", "segmentation.json"),
        JSON.stringify(humanVerdict("segmentation", "fail", "This is wrong.")),
      );

      assert.equal(await findSendBackPhase(taskDir, protocolYaml), null);
      assert.equal(await readHumanFeedbackNote(taskDir, "segmentation"), null);
      await assert.rejects(
        () => invalidateForSendBack(taskDir, protocolYaml),
        /No phase to rerun/,
      );
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("findSendBackPhase returns the earliest sent-back phase in protocol order", async () => {
    const taskDir = await makeCompletedRun();
    try {
      await writeFile(
        join(taskDir, "review", "verdict", "measure.json"),
        JSON.stringify(humanVerdict("measure", "changes_requested", "later phase")),
      );
      await writeFile(
        join(taskDir, "review", "verdict", "segmentation.json"),
        JSON.stringify(humanVerdict("segmentation", "changes_requested", "earlier phase")),
      );
      assert.equal(await findSendBackPhase(taskDir, protocolYaml), "segmentation");
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });
});
