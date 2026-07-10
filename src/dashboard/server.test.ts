import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createApp } from "./server.js";

// Route-level tests for POST /api/tasks/:id/review/finish and its read-back
// via GET /api/tasks/:id/phases/:phase — booted over real HTTP (Node's
// global fetch), matching review-site.test.ts's "assert on the route, not a
// helper re-deriving the expected value" style.
const FIXTURE = fileURLToPath(
  new URL("../../fixtures/tasks/task-2026-07-09-001", import.meta.url),
);
const TASK_ID = "task-2026-07-09-001";

const dirs: string[] = [];
const servers: http.Server[] = [];
after(async () => {
  for (const s of servers) s.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function boot(): Promise<{ base: string }> {
  const tasksDir = await mkdtemp(path.join(tmpdir(), "labrat-server-review-"));
  dirs.push(tasksDir);
  await cp(FIXTURE, path.join(tasksDir, TASK_ID), { recursive: true });
  const app = createApp({ tasksDir, user: "tester", port: 0, devReplay: false });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}` };
}

const validBody = {
  phase: "segmentation",
  human_verdict: "pass",
  corrected: true,
  notes: "Fixed the femur landmark.",
  adjustments: [
    { id: "lm-1", proposed: { x: 0, y: 0, z: 0 }, corrected: { x: 1, y: 0, z: 0 } },
  ],
};

describe("POST /api/tasks/:id/review/finish", () => {
  it("happy path: 201 + the review chain reads it back on GET .../phases/:phase", async () => {
    const { base } = await boot();
    const postRes = await fetch(`${base}/api/tasks/${TASK_ID}/review/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    assert.equal(postRes.status, 201);
    const posted = (await postRes.json()) as Record<string, any>;
    assert.equal(posted.human_verdict, "pass");
    assert.equal(posted.agent_gate_decision, "pass-with-concerns");

    // Reload-survivable: a fresh GET (no in-memory state) shows the same verdict.
    const getRes = await fetch(`${base}/api/tasks/${TASK_ID}/phases/segmentation`);
    assert.equal(getRes.status, 200);
    const phase = (await getRes.json()) as Record<string, any>;
    assert.ok(phase.humanVerdict, "expected humanVerdict to be populated");
    assert.equal(phase.humanVerdict.human_verdict, "pass");
    assert.equal(phase.humanVerdict.corrected, true);
    assert.equal(phase.humanVerdict.agent_confidence.overall, "medium");
  });

  it("rejects a malformed body (missing required field) with 400", async () => {
    const { base } = await boot();
    const { human_verdict: _drop, ...bad } = validBody;
    const res = await fetch(`${base}/api/tasks/${TASK_ID}/review/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bad),
    });
    assert.equal(res.status, 400);
  });

  it("rejects malformed JSON with 400 (not express's default HTML error page)", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/tasks/${TASK_ID}/review/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, any>;
    assert.match(body.error, /json/i);
  });

  it("rejects a path-traversal task id with 400", async () => {
    const { base } = await boot();
    const res = await fetch(
      `${base}/api/tasks/${encodeURIComponent("../../etc")}/review/finish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      },
    );
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
  });

  it("rejects an unknown task id with 404", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/tasks/task-2026-07-09-999/review/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    assert.equal(res.status, 404);
  });

  it("rejects an oversized body (over express.json's 64kb limit)", async () => {
    const { base } = await boot();
    const oversized = { ...validBody, notes: "x".repeat(70 * 1024) };
    const res = await fetch(`${base}/api/tasks/${TASK_ID}/review/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(oversized),
    });
    assert.equal(res.status, 413);
  });

  it("a phase with no persisted verdict yet reads back humanVerdict: null", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/tasks/${TASK_ID}/phases/intake`);
    assert.equal(res.status, 200);
    const phase = (await res.json()) as Record<string, any>;
    assert.equal(phase.humanVerdict, null);
  });
});
