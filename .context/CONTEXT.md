# CONTEXT — LabRat repo reference

Reference depth for working in this repo. See `../AGENTS.md` for intent and the
mental model; the KB (`labrat-domain-and-skills.md`) for domain and skills.

## Config seam (contract)

`src/config/index.ts` `loadConfig(env?, cwd?) → LabratConfig`. Precedence:
`built-in default < labrat.config.json < env < protocol.yaml < agent-def`.
User settings in `labrat.config.json` (gitignored); `labrat.config.example.json`
is tracked. Per-agent `model` and `permissions` live on `AgentProfile`, mirroring
the SDK's `AgentDefinition`; run-wide defaults come from config.

## Runtime substrate

Per-skill Python env provisioned from `<skillDir>/environment.yml` via micromamba
(claude-science conda at `$CLAUDE_SCIENCE_HOME/conda`). `protocol.runtime.substrate`
is **required** (errors if absent). `protocol.runtime.deps` is declarative — it
drives non-python (binary/conda/env) validation only, not installation;
`environment.yml` is the authoritative install manifest.

## Session env (must-know)

Every harness-spawned session (worker, gate-reviewer, monitor, author,
feedback-router) must carry `SESSION_ENV_HARDENING`
(`src/harness/session/session-env.ts`, `ENABLE_TOOL_SEARCH=false`) — Claude
Code's progressive tool disclosure can defer and then drop an in-process
MCP tool (e.g. `record_phase`) after a long turn, mis-reporting a completed
phase as a stall. A new session builder that skips it silently reopens that
bug. See KB `labrat-worker-completion-reliability.md` for the full root
cause and the progress-based stall detector this pairs with.

## Task tree (disk-is-the-contract)

A run writes phase records, gate decisions, the provenance manifest, and the
reviewer's verification files under the task dir. The dashboard API reads that
tree; SSE (`/events`) carries **notifications only** — clients re-read the API on
each event, never reading data off the stream. All lifecycle transitions funnel
through `notifyEvent` (harness) → `publishEvent` (dashboard) — the single event
seam.

## Commands

- `npm run typecheck` · `npm test` (node:test) — before finishing any change.
- `npm run dev -- enqueue <dicom-path-or-zip> [protocol-name]` — run a protocol
  (prefix `CLAUDE_SCIENCE_HOME=~/.claude-science` if non-default).
- `scripts/export-skills-to-claude-science.sh [--dry-run]` — install the repo's
  vendored `skills/` into the Claude Science registry (where the harness reads
  them). The bridge between repo-as-source-of-truth and the runtime load path.
- Dashboard binds `localhost:4600`. This sandbox SIGTERMs listening sockets —
  verify dashboard logic via its loaders, not by hosting it.
- The dashboard runs via `tsx` and caches modules at process start: a
  running daemon won't pick up new dashboard-side code (e.g. a new API
  field) until restarted. An empty-looking review artifact that should be
  populated is often a stale daemon, not a data bug — restart before
  debugging further.
- Per-phase review sites on disk hold `__REVIEW_INJECT:*` sentinel
  placeholders, not real geometry/volume data — the dashboard splices the
  real bytes in at serve time. Opening the raw `artifacts/review-sites/`
  `index.html` via `file://` shows an empty scene and looks like a data-loss
  bug; it isn't. Always verify through
  `/api/tasks/:id/review-sites/:phase/index.html`. See KB
  `labrat-review-bundle-trust-model.md`.
