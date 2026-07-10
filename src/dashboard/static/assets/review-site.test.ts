import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/*
 * review-site.js is a plain classic script (loaded via <script src> in
 * index.html, sharing global scope with app.js — see that file's boot
 * order) — not an ES module, so it can't be `import`ed directly. It is
 * executed here in a Node `vm` context instead, which gives top-level
 * `var`/`function` declarations the exact same "attach to the global
 * object" behavior a browser `window` gives a classic script (confirmed:
 * that's true of both). This runs the REAL committed file, byte for byte —
 * no reimplementation to drift from what the browser actually loads.
 */
function loadReviewSite(): Record<string, unknown> {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "review-site.js"), "utf8");
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  new vm.Script(src, { filename: "review-site.js" }).runInContext(sandbox);
  return sandbox;
}

const { REVIEW_SANDBOX, reviewSiteSrc } = loadReviewSite() as {
  REVIEW_SANDBOX: string;
  reviewSiteSrc: (taskId: string) => string;
};

/*
 * The one thing this file exists to protect: the sandboxed iframe's trust
 * boundary (design/review-template.md §3 point 3, C1). `allow-same-origin`
 * must never appear on REVIEW_SANDBOX — its absence is what makes the
 * review site's origin opaque, so its JS cannot reach the dashboard's
 * cookies/storage/DOM or call /api/*. `allow-downloads` must stay present —
 * without it the verdict Export silently fails to download in Chrome 83+.
 */
describe("REVIEW_SANDBOX (iframe trust boundary)", () => {
  it("grants exactly allow-scripts and allow-downloads", () => {
    const tokens = REVIEW_SANDBOX.split(" ");
    assert.deepEqual(tokens.sort(), ["allow-downloads", "allow-scripts"]);
  });

  it("never grants allow-same-origin", () => {
    assert.ok(
      !REVIEW_SANDBOX.split(" ").includes("allow-same-origin"),
      "allow-same-origin would collapse the opaque-origin trust boundary (design doc Top risk / R2 RESOLVED)",
    );
  });
});

describe("reviewSiteSrc (Lane A URL shape, fixture README)", () => {
  it("points at GET /api/tasks/:id/review-site/index.html", () => {
    assert.equal(
      reviewSiteSrc("task-2026-07-09-001"),
      "/api/tasks/task-2026-07-09-001/review-site/index.html",
    );
  });

  it("encodes the task id so it cannot break out of the path segment", () => {
    const src = reviewSiteSrc("../etc/passwd");
    assert.equal(src, "/api/tasks/..%2Fetc%2Fpasswd/review-site/index.html");
    assert.ok(!src.includes("/../"));
  });
});

/*
 * The tests above protect the constant. They would NOT catch app.js
 * hardcoding its own sandbox string instead of using REVIEW_SANDBOX (e.g. a
 * future edit that "helpfully" inlines the value and typos in
 * allow-same-origin). Read the real, committed app.js source and check the
 * rendered <iframe> markup directly — the closest thing to a DOM assertion
 * available without adding a jsdom dependency for two lines of template.
 */
describe("app.js renderReviews() markup (source-level regression guard)", () => {
  const appJsPath = join(dirname(fileURLToPath(import.meta.url)), "app.js");
  const appJs = readFileSync(appJsPath, "utf8");
  const iframeTag = appJs.match(/<iframe[^>]*>/)?.[0];

  it("app.js defines exactly one <iframe> tag, for the review site", () => {
    assert.ok(iframeTag, "expected app.js to contain an <iframe ...> template");
  });

  it("that <iframe> sets sandbox from REVIEW_SANDBOX, not a hardcoded string", () => {
    assert.match(iframeTag ?? "", /sandbox="\$\{esc\(REVIEW_SANDBOX\)\}"/);
  });

  it("no literal sandbox=\"...\" attribute in app.js ever includes allow-same-origin", () => {
    const literalSandboxAttrs = appJs.match(/sandbox\s*=\s*"[^"]*"/g) ?? [];
    for (const attr of literalSandboxAttrs) {
      assert.ok(
        !attr.includes("allow-same-origin"),
        `found a hardcoded sandbox attribute granting allow-same-origin: ${attr}`,
      );
    }
  });

  it("the <iframe> src is built from reviewSiteSrc(), not a hardcoded path", () => {
    assert.match(iframeTag ?? "", /src="\$\{esc\(reviewSiteSrc\(id\)\)\}"/);
  });
});
