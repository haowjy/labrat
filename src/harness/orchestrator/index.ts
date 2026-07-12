import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, type LabratConfig } from "../../config/index.js";
import type { ProtocolYaml, TaskJson } from "../../schema/index.js";
import { validateTaskJson } from "../../schema/index.js";
import { atomicWriteJson } from "../../util/atomic-write.js";
import { resolveDeclaredArtifactPath } from "../../util/artifact-path.js";
import { configureEvents, notifyEvent } from "../events/index.js";
import {
  loadProtocolByName,
  type LoadedProtocol,
} from "../protocol-loader/index.js";
import { readHumanVerdict } from "../review-verdict/index.js";
import { ensureRuntime, pythonRuntime } from "../runtime-setup/index.js";
import { runWorkerPhase } from "../session/worker.js";
import {
  appendPublishedArtifactProvenance,
  artifactSettlementPending,
  REVIEW_ARTIFACT_AUTHOR_PAUSE_REASON,
  scientificGateAccepted,
  settleReviewArtifact,
} from "./artifact-settlement.js";
import { runGate } from "./gate.js";
import type { GateContext, RunGateResult } from "./gate.js";
import { downstreamPhaseIds, invalidateFromPhase } from "./invalidation.js";
import { findRecordedWorkerSessionId } from "./session-lookup.js";

