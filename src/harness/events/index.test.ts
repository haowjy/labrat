import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { configureEvents, notifyEvent } from "./index.js";
import {
  EVENTS_LOG_REL,
  validatePersistedSseEvent,
  uuidv7,
  type SseEvent,
} from "../../schema/index.js";

/*
 * Producer contract (review-provenance §3B): notifyEvent appends a
 * PersistedSseEvent envelope line to <taskDir>/events/events.jsonl — the
 * AUTHORITATIVE record — and only then fires a best-effort {taskId, id} wake
 * hint at the dashboard. The append is awaited; the hint may fail freely.
 */

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Capture wake hints; never let a test reach the network.
type Hint = { url: string; body: unknown };
const hints: Hint[] = [];
let failHints = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown): Promise<Response> => {
  const url = String(
    typeof input === "string" ? input : ((input as { url?: string })?.url ?? ""),
  );
  if (failHints) throw new Error("dashboard down");
  const body = (init as { body?: string } | undefined)?.body;
  hints.push({ url, body: typeof body === "string" ? JSON.parse(body) : null });
  return new Response(null, { status: 204 });
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

configureEvents("http://dashboard.test:0");

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function makeTaskDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "labrat-events-"));
  dirs.push(dir);
  return dir;
}

function logEvent(line: string): SseEvent {
  return { type: "log", taskId: "t-1", line, ephemeral: true };
}

async function readEnvelopes(taskDir: string) {
  const raw = await readFile(join(taskDir, EVENTS_LOG_REL), "utf8");
  assert.ok(raw.endsWith("\n"), "log ends with a complete line");
  return raw
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const validated = validatePersistedSseEvent(JSON.parse(l));
      assert.ok(validated.ok, `persisted line validates: ${l}`);
      return validated.value;
    });
}

describe("uuidv7", () => {
  it("emits RFC 9562 v7 ids that sort by generation order", () => {
    const ids = Array.from({ length: 500 }, () => uuidv7());
    for (const id of ids) assert.match(id, UUID_V7_RE);
    assert.equal(new Set(ids).size, ids.length, "ids are unique");
    assert.deepEqual([...ids].sort(), ids, "ids sort lexicographically in order");
  });
});

describe("notifyEvent", () => {
  it("appends a validated envelope and returns it", async () => {
    const taskDir = await makeTaskDir();
    const event: SseEvent = { type: "phase-started", taskId: "t-1", phase: "intake" };
    const envelope = await notifyEvent(taskDir, event);

    assert.equal(envelope.schemaVersion, 1);
    assert.match(envelope.id, UUID_V7_RE);
    assert.ok(!Number.isNaN(Date.parse(envelope.emittedAt)));
    assert.deepEqual(envelope.event, event, "payload is byte-identical to the input");

    const lines = await readEnvelopes(taskDir);
    assert.deepEqual(lines, [envelope]);
  });

  it("POSTs a {taskId, id} wake hint AFTER the append lands", async () => {
    const taskDir = await makeTaskDir();
    hints.length = 0;
    const envelope = await notifyEvent(taskDir, logEvent("hello"));
    // The hint promise is detached; give the microtask queue one turn.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(hints.length, 1);
    assert.ok(hints[0]!.url.endsWith("/internal/events"));
    assert.deepEqual(hints[0]!.body, { taskId: "t-1", id: envelope.id });
  });

  it("still resolves and appends when the dashboard is unreachable", async () => {
    const taskDir = await makeTaskDir();
    failHints = true;
    try {
      const envelope = await notifyEvent(taskDir, logEvent("dashboard down"));
      const lines = await readEnvelopes(taskDir);
      assert.deepEqual(lines, [envelope], "append is unaffected by a dead hint");
    } finally {
      failHints = false;
    }
  });

  it("serializes concurrent appends per file — no interleaved lines", async () => {
    const taskDir = await makeTaskDir();
    const events = Array.from({ length: 50 }, (_, i) => logEvent(`line ${i}`));
    const envelopes = await Promise.all(events.map((e) => notifyEvent(taskDir, e)));

    const lines = await readEnvelopes(taskDir);
    assert.equal(lines.length, 50);
    // Every line is complete + valid (readEnvelopes asserted), ids unique.
    assert.equal(new Set(lines.map((l) => l.id)).size, 50);
    // notifyEvent was invoked in order on one queue → log order matches.
    assert.deepEqual(
      lines.map((l) => l.id),
      envelopes.map((e) => e.id),
    );
  });

  it("rejects an invalid event without touching disk", async () => {
    const taskDir = await makeTaskDir();
    await assert.rejects(
      () =>
        notifyEvent(taskDir, {
          type: "gate-result",
          taskId: "t-1",
          phase: "intake",
          decision: "nope",
        } as unknown as SseEvent),
      /invalid SSE event/,
    );
    await assert.rejects(() => readFile(join(taskDir, EVENTS_LOG_REL), "utf8"));
  });
});
