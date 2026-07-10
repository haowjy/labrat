import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { createApp } from "./server.js";
import { resolveReviewSiteFile, reviewSiteCsp } from "./server.js";

// mime-types is what express's sendFile uses to set Content-Type, so it
// faithfully predicts the header the route emits. No bundled types; load it
// through require rather than pulling in a @types dep for one assertion.
const { contentType } = createRequire(import.meta.url)("mime-types") as {
  contentType: (name: string) => string | false;
};

// The committed Lane 0 fixture (validation/fixtures/review-site/) stands in for
// a task's artifacts/review-site/ tree. We COPY it into a throwaway task dir so
// the tree is real files inside the task tree — mirroring what the worker writes
// (a symlinked tree is itself an escape now that resolveTaskFile realpaths).
const FIXTURE = fileURLToPath(
  new URL("../../validation/fixtures/review-site", import.meta.url),
);
const TASK_ID = "task-2026-07-09-001";

/** Build a task tree whose artifacts/review-site/ holds the fixture's real files. */
async function makeTasksDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "labrat-review-site-"));
  const site = path.join(dir, TASK_ID, "artifacts", "review-site");
  await mkdir(site, { recursive: true });
  await cp(FIXTURE, site, { recursive: true });
  return dir;
}

describe("resolveReviewSiteFile (traversal + symlink guard via resolveTaskFile)", () => {
  it("resolves a nested fixture path to the real file", async () => {
    const dir = await makeTasksDir();
    try {
      const file = resolveReviewSiteFile(dir, TASK_ID, ["data", "manifest.js"]);
      assert.ok(file, "expected a resolved path");
      assert.ok(existsSync(file), `expected ${file} to exist`);
      // sendFile derives Content-Type from the extension via mime-types (the
      // same lib express uses); assert the type the route will emit for .js.
      assert.equal(contentType(path.basename(file)), "text/javascript; charset=utf-8");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits correct content-types for html/css/json", async () => {
    const dir = await makeTasksDir();
    try {
      for (const [seg, type] of [
        ["index.html", "text/html; charset=utf-8"],
        ["assets/app.css", "text/css; charset=utf-8"],
      ] as const) {
        const file = resolveReviewSiteFile(dir, TASK_ID, seg.split("/"));
        assert.ok(file && existsSync(file), `expected ${seg} to resolve+exist`);
        assert.equal(contentType(path.basename(file)), type);
      }
      // .json content-type is stable even without a fixture file present.
      assert.equal(contentType("x.json"), "application/json; charset=utf-8");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a '..' segment", () => {
    assert.equal(resolveReviewSiteFile("/tasks", TASK_ID, ["..", "..", "etc"]), null);
    assert.equal(resolveReviewSiteFile("/tasks", TASK_ID, ["data", "..", "secret"]), null);
  });

  it("rejects an absolute path (empty leading segment)", () => {
    // path-to-regexp splits "/etc/passwd" into ["", "etc", "passwd"]; the empty
    // segment is unsafe.
    assert.equal(resolveReviewSiteFile("/tasks", TASK_ID, ["", "etc", "passwd"]), null);
  });

  it("rejects a null-byte segment", () => {
    assert.equal(resolveReviewSiteFile("/tasks", TASK_ID, ["data\0.js"]), null);
  });

  it("rejects an invalid task id", () => {
    assert.equal(resolveReviewSiteFile("/tasks", "../evil", ["index.html"]), null);
  });

  it("rejects a symlink whose target escapes the task tree", async () => {
    const dir = await makeTasksDir();
    try {
      const site = path.join(dir, TASK_ID, "artifacts", "review-site");
      // Worker-authored symlink pointing outside the tree at a real secret.
      await symlink("/etc/passwd", path.join(site, "evil.js"), "file");
      assert.equal(resolveReviewSiteFile(dir, TASK_ID, ["evil.js"]), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("reviewSiteCsp (design C5/R2 quarantine)", () => {
  it("emits the full policy with an allow-listed CDN", () => {
    const csp = reviewSiteCsp("https://cdn.example.test");
    assert.equal(
      csp,
      "default-src 'self'; " +
        "script-src 'self' https://cdn.example.test; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "connect-src 'none'; " +
        "frame-ancestors 'self'; " +
        "base-uri 'none'; " +
        "form-action 'none'; " +
        "object-src 'none'",
    );
  });

  it("blocks framing, network reach-back, forms, and plugins", () => {
    const csp = reviewSiteCsp();
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /object-src 'none'/);
  });

  it("defaults to an empty allowlist: script-src 'self' with no trailing space", () => {
    const csp = reviewSiteCsp();
    assert.match(csp, /script-src 'self';/);
    // No CDN token leaked in, and no `script-src 'self' ;` trailing-space bug.
    assert.doesNotMatch(csp, /cdn\./);
    assert.doesNotMatch(csp, /script-src 'self' ;/);
  });
});

// Integration: boot the real Express app and drive the review-site route over
// HTTP so assertions observe the ROUTE's response headers/status — not a helper
// re-deriving the expected value. This is the layer where the symlink escape
// (S1) was reachable and where the wrong CSP default (S2) would surface.
describe("review-site route (booted app over HTTP)", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function boot(): Promise<{ base: string; server: http.Server }> {
    const tasksDir = await makeTasksDir();
    dirs.push(tasksDir);
    const app = createApp({ tasksDir, user: "tester", port: 0, devReplay: false });
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    return { base: `http://127.0.0.1:${port}`, server };
  }

  function get(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      http
        .get(url, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
          );
        })
        .on("error", reject);
    });
  }

  it("serves a real file with the observed Content-Type and CSP headers", async () => {
    const { base, server } = await boot();
    try {
      const res = await get(`${base}/api/tasks/${TASK_ID}/review-site/index.html`);
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
      assert.equal(res.headers["content-security-policy"], reviewSiteCsp());
      // The served CSP must never exceed the gated (empty) allowlist.
      assert.match(String(res.headers["content-security-policy"]), /script-src 'self';/);
    } finally {
      server.close();
    }
  });

  it("returns 4xx (not 200) for a symlink that escapes the task tree", async () => {
    const { base, server } = await boot();
    try {
      const site = path.join(dirs[dirs.length - 1]!, TASK_ID, "artifacts", "review-site");
      await symlink("/etc/passwd", path.join(site, "evil.js"), "file");
      const res = await get(`${base}/api/tasks/${TASK_ID}/review-site/evil.js`);
      assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
      assert.doesNotMatch(res.body, /root:.*:0:0:/, "must not leak /etc/passwd contents");
    } finally {
      server.close();
    }
  });
});
