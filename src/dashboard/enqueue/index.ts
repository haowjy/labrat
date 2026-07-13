import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { controlDir } from "../../control/index.js";
import { listClaudeScienceSkills } from "../../harness/claude-science/registry.js";
import { spawnDetachedCli } from "../detached-cli.js";

/**
 * Dashboard side of "Submit a sample" (route `POST /api/enqueue`). Mirrors
 * `dashboard/watcher`'s split: validation + launch here, the route maps the
 * `{ok,...}` result straight to the HTTP response.
 *
 * ARCHITECTURE NOTE: starting a run means spawning the EXISTING CLI
 * (`tsx src/cli/index.ts enqueue <input> <protocol> --no-dashboard`) as a
 * DETACHED child — the shared `dashboard/detached-cli` posture (crash
 * isolation, SSE progress, never imports the harness).
 *
 * The task id is allocated inside the child (`enqueueAndRun`), so this route
 * cannot return it synchronously — it answers 202 "started" and the panel
 * discovers the new id from the task list (see SubmitPanel.js).
 */

export type EnqueueRequest = {
  readonly input: string;
  readonly protocol: string;
};

export type EnqueueStarted = {
  readonly started: true;
  /** Absolute input path the run was launched with. */
  readonly input: string;
  readonly protocol: string;
  readonly pid: number | null;
  /** Where the detached child's stdout/stderr land (under control/). */
  readonly log: string;
};

export type StartManualRunResult =
  | { readonly ok: true; readonly value: EnqueueStarted }
  | { readonly ok: false; readonly status: 400; readonly error: string };

/** Injection seam for tests: protocol lookup + the detached spawn, so route
 * and unit tests never launch a real run or read the real registry. */
export type StartManualRunDeps = {
  /** Names of runnable protocols in the Claude Science registry. */
  readonly listProtocols: (scienceHome: string) => Promise<readonly string[]>;
  /** Fire the detached child; returns its pid (null if the runtime hides it). */
  readonly launch: (opts: {
    readonly runRoot: string;
    readonly inputAbs: string;
    readonly protocol: string;
    readonly logFile: string;
  }) => number | null;
};

const defaultDeps: StartManualRunDeps = {
  async listProtocols(scienceHome) {
    const skills = await listClaudeScienceSkills(scienceHome, { includeBuiltins: true });
    return skills.filter((s) => s.runnable).map((s) => s.name);
  },
  launch({ runRoot, inputAbs, protocol, logFile }) {
    return spawnDetachedCli({
      runRoot,
      args: ["enqueue", inputAbs, protocol, "--no-dashboard"],
      logFile,
    });
  },
};

/**
 * `POST /api/enqueue` write path: validate the body (shape, known protocol,
 * input path that exists and stays inside the project root), then launch the
 * detached CLI run. Validation failures are 400s with a plain message —
 * never a stack trace.
 */
export async function startManualRun(
  config: { readonly tasksDir: string; readonly scienceHome: string },
  body: unknown,
  deps: StartManualRunDeps = defaultDeps,
): Promise<StartManualRunResult> {
  const bad = (error: string): StartManualRunResult => ({ ok: false, status: 400, error });

  const { input, protocol } = (body ?? {}) as { input?: unknown; protocol?: unknown };
  if (typeof input !== "string" || input.trim() === "") {
    return bad("input: a non-empty path string is required");
  }
  if (typeof protocol !== "string" || protocol.trim() === "") {
    return bad("protocol: a non-empty protocol name is required");
  }

  const known = await deps.listProtocols(config.scienceHome);
  if (!known.includes(protocol.trim())) {
    return bad(
      `protocol "${protocol.trim()}" is not a runnable protocol in the Claude Science ` +
        `registry${known.length > 0 ? ` (known: ${known.join(", ")})` : ""}`,
    );
  }

  // The run root is the parent of the served task tree — the child's
  // <cwd>/tasks is exactly this dashboard's tasksDir. Relative inputs
  // resolve against it, and NO input may escape it (same containment
  // posture as resolveTaskFile guards on the task routes).
  const runRoot = path.dirname(path.resolve(config.tasksDir));
  const inputAbs = path.resolve(runRoot, input.trim());
  if (inputAbs !== runRoot && !inputAbs.startsWith(runRoot + path.sep)) {
    return bad(`input "${input.trim()}" resolves outside the project root ${runRoot}`);
  }
  try {
    await stat(inputAbs);
  } catch {
    return bad(`input path does not exist: ${inputAbs}`);
  }

  const control = controlDir(config.tasksDir);
  await mkdir(control, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const logFile = path.join(control, `enqueue-${stamp}.log`);

  const pid = deps.launch({ runRoot, inputAbs, protocol: protocol.trim(), logFile });
  return {
    ok: true,
    value: { started: true, input: inputAbs, protocol: protocol.trim(), pid, log: logFile },
  };
}
