import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { controlDir } from "../../control/index.js";
import {
  isValidTaskId,
  validateReviewVerdictRecord,
  validateTaskJson,
} from "../../schema/index.js";
import { taskDir } from "../api/index.js";
import { spawnDetachedCli } from "../detached-cli.js";

/**
 * Dashboard side of "Re-run this phase" (route `POST /api/tasks/:id/rerun`).
 * Closes the send-back loop in-dashboard: "Send back for revision"
 * (review/finish) writes the `changes_requested` mark, this launches the
 * EXISTING CLI rerun (`tsx src/cli/index.ts rerun <task-id> --no-dashboard`)
 * as a DETACHED child — same posture as `enqueue/startManualRun` (shared
 * `dashboard/detached-cli`): crash-isolated, never awaited, progress flows
 * back over the task tree + SSE.
 *
 * Validation here is a PRE-FLIGHT so the panel gets an immediate, plain
 * answer instead of a silent child failure in a control/ log:
 *   - the task must exist and not be `running` (mirrors `rerunTask`'s guard —
 *     a rerun would double-run against the same task tree);
 *   - some phase must carry a LIVE `changes_requested` verdict, the mark
 *     `rerunTask` re-enters from. Nothing marked → 400, don't launch.
 * The child owns the authoritative decision of WHICH phase re-runs
 * (`invalidateForSendBack`: explicit override > feedback-router proposal >
 * earliest mark); the `phase` returned here is the first mark found, for
 * display only.
 */

export type RerunStarted = {
  readonly started: true;
  readonly taskId: string;
  /** First phase found with a live changes_requested mark (display only —
   * the child's send-back routing decides authoritatively). */
  readonly phase: string;
  readonly pid: number | null;
  /** Where the detached child's stdout/stderr land (under control/). */
  readonly log: string;
};

export type StartRerunResult =
  | { readonly ok: true; readonly value: RerunStarted }
  | { readonly ok: false; readonly status: 400 | 404; readonly error: string };

/** Injection seam for tests: the detached spawn, so unit tests never launch
 * a real rerun. */
export type StartRerunDeps = {
  readonly launch: (opts: {
    readonly runRoot: string;
    readonly taskId: string;
    readonly logFile: string;
  }) => number | null;
};

const defaultDeps: StartRerunDeps = {
  launch({ runRoot, taskId, logFile }) {
    return spawnDetachedCli({
      runRoot,
      args: ["rerun", taskId, "--no-dashboard"],
      logFile,
    });
  },
};

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * The phases carrying a LIVE `changes_requested` human verdict, read straight
 * off `review/verdict/*.json` (name-sorted). Archived `{phase}.attempt-N.json`
 * verdicts are consumed send-backs and never count — same convention as the
 * harness's `readHumanVerdict` (which the dashboard must not import).
 */
async function findChangesRequestedPhases(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(path.join(dir, "review", "verdict"));
  } catch {
    return [];
  }
  const phases: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || name.includes(".attempt-")) continue;
    const raw = await readJson(path.join(dir, "review", "verdict", name));
    if (raw === null) continue;
    const record = validateReviewVerdictRecord(raw);
    if (record.ok && record.value.human_verdict === "changes_requested") {
      phases.push(name.slice(0, -".json".length));
    }
  }
  return phases;
}

/**
 * `POST /api/tasks/:id/rerun` write path: validate (known task, not running,
 * a pending send-back mark exists), then launch the detached CLI rerun.
 * Failures are plain-message 400/404s — never a stack trace.
 */
export async function startRerun(
  config: { readonly tasksDir: string },
  taskId: string,
  deps: StartRerunDeps = defaultDeps,
): Promise<StartRerunResult> {
  const bad = (status: 400 | 404, error: string): StartRerunResult => ({
    ok: false,
    status,
    error,
  });

  if (!isValidTaskId(taskId)) {
    return bad(400, `invalid task id "${taskId}"`);
  }

  const dir = taskDir(config.tasksDir, taskId);
  const taskRaw = await readJson(path.join(dir, "task.json"));
  if (taskRaw === null) {
    return bad(404, "task not found");
  }

  // Same guard rerunTask applies, surfaced synchronously: launching against a
  // running task would only fail in the child's log with no UI feedback.
  const task = validateTaskJson(taskRaw);
  if (task.ok && task.value.state === "running") {
    return bad(
      400,
      `task ${taskId} is currently running — a rerun would double-run against the same task tree; wait for it to finish`,
    );
  }

  const marked = await findChangesRequestedPhases(dir);
  if (marked.length === 0) {
    return bad(
      400,
      "no phase is marked changes_requested — send a phase back for revision first",
    );
  }

  const runRoot = path.dirname(path.resolve(config.tasksDir));
  const control = controlDir(config.tasksDir);
  await mkdir(control, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const logFile = path.join(control, `rerun-${taskId}-${stamp}.log`);

  const pid = deps.launch({ runRoot, taskId, logFile });
  return {
    ok: true,
    value: { started: true, taskId, phase: marked[0]!, pid, log: logFile },
  };
}
