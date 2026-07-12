import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import { after, describe, it } from "node:test";
import { createSseBroker, type SseBroker } from "./index.js";
import {
  EVENTS_LOG_REL,
  type PersistedSseEvent,
  type SseEvent,
} from "../../schema/index.js";
import { configureEvents, notifyEvent } from "../../harness/events/index.js";

/*
 * Disk-broker contract (review-provenance §3B): the per-task event logs are
 * authoritative. A connecting client gets a replay (all retained, or only
 * events after its Last-Event-ID), then a live tail; a per-connection seen-id
 * LRU means the replay/live race and duplicate wake hints can never send an
 * id twice; a malformed interior line stops that task's tail rather than
 * skip/reorder, while an incomplete final line is simply not consumed yet.
 *
 * Events are written through the REAL producer (notifyEvent) wherever timing
 * doesn't need to be forged, so this also covers the producer↔broker contract
 * end to end on disk.
 */

// The producer fires wake hints at global fetch — keep tests hermetic.
const realFetch = globalThis.fetch;
// (cast through unknown: `Response` names the express type in this module)
globalThis.fetch = (async () =>
  new Response(null, { status: 204 })) as unknown as typeof fetch;
configureEvents("http://dashboard.test:0");
after(() => {
  globalThis.fetch = realFetch;
});

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

async function makeTasksDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "labrat-sse-broker-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeBroker(tasksDir: string): SseBroker {
  // Long poll interval: tests drive the tail explicitly via scanNow() so
  // assertions are deterministic, mirroring the wake-hint path.
  const broker = createSseBroker({ tasksDir, pollIntervalMs: 3_600_000, heartbeatMs: 3_600_000 });
  cleanups.push(() => broker.close());
  return broker;
}

type Frame = { id: string; event: string; data: SseEvent };

