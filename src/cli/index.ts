#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/index.js";
import {
  enqueueAndRun,
  rerunTask,
  resetTaskToPhase,
  resumeTask,
  runPhaseInIsolation,
  runStandaloneGate,
} from "../harness/orchestrator/index.js";
import { runCheckReviewSiteCli } from "../review-site/cli.js";

function expandUserPath(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "enqueue" || command === undefined) {
    const inputPath = command === "enqueue" ? args[1] : args[0];
    if (!inputPath) {
      console.error("Usage: labrat enqueue <dicom-path-or-zip>");
      process.exit(1);
    }

    const inputAbs = resolve(expandUserPath(inputPath));
    const config = loadConfig();
    const protocol = args[2] ?? config.defaultProtocol;
    if (!protocol) {
      console.error(
        "Usage: labrat enqueue <dicom-path-or-zip> [protocol-name]\n" +
          "No protocol given and no defaultProtocol configured " +
          "(labrat.config.json or LABRAT_PROTOCOL).",
      );
      process.exit(1);
    }

    console.log(`enqueue ${inputAbs} protocol=${protocol}`);
    const result = await enqueueAndRun(inputAbs, protocol, undefined, config);

    console.log(JSON.stringify({
      taskId: result.taskId,
      taskDir: result.taskDir,
      state: result.task.state,
      phasesComplete: result.task.phasesComplete,
      workerSessions: result.phases.map((p) => ({
        phase: p.phase,
        sessionId: p.workerSessionId,
        gate: p.gate,
      })),
    }, null, 2));
    return;
  }

  if (command === "gate") {
    const taskId = args[1];
    const phaseId = args[2];
    if (!taskId || !phaseId) {
      console.error("Usage: labrat gate <task-id> <phase>");
      process.exit(1);
    }

    console.log(`gate ${taskId} phase=${phaseId}`);
    const result = await runStandaloneGate(taskId, phaseId);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "run-phase") {
    const taskId = args[1];
    const phaseId = args[2];
    const withGate = args.includes("--gate");
    if (!taskId || !phaseId) {
      console.error("Usage: labrat run-phase <task-id> <phase> [--gate]");
      process.exit(1);
    }

    console.log(`run-phase ${taskId} phase=${phaseId} gate=${withGate}`);
    const result = await runPhaseInIsolation(taskId, phaseId, withGate);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "check-review-site") {
    // Set exitCode (not process.exit) so stdout flushes before the process ends.
    process.exitCode = await runCheckReviewSiteCli(args.slice(1));
    return;
  }

  if (command === "resume") {
    const taskId = args[1];
    if (!taskId) {
      console.error("Usage: labrat resume <task-id>");
      process.exit(1);
    }

    console.log(`resume ${taskId}`);
    const result = await resumeTask(taskId);
    console.log(JSON.stringify({
      taskId,
      state: result.task.state,
      phasesComplete: result.task.phasesComplete,
      workerSessions: result.phases.map((p) => ({
        phase: p.phase,
        sessionId: p.workerSessionId,
        gate: p.gate,
      })),
    }, null, 2));
    return;
  }

  if (command === "rerun") {
    const taskId = args[1];
    const fromPhase = args[2];
    if (!taskId) {
      console.error("Usage: labrat rerun <task-id> [from-phase]");
      process.exit(1);
    }

    // Human-initiated re-entry into the same run loop the agent-FAIL retry
    // uses: invalidate from the sent-back phase (or explicit from-phase) and
    // resume. Without a from-phase, rerun re-runs the earliest phase carrying
    // a human `changes_requested` verdict (dashboard "Send back" writes it).
    console.log(`rerun ${taskId}${fromPhase ? ` from=${fromPhase}` : ""}`);
    const result = await rerunTask(taskId, fromPhase);
    console.log(JSON.stringify({
      taskId,
      rerunFrom: result.rerunFrom,
      state: result.task.state,
      phasesComplete: result.task.phasesComplete,
      workerSessions: result.phases.map((p) => ({
        phase: p.phase,
        sessionId: p.workerSessionId,
        gate: p.gate,
      })),
    }, null, 2));
    return;
  }

  if (command === "reset-to") {
    const taskId = args[1];
    const phaseId = args[2];
    if (!taskId || !phaseId) {
      console.error("Usage: labrat reset-to <task-id> <phase>");
      process.exit(1);
    }

    console.log(`reset-to ${taskId} phase=${phaseId}`);
    const task = await resetTaskToPhase(taskId, phaseId);
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Usage: labrat enqueue <dicom-path-or-zip> [protocol-name]");
  console.error("       labrat gate <task-id> <phase>");
  console.error("       labrat run-phase <task-id> <phase> [--gate]");
  console.error("       labrat check-review-site <site-dir> [--results <path>] [--cdn-allowlist a,b]");
  console.error("       labrat resume <task-id>");
  console.error("       labrat rerun <task-id> [from-phase]");
  console.error("       labrat reset-to <task-id> <phase>");
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
