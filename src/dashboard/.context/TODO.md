# TODO — dashboard

Deferred work colocated with the dashboard. Full triage: work-dir `gaps-backlog.md`.

The review-site route, sandboxed-iframe "Reviews" view, and harness-bound
`check_review_site` gate (#8's core scope) shipped — see `reviewSiteCsp()` /
`resolveReviewSiteFile()` in `server.ts` and `static/assets/review-site.js`.
Trust model and rationale: KB `labrat-review-bundle-trust-model.md`.

- [ ] **Per-skill CDN allowlist wired into the served CSP** (#8, remaining
  slice) — `cdn_allowlist` is already a real `protocol.yaml` phase field the
  linter's G6 gate enforces authoritatively, but `reviewSiteCsp()` is always
  called with no argument in `server.ts`, so every served review site gets
  the same demo-scoped default (`script-src 'self' 'unsafe-inline'`, empty
  allowlist) instead of the phase's declared value. Thread the phase's
  `cdn_allowlist` through the route handler into the `reviewSiteCsp()` call.
