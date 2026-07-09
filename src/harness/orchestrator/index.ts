import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProtocolPhase, ProtocolYaml, TaskJson } from "../../schema/index.js";
import { validateTaskJson } from "../../schema/index.js";
import { atomicWriteJson } from "../util/atomic-write.js";
import {
  loadProtocolByName,
  type LoadedProtocol,
} from "../protocol-loader/index.js";
import { ensureRuntime, pythonRuntime } from "../runtime-setup/index.js";
import { runWorkerPhase } from "../session/worker.js";

const WORKER_SPINE_PHASES = ["intake", "segmentation"] as const;

export type OrchestratorConfig = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly inputRel: string;
  readonly protocol: LoadedProtocol;
};

export type GateContext = {
  readonly taskId: string;
  readonly taskDir: string;
  readonly protocol: ProtocolYaml;
  readonly phase: ProtocolPhase;
  readonly workerSessionId: string;
};

export type RunGateResult = {
  readonly kind: "deferred";
  readonly phase: string;
};

/** Seam for the gate-reviewer lane — worker spine does not run the reviewer yet. */
export async function runGate(ctx: GateContext): Promise<RunGateResult> {
  return { kind: "deferred", phase: ctx.phase.id };
}

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
    currentPhase: WORKER_SPINE_PHASES[0] ?? null,
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

export async function runTask(config: OrchestratorConfig): Promise<RunTaskResult> {
  const runtimeResult = await ensureRuntime(config.protocol.yaml, {
    skillRuntimeDeps: [],
  });
  if (!runtimeResult.ok || !runtimeResult.handle) {
    throw new Error(
      `Runtime setup failed: ${runtimeResult.errors.join("; ")}`,
    );
  }

  const runtime = pythonRuntime();
  const phaseResults: PhaseRunResult[] = [];
  const priorSummaries: Record<string, string> = {};

  for (const phaseId of WORKER_SPINE_PHASES) {
    const loadedPhase = config.protocol.yaml.phases.find((p) => p.id === phaseId);
    if (!loadedPhase) {
      throw new Error(`Protocol missing worker-spine phase: ${phaseId}`);
    }

    let task = await loadTaskJson(config.taskDir);
    task = {
      ...task,
      state: "running",
      currentPhase: phaseId,
      updatedAt: new Date().toISOString(),
    };
    await writeTaskJson(config.taskDir, task);

    const workerResult = await runWorkerPhase({
      taskId: config.taskId,
      taskDir: config.taskDir,
      inputRel: config.inputRel,
      protocol: config.protocol,
      phaseId,
      runtime,
      priorPhaseSummaries: priorSummaries,
    });

    if (workerResult.blockedReason) {
      task = {
        ...task,
        state: "paused",
        reason: workerResult.blockedReason,
        updatedAt: new Date().toISOString(),
      };
      await writeTaskJson(config.taskDir, task);
      throw new Error(`Task paused: ${workerResult.blockedReason}`);
    }

    if (workerResult.stallExhausted || !workerResult.phaseComplete) {
      task = {
        ...task,
        state: "failed",
        reason: `Worker stalled on phase ${phaseId} after ${3} reminders without record_phase`,
        updatedAt: new Date().toISOString(),
      };
      await writeTaskJson(config.taskDir, task);
      throw new Error(task.reason ?? `Phase ${phaseId} did not complete`);
    }

    const summary = await readPhaseSummary(config.taskDir, phaseId);
    if (summary) {
      priorSummaries[phaseId] = summary;
    }

    const phasesComplete = [...task.phasesComplete, phaseId];
    task = {
      ...task,
      phasesComplete,
      currentPhase: null,
      updatedAt: new Date().toISOString(),
    };
    await writeTaskJson(config.taskDir, task);

    const gate = await runGate({
      taskId: config.taskId,
      taskDir: config.taskDir,
      protocol: config.protocol.yaml,
      phase: loadedPhase,
      workerSessionId: workerResult.sessionId,
    });

    phaseResults.push({
      phase: phaseId,
      workerSessionId: workerResult.sessionId,
      gate,
    });
  }

  const finalTask = await loadTaskJson(config.taskDir);
  const doneTask: TaskJson = {
    ...finalTask,
    state: "running",
    currentPhase: "seed-review",
    updatedAt: new Date().toISOString(),
  };
  await writeTaskJson(config.taskDir, doneTask);

  return { task: doneTask, phases: phaseResults };
}

export async function enqueueAndRun(
  inputAbsPath: string,
  protocolName = "bonemorph-oa-mouse-knee",
  tasksRoot?: string,
): Promise<RunTaskResult & { taskId: string; taskDir: string }> {
  const { resolve } = await import("node:path");
  const root =
    tasksRoot ?? join(resolve(process.cwd(), "tasks"));

  const protocol = await loadProtocolByName(protocolName);
  const { taskId, taskDir, inputRel } = await initTaskTree(
    root,
    inputAbsPath,
    protocolName,
  );

  const result = await runTask({
    taskId,
    taskDir,
    inputRel,
    protocol,
  });

  return { ...result, taskId, taskDir };
}
