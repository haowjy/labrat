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
- Dashboard binds `localhost:4600`. This sandbox SIGTERMs listening sockets —
  verify dashboard logic via its loaders, not by hosting it.
