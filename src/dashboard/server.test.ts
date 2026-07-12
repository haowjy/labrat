import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function boot(): Promise<{ base: string; tasksDir: string }> {
  const tasksDir = await mkdtemp(path.join(tmpdir(), "labrat-server-review-"));
  dirs.push(tasksDir);
  await cp(FIXTURE, path.join(tasksDir, TASK_ID), { recursive: true });
  const app = createApp({ tasksDir, scienceHome: "/nonexistent", user: "tester", port: 0, devReplay: false });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, tasksDir };
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

  it("closes the loop end to end: finish with a null proposed, then GET /api/tasks/:id surfaces humanVerdict on the matching phase entry", async () => {
    const { base } = await boot();
    const body = {
      phase: "segmentation",
      human_verdict: "fail",
      corrected: true,
      notes: "Femur landmark needed a manual correction; no pre-drag position was sent.",
      adjustments: [{ id: "lm-1", proposed: null, corrected: { x: 1, y: 2, z: 3 } }],
    };

    const postRes = await fetch(`${base}/api/tasks/${TASK_ID}/review/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(postRes.status, 201);

    const taskRes = await fetch(`${base}/api/tasks/${TASK_ID}`);
    assert.equal(taskRes.status, 200);
    const task = (await taskRes.json()) as Record<string, any>;
    const entry = (task.timeline as Array<Record<string, any>>).find(
      (e) => e.phase === "segmentation",
    );
    assert.ok(entry, "expected a segmentation timeline entry");
    assert.ok(entry.humanVerdict, "expected humanVerdict to be populated on the timeline entry");
    assert.equal(entry.humanVerdict.human_verdict, "fail");
    assert.deepEqual(entry.humanVerdict.corrected, true);
    assert.equal(
      entry.humanVerdict.notes,
      "Femur landmark needed a manual correction; no pre-drag position was sent.",
    );
    assert.ok(entry.humanVerdict.reviewed_at, "expected a reviewed_at stamp");
    assert.deepEqual(entry.humanVerdict.adjustments, [
      { id: "lm-1", proposed: null, corrected: { x: 1, y: 2, z: 3 } },
    ]);
  });
});

describe("GET /api/tasks/:id/export", () => {
  it("serves a downloadable review-chain bundle with an attachment filename", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/tasks/${TASK_ID}/export`);
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("content-disposition"),
      `attachment; filename="${TASK_ID}-review-chain.json"`,
    );
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const bundle = (await res.json()) as Record<string, any>;
    assert.equal(bundle.taskId, TASK_ID);
    assert.ok(String(bundle.taskDir).endsWith(`/${TASK_ID}`), "taskDir is the absolute task tree path");
    assert.equal((bundle.provenance as unknown[]).length, 2);
    const seg = (bundle.phases as Array<Record<string, any>>).find((p) => p.phase === "segmentation");
    assert.ok(seg);
    assert.equal(seg.gate.decision, "pass-with-concerns");
    assert.equal(seg.humanVerdict.human_verdict, "pass");
    assert.equal(seg.measurements.femurVoxels, 142789);
    assert.equal(seg.suggestions.length, 1);
  });

  it("404s an unknown task id", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/tasks/task-2026-01-01-999/export`);
    assert.equal(res.status, 404);
  });
});

/*
 * Phase-scoped review-site routing (review-provenance §3.D "Dashboard
 * seams"): /api/tasks/:id/review-sites/:phase/* serves the harness-published
 * `artifacts/review-sites/<phase>/` tree with the SAME CSP quarantine and
 * traversal guard as the legacy single-site route — and never serves the
 * unpublished `.staging/` tree.
 */
describe("GET /api/tasks/:id/review-sites/:phase/*path", () => {
  async function bootWithPublishedSite(): Promise<{ base: string }> {
    const { base, tasksDir } = await boot();
    const siteDir = path.join(
      tasksDir,
      TASK_ID,
      "artifacts",
      "review-sites",
      "segmentation",
    );
    await mkdir(siteDir, { recursive: true });
    await writeFile(
      path.join(siteDir, "index.html"),
      "<!doctype html><html><body>published segmentation artifact</body></html>",
    );
    const stagingDir = path.join(
      tasksDir,
      TASK_ID,
      "artifacts",
      "review-sites",
      ".staging",
      "segmentation",
      "1",
    );
    await mkdir(stagingDir, { recursive: true });
    await writeFile(path.join(stagingDir, "index.html"), "UNPUBLISHED");
    return { base };
  }

  it("serves a published phase site with the review-site CSP", async () => {
    const { base } = await bootWithPublishedSite();
    const res = await fetch(
      `${base}/api/tasks/${TASK_ID}/review-sites/segmentation/index.html`,
    );
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy");
    assert.ok(csp, "phase-scoped route must carry the same CSP quarantine");
    assert.match(csp ?? "", /default-src 'none'|script-src/);
    assert.match(await res.text(), /published segmentation artifact/);
  });

  it("rejects a phase with no published site (resolveTaskFile fails closed)", async () => {
    const { base } = await bootWithPublishedSite();
    const res = await fetch(
      `${base}/api/tasks/${TASK_ID}/review-sites/unknown-phase/index.html`,
    );
    // Same contract as the legacy route: an unresolvable path is a 400 from
    // the traversal-guarded resolver, never a directory listing or a leak.
    assert.equal(res.status, 400);
  });

  it("never serves the unpublished .staging tree", async () => {
    const { base } = await bootWithPublishedSite();
    const res = await fetch(
      `${base}/api/tasks/${TASK_ID}/review-sites/.staging/segmentation/1/index.html`,
    );
    assert.equal(res.status, 400);
  });

  it("rejects traversal in the phase segment", async () => {
    const { base } = await bootWithPublishedSite();
    const res = await fetch(
      `${base}/api/tasks/${TASK_ID}/review-sites/${encodeURIComponent("..")}/task.json`,
    );
    assert.ok(res.status === 400 || res.status === 404);
    const body = await res.text();
    assert.ok(!body.includes('"protocol"'), "must not leak task.json through traversal");
  });

  it("the legacy /review-site/ route still serves beside the new one", async () => {
    const { base, tasksDir } = await boot();
    const legacyDir = path.join(tasksDir, TASK_ID, "artifacts", "review-site");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, "index.html"),
      "<!doctype html><html><body>legacy single site</body></html>",
    );
    const res = await fetch(`${base}/api/tasks/${TASK_ID}/review-site/index.html`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-security-policy"));
    assert.match(await res.text(), /legacy single site/);
  });
});
