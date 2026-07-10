"use strict";
/*
 * Review-site embedding contract (design/review-template.md §1 I5, §3 point 3;
 * fixture README "URL shape"). Split out of app.js into its own file because
 * these two facts are the trust-boundary-critical ones every reviewer/agent
 * touching this code must not casually "fix":
 *
 *   - REVIEW_SANDBOX never gains `allow-same-origin`. The iframe must stay
 *     opaque-origin so the quarantined review site's JS cannot read the
 *     dashboard's cookies/storage/DOM or call /api/*. `allow-downloads` is
 *     required for the verdict Export to work in Chrome 83+ and does NOT
 *     grant any same-origin capability (C1 / design doc principle 3).
 *   - reviewSiteSrc() must match the URL shape Lane A serves (pinned in
 *     validation/fixtures/review-site/README.md): GET
 *     /api/tasks/:id/review-site/*path, defaulting to index.html.
 *
 * Plain classic script (index.html loads it before app.js, same as app.js's
 * own internal functions) — no `document`/`window` access, `var`/`function`
 * only (not `const`/`let`), so top-level declarations attach to the global
 * object the exact same way in a browser and in a Node `vm` context. That's
 * what makes review-site.test.ts able to load and assert this file directly
 * with no bundler and no reimplementation to drift from what app.js runs.
 */

var REVIEW_SANDBOX = "allow-scripts allow-downloads";

/** GET .../review-site/index.html for one task, per the pinned URL shape. */
function reviewSiteSrc(taskId) {
  return "/api/tasks/" + encodeURIComponent(taskId) + "/review-site/index.html";
}
