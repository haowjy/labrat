/**
 * Constrained full-run smoke harness (Lane D2).
 *
 * Enqueues the `toy-stats` protocol and runs the whole
 * worker → gate → monitor → provenance → events loop end-to-end on Haiku, then
 * asserts the durable evidence of a healthy run: task reaches `state: done`,
 * `review/verdict.json` passed, the provenance manifest has an entry per phase,
 * the independent monitor recorded a verdict per phase, and the expected SSE
 * event types fired.
 *
 * Runs in-process (no port bind — the sandbox SIGTERMs those). SSE events are
 * captured by stubbing `globalThis.fetch`, which is the ONLY thing the harness
 * process uses to emit them (`notifyEvent`); the Agent SDK runs the model in a
 * subprocess, so the stub does not touch model traffic.
 */
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../../src/config/index.js";
import { enqueueAndRun } from "../../src/harness/orchestrator/index.js";

type Captured = { type: string; taskId?: string; phase?: string };

const captured: Captured[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown): Promise<Response> => {
  const url = String(
    typeof input === "string" ? input : (input as { url?: string })?.url ?? "",
  );
  if (url.endsWith("/internal/events")) {
    try {
      const body = (init as { body?: string } | undefined)?.body;
      if (typeof body === "string") captured.push(JSON.parse(body) as Captured);
    } catch {
      /* ignore malformed capture */
    }
    return new Response(null, { status: 204 });
  }
  return realFetch(input as never, init as never);
}) as typeof fetch;

const EXPECTED_PHASES = ["classify", "regression"] as const;
const EXPECTED_EVENTS = [
  "task-started",
  "phase-started",
  "phase-complete",
  "gate-result",
  "task-done",
] as const;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`SMOKE ASSERT FAILED: ${msg}`);
  console.log(`  ok  ${msg}`);
}

async function main(): Promise<void> {
  const inputDir = await mkdtemp(join(tmpdir(), "labrat-smoke-input-"));
  await writeFile(
    join(inputDir, "README.txt"),
    "toy-stats smoke input — content irrelevant; classify generates its own data.\n",
  );
  const tasksRoot = await mkdtemp(join(tmpdir(), "labrat-smoke-tasks-"));

  console.log(`[smoke] enqueue toy-stats  tasksRoot=${tasksRoot}`);
  const started = Date.now();
  const result = await enqueueAndRun(inputDir, "toy-stats", tasksRoot, loadConfig());
  console.log(`[smoke] run finished in ${((Date.now() - started) / 1000).toFixed(1)}s  taskDir=${result.taskDir}\n`);

  const { taskDir } = result;

  assert(result.task.state === "done", `task reached state=done (got ${result.task.state})`);

  const verdictRaw = await readFile(join(taskDir, "review", "verdict.json"), "utf8");
  const verdict = JSON.parse(verdictRaw) as { status?: string };
  assert(
    verdict.status === "pass" || verdict.status === "pass-with-concerns",
    `review/verdict.json status is a pass (got ${verdict.status})`,
  );

  const manifestRaw = await readFile(join(taskDir, "provenance", "manifest.yaml"), "utf8");
  const manifest = parseYaml(manifestRaw) as { phase?: string }[];
  for (const phase of EXPECTED_PHASES) {
    assert(
      Array.isArray(manifest) && manifest.some((e) => e.phase === phase),
      `provenance manifest has an entry for phase "${phase}"`,
    );
  }

  for (const phase of EXPECTED_PHASES) {
    const monitorPath = join(taskDir, "review", "monitor", `${phase}.json`);
    assert(await exists(monitorPath), `independent monitor recorded review/monitor/${phase}.json`);
    const mon = JSON.parse(await readFile(monitorPath, "utf8")) as { verdict?: string };
    assert(mon.verdict === "ok", `monitor verdict for "${phase}" is ok on a genuine run (got ${mon.verdict})`);
  }

  const seen = new Set(captured.map((e) => e.type));
  for (const type of EXPECTED_EVENTS) {
    assert(seen.has(type), `emitted SSE event "${type}"`);
  }

  console.log("\n[smoke] PASS — toy-stats ran end-to-end through worker → gate → monitor → done");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(`\n[smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
