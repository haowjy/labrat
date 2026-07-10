# AGENTS.md — LabRat

## What this is

LabRat is an **autonomous execution harness** for scientific protocols, on the
Claude Agent SDK (Node 24, TS ESM strict). A worker agent executes a protocol
phase-by-phase; an **independent reviewer agent** verifies each phase; the run
emits a **provenance trail + review chain** to the dashboard. It is **not** an
authoring tool — protocols and skills are authored in **Claude Science** and
live in the registry, not this repo.

## Mental model

- **Disk is the contract.** Phases, gates, provenance, and events are files
  under the task tree. Every layer (harness, reviewer, dashboard) reads/writes
  that tree — state is not passed in memory across layers.
- **Worker ↔ independent reviewer.** The reviewer runs in its own session behind
  a trust boundary, writes its own verification, and gates each phase. Don't
  collapse them or leak the reviewer's private state to the worker.
- **Protocols/skills live in the registry**, not here:
  `$CLAUDE_SCIENCE_HOME/orgs/*/skills/<name>/`. This repo is the execution loop.
- **Skills declare requirements; user config owns policy/secrets; the harness
  enforces.** The same seam governs deps, model, substrate, and permissions.

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
- Domain (OA / micro-CT), the authored skills, product thesis, and the Claude
  Science relationship → KB `labrat-domain-and-skills.md`
