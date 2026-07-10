import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { resolveReviewSiteFile, reviewSiteCsp } from "./server.js";

// mime-types is what express's sendFile uses to set Content-Type, so it
// faithfully predicts the header the route emits. No bundled types; load it
// through require rather than pulling in a @types dep for one assertion.
const { contentType } = createRequire(import.meta.url)("mime-types") as {
  contentType: (name: string) => string | false;
};

// The committed Lane 0 fixture (validation/fixtures/review-site/) stands in for
// a task's artifacts/review-site/ tree. We build a throwaway task dir whose
// artifacts/review-site/ symlinks to it, so resolveReviewSiteFile resolves to
// real files without copying the fixture.
const FIXTURE = fileURLToPath(
  new URL("../../validation/fixtures/review-site", import.meta.url),
);
const TASK_ID = "task-2026-07-09-001";

async function makeTasksDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "labrat-review-site-"));
  const artifacts = path.join(dir, TASK_ID, "artifacts");
  await mkdir(artifacts, { recursive: true });
  await symlink(FIXTURE, path.join(artifacts, "review-site"), "dir");
  return dir;
}

describe("resolveReviewSiteFile (traversal guard via resolveTaskFile)", () => {
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

  it("rejects an invalid task id", () => {
    assert.equal(resolveReviewSiteFile("/tasks", "../evil", ["index.html"]), null);
  });
});

describe("reviewSiteCsp (design C5/R2 quarantine)", () => {
  it("emits the full policy with the allow-listed CDN", () => {
    const csp = reviewSiteCsp("https://cdn.example.test");
    assert.equal(
      csp,
      "default-src 'self'; " +
        "script-src 'self' https://cdn.example.test; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "connect-src 'none'; " +
        "frame-ancestors 'self'; " +
        "base-uri 'none'",
    );
  });

  it("blocks framing and network reach-back (C5 + connect-src)", () => {
    const csp = reviewSiteCsp();
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
  });

  it("uses the hardcoded demo allowlist by default", () => {
    assert.match(reviewSiteCsp(), /script-src 'self' https:\/\/cdn\.jsdelivr\.net https:\/\/cdn\.plot\.ly/);
  });
});
