# AGENTS.md — LabRat

## What this is

LabRat is an **autonomous execution harness** for scientific protocols, on the
Claude Agent SDK (Node 24, TS ESM strict). A worker agent executes a protocol
phase-by-phase; an **independent reviewer agent** verifies each phase; the run
emits a **provenance trail + review chain** to the dashboard. It is **not** an
authoring tool — the skills are authored in **Claude Science**; this repo
**vendors** the project's skills under `skills/` and executes them.

## Mental model

- **Disk is the contract.** Phases, gates, provenance, and events are files
  under the task tree. Every layer (harness, reviewer, dashboard) reads/writes
  that tree — state is not passed in memory across layers.
- **Worker ↔ independent reviewer.** The reviewer runs in its own session behind
  a trust boundary, writes its own verification, and gates each phase. Don't
  collapse them or leak the reviewer's private state to the worker.
- **The repo is a Claude plugin** (`.claude-plugin/plugin.json`): project skills
  vendored in `skills/`, agent role defaults in `agents/` (worker, gate-reviewer).
  The running harness still resolves skills from the registry
  (`$CLAUDE_SCIENCE_HOME/orgs/*/skills/`) — the vendored copies are the
  open-source/submission source of truth; wiring the loader to read `skills/`
  and `agents/` is a follow-up. See `.context/CONTEXT.md`.
- **Skills declare requirements; user config owns policy/secrets; the harness
  enforces.** The same seam governs deps, model, substrate, and permissions.

## Running protocols

The CLI is the primary interface. Skills must be in the Claude Science registry
before the harness can load them — export first if you changed `skills/`.

```bash
# Export vendored skills to the Claude Science registry
scripts/export-skills-to-claude-science.sh

# Run a protocol against real data
npm run dev -- enqueue <dicom-path-or-zip> [protocol-name]

# Full microct e2e (OA6-1RK specimen, all 6 phases, Opus worker)
npm run e2e

# Toy-stats smoke test (fast, Haiku, no imaging deps)
npm run smoke
```

The CLI also supports: `gate`, `run-phase`, `resume`, `rerun`, `reset-to`,
`check-review-site`, `skills`, `import-skill`. Run `npm run dev` with no args
for usage.

A folder watcher (`src/harness/watcher/`) is stubbed but not yet wired — today
runs are CLI-initiated. Dashboard enqueue is planned.

## Key rules

- Verify every change: `npm run typecheck && npm test` before finishing.
- One config seam — `src/config/index.ts` `loadConfig()`. Thread resolved values
  from it; don't reintroduce scattered defaults or read env in leaf code.
- Planning / requirements / pitch / decision docs live in the Meridian work dir
  and KB — never in this repo.

## Anti-patterns

- Restating a skill's or the KB's knowledge here. Point, don't duplicate.
- Carrying task state in memory instead of through the task tree.
- Hosting the dashboard in this sandbox to test it — it SIGTERMs any port bind;
  drive its disk-read loaders instead.

## Depth

- Repo-local contracts, config precedence, runtime substrate, commands →
  [`.context/CONTEXT.md`](.context/CONTEXT.md)
- Domain (OA / micro-CT), the authored skills, and the Claude Science
  relationship → KB `labrat-domain-and-skills.md`
- Product vision and trust architecture → KB `labrat-vision.md`; build status
  and gh-issue-keyed roadmap → KB `labrat-roadmap.md`