export { runGate };
export type { GateContext, RunGateResult };
export {
  archiveAndResetPhase,
  consumeSendBackVerdict,
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

/**
 * Rebuild the in-memory `priorPhaseSummaries` map from `phases/<id>/summary.md`
 * on disk (the one disk-contract exception — see AGENTS.md). Used by both
 * task-level resume and single-phase isolation so a phase run outside the
 * normal `runTask` loop still sees the same upstream context the live loop
 * would have passed in memory.
 */
export async function reconstructPriorSummaries(
  taskDir: string,
  protocolYaml: ProtocolYaml,
  phaseId: string,
): Promise<Record<string, string>> {
  const phaseIds = protocolYaml.phases.map((p) => p.id);
  const idx = phaseIds.indexOf(phaseId);
  const upstream = idx === -1 ? phaseIds : phaseIds.slice(0, idx);

  const summaries: Record<string, string> = {};
  for (const id of upstream) {
    const summary = await readPhaseSummary(taskDir, id);
    if (summary) {
      summaries[id] = summary;
    }
  }
  return summaries;
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

/**
 * Mark one phase SETTLED (review-provenance §3.D): scientific gate accepted
 * AND its review artifact published (or `none`/legacy). `phasesComplete` is
 * the list of settled phases — updated ONLY here, AFTER runGate returns a
 * settled success, never before the gate (the old pre-gate write meant
 * "worker recorded", and its rollback filters are gone with it).
 */
async function markPhaseSettled(
  taskDir: string,
  taskId: string,
  phaseId: string,
): Promise<TaskJson> {
  const loaded = await loadTaskJson(taskDir);
  // Drop any stale pause reason (e.g. a resumed review-artifact-author-failed
  // pause whose artifact just settled) and put the task back to running.
  const { reason: _droppedReason, ...rest } = loaded;
  const task: TaskJson = {
    ...rest,
    state: "running",
    phasesComplete: loaded.phasesComplete.includes(phaseId)
      ? loaded.phasesComplete
      : [...loaded.phasesComplete, phaseId],
    currentPhase: null,
    updatedAt: new Date().toISOString(),
  };
  await writeTaskJson(taskDir, task);
  await notifyEvent(taskDir, { type: "phase-complete", taskId, phase: phaseId });
  return task;
}

/**
 * Clean PAUSE for an exhausted review-artifact author (review-provenance
 * correction #3): the phase's SCIENCE stays accepted on disk (gate file +
 * provenance entry untouched), nothing is archived or reset, and a later
 * `resume` re-enters ONLY the authoring step for this phase.
 */
async function pauseForArtifactFailure(
  taskDir: string,
  taskId: string,
): Promise<TaskJson> {
  let task = await loadTaskJson(taskDir);
  task = {
    ...task,
    state: "paused",
    reason: REVIEW_ARTIFACT_AUTHOR_PAUSE_REASON,
    updatedAt: new Date().toISOString(),
  };
  await writeTaskJson(taskDir, task);
  await notifyEvent(taskDir, {
    type: "task-paused",
    taskId,
    reason: REVIEW_ARTIFACT_AUTHOR_PAUSE_REASON,
  });
  return task;
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
    skillDir: orchestratorConfig.protocol.skillDir,
  });
  if (!runtimeResult.ok || !runtimeResult.handle) {
    throw new Error(
      `Runtime setup failed: ${runtimeResult.errors.join("; ")}`,
    );
  }

  const runtime = pythonRuntime();
  const phaseIds = orchestratorConfig.protocol.yaml.phases.map((p) => p.id);
  const phaseResults: PhaseRunResult[] = [];
  const attemptByPhase = new Map<string, number>();

  // Resume-aware: start at the first phase NOT already in `phasesComplete`
  // instead of always phase 0. A fresh `enqueue` task has `phasesComplete:
  // []`, so `pointer` still starts at 0 for it — this is a strict superset
  // of the old behavior, not a branch on top of it.
  const startTask = await loadTaskJson(orchestratorConfig.taskDir);
  let pointer = phaseIds.findIndex((id) => !startTask.phasesComplete.includes(id));
  if (pointer === -1) {
    pointer = phaseIds.length;
  }
  const priorSummaries: Record<string, string> =
    pointer > 0
      ? await reconstructPriorSummaries(
          orchestratorConfig.taskDir,
          orchestratorConfig.protocol.yaml,
          phaseIds[pointer] ?? "",
        )
      : {};

  while (pointer < phaseIds.length) {
    const phaseId = phaseIds[pointer];
    if (!phaseId) break;
    const loadedPhaseDef = orchestratorConfig.protocol.yaml.phases.find(
      (p) => p.id === phaseId,
    );
    if (!loadedPhaseDef) {
      throw new Error(`Protocol missing phase definition: ${phaseId}`);
    }

    // Resume-into-authoring (review-provenance §3.D): a phase whose SCIENCE is
    // already accepted on disk (passing gate file + provenance entry) but that
    // never settled — a crash between gate acceptance and settlement, or a
    // pause for `review-artifact-author-failed` — NEVER re-runs its worker.
    // Only the artifact half of settlement remains.
    if (await scientificGateAccepted(orchestratorConfig.taskDir, phaseId)) {
      if (await artifactSettlementPending(orchestratorConfig.taskDir, loadedPhaseDef)) {
        const settle = await settleReviewArtifact({
          taskId: orchestratorConfig.taskId,
          taskDir: orchestratorConfig.taskDir,
          protocol: orchestratorConfig.protocol,
          phase: loadedPhaseDef,
          attempt: attemptByPhase.get(phaseId) ?? 1,
          runtime,
          config,
        });
        if (settle.kind === "artifact-failed") {
          const paused = await pauseForArtifactFailure(
            orchestratorConfig.taskDir,
            orchestratorConfig.taskId,
          );
          return { task: paused, phases: phaseResults };
        }
        if (settle.kind === "published") {
          await appendPublishedArtifactProvenance(
            orchestratorConfig.taskDir,
            phaseId,
            settle,
          );
        }
      }
      const summary = await readPhaseSummary(orchestratorConfig.taskDir, phaseId);
      if (summary) {
        priorSummaries[phaseId] = summary;
      }
      await markPhaseSettled(
        orchestratorConfig.taskDir,
        orchestratorConfig.taskId,
        phaseId,
      );
      pointer += 1;
      continue;
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
    await notifyEvent(orchestratorConfig.taskDir, {
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
      attempt,
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
      await notifyEvent(orchestratorConfig.taskDir, {
        type: "task-paused",
        taskId: orchestratorConfig.taskId,
        reason: workerResult.blockedReason,
      });
      throw new Error(`Task paused: ${workerResult.blockedReason}`);
    }

    if (workerResult.stallExhausted || !workerResult.phaseComplete) {
      const failReason =
        workerResult.stallExhaustedReason === "background-grace"
          ? `Worker background work on phase ${phaseId} exceeded ${config.retries.backgroundGraceRetries} grace continuations without record_phase`
          : `Worker stalled on phase ${phaseId} after ${config.retries.workerStall} reminders without record_phase`;
      task = {
        ...task,
        state: "failed",
        reason: failReason,
        updatedAt: new Date().toISOString(),
      };
      await writeTaskJson(orchestratorConfig.taskDir, task);
      await notifyEvent(orchestratorConfig.taskDir, {
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

    if (gate.kind === "artifact-failed") {
      // Science accepted; only the review artifact is missing. Pause cleanly —
      // NEVER archive/reset the verified worker outputs — and let a later
      // `resume` re-enter the authoring step only.
      const paused = await pauseForArtifactFailure(
        orchestratorConfig.taskDir,
        orchestratorConfig.taskId,
      );
      return { task: paused, phases: phaseResults };
    }

    if (gate.kind !== "fail" && gate.kind !== "fail-upstream") {
      // Fully settled: scientific gate accepted AND the review artifact
      // published (or none/legacy). Only now does the phase join
      // phasesComplete (review-provenance §3.D settlement state).
      await markPhaseSettled(
        orchestratorConfig.taskDir,
        orchestratorConfig.taskId,
        phaseId,
      );
      pointer += 1;
      continue;
    }

    if (gate.kind === "fail") {
      // runGate already archived phases/{phase}/ + reset its outputs on disk
      // (gate.ts fail path). phasesComplete never contained this phase — it
      // is written only at settlement now — so there is nothing to roll back.
      if (attempt >= config.retries.phaseAttempts) {
        task = {
          ...task,
          state: "failed",
          reason: `Gate failed twice on phase ${phaseId}: ${gate.feedback ?? "no feedback"}`,
          updatedAt: new Date().toISOString(),
        };
        await writeTaskJson(orchestratorConfig.taskDir, task);
        await notifyEvent(orchestratorConfig.taskDir, {
          type: "task-failed",
          taskId: orchestratorConfig.taskId,
          reason: task.reason ?? `Phase ${phaseId} gate failed twice`,
        });
        throw new Error(task.reason ?? `Phase ${phaseId} gate failed twice`);
      }
      // Retry: re-run the same pointer with a fresh agent. Drop this phase's
      // own summary so the retried worker doesn't inherit its failed
      // attempt's summary (F6).
      delete priorSummaries[phaseId];
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
    // Rewind can invalidate phases that HAD settled (earlier passes between
    // rewindTo and here) — drop them from the settled list to match the disk
    // invalidation runGate already performed.
    task = await loadTaskJson(orchestratorConfig.taskDir);
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
  await notifyEvent(orchestratorConfig.taskDir, { type: "task-done", taskId: orchestratorConfig.taskId });

  return { task: doneTask, phases: phaseResults };
}

export async function enqueueAndRun(
  inputAbsPath: string,
  protocolName?: string,
  tasksRoot?: string,
  config: LabratConfig = loadConfig(),
): Promise<RunTaskResult & { taskId: string; taskDir: string }> {
  const { resolve } = await import("node:path");
  const root =
    tasksRoot ?? join(resolve(process.cwd(), "tasks"));

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
  await notifyEvent(taskDir, { type: "task-started", taskId, protocol: resolvedProtocolName });

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
  // Gate an ALREADY-RECORDED phase: the worker must have run (its phase dir
  // is on disk). phasesComplete no longer implies this — it now means SETTLED
  // (gate + artifact), which is what this command produces, not requires.
  const phaseRecorded =
    (await existsAt(join(taskDir, "phases", phaseId, "summary.md"))) ||
    (await existsAt(join(taskDir, "phases", phaseId)));
  if (!phaseRecorded && !task.phasesComplete.includes(phaseId)) {
    throw new Error(
      `Phase "${phaseId}" has not been recorded for ${taskId} (no phases/${phaseId}/ on disk). Run the phase first.`,
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
    skillDir: protocol.skillDir,
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
  await syncTaskAfterStandaloneGate(taskDir, protocol.yaml, phaseId, gate);

  return gate;
}

/**
 * Bring task.json back in sync with the disk-side outcome `runGate` already
 * performed, for gate runs that happen outside the `runTask` loop (standalone
 * `gate` and isolated `run-phase --gate`): settle the phase on a pass, pause
 * on an artifact failure, and mirror the invalidation on fail paths.
 */
async function syncTaskAfterStandaloneGate(
  taskDir: string,
  protocolYaml: ProtocolYaml,
  phaseId: string,
  gate: RunGateResult,
): Promise<void> {
  if (gate.kind === "pass" || gate.kind === "pass-with-concerns") {
    const refreshed = await loadTaskJson(taskDir);
    await writeTaskJson(taskDir, {
      ...refreshed,
      phasesComplete: refreshed.phasesComplete.includes(phaseId)
        ? refreshed.phasesComplete
        : [...refreshed.phasesComplete, phaseId],
      updatedAt: new Date().toISOString(),
    });
  } else if (gate.kind === "artifact-failed") {
    const refreshed = await loadTaskJson(taskDir);
    await writeTaskJson(taskDir, {
      ...refreshed,
      state: "paused",
      reason: REVIEW_ARTIFACT_AUTHOR_PAUSE_REASON,
      updatedAt: new Date().toISOString(),
    });
  } else if (gate.kind === "fail") {
    const refreshed = await loadTaskJson(taskDir);
    await writeTaskJson(taskDir, {
      ...refreshed,
      phasesComplete: refreshed.phasesComplete.filter((p) => p !== phaseId),
      currentPhase: phaseId,
      updatedAt: new Date().toISOString(),
    });
  } else if (gate.kind === "fail-upstream") {
    const invalidatedIds = downstreamPhaseIds(protocolYaml, gate.rewindTo);
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
}

export type RunPhaseIsolatedResult = {
  readonly task: TaskJson;
  readonly workerSessionId: string;
  readonly phaseComplete: boolean;
  readonly gate?: RunGateResult;
};

/**
 * Fail fast (F7) if a phase's declared inputs are not on disk — run-phase runs
 * ONE phase against the already-materialized upstream artifacts, so a missing
 * input means an upstream phase never ran (or was reset). Resolves each
 * declared input the same way provenance/invalidation do: `input/` is
 * task-root-relative, everything else lives under `artifacts/`.
 */
async function assertUpstreamReady(
  taskDir: string,
  phaseIds: readonly string[],
  phaseDef: { readonly inputs?: readonly string[] },
  phaseId: string,
): Promise<void> {
  const missing: string[] = [];
  for (const declared of phaseDef.inputs ?? []) {
    const { absPath, manifestPath } = resolveDeclaredArtifactPath(taskDir, declared);
    if (!(await existsAt(absPath))) {
      missing.push(manifestPath);
    }
  }
  if (missing.length === 0) return;

  const idx = phaseIds.indexOf(phaseId);
  const upstream = idx > 0 ? phaseIds.slice(0, idx).join(", ") : "(none)";
  throw new Error(
    `Cannot run phase "${phaseId}" in isolation: declared inputs missing on disk: ` +
      `${missing.join(", ")}. Run its upstream phase(s) first [${upstream}] before run-phase.`,
  );
}

/**
 * `run-phase <task-id> <phase> [--gate]`: run ONE phase's worker via
 * `runWorkerPhase` against whatever upstream artifacts are already on disk
 * for `taskId` — no other phase is touched. `priorPhaseSummaries` is
 * rebuilt from `phases/<id>/summary.md` (the disk-contract exception), not
 * carried over from any prior in-memory run. Optionally also runs that
 * phase's gate afterward (`withGate`), reusing the same standalone-gate
 * bookkeeping as the `gate` CLI.
 */
export async function runPhaseInIsolation(
  taskId: string,
  phaseId: string,
  withGate: boolean,
  tasksRoot?: string,
): Promise<RunPhaseIsolatedResult> {
  const { resolve } = await import("node:path");
  const root = tasksRoot ?? join(resolve(process.cwd(), "tasks"));
  const taskDir = join(root, taskId);

  const config = loadConfig();
  configureEvents(config.dashboard.url);

  let task = await loadTaskJson(taskDir);
  const protocol = await loadProtocolByName(task.protocol, config.scienceHome);
  const phaseIds = protocol.yaml.phases.map((p) => p.id);
  const phaseDef = protocol.yaml.phases.find((p) => p.id === phaseId);
  if (!phaseDef) {
    throw new Error(`Protocol "${task.protocol}" has no phase "${phaseId}"`);
  }

  // F7: run-phase runs ONE phase against whatever is already on disk — fail
  // fast (before spinning up a runtime + worker) if its upstream context is
  // missing, mirroring runStandaloneGate's "run the phase first" guard.
  await assertUpstreamReady(taskDir, phaseIds, phaseDef, phaseId);

  process.env["MPLBACKEND"] = process.env["MPLBACKEND"] ?? "Agg";

  const runtimeResult = await ensureRuntime(protocol.yaml, {
    skillRuntimeDeps: [],
    claudeScienceHome: config.scienceHome,
    microctSrcPath: config.microctSrc,
    skillDir: protocol.skillDir,
  });
  if (!runtimeResult.ok || !runtimeResult.handle) {
    throw new Error(`Runtime setup failed: ${runtimeResult.errors.join("; ")}`);
  }
  const runtime = pythonRuntime();

  const priorSummaries = await reconstructPriorSummaries(taskDir, protocol.yaml, phaseId);

  task = {
    ...task,
    state: "running",
    currentPhase: phaseId,
    updatedAt: new Date().toISOString(),
  };
  await writeTaskJson(taskDir, task);
  await notifyEvent(taskDir, { type: "phase-started", taskId, phase: phaseId });

  const startedAt = new Date().toISOString();
  // Same attempt-numbering source the standalone gate below uses, computed
  // BEFORE the worker runs so its session log carries the right attempt.
  const attempt = await nextGateAttempt(taskDir, phaseId);
  const workerResult = await runWorkerPhase({
    taskId,
    taskDir,
    inputRel: task.input,
    protocol,
    phaseId,
    attempt,
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
    await writeTaskJson(taskDir, task);
    await notifyEvent(taskDir, { type: "task-paused", taskId, reason: workerResult.blockedReason });
    return { task, workerSessionId: workerResult.sessionId, phaseComplete: false };
  }

  if (workerResult.stallExhausted || !workerResult.phaseComplete) {
    const failReason =
      workerResult.stallExhaustedReason === "background-grace"
        ? `Worker background work on phase ${phaseId} exceeded ${config.retries.backgroundGraceRetries} grace continuations without record_phase`
        : `Worker stalled on phase ${phaseId} after ${config.retries.workerStall} reminders without record_phase`;
    task = {
      ...task,
      state: "failed",
      reason: failReason,
      updatedAt: new Date().toISOString(),
    };
    await writeTaskJson(taskDir, task);
    await notifyEvent(taskDir, { type: "task-failed", taskId, reason: task.reason ?? `Phase ${phaseId} did not complete` });
    return { task, workerSessionId: workerResult.sessionId, phaseComplete: false };
  }

  // Worker recorded ≠ settled: phasesComplete now means SETTLED (gate +
  // artifact — review-provenance §3.D), so the isolated run-phase no longer
  // adds this phase; syncTaskAfterStandaloneGate does after a passing gate.
  // NEVER promote to "done" here: the isolated run-phase tool has no authority
  // to declare the task terminal — that requires the gated runTask/resume path
  // (gate + monitor + provenance for every phase). Leave state "running";
  // syncTaskAfterStandaloneGate owns any post-gate state change below (F3).
  task = {
    ...task,
    currentPhase: null,
    state: "running",
    updatedAt: new Date().toISOString(),
  };
  await writeTaskJson(taskDir, task);
  await notifyEvent(taskDir, { type: "phase-complete", taskId, phase: phaseId });

  if (!withGate) {
    return { task, workerSessionId: workerResult.sessionId, phaseComplete: true };
  }

  const gate = await runGate({
    taskId,
    taskDir,
    protocol,
    phase: phaseDef,
    workerSessionId: workerResult.sessionId,
    runtime,
    attempt,
    startedAt,
    config,
  });

  await syncTaskAfterStandaloneGate(taskDir, protocol.yaml, phaseId, gate);
  task = await loadTaskJson(taskDir);

  return { task, workerSessionId: workerResult.sessionId, phaseComplete: true, gate };
}

/**
 * `resume <task-id>`: re-enter `runTask` for a task already on disk,
 * picking up at the first phase not in `phasesComplete` (runTask itself is
 * resume-aware — this just reloads the protocol/config needed to build an
 * `OrchestratorConfig` for a task that wasn't just enqueued in-process).
 */
export async function resumeTask(
  taskId: string,
  tasksRoot?: string,
  config: LabratConfig = loadConfig(),
): Promise<RunTaskResult> {
  const { resolve } = await import("node:path");
  const root = tasksRoot ?? join(resolve(process.cwd(), "tasks"));
  const taskDir = join(root, taskId);

  configureEvents(config.dashboard.url);

  const task = await loadTaskJson(taskDir);
  const protocol = await loadProtocolByName(task.protocol, config.scienceHome);

  return runTask({
    taskId,
    taskDir,
    inputRel: task.input,
    protocol,
    config,
  });
}

/**
 * `reset-to <task-id> <phase>`: truncate `phasesComplete` to the phases
 * strictly before `<phase>`, point `currentPhase`/`state` at `<phase>`, and
 * invalidate `<phase>` and everything downstream of it — so a subsequent
 * `run-phase`/`resume` starts clean there. Only ever touches phases at or
 * after `<phase>`; never `<phase>`'s upstream inputs.
 *
 * F1: invalidation goes through `invalidateFromPhase` (the same
 * archive-phase + reset-DECLARED-OUTPUTS mechanism rewind/retry use), NOT a
 * blind `rm artifacts/<phaseId>`. The real protocol scatters a phase's outputs
 * across `artifacts/` (`spacing.json`, `labels.nii.gz`, `masks/`, …) under
 * names that are NOT the phase id, so id-namespaced deletion left stale
 * central artifacts behind for a downstream phase to read — cross-run
 * contamination. Resolving each phase's *declared* outputs is the only correct
 * way to clear them.
 */
export async function resetTaskToPhase(
  taskId: string,
  phaseId: string,
  tasksRoot?: string,
): Promise<TaskJson> {
  const { resolve } = await import("node:path");
  const root = tasksRoot ?? join(resolve(process.cwd(), "tasks"));
  const taskDir = join(root, taskId);

  const config = loadConfig();
  const task = await loadTaskJson(taskDir);
  const protocol = await loadProtocolByName(task.protocol, config.scienceHome);
  return resetTaskToPhaseWithProtocol(taskDir, protocol.yaml, phaseId);
}

/**
 * Protocol-injected core of `resetTaskToPhase`: given the protocol already
 * loaded, invalidate `<phase>` + everything downstream and re-point
 * task.json at it. Split out so callers that already hold the protocol (and
 * tests that build one inline) don't re-run the loader — and so the
 * human-send-back path can reuse the exact same invalidation the CLI
 * `reset-to`/`rerun` use rather than a parallel mechanism.
 */
export async function resetTaskToPhaseWithProtocol(
  taskDir: string,
  protocolYaml: ProtocolYaml,
  phaseId: string,
): Promise<TaskJson> {
  const phaseIds = protocolYaml.phases.map((p) => p.id);
  if (!phaseIds.includes(phaseId)) {
    throw new Error(`Protocol "${protocolYaml.name}" has no phase "${phaseId}"`);
  }

  const downstream = downstreamPhaseIds(protocolYaml, phaseId);
  await invalidateFromPhase(taskDir, protocolYaml, phaseId);

  const task = await loadTaskJson(taskDir);
  const { reason: _droppedReason, ...rest } = task;
  const updated: TaskJson = {
    ...rest,
    phasesComplete: task.phasesComplete.filter((p) => !downstream.includes(p)),
    currentPhase: phaseId,
    state: "running",
    updatedAt: new Date().toISOString(),
  };
  await writeTaskJson(taskDir, updated);

  return loadTaskJson(taskDir);
}

/**
 * The earliest phase (protocol declaration order) carrying a LIVE human
 * `changes_requested` verdict on disk (`review/verdict/{phase}.json`), or
 * null if none is pending. This is the "send back" MARK the human writes
 * through the dashboard; `rerunTask` reads it to know where to re-enter.
 * Only `changes_requested` counts — a `pass`/`fail` verdict is terminal and
 * never re-runs a phase. Once the re-run re-passes its gate, the mark is
 * consumed (archived to `{phase}.attempt-N.json` — `consumeSendBackVerdict`,
 * called from the gate pass path), so it can't trigger a second rewind.
 */
export async function findSendBackPhase(
  taskDir: string,
  protocolYaml: ProtocolYaml,
): Promise<string | null> {
  for (const phase of protocolYaml.phases) {
    const record = await readHumanVerdict(taskDir, phase.id);
    if (record?.human_verdict === "changes_requested") {
      return phase.id;
    }
  }
  return null;
}

/**
 * Send-back invalidation seam: resolve the phase to re-run (an explicit
 * `fromPhase`, else the earliest `changes_requested` verdict on disk) and
 * apply the SAME archive+reset invalidation retry/rewind/reset-to use. Does
 * NOT run any compute — it only rewinds disk state so a subsequent `runTask`
 * resumes there. Returns the resolved phase + updated task.json.
 */
export async function invalidateForSendBack(
  taskDir: string,
  protocolYaml: ProtocolYaml,
  fromPhase?: string,
): Promise<{ readonly phase: string; readonly task: TaskJson }> {
  const phase = fromPhase ?? (await findSendBackPhase(taskDir, protocolYaml));
  if (!phase) {
    throw new Error(
      "No phase to rerun: pass a phase, or send one back from the dashboard " +
        "(writes a changes_requested verdict to review/verdict/{phase}.json).",
    );
  }
  const task = await resetTaskToPhaseWithProtocol(taskDir, protocolYaml, phase);
  return { phase, task };
}

/**
 * `rerun <task-id> [fromPhase]`: the human-initiated re-entry into the SAME
 * run loop the agent-FAIL retry uses. Invalidate from the send-back phase
 * (or explicit `fromPhase`), then re-enter `runTask`, which resumes at the
 * now-incomplete phase. The re-run worker's prompt carries the human's note
 * (readHumanFeedbackNote, threaded in session/worker.ts); the independent
 * reviewer re-gates from scratch — the human verdict never reaches it.
 */
export async function rerunTask(
  taskId: string,
  fromPhase?: string,
  tasksRoot?: string,
  config: LabratConfig = loadConfig(),
  opts: { readonly force?: boolean } = {},
): Promise<RunTaskResult & { readonly rerunFrom: string }> {
  const { resolve } = await import("node:path");
  const root = tasksRoot ?? join(resolve(process.cwd(), "tasks"));
  const taskDir = join(root, taskId);

  configureEvents(config.dashboard.url);

  const task = await loadTaskJson(taskDir);
  if (task.state === "running" && !opts.force) {
    throw new Error(
      `Task ${taskId} is currently running — rerun would double-run against the same task tree. Wait for it to finish, or pass --force to override.`,
    );
  }
  const protocol = await loadProtocolByName(task.protocol, config.scienceHome);

  const { phase } = await invalidateForSendBack(taskDir, protocol.yaml, fromPhase);

  const result = await runTask({
    taskId,
    taskDir,
    inputRel: task.input,
    protocol,
    config,
  });

  return { ...result, rerunFrom: phase };
}
