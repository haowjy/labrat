import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, type LabratConfig } from "../../config/index.js";
import type { TaskJson } from "../../schema/index.js";
import { validateTaskJson } from "../../schema/index.js";
import { atomicWriteJson } from "../../util/atomic-write.js";
import { configureEvents, notifyEvent } from "../events/index.js";
import {
  loadProtocolByName,
  type LoadedProtocol,
} from "../protocol-loader/index.js";
import { ensureRuntime, pythonRuntime } from "../runtime-setup/index.js";
import { runWorkerPhase } from "../session/worker.js";
import { runGate } from "./gate.js";
import type { GateContext, RunGateResult } from "./gate.js";
import { downstreamPhaseIds } from "./invalidation.js";
import { findRecordedWorkerSessionId } from "./session-lookup.js";

export { runGate };
export type { GateContext, RunGateResult };
export {
  archiveAndResetPhase,
  downstreamPhaseIds,
  invalidateFromPhase,
} from "./invalidation.js";
export { findRecordedWorkerSessionId } from "./session-lookup.js";

export type OrchestratorConfig = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly inputRel: string;
  readonly protocol: LoadedProtocol;
  readonly config: LabratConfig;
};

export type PhaseRunResult = {
  readonly phase: string;
  readonly workerSessionId: string;
  readonly gate: RunGateResult;
};

export type RunTaskResult = {
  readonly task: TaskJson;
  readonly phases: readonly PhaseRunResult[];
};

