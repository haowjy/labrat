#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/index.js";
import { loadConfig as loadDashboardConfig } from "../dashboard/config.js";
import { startServerAsync } from "../dashboard/server.js";
import {
  enqueueAndRun,
  rerunTask,
  resetTaskToPhase,
  resumeTask,
  runPhaseInIsolation,
  runStandaloneGate,
} from "../harness/orchestrator/index.js";
import { createSupervisor } from "../harness/watcher/supervisor.js";
import { runCheckReviewSiteCli } from "../review-site/cli.js";
import {
  importSkill,
  listClaudeScienceSkills,
  listVendoredSkillNames,
} from "../harness/claude-science/registry.js";

/** Start the dashboard server in-process so SSE events land and the live view
 *  is available during protocol execution. Skipped when `--no-dashboard` is
 *  passed. Returns a no-op if the flag is present. */
async function ensureDashboard(args: readonly string[]): Promise<void> {
  if (args.includes("--no-dashboard")) return;
  const config = loadDashboardConfig();
  await startServerAsync(config);
}

function expandUserPath(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** `labrat skills [--builtins]` — browse the Claude Science registry, flagging
 * which skills are runnable (have a protocol.yaml) and which are already
 * vendored in the repo's skills/ dir. */
async function runSkillsList(args: readonly string[]): Promise<void> {
  const includeBuiltins = args.includes("--builtins");
  const config = loadConfig();
  const [skills, vendored] = await Promise.all([
    listClaudeScienceSkills(config.scienceHome, { includeBuiltins }),
    listVendoredSkillNames(),
  ]);

  if (skills.length === 0) {
    console.log(`No skills found under ${config.scienceHome}.`);
    return;
  }

  console.log(`Claude Science skills (${config.scienceHome}):\n`);
  for (const s of skills) {
    const tags = [
      s.runnable ? "runnable" : null,
      vendored.has(s.name) ? "vendored" : null,
      s.builtin ? "builtin" : null,
    ].filter((t): t is string => t !== null);
    const suffix = tags.length ? `  [${tags.join(", ")}]` : "";
    console.log(`  ${s.name}  (${s.source})${suffix}`);
    if (s.description) console.log(`      ${s.description}`);
  }
  console.log(`\n${skills.length} skill(s). Import with: labrat import-skill <name> [--force]`);
}

/** `labrat import-skill <name> [--force]` — copy a Claude Science skill into
 * the repo's vendored skills/ dir (inverse of the export script). */
async function runImportSkill(args: readonly string[]): Promise<void> {
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) {
    console.error("Usage: labrat import-skill <name> [--force]");
    process.exit(1);
  }
  const force = args.includes("--force");
  const config = loadConfig();
  let result;
  try {
    result = await importSkill(name, config.scienceHome, undefined, { force });
  } catch (err) {
    // Expected user errors (unknown skill, no-clobber guard) — a clean line,
    // not a stack trace.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  console.log(
    `${result.overwritten ? "Overwrote" : "Imported"} "${result.name}" ` +
      `(${result.source})\n  from: ${result.from}\n  to:   ${result.to}\n  ` +
      `${result.files.length} file(s) copied.`,
  );
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

    await ensureDashboard(args);
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

  if (command === "watch") {
    // Folder-watch supervisor daemon: reads desired state from
    // control/watcher.json (dashboard-written), moves drops
    // incoming → in-progress → done|failed, heartbeats to
    // control/watcher-status.json. Runs until SIGINT/SIGTERM, then writes a
    // final stopped heartbeat.
    const config = loadConfig();
    const tasksRoot = join(resolve(process.cwd()), "tasks");
    const supervisor = createSupervisor({
      config,
      tasksRoot,
      log: (message) => console.log(`[watch] ${message}`),
    });
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    process.on("SIGTERM", () => controller.abort());
    console.log(
      `[watch] supervising (tasks: ${tasksRoot}, control: ${resolve(tasksRoot, "..", "control")})`,
    );
    await supervisor.run(controller.signal);
    console.log("[watch] stopped");
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

    await ensureDashboard(args);
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

  if (command === "skills") {
    await runSkillsList(args.slice(1));
    return;
  }

  if (command === "import-skill") {
    await runImportSkill(args.slice(1));
    return;
  }

  if (command === "resume") {
    const taskId = args[1];
    if (!taskId) {
      console.error("Usage: labrat resume <task-id>");
      process.exit(1);
    }

    await ensureDashboard(args);
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
    const rerunArgs = args.slice(1).filter((a) => a !== "--force");
    const force = args.includes("--force");
    const taskId = rerunArgs[0];
    const fromPhase = rerunArgs[1];
    if (!taskId) {
      console.error("Usage: labrat rerun <task-id> [from-phase] [--force]");
      process.exit(1);
    }

    // Human-initiated re-entry into the same run loop the agent-FAIL retry
    // uses: invalidate from the sent-back phase (or explicit from-phase) and
    // resume. Without a from-phase, rerun re-runs the earliest phase carrying
    // a human `changes_requested` verdict (dashboard "Send back" writes it).
    // Refuses a task that is still `running` unless --force is passed.
    await ensureDashboard(args);
    console.log(`rerun ${taskId}${fromPhase ? ` from=${fromPhase}` : ""}`);
    const result = await rerunTask(taskId, fromPhase, undefined, undefined, { force });
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
  console.error("Usage: labrat enqueue <dicom-path-or-zip> [protocol-name] [--no-dashboard]");
  console.error("       labrat watch");
  console.error("       labrat gate <task-id> <phase>");
  console.error("       labrat run-phase <task-id> <phase> [--gate] [--no-dashboard]");
  console.error("       labrat check-review-site <site-dir> [--results <path>] [--cdn-allowlist a,b]");
  console.error("       labrat skills [--builtins]");
  console.error("       labrat import-skill <name> [--force]");
  console.error("       labrat resume <task-id> [--no-dashboard]");
  console.error("       labrat rerun <task-id> [from-phase] [--force] [--no-dashboard]");
  console.error("       labrat reset-to <task-id> <phase>");
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
