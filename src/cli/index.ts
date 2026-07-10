#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/index.js";
import { enqueueAndRun, runStandaloneGate } from "../harness/orchestrator/index.js";

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
    const protocol = args[2] ?? loadConfig().defaultProtocol;
    if (!protocol) {
      console.error(
        "Usage: labrat enqueue <dicom-path-or-zip> [protocol-name]\n" +
          "No protocol given and no defaultProtocol configured " +
          "(labrat.config.json or LABRAT_PROTOCOL).",
      );
      process.exit(1);
    }

    console.log(`enqueue ${inputAbs} protocol=${protocol}`);
    const result = await enqueueAndRun(inputAbs, protocol);

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

  console.error(`Unknown command: ${command}`);
  console.error("Usage: labrat enqueue <dicom-path-or-zip> [protocol-name]");
  console.error("       labrat gate <task-id> <phase>");
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