async function existsAt(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readPhaseSummary(
  taskDir: string,
  phaseId: string,
): Promise<string | undefined> {
  const summaryPath = join(taskDir, "phases", phaseId, "summary.md");
  if (!(await existsAt(summaryPath))) {
    return undefined;
  }
  return readFile(summaryPath, "utf8");
}

async function writeTaskJson(taskDir: string, task: TaskJson): Promise<void> {
  const validated = validateTaskJson(task);
  if (!validated.ok) {
    throw new Error(
      `Invalid task.json: ${validated.errors.map((e) => e.message).join("; ")}`,
    );
  }
  await atomicWriteJson(join(taskDir, "task.json"), validated.value);
}

async function loadTaskJson(taskDir: string): Promise<TaskJson> {
  const raw = JSON.parse(
    await readFile(join(taskDir, "task.json"), "utf8"),
  ) as unknown;
  const validated = validateTaskJson(raw);
  if (!validated.ok) {
    throw new Error(
      `Invalid task.json on disk: ${validated.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return validated.value;
}

export async function allocateTaskId(
  tasksRoot: string,
  now = new Date(),
): Promise<string> {
  const date = now.toISOString().slice(0, 10);
  const prefix = `task-${date}-`;
  let max = 0;

  if (await existsAt(tasksRoot)) {
    const entries = await readdir(tasksRoot);
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const suffix = entry.slice(prefix.length);
      const n = Number.parseInt(suffix, 10);
      if (Number.isFinite(n) && n > max) {
        max = n;
      }
    }
  }

  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

export async function initTaskTree(
  tasksRoot: string,
  inputAbsPath: string,
  protocolName: string,
  firstPhaseId: string | null,
): Promise<{ taskId: string; taskDir: string; inputRel: string }> {
  await mkdir(tasksRoot, { recursive: true });
  const taskId = await allocateTaskId(tasksRoot);
  const taskDir = join(tasksRoot, taskId);
  const inputRel = await stageInput(inputAbsPath, taskDir);

  const now = new Date().toISOString();
  const task: TaskJson = {
    id: taskId,
    protocol: protocolName,
    input: inputRel,
    state: "running",
    currentPhase: firstPhaseId,
    phasesComplete: [],
    createdAt: now,
    updatedAt: now,
  };

  await mkdir(join(taskDir, "artifacts"), { recursive: true });
  await mkdir(join(taskDir, "phases"), { recursive: true });
  await mkdir(join(taskDir, "provenance"), { recursive: true });
  await mkdir(join(taskDir, "review", "gates"), { recursive: true });
  await writeTaskJson(taskDir, task);

  return { taskId, taskDir, inputRel };
}

async function stageInput(
  inputAbsPath: string,
  taskDir: string,
): Promise<string> {
  const { basename, extname } = await import("node:path");
  const { cp } = await import("node:fs/promises");
  const { runCommand } = await import("../runtime-setup/subprocess.js");

  const inputRoot = join(taskDir, "input");
  await mkdir(inputRoot, { recursive: true });

  if (extname(inputAbsPath).toLowerCase() === ".zip") {
    const folderName = basename(inputAbsPath, extname(inputAbsPath));
    const result = await runCommand("unzip", [
      "-q",
      "-o",
      inputAbsPath,
      "-d",
      inputRoot,
    ]);
    if (result.code !== 0) {
      throw new Error(
        `Failed to unzip ${inputAbsPath}: ${result.stderr || result.stdout}`,
      );
    }
    return `input/${folderName}`;
  }

  const folderName = basename(inputAbsPath);
  const dest = join(inputRoot, folderName);
  await cp(inputAbsPath, dest, { recursive: true });
  return `input/${folderName}`;
}

export async function runTask(
  orchestratorConfig: OrchestratorConfig,
): Promise<RunTaskResult> {
  const { config } = orchestratorConfig;
  process.env["MPLBACKEND"] = process.env["MPLBACKEND"] ?? "Agg";

  const runtimeResult = await ensureRuntime(orchestratorConfig.protocol.yaml, {
    skillRuntimeDeps: [],
    claudeScienceHome: config.scienceHome,
    microctSrcPath: config.microctSrc,
  });
  if (!runtimeResult.ok || !runtimeResult.handle) {
    throw new Error(
      `Runtime setup failed: ${runtimeResult.errors.join("; ")}`,
    );
  }

  const runtime = pythonRuntime();
  const phaseIds = orchestratorConfig.protocol.yaml.phases.map((p) => p.id);
  const phaseResults: PhaseRunResult[] = [];
  const priorSummaries: Record<string, string> = {};
  const attemptByPhase = new Map<string, number>();

  let pointer = 0;
  while (pointer < phaseIds.length) {
    const phaseId = phaseIds[pointer];
    if (!phaseId) break;
    const loadedPhaseDef = orchestratorConfig.protocol.yaml.phases.find(
      (p) => p.id === phaseId,
    );
    if (!loadedPhaseDef) {
      throw new Error(`Protocol missing phase definition: ${phaseId}`);
    }

    const attempt = (attemptByPhase.get(phaseId) ?? 0) + 1;
    attemptByPhase.set(phaseId, attempt);

    let task = await loadTaskJson(orchestratorConfig.taskDir);
    task = {
      ...task,
      state: "running",
      currentPhase: phaseId,
      updatedAt: new Date().toISOString(),
    };
    await writeTaskJson(orchestratorConfig.taskDir, task);
    notifyEvent({
      type: "phase-started",
      taskId: orchestratorConfig.taskId,
      phase: phaseId,
    });

    const startedAt = new Date().toISOString();
    const workerResult = await runWorkerPhase({
      taskId: orchestratorConfig.taskId,
      taskDir: orchestratorConfig.taskDir,
      inputRel: orchestratorConfig.inputRel,
      protocol: orchestratorConfig.protocol,
      phaseId,
      runtime,
      priorPhaseSummaries: priorSummaries,
      runSettings: config,
    });

    if (workerResult.blockedReason) {
      task = {
        ...task,
        state: "paused",
        reason: workerResult.blockedReason,
        updatedAt: new Date().toISOString(),
      };
      await writeTaskJson(orchestratorConfig.taskDir, task);
      notifyEvent({
        type: "task-paused",
        taskId: orchestratorConfig.taskId,
        reason: workerResult.blockedReason,
      });
      throw new Error(`Task paused: ${workerResult.blockedReason}`);
    }

    if (workerResult.stallExhausted || !workerResult.phaseComplete) {
      task = {
        ...task,
        state: "failed",
        reason: `Worker stalled on phase ${phaseId} after ${config.retries.workerStall} reminders without record_phase`,
        updatedAt: new Date().toISOString(),
      };
      await writeTaskJson(orchestratorConfig.taskDir, task);
      notifyEvent({
        type: "task-failed",
        taskId: orchestratorConfig.taskId,
        reason: task.reason ?? `Phase ${phaseId} did not complete`,
      });
      throw new Error(task.reason ?? `Phase ${phaseId} did not complete`);
    }

    const summary = await readPhaseSummary(orchestratorConfig.taskDir, phaseId);
    if (summary) {
      priorSummaries[phaseId] = summary;
    }

    const phasesComplete = task.phasesComplete.includes(phaseId)
      ? task.phasesComplete
      : [...task.phasesComplete, phaseId];
    task = {
      ...task,
      phasesComplete,
      currentPhase: null,
      updatedAt: new Date().toISOString(),
    };
    await writeTaskJson(orchestratorConfig.taskDir, task);
    notifyEvent({
      type: "phase-complete",
      taskId: orchestratorConfig.taskId,
      phase: phaseId,
    });

    const gate = await runGate({
      taskId: orchestratorConfig.taskId,
      taskDir: orchestratorConfig.taskDir,
      protocol: orchestratorConfig.protocol,
      phase: loadedPhaseDef,
      workerSessionId: workerResult.sessionId,
      runtime,
      attempt,
      startedAt,
      config,
    });

    phaseResults.push({
      phase: phaseId,
      workerSessionId: workerResult.sessionId,
      gate,
    });

    if (gate.kind !== "fail" && gate.kind !== "fail-upstream") {
      pointer += 1;
      continue;
    }

    if (gate.kind === "fail") {
      if (attempt >= config.retries.phaseAttempts) {
        task = {
          ...task,
          state: "failed",
          reason: `Gate failed twice on phase ${phaseId}: ${gate.feedback ?? "no feedback"}`,
          updatedAt: new Date().toISOString(),
        };
        await writeTaskJson(orchestratorConfig.taskDir, task);
        notifyEvent({
          type: "task-failed",
          taskId: orchestratorConfig.taskId,
          reason: task.reason ?? `Phase ${phaseId} gate failed twice`,
        });
        throw new Error(task.reason ?? `Phase ${phaseId} gate failed twice`);
      }
      // Retry: phases/{phase}/ + gate already archived by runGate; drop it
      // from phasesComplete and re-run the same pointer with a fresh agent.
      task = {
        ...task,
        phasesComplete: task.phasesComplete.filter((p) => p !== phaseId),
        updatedAt: new Date().toISOString(),
      };
      await writeTaskJson(orchestratorConfig.taskDir, task);
      continue;
    }

    // fail-upstream: rewind. Target + downstream already archived by runGate.
    const rewindIdx = phaseIds.indexOf(gate.rewindTo);
    if (rewindIdx === -1) {
      throw new Error(
        `Reviewer requested rewind to unknown phase: ${gate.rewindTo}`,
      );
    }
    for (const invalidated of phaseIds.slice(rewindIdx)) {
      delete priorSummaries[invalidated];
      attemptByPhase.delete(invalidated);
    }
    task = {
      ...task,
      phasesComplete: task.phasesComplete.filter(
        (p) => !phaseIds.slice(rewindIdx).includes(p),
      ),
      updatedAt: new Date().toISOString(),
    };
    await writeTaskJson(orchestratorConfig.taskDir, task);
    pointer = rewindIdx;
  }

  const finalTask = await loadTaskJson(orchestratorConfig.taskDir);
  const doneTask: TaskJson = {
    ...finalTask,
    state: "done",
    updatedAt: new Date().toISOString(),
  };
  await writeTaskJson(orchestratorConfig.taskDir, doneTask);
  notifyEvent({ type: "task-done", taskId: orchestratorConfig.taskId });

  return { task: doneTask, phases: phaseResults };
}

export async function enqueueAndRun(
  inputAbsPath: string,
  protocolName?: string,
  tasksRoot?: string,
): Promise<RunTaskResult & { taskId: string; taskDir: string }> {
  const { resolve } = await import("node:path");
  const root =
    tasksRoot ?? join(resolve(process.cwd(), "tasks"));

  const config = loadConfig();
  configureEvents(config.dashboard.url);
  const resolvedProtocolName = protocolName ?? config.defaultProtocol;
  if (!resolvedProtocolName) {
    throw new Error(
      "No protocol specified and no default configured. Pass a protocol name, " +
        "or set defaultProtocol in labrat.config.json / LABRAT_PROTOCOL.",
    );
  }

  const protocol = await loadProtocolByName(resolvedProtocolName, config.scienceHome);
  const { taskId, taskDir, inputRel } = await initTaskTree(
    root,
    inputAbsPath,
    resolvedProtocolName,
    protocol.yaml.phases[0]?.id ?? null,
  );
  notifyEvent({ type: "task-started", taskId, protocol: resolvedProtocolName });

  const result = await runTask({
    taskId,
    taskDir,
    inputRel,
    protocol,
    config,
  });

  return { ...result, taskId, taskDir };
}

async function nextGateAttempt(taskDir: string, phaseId: string): Promise<number> {
  const gatesRoot = join(taskDir, "review", "gates");
  let entries: string[];
  try {
    entries = await readdir(gatesRoot);
  } catch {
    return 1;
  }
  const re = new RegExp(`^${phaseId}\\.attempt-(\\d+)\\.json$`);
  let max = 0;
  for (const entry of entries) {
    const m = re.exec(entry);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

/**
 * Standalone gate entry point: `npm run dev -- gate <task-id> <phase>`.
 * Runs runGate against an ALREADY-RECORDED phase in an existing task dir —
 * does not re-run the worker. Reconstructs the worker session id from the
 * SDK's own on-disk conversation history (session-lookup.ts) since the
 * standalone path has no in-memory WorkerSessionResult to read it from.
 */
export async function runStandaloneGate(
  taskId: string,
  phaseId: string,
  tasksRoot?: string,
): Promise<RunGateResult> {
  const { resolve } = await import("node:path");
  const root = tasksRoot ?? join(resolve(process.cwd(), "tasks"));
  const taskDir = join(root, taskId);

  const config = loadConfig();
  configureEvents(config.dashboard.url);

  const task = await loadTaskJson(taskDir);
  if (!task.phasesComplete.includes(phaseId)) {
    throw new Error(
      `Phase "${phaseId}" is not recorded complete for ${taskId} (phasesComplete: ${task.phasesComplete.join(", ") || "none"}). Run the phase first.`,
    );
  }

  const protocol = await loadProtocolByName(task.protocol, config.scienceHome);
  const phase = protocol.yaml.phases.find((p) => p.id === phaseId);
  if (!phase) {
    throw new Error(`Protocol "${task.protocol}" has no phase "${phaseId}"`);
  }

  process.env["MPLBACKEND"] = process.env["MPLBACKEND"] ?? "Agg";

  const runtimeResult = await ensureRuntime(protocol.yaml, {
    skillRuntimeDeps: [],
    claudeScienceHome: config.scienceHome,
    microctSrcPath: config.microctSrc,
  });
  if (!runtimeResult.ok || !runtimeResult.handle) {
    throw new Error(`Runtime setup failed: ${runtimeResult.errors.join("; ")}`);
  }
  const runtime = pythonRuntime();

  const workerSessionId = await findRecordedWorkerSessionId(taskDir, taskId, phaseId);
  if (!workerSessionId) {
    throw new Error(
      `Could not find a recorded worker session for phase "${phaseId}" of ${taskId} under ~/.claude/projects/. ` +
        `Pass it explicitly if the SDK conversation history has been pruned.`,
    );
  }

  const attempt = await nextGateAttempt(taskDir, phaseId);

  const gate = await runGate({
    taskId,
    taskDir,
    protocol,
    phase,
    workerSessionId,
    runtime,
    attempt,
    config,
  });

  // PASS/pass-with-concerns: task.json already reflects this phase as
  // complete from whatever ran it. FAIL paths: runGate's invalidation
  // already archived phases + reset outputs on disk — bring task.json's
  // phasesComplete/currentPhase back in sync with that so disk stays
  // consistent (the normal runTask loop does this bookkeeping itself, but
  // the standalone `gate` CLI backfills a phase outside that loop).
  if (gate.kind === "fail") {
    const refreshed = await loadTaskJson(taskDir);
    await writeTaskJson(taskDir, {
      ...refreshed,
      phasesComplete: refreshed.phasesComplete.filter((p) => p !== phaseId),
      currentPhase: phaseId,
      updatedAt: new Date().toISOString(),
    });
  } else if (gate.kind === "fail-upstream") {
    const invalidatedIds = downstreamPhaseIds(protocol.yaml, gate.rewindTo);
    const refreshed = await loadTaskJson(taskDir);
    await writeTaskJson(taskDir, {
      ...refreshed,
      phasesComplete: refreshed.phasesComplete.filter(
        (p) => !invalidatedIds.includes(p),
      ),
      currentPhase: gate.rewindTo,
      updatedAt: new Date().toISOString(),
    });
  }

  return gate;
}
