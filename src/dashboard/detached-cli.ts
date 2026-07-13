import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The ONE way dashboard write-routes start harness work: spawn the EXISTING
 * CLI (`tsx src/cli/index.ts …`) as a DETACHED child. Shared by
 * `enqueue/startManualRun` and `rerun/startRerun` so both actions carry the
 * same posture:
 *   - the Express event loop never awaits the run (a run takes minutes to
 *     hours), and a crashing run can never take the dashboard down with it;
 *   - the child is the same tested code path a terminal `labrat <cmd>` uses —
 *     callers pass `--no-dashboard` because this dashboard already holds the
 *     port;
 *   - progress flows back the normal way: the child writes the task tree and
 *     POSTs /internal/events, so the UI's SSE refresh needs zero extra
 *     plumbing.
 *
 * ARCHITECTURE NOTE: Process B stays read-only over the task tree — this
 * module never imports the harness/orchestrator.
 */

/** Repo root, resolved from this module's own location (src/dashboard/ → two
 * levels up) so the CLI entry and the tsx binary are found no matter what cwd
 * the dashboard was started from. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Fire the detached child; returns its pid (null if the runtime hides it).
 * `cwd` is the project root the dashboard serves (so the child's <cwd>/tasks
 * IS this dashboard's tasksDir). detached + unref → the run outlives (and
 * never blocks) the Express process; output goes to a log file because a
 * detached child must not share our stdio.
 */
export function spawnDetachedCli(opts: {
  readonly runRoot: string;
  readonly args: readonly string[];
  readonly logFile: string;
}): number | null {
  const out = openSync(opts.logFile, "a");
  const child = spawn(
    path.join(REPO_ROOT, "node_modules", ".bin", "tsx"),
    [path.join(REPO_ROOT, "src", "cli", "index.ts"), ...opts.args],
    { cwd: opts.runRoot, detached: true, stdio: ["ignore", out, out] },
  );
  child.unref();
  return child.pid ?? null;
}
