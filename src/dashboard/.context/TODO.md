# TODO — dashboard

Deferred work colocated with the dashboard. Full triage: work-dir `gaps-backlog.md`.
Active design: work-dir `design-review-bundle-cdn.md` (design-lead).

- [ ] **Review bundle in the dashboard + per-skill CDN allowlist** (#8) — surface the
  `microct-review-artifact` HTML bundle here: a "Reviews" view that loads it in a
  **sandboxed iframe** (`sandbox="allow-scripts"`, NO `allow-same-origin`) so the
  skill/LLM-authored JS can't reach the API. Per-skill CDN allowlist → the iframe's
  CSP `script-src` (skill declares CDNs; harness stamps them). This is the demo's
  north-star ("dashboard shows review chain") — see the design doc before building.
