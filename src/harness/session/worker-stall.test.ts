import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  classifyTurnOutcome,
  snapshotPhaseDir,
  snapshotsEqual,
  type TurnInput,
  type TurnLimits,
} from "./worker-stall.js";

const LIMITS: TurnLimits = {
  workerStall: 3,
  backgroundGraceRetries: 10,
  wallClockMs: 90 * 60_000,
  iterationCap: 200,
};

function turn(over: Partial<TurnInput> = {}): TurnInput {
  return {
    blocked: false,
    phaseComplete: false,
    recordable: false,
    hasActiveBackgroundTasks: false,
    progressed: false,
    noProgressCount: 0,
    bgGraceCount: 0,
    elapsedMs: 1_000,
    iteration: 1,
    limits: LIMITS,
    ...over,
  };
}

describe("classifyTurnOutcome — terminal outcomes", () => {
  it("blocked wins over everything", () => {
    const d = classifyTurnOutcome(
      turn({ blocked: true, phaseComplete: true, recordable: true }),
    );
    assert.deepEqual(d, { action: "return-blocked" });
  });

  it("explicit record_phase completes", () => {
    const d = classifyTurnOutcome(turn({ phaseComplete: true }));
    assert.deepEqual(d, {
      action: "return-complete",
      completedVia: "record_phase",
    });
  });

  it("completion fallback: recordable without record_phase completes via outputs-present", () => {
    const d = classifyTurnOutcome(turn({ recordable: true }));
    assert.deepEqual(d, {
      action: "return-complete",
      completedVia: "outputs-present",
    });
  });

  it("a recordable phase auto-completes even with background tasks still active (mirrors record_phase, which does not check bg tasks)", () => {
    const d = classifyTurnOutcome(
      turn({ recordable: true, hasActiveBackgroundTasks: true }),
    );
    assert.deepEqual(d, {
      action: "return-complete",
      completedVia: "outputs-present",
    });
  });

  it("explicit record_phase wins over an expired time budget", () => {
    const d = classifyTurnOutcome(
      turn({ phaseComplete: true, elapsedMs: LIMITS.wallClockMs + 1 }),
    );
    assert.deepEqual(d, {
      action: "return-complete",
      completedVia: "record_phase",
    });
  });

  it("completion wins over an expired time budget and the iteration cap", () => {
    const d = classifyTurnOutcome(
      turn({
        recordable: true,
        elapsedMs: LIMITS.wallClockMs + 1,
        iteration: LIMITS.iterationCap,
      }),
    );
    assert.deepEqual(d, {
      action: "return-complete",
      completedVia: "outputs-present",
    });
  });
});

describe("classifyTurnOutcome — background grace", () => {
  it("continues with grace while background tasks run, incrementing the count", () => {
    const d = classifyTurnOutcome(
      turn({ hasActiveBackgroundTasks: true, bgGraceCount: 4 }),
    );
    assert.deepEqual(d, {
      action: "grace-continue",
      bgGraceCount: 5,
      noProgressCount: 0,
    });
  });

  it("fails background-grace once the grace budget is exhausted", () => {
    const d = classifyTurnOutcome(
      turn({
        hasActiveBackgroundTasks: true,
        bgGraceCount: LIMITS.backgroundGraceRetries,
      }),
    );
    assert.deepEqual(d, { action: "fail", reason: "background-grace" });
  });

  it("background tasks shield an unfinished turn from the stall clock", () => {
    const d = classifyTurnOutcome(
      turn({
        hasActiveBackgroundTasks: true,
        noProgressCount: LIMITS.workerStall, // would fail as stall if idle
      }),
    );
    assert.equal(d.action, "grace-continue");
  });

  it("a grace period grants a fresh stall budget afterward (finding 4)", () => {
    // N no-progress turns erode the stall clock...
    let noProgressCount = 0;
    for (let i = 0; i < LIMITS.workerStall; i += 1) {
      const d = classifyTurnOutcome(turn({ noProgressCount }));
      assert.equal(d.action, "reminder-continue");
      noProgressCount = d.action === "reminder-continue" ? d.noProgressCount : -1;
    }
    assert.equal(noProgressCount, LIMITS.workerStall); // one more idle turn would fail

    // ...then background work appears: grace-continue resets the clock.
    const grace = classifyTurnOutcome(
      turn({ hasActiveBackgroundTasks: true, noProgressCount }),
    );
    assert.equal(grace.action, "grace-continue");
    noProgressCount =
      grace.action === "grace-continue" ? grace.noProgressCount : -1;
    assert.equal(noProgressCount, 0);

    // After grace ends, the stall must NOT fire one turn later — it takes a
    // full workerStall budget of no-progress turns again before failing.
    for (let i = 0; i < LIMITS.workerStall; i += 1) {
      const d = classifyTurnOutcome(turn({ noProgressCount }));
      assert.equal(d.action, "reminder-continue", `post-grace turn ${i + 1}`);
      noProgressCount = d.action === "reminder-continue" ? d.noProgressCount : -1;
    }
    const exhausted = classifyTurnOutcome(turn({ noProgressCount }));
    assert.deepEqual(exhausted, { action: "fail", reason: "stall" });
  });
});

