# LabRat — Design

The concrete system design implementation agents build from. Extends
`../requirements/` (problem + approved requirements) with module boundaries,
interfaces, data flow, lifecycles, and build order.

## Read this first
- **[00-system-design.md](00-system-design.md)** — the design. Start at §2 (the
  load-bearing decision) and §11 (build order). §16 traces how every review
  finding was addressed.

## Evidence (grounds the SDK-dependent decisions — proof, not assertion)
- **evidence/agent-sdk-capabilities.md** — `@anthropic-ai/claude-agent-sdk@0.3.205`
  capability audit (what the harness relies on, with API + snippets + URLs).
- **evidence/poc-results.md** — throwaway POC that ran the risky spine LIVE
  against real SDK + auth. All 5 questions VERIFIED-LIVE (phase handoff,
  session-per-phase, hooks/anchors, concurrent sessions, disk-backed state).
- **evidence/design-review.md** — adversarial review of the design (9 findings,
  3 × P0). All folded into 00-system-design.md §16.
- **evidence/cs-skills-map.md** — what the worker actually loads from
  `~/.claude-science/` (the 3 skills, the missing `mc_*` helpers, the runtime).

## Status
DESIGN v2 — audited, reviewed, and POC-verified. Ready to build. The one product
choice the user made: worker runtime substrate = Option B (import the tested
`microct_analysis` package for hard parts; §14).

## Build order in one line
Prove the runtime on the real sample → `schema` → worker vertical slice
(intake+segmentation writing real `artifacts/`, then a fresh landmarks phase) →
reviewer + dashboard in parallel against that output → watcher→queue wiring,
end-to-end, polish, Tailscale, record demo. Risk then dependency, not a calendar. (§11)
