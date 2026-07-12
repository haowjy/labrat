import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  ProtocolYaml,
  ReviewVerdictRecord,
  SendBackInvalidationRecord,
  SendBackRouteRecord,
  TaskJson,
} from "../../schema/index.js";
import { readHumanFeedbackNote } from "../review-verdict/index.js";
import {
  consumeSendBackVerdict,
  findSendBackPhase,
  invalidateForSendBack,
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

      const { phase, task, route } = await invalidateForSendBack(taskDir, protocolYaml);
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

      // The human verdict is NOT archived at invalidation time — it must
      // survive the rewind so the re-run worker's prompt can still read the
      // note. Consumption happens only AFTER delivery, when the phase
      // re-passes its gate (consumeSendBackVerdict — lifecycle tests below).
      // This is the read the reviewer must never do.
      assert.equal(
        await exists(join(taskDir, "review", "verdict", "segmentation.json")),
        true,
      );
      assert.equal(
        await readHumanFeedbackNote(taskDir, "segmentation"),
        "Fix the femur speckle.",
      );

      // The seam is audited: harness code (never a model) wrote the routing
      // decision + applied invalidation record before/around the mutation.
      const record = JSON.parse(
        await readFile(
          join(taskDir, "review", "routing", "send-back", `${route.route_id}.json`),
          "utf8",
        ),
      ) as SendBackRouteRecord;
      assert.equal(record.source, "deterministic-fallback");
      assert.equal(record.acceptance, "fallback");
      assert.equal(record.accepted_phase, "segmentation");
      const invalidation = JSON.parse(
        await readFile(join(taskDir, route.invalidation_record), "utf8"),
      ) as SendBackInvalidationRecord;
      assert.equal(invalidation.status, "applied");
      assert.deepEqual(invalidation.downstream_phases, ["segmentation", "measure"]);
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

// Re-materialize what a successful re-run leaves on disk after a send-back
// rewind: the invalidated phases' dirs/artifacts and a "done" task.json.
// (Attempt-N archives from the rewind stay where they are, as on a real run.)
async function simulateRerunCompleted(taskDir: string): Promise<void> {
  await mkdir(join(taskDir, "artifacts", "measurements"), { recursive: true });
  await writeFile(join(taskDir, "artifacts", "labels.nii.gz"), "LABELS-v2");
  await writeFile(join(taskDir, "artifacts", "measurements", "thickness.json"), '{"t":0.2}');
  for (const id of ["segmentation", "measure"]) {
    await mkdir(join(taskDir, "phases", id), { recursive: true });
    await writeFile(join(taskDir, "phases", id, "summary.md"), `# ${id} (rerun)\n`);
  }
  const task: TaskJson = {
    id: "task-2026-07-10-001",
    protocol: "test-protocol",
    input: "input/scan",
    state: "done",
    currentPhase: null,
    phasesComplete: ["intake", "segmentation", "measure"],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T01:00:00.000Z",
  };
  await writeFile(join(taskDir, "task.json"), JSON.stringify(task));
}

describe("send-back mark lifecycle — consumed once the re-run re-passes its gate", () => {
  it("a consumed mark cannot trigger a second rewind: a later send-back of a downstream phase rewinds ONLY there", async () => {
    const taskDir = await makeCompletedRun();
    try {
      // 1. Human sends back `segmentation`; rerun rewinds to it.
      await writeFile(
        join(taskDir, "review", "verdict", "segmentation.json"),
        JSON.stringify(humanVerdict("segmentation", "changes_requested", "Fix the femur speckle.")),
      );
      const first = await invalidateForSendBack(taskDir, protocolYaml);
      assert.equal(first.phase, "segmentation");

      // 2. The re-run worker still sees the note (delivery precedes consumption).
      assert.equal(
        await readHumanFeedbackNote(taskDir, "segmentation"),
        "Fix the femur speckle.",
      );

      // 3. Re-run completes and the phase re-passes its gate — the gate pass
      //    path consumes the mark (archived, not deleted).
      await simulateRerunCompleted(taskDir);
      await consumeSendBackVerdict(taskDir, "segmentation");

      assert.equal(
        await exists(join(taskDir, "review", "verdict", "segmentation.json")),
        false,
      );
      assert.equal(
        await exists(join(taskDir, "review", "verdict", "segmentation.attempt-1.json")),
        true,
        "consumed mark is archived for audit, not deleted",
      );
      // No pending send-back left; the stale note cannot re-inject into an
      // unrelated later re-run of segmentation (e.g. an agent-FAIL retry).
      assert.equal(await findSendBackPhase(taskDir, protocolYaml), null);
      assert.equal(await readHumanFeedbackNote(taskDir, "segmentation"), null);

      // 4. Human now sends back the DOWNSTREAM `measure`; rerun must rewind
      //    only to measure — before consumption existed, the stale
      //    segmentation mark won the earliest-phase scan and re-archived the
      //    good segmentation work.
      await writeFile(
        join(taskDir, "review", "verdict", "measure.json"),
        JSON.stringify(humanVerdict("measure", "changes_requested", "Recheck thickness.")),
      );
      const second = await invalidateForSendBack(taskDir, protocolYaml);
      assert.equal(second.phase, "measure");

      // Segmentation's re-run work survives untouched.
      assert.equal(await exists(join(taskDir, "phases", "segmentation")), true);
      assert.equal(await exists(join(taskDir, "artifacts", "labels.nii.gz")), true);
      assert.deepEqual(second.task.phasesComplete, ["intake", "segmentation"]);
      assert.equal(second.task.currentPhase, "measure");
      // Measure itself is rewound (attempt-2: attempt-1 was the first rewind).
      assert.equal(await exists(join(taskDir, "phases", "measure")), false);
      assert.equal(
        await exists(join(taskDir, "phases", "measure.attempt-2")),
        true,
      );
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("consumption only touches changes_requested — terminal pass/fail verdicts stay live for the review chain", async () => {
    const taskDir = await makeCompletedRun();
    try {
      await writeFile(
        join(taskDir, "review", "verdict", "segmentation.json"),
        JSON.stringify(humanVerdict("segmentation", "pass", "Looks right.")),
      );
      await consumeSendBackVerdict(taskDir, "segmentation");
      assert.equal(
        await exists(join(taskDir, "review", "verdict", "segmentation.json")),
        true,
      );
      // Absent verdict: a plain gate pass with no human review is a no-op.
      await consumeSendBackVerdict(taskDir, "measure");
      assert.equal(
        await exists(join(taskDir, "review", "verdict", "measure.attempt-1.json")),
        false,
      );
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("multiple live marks: one restart at the earliest mark covers all later marks; each is consumed phase-locally", async () => {
    const taskDir = await makeCompletedRun();
    try {
      // Human sends back BOTH segmentation and measure in one review pass.
      await writeFile(
        join(taskDir, "review", "verdict", "segmentation.json"),
        JSON.stringify(humanVerdict("segmentation", "changes_requested", "mask leaked")),
      );
      await writeFile(
        join(taskDir, "review", "verdict", "measure.json"),
        JSON.stringify(humanVerdict("measure", "changes_requested", "thickness wrong")),
      );

      // One routing decision: earliest mark wins; the invalidation closure
      // covers the later marked phase too.
      const { phase, route } = await invalidateForSendBack(taskDir, protocolYaml);
      assert.equal(phase, "segmentation");
      assert.ok(await exists(join(taskDir, "phases", "segmentation.attempt-1")));
      assert.ok(await exists(join(taskDir, "phases", "measure.attempt-1")));
      assert.deepEqual(
        route.feedback_files.map((f) => f.path),
        ["review/verdict/segmentation.json", "review/verdict/measure.json"],
      );

      // Both marks stay live through routing (delivery precedes consumption)…
      assert.ok(await exists(join(taskDir, "review", "verdict", "segmentation.json")));
      assert.ok(await exists(join(taskDir, "review", "verdict", "measure.json")));

      // …and the rigid loop consumes each one only when ITS phase re-passes
      // its fresh gate — so no stale mark can trigger a second rerun.
      await simulateRerunCompleted(taskDir);
      await consumeSendBackVerdict(taskDir, "segmentation");
      await consumeSendBackVerdict(taskDir, "measure");
      assert.equal(await findSendBackPhase(taskDir, protocolYaml), null);
      assert.ok(
        await exists(join(taskDir, "review", "verdict", "segmentation.attempt-1.json")),
      );
      assert.ok(await exists(join(taskDir, "review", "verdict", "measure.attempt-1.json")));
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("repeat send-backs of the same phase archive under increasing attempt numbers", async () => {
    const taskDir = await makeCompletedRun();
    try {
      for (const [n, note] of [
        [1, "first"],
        [2, "second"],
      ] as const) {
        await writeFile(
          join(taskDir, "review", "verdict", "segmentation.json"),
          JSON.stringify(humanVerdict("segmentation", "changes_requested", note)),
        );
        await consumeSendBackVerdict(taskDir, "segmentation");
        assert.equal(
          await exists(
            join(taskDir, "review", "verdict", `segmentation.attempt-${n}.json`),
          ),
          true,
        );
      }
      assert.equal(await findSendBackPhase(taskDir, protocolYaml), null);
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });
});