describe("classifyTurnOutcome — progress vs stall", () => {
  it("progress resets the no-progress count", () => {
    const d = classifyTurnOutcome(
      turn({ progressed: true, noProgressCount: LIMITS.workerStall }),
    );
    assert.deepEqual(d, { action: "reminder-continue", noProgressCount: 0 });
  });

  it("many progressing iterations never fail (no re-invocation ceiling)", () => {
    let noProgressCount = 0;
    for (let iteration = 1; iteration < LIMITS.iterationCap; iteration += 1) {
      const d = classifyTurnOutcome(
        turn({ progressed: true, noProgressCount, iteration }),
      );
      assert.equal(d.action, "reminder-continue", `iteration ${iteration}`);
      noProgressCount = d.action === "reminder-continue" ? d.noProgressCount : -1;
    }
  });

  it("no-progress turns continue with a reminder until workerStall is exhausted", () => {
    for (let prior = 0; prior < LIMITS.workerStall; prior += 1) {
      const d = classifyTurnOutcome(turn({ noProgressCount: prior }));
      assert.deepEqual(
        d,
        { action: "reminder-continue", noProgressCount: prior + 1 },
        `prior count ${prior}`,
      );
    }
    const d = classifyTurnOutcome(
      turn({ noProgressCount: LIMITS.workerStall }),
    );
    assert.deepEqual(d, { action: "fail", reason: "stall" });
  });
});

describe("classifyTurnOutcome — backstops", () => {
  it("fails time-budget when the wall clock is exceeded, even mid-progress", () => {
    const d = classifyTurnOutcome(
      turn({ progressed: true, elapsedMs: LIMITS.wallClockMs + 1 }),
    );
    assert.deepEqual(d, { action: "fail", reason: "time-budget" });
  });

  it("fails time-budget over waiting on background work", () => {
    const d = classifyTurnOutcome(
      turn({
        hasActiveBackgroundTasks: true,
        elapsedMs: LIMITS.wallClockMs + 1,
      }),
    );
    assert.deepEqual(d, { action: "fail", reason: "time-budget" });
  });

  it("fails iteration-cap at the absolute safety cap", () => {
    const d = classifyTurnOutcome(
      turn({ progressed: true, iteration: LIMITS.iterationCap }),
    );
    assert.deepEqual(d, { action: "fail", reason: "iteration-cap" });
  });
});

describe("snapshotPhaseDir — the progress signal", () => {
  it("missing phase dir yields an empty snapshot (turn 1 before any writes)", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "labrat-snap-"));
    try {
      const snap = await snapshotPhaseDir(taskDir, "segmentation");
      assert.deepEqual(snap, {});
      assert.ok(snapshotsEqual(snap, {}));
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  it("detects new, modified, and removed files recursively", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "labrat-snap-"));
    try {
      const phaseDir = join(taskDir, "phases", "segmentation");
      await mkdir(join(phaseDir, "sub"), { recursive: true });
      await writeFile(join(phaseDir, "record.md"), "v1");
      await writeFile(join(phaseDir, "sub", "notes.txt"), "n");

      const base = await snapshotPhaseDir(taskDir, "segmentation");
      assert.equal(Object.keys(base).length, 2);
      assert.ok(snapshotsEqual(base, await snapshotPhaseDir(taskDir, "segmentation")));

      // Modified (different size — independent of mtime resolution).
      await writeFile(join(phaseDir, "record.md"), "v2 longer");
      const modified = await snapshotPhaseDir(taskDir, "segmentation");
      assert.ok(!snapshotsEqual(base, modified));

      // New file.
      await writeFile(join(phaseDir, "sub", "extra.txt"), "x");
      const added = await snapshotPhaseDir(taskDir, "segmentation");
      assert.ok(!snapshotsEqual(modified, added));

      // Removed file.
      await rm(join(phaseDir, "sub", "extra.txt"));
      const removed = await snapshotPhaseDir(taskDir, "segmentation");
      assert.ok(!snapshotsEqual(added, removed));
      assert.ok(snapshotsEqual(modified, removed));
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });
});
