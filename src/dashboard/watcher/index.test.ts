import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { after, describe, it } from "node:test";
import { createApp } from "../server.js";
import { writeWatcherStatus } from "../../control/index.js";
import type { WatcherStatusFile } from "../../schema/index.js";

// Route-level tests for GET /api/watcher/status and POST /api/watcher —
// booted over real HTTP like server.test.ts. Each boot gets a project-root
// shaped tmp tree (tasks/ + control/ siblings) since the control files
// resolve to <tasksDir>/../control/. Per contract R7 the GET is a pure
// status-file read (+ derived health) — it never traverses watchRoot paths.

const roots: string[] = [];
const servers: http.Server[] = [];
after(async () => {
  for (const s of servers) s.close();
  for (const d of roots) await rm(d, { recursive: true, force: true });
});

async function boot(): Promise<{ base: string; root: string; tasksDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "labrat-watcher-routes-"));
  roots.push(root);
  const tasksDir = path.join(root, "tasks");
  await mkdir(tasksDir, { recursive: true });
  const app = createApp({ tasksDir, scienceHome: "/nonexistent", user: "tester", port: 0, devReplay: false });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, root, tasksDir };
}

function statusFixture(lastHeartbeat: string): WatcherStatusFile {
  return {
    desired: "running",
    state: "running",
    pid: 12345,
    since: "2026-07-11T15:00:00.000Z",
    lastHeartbeat,
    pollIntervalMs: 1000,
    activeDrop: null,
    configError: null,
    protocols: {
      "microct-oa-mouse-knee": {
        watchRoot: "/abs/dropbox",
        counts: { incoming: 0, inProgress: 1, done: 3, failed: 0 },
        lastDrop: {
          name: "OA6-1RK.zip",
          state: "in-progress",
          taskId: "task-2026-07-11-004",
          at: "2026-07-11T15:00:02.000Z",
        },
        error: null,
      },
    },
  };
}

describe("GET /api/watcher/status", () => {
  it("synthesizes a stopped view when no heartbeat exists", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/watcher/status`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { state: "stopped", protocols: {} });
  });

  it("serves the supervisor's heartbeat verbatim, healthy while fresh", async () => {
    const { base, tasksDir } = await boot();
    await writeWatcherStatus(tasksDir, statusFixture(new Date().toISOString()));

    const res = await fetch(`${base}/api/watcher/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.state, "running");
    assert.equal(body.pid, 12345);
    assert.equal(body.healthy, true);
    // R7: counts come from the file — the supervisor owns them; the route
    // never traverses the (here nonexistent) watchRoot.
    assert.deepEqual(body.protocols["microct-oa-mouse-knee"].counts, {
      incoming: 0,
      inProgress: 1,
      done: 3,
      failed: 0,
    });
    assert.equal(body.protocols["microct-oa-mouse-knee"].lastDrop.name, "OA6-1RK.zip");
  });

  it("a stale heartbeat reads as unhealthy (daemon offline), not running", async () => {
    const { base, tasksDir } = await boot();
    const stale = new Date(Date.now() - 60_000).toISOString();
    await writeWatcherStatus(tasksDir, statusFixture(stale));

    const res = await fetch(`${base}/api/watcher/status`);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.healthy, false);
    // The raw state is still reported; `healthy: false` is the offline signal.
    assert.equal(body.state, "running");
  });
});

describe("POST /api/watcher", () => {
  it("writes desired state + protocols and merges follow-up patches", async () => {
    const { base, root } = await boot();

    const first = await fetch(`${base}/api/watcher`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        desired: "running",
        protocols: { "microct-oa-mouse-knee": { watchRoot: "/abs/dropbox" } },
      }),
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      desired: "running",
      protocols: { "microct-oa-mouse-knee": { watchRoot: "/abs/dropbox" } },
    });

    // Partial patch: stop the watcher without resending protocols.
    const second = await fetch(`${base}/api/watcher`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desired: "stopped" }),
    });
    assert.equal(second.status, 200);
    const merged = (await second.json()) as Record<string, any>;
    assert.equal(merged.desired, "stopped");
    assert.deepEqual(merged.protocols, {
      "microct-oa-mouse-knee": { watchRoot: "/abs/dropbox" },
    });

    // Atomically written to control/watcher.json (sibling of tasks/).
    const onDisk = JSON.parse(
      await readFile(join(root, "control", "watcher.json"), "utf8"),
    ) as Record<string, any>;
    assert.equal(onDisk.desired, "stopped");
  });

  it("rejects an unknown desired value with 400", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/watcher`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desired: "paused" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, any>;
    assert.ok(String(body.error).includes("$.desired"));
  });

  it("rejects an empty or relative watchRoot with 400", async () => {
    const { base } = await boot();
    for (const watchRoot of ["", "relative/dropbox"]) {
      const res = await fetch(`${base}/api/watcher`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocols: { p1: { watchRoot } } }),
      });
      assert.equal(res.status, 400, `watchRoot=${JSON.stringify(watchRoot)}`);
    }
  });

  it("rejects an empty patch (neither desired nor protocols) with 400", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/watcher`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});