/** Minimal SSE client double: `frames()` parses everything written so far. */
function connect(
  broker: SseBroker,
  lastEventId?: string,
): { frames: () => Frame[]; close: () => void } {
  const req = new EventEmitter() as unknown as Request;
  (req as { headers: Record<string, string> }).headers = lastEventId
    ? { "last-event-id": lastEventId }
    : {};
  const chunks: string[] = [];
  const res = {
    setHeader: () => {},
    flushHeaders: () => {},
    write: (chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    },
    end: () => {},
  } as unknown as Response;

  broker.handleSse(req, res);

  return {
    frames: () => {
      const frames: Frame[] = [];
      for (const block of chunks.join("").split("\n\n")) {
        const id = /(?:^|\n)id: (.+)/.exec(block)?.[1];
        const event = /(?:^|\n)event: (.+)/.exec(block)?.[1];
        const data = /(?:^|\n)data: (.+)/.exec(block)?.[1];
        if (id && event && data) {
          frames.push({ id, event, data: JSON.parse(data) as SseEvent });
        }
      }
      return frames;
    },
    close: () => (req as unknown as EventEmitter).emit("close"),
  };
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function logEvent(taskId: string, line: string): SseEvent {
  return { type: "log", taskId, line, ephemeral: true };
}

/** Hand-write an envelope line (for forged timestamps / corrupt-log cases). */
async function writeRawLine(tasksDir: string, taskId: string, line: string): Promise<void> {
  const logPath = join(tasksDir, taskId, EVENTS_LOG_REL);
  await mkdir(join(tasksDir, taskId, "events"), { recursive: true });
  await appendFile(logPath, line, "utf8");
}

function envelopeLine(id: string, emittedAt: string, event: SseEvent): string {
  const envelope: PersistedSseEvent = { schemaVersion: 1, id, emittedAt, event };
  return `${JSON.stringify(envelope)}\n`;
}

describe("sse disk broker", () => {
  it("replays events written while the dashboard was down, payload shape unchanged", async () => {
    const tasksDir = await makeTasksDir();
    // Harness runs with NO dashboard: appends land, wake hints go nowhere.
    const e1 = await notifyEvent(join(tasksDir, "t-1"), {
      type: "task-started",
      taskId: "t-1",
      protocol: "toy-stats",
    });
    const e2 = await notifyEvent(join(tasksDir, "t-1"), {
      type: "phase-started",
      taskId: "t-1",
      phase: "intake",
    });

    // Dashboard starts AFTER the writes — first connect replays everything.
    const broker = makeBroker(tasksDir);
    const client = connect(broker);
    await waitFor(() => client.frames().length === 2, "replay of 2 events");

    assert.deepEqual(
      client.frames().map((f) => f.id),
      [e1.id, e2.id],
      "replay in (emittedAt, id) order with envelope ids",
    );
    assert.deepEqual(
      client.frames().map((f) => f.event),
      ["task-started", "phase-started"],
    );
    // Browser-facing contract: `data:` is the bare SseEvent — the envelope
    // never leaks, so existing front-end listeners need no change.
    assert.deepEqual(client.frames()[0]!.data, e1.event);
    assert.ok(!("schemaVersion" in client.frames()[0]!.data));
    client.close();
  });

  it("merges multiple task logs by (emittedAt, id) on replay", async () => {
    const tasksDir = await makeTasksDir();
    await writeRawLine(
      tasksDir,
      "t-a",
      envelopeLine("0189aaaa-0000-7000-8000-000000000001", "2026-07-12T10:00:02.000Z", logEvent("t-a", "second")),
    );
    await writeRawLine(
      tasksDir,
      "t-b",
      envelopeLine("0189aaaa-0000-7000-8000-000000000002", "2026-07-12T10:00:01.000Z", logEvent("t-b", "first")),
    );

    const broker = makeBroker(tasksDir);
    const client = connect(broker);
    await waitFor(() => client.frames().length === 2, "merged replay");
    assert.deepEqual(
      client.frames().map((f) => (f.data as { line?: string }).line),
      ["first", "second"],
    );
    client.close();
  });

  it("reconnect with Last-Event-ID replays only newer events", async () => {
    const tasksDir = await makeTasksDir();
    const taskDir = join(tasksDir, "t-1");
    const e1 = await notifyEvent(taskDir, logEvent("t-1", "one"));
    const e2 = await notifyEvent(taskDir, logEvent("t-1", "two"));
    const e3 = await notifyEvent(taskDir, logEvent("t-1", "three"));

    const broker = makeBroker(tasksDir);
    const client = connect(broker, e2.id);
    await waitFor(() => client.frames().length === 1, "replay after Last-Event-ID");
    assert.deepEqual(client.frames().map((f) => f.id), [e3.id]);
    assert.ok(!client.frames().some((f) => f.id === e1.id));
    client.close();
  });

  it("never sends an id twice on one connection (replay/live race, duplicate wakes)", async () => {
    const tasksDir = await makeTasksDir();
    const taskDir = join(tasksDir, "t-1");
    const e1 = await notifyEvent(taskDir, logEvent("t-1", "one"));
    const e2 = await notifyEvent(taskDir, logEvent("t-1", "two"));

    const broker = makeBroker(tasksDir);
    const client = connect(broker);
    // Race the snapshot replay with tail scans of the SAME lines (a fresh
    // broker tails from offset 0), plus duplicate wake hints.
    broker.scanNow();
    broker.scanNow();
    await waitFor(() => client.frames().length >= 2, "events delivered");
    // Settle any coalesced re-scan.
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(client.frames().map((f) => f.id), [e1.id, e2.id]);

    // A NEW event with duplicate wake hints is still delivered exactly once.
    const e3 = await notifyEvent(taskDir, logEvent("t-1", "three"));
    broker.scanNow();
    broker.scanNow();
    await waitFor(() => client.frames().some((f) => f.id === e3.id), "live tail event");
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(client.frames().map((f) => f.id), [e1.id, e2.id, e3.id]);
    client.close();
  });

  it("ignores an incomplete final line until it completes", async () => {
    const tasksDir = await makeTasksDir();
    const full = envelopeLine(
      "0189bbbb-0000-7000-8000-000000000001",
      "2026-07-12T10:00:00.000Z",
      logEvent("t-1", "complete"),
    );
    const partial = envelopeLine(
      "0189bbbb-0000-7000-8000-000000000002",
      "2026-07-12T10:00:01.000Z",
      logEvent("t-1", "in-flight"),
    );
    const cut = Math.floor(partial.length / 2);
    await writeRawLine(tasksDir, "t-1", full + partial.slice(0, cut));

    const broker = makeBroker(tasksDir);
    const client = connect(broker);
    await waitFor(() => client.frames().length === 1, "replay of the complete line");
    broker.scanNow();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(client.frames().length, 1, "half-written line is not consumed");

    // The writer finishes the line — the tail picks it up, exactly once.
    await writeRawLine(tasksDir, "t-1", partial.slice(cut));
    broker.scanNow();
    await waitFor(() => client.frames().length === 2, "completed line delivered");
    assert.equal((client.frames()[1]!.data as { line?: string }).line, "in-flight");
    client.close();
  });

  it("stops a task's tail at a malformed interior line — never skips ahead", async () => {
    const tasksDir = await makeTasksDir();
    await writeRawLine(
      tasksDir,
      "t-1",
      envelopeLine("0189cccc-0000-7000-8000-000000000001", "2026-07-12T10:00:00.000Z", logEvent("t-1", "good")) +
        "{ this is not json\n" +
        envelopeLine("0189cccc-0000-7000-8000-000000000003", "2026-07-12T10:00:02.000Z", logEvent("t-1", "after corruption")),
    );

    const broker = makeBroker(tasksDir);
    const client = connect(broker);
    await waitFor(() => client.frames().length === 1, "replay up to the corruption");
    assert.equal((client.frames()[0]!.data as { line?: string }).line, "good");

    // Tail also stops there — even new appends after the corruption stay
    // undelivered rather than being reordered past the bad line.
    await writeRawLine(
      tasksDir,
      "t-1",
      envelopeLine("0189cccc-0000-7000-8000-000000000004", "2026-07-12T10:00:03.000Z", logEvent("t-1", "later")),
    );
    broker.scanNow();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(client.frames().length, 1, "tail stopped at the corruption");

    // Other tasks are unaffected.
    await notifyEvent(join(tasksDir, "t-2"), logEvent("t-2", "healthy task"));
    broker.scanNow();
    await waitFor(() => client.frames().length === 2, "healthy task still tails");
    assert.equal((client.frames()[1]!.data as { line?: string }).line, "healthy task");
    client.close();
  });
});
