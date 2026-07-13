import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { startRerun, type StartRerunDeps } from "./index.js";

// Unit tests for the POST /api/tasks/:id/rerun backing logic. The detached
// spawn is injected so nothing here launches a real rerun; the route-level
// rejection tests live in server.test.ts.

const TASK_ID = "task-2026-07-10-001";

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** A project root with a tasks/<TASK_ID>/ tree in the given state. */
async function makeTask(opts: {
  state?: string;
  verdicts?: Record<string, string>; // filename (no .json) → human_verdict
}): Promise<{ root: string; tasksDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "labrat-rerun-"));
  dirs.push(root);
  const tasksDir = path.join(root, "tasks");
  const dir = path.join(tasksDir, TASK_ID);
  await mkdir(path.join(dir, "review", "verdict"), { recursive: true });
  await writeFile(
    path.join(dir, "task.json"),
    JSON.stringify({
      id: TASK_ID,
      protocol: "toy-stats",
      input: "input/sample/",
      state: opts.state ?? "paused",
      currentPhase: "analysis",
      phasesComplete: ["intake"],
      createdAt: "2026-07-10T10:00:00Z",
      updatedAt: "2026-07-10T10:30:00Z",
    }),
  );
  for (const [name, human_verdict] of Object.entries(opts.verdicts ?? {})) {
    await writeFile(
      path.join(dir, "review", "verdict", `${name}.json`),
      JSON.stringify({
        phase: name.replace(/\.attempt-\d+$/, ""),
        human_verdict,
        corrected: false,
        notes: "move the landmark one slice proximal",
        adjustments: [],
        agent_confidence: null,
        agent_gate_decision: "pass",
        agent_gate_feedback: null,
        reviewed_at: "2026-07-10T10:30:00Z",
      }),
    );
  }
  return { root, tasksDir };
}

function fakeDeps(): {
  deps: StartRerunDeps;
  launches: Parameters<StartRerunDeps["launch"]>[0][];
} {
  const launches: Parameters<StartRerunDeps["launch"]>[0][] = [];
  return {
    launches,
    deps: {
      launch: (opts) => {
        launches.push(opts);
        return 4242;
      },
    },
  };
}

describe("startRerun", () => {
  it("happy path: 202 shape, marked phase, log under control/, launch args", async () => {
    const { root, tasksDir } = await makeTask({
      verdicts: { analysis: "changes_requested" },
    });
    const { deps, launches } = fakeDeps();

    const result = await startRerun({ tasksDir }, TASK_ID, deps);

    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.value.started, true);
    assert.equal(result.value.taskId, TASK_ID);
    assert.equal(result.value.phase, "analysis");
    assert.equal(result.value.pid, 4242);
    assert.ok(result.value.log.startsWith(path.join(root, "control") + path.sep));

    assert.equal(launches.length, 1);
    assert.equal(launches[0]!.runRoot, root);
    assert.equal(launches[0]!.taskId, TASK_ID);
  });

  it("rejects an invalid task id with 400 and never launches", async () => {
    const { tasksDir } = await makeTask({});
    const { deps, launches } = fakeDeps();
    for (const id of ["", "not-a-task", "../../etc", "task-2026-07-10-001x"]) {
      const result = await startRerun({ tasksDir }, id, deps);
      assert.equal(result.ok, false, id);
      assert.equal(!result.ok && result.status, 400);
    }
    assert.equal(launches.length, 0);
  });

  it("rejects an unknown task with 404", async () => {
    const { tasksDir } = await makeTask({});
    const { deps, launches } = fakeDeps();
    const result = await startRerun({ tasksDir }, "task-2026-07-10-999", deps);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 404);
    assert.equal(launches.length, 0);
  });

  it("rejects a task with no changes_requested verdict with 400", async () => {
    const { tasksDir } = await makeTask({ verdicts: { analysis: "pass" } });
    const { deps, launches } = fakeDeps();
    const result = await startRerun({ tasksDir }, TASK_ID, deps);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /changes_requested/);
    assert.equal(!result.ok && result.status, 400);
    assert.equal(launches.length, 0);
  });

  it("ignores archived attempt-N verdicts (consumed send-backs)", async () => {
    const { tasksDir } = await makeTask({
      verdicts: { "analysis.attempt-1": "changes_requested", analysis: "pass" },
    });
    const { deps, launches } = fakeDeps();
    const result = await startRerun({ tasksDir }, TASK_ID, deps);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 400);
    assert.equal(launches.length, 0);
  });

  it("rejects a running task with 400 (mirrors rerunTask's double-run guard)", async () => {
    const { tasksDir } = await makeTask({
      state: "running",
      verdicts: { analysis: "changes_requested" },
    });
    const { deps, launches } = fakeDeps();
    const result = await startRerun({ tasksDir }, TASK_ID, deps);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 400);
    assert.match(!result.ok ? result.error : "", /running/);
    assert.equal(launches.length, 0);
  });
});
