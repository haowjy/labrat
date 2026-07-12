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
 * read back from the task's authoritative event log
 * (`<taskDir>/events/events.jsonl` — review-provenance §3B); the dashboard
 * wake hints `notifyEvent` POSTs are swallowed by stubbing `globalThis.fetch`
 * (the Agent SDK runs the model in a subprocess, so the stub does not touch
 * model traffic).
 */
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../../src/config/index.js";
import { enqueueAndRun } from "../../src/harness/orchestrator/index.js";

type CapturedHint = { taskId?: string; id?: string };

const captured: CapturedHint[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown): Promise<Response> => {
  const url = String(
    typeof input === "string" ? input : (input as { url?: string })?.url ?? "",
  );
  if (url.endsWith("/internal/events")) {
    try {
      const body = (init as { body?: string } | undefined)?.body;
      if (typeof body === "string") captured.push(JSON.parse(body) as CapturedHint);
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
    // F2: on a genuine run the ENFORCING verdict `rubber_stamp` must not fire —
    // that's the false positive that discards worker output and forces a retry.
    // `insufficient_evidence` is advisory (the model's nuance on an
    // evidence-present pass); it is recorded but does NOT fail the gate, so the
    // task still reaches `done` above without a retry. Only rubber_stamp is a
    // failure here.
    assert(
      mon.verdict === "ok" || mon.verdict === "insufficient_evidence",
      `monitor did not rubber_stamp-fail "${phase}" on a genuine run (got ${mon.verdict})`,
    );
  }

  const eventsRaw = await readFile(join(taskDir, "events", "events.jsonl"), "utf8");
  const envelopes = eventsRaw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { id?: string; event?: { type?: string } });
  const seen = new Set(envelopes.map((e) => e.event?.type));
  for (const type of EXPECTED_EVENTS) {
    assert(seen.has(type), `persisted SSE event "${type}" in events/events.jsonl`);
  }
  assert(
    captured.length > 0 && captured.every((h) => typeof h.id === "string"),
    `wake hints POSTed to /internal/events carry envelope ids (${captured.length} captured)`,
  );

  console.log("\n[smoke] PASS — toy-stats ran end-to-end through worker → gate → monitor → done");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(`\n[smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
