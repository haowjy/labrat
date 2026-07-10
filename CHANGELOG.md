# Changelog

All notable changes to LabRat are documented here. Caveman style: terse, behavioral.

## [Unreleased]

### Added
- Single config seam (`labrat.config.json` + env), precedence `default < file < env < protocol.yaml < agent-def`. Set `defaultModel`, `defaultProtocol`, `scienceHome`, dashboard `port`/`url`/`user` without touching code.
- `model` and `permissions` (permissionMode) are now per-agent fields on `AgentProfile`, mirroring the SDK's `AgentDefinition`. Protocol authors pick the model per agent; run-wide defaults come from config.
- `toy-stats` demo protocol: stdlib-only (fake data → classify → OLS regression), independent reviewer recomputes and gates each phase. Runs on Haiku in seconds, no imaging deps.
- Runs now reach `state: done` and emit a `task-done` event when all protocol phases pass.
- `labrat.config.example.json` template; retry knobs via env (`LABRAT_WORKER_STALL_RETRIES`, `LABRAT_REVIEW_ATTEMPTS`, `LABRAT_PHASE_ATTEMPTS`).

### Changed
- Runtime provisioning is now driven by a per-skill `environment.yml` (micromamba/conda env spec) instead of a hardcoded `microct_analysis` special-case (#2). `protocol.runtime.substrate` is required (no silent default); `protocol.runtime.deps` is declarative only.
- Walked phase list comes from `protocol.yaml` instead of a hardcoded two-phase constant.
- Dashboard config derives from the shared config seam; SSE dev-replay reads a real task on disk (`LABRAT_REPLAY_TASK`) instead of a hardcoded bonemorph run.
- Reviewer sessions only skip permissions when the resolved mode is `bypassPermissions`.

### Removed
- Machine-specific defaults: personal PYTHONPATH, the `jimmy@voluma.bio` default author (now OS username), duplicated `4600`/`~/.claude-science` literals, and the silent `bonemorph-oa-mouse-knee` default protocol (now errors clearly when no protocol is given).
- `runtime-setup/verify.ts` moved out of shipped `src/` to `scripts/` (microct-only manual smoke script).
- Hardcoded `microct_analysis` pip-install recipe (`MICROCT_ANALYSIS_PIP_SPECS`, `DEFAULT_SUBSTRATE`) and the fragile per-package import probe (`probePythonImports`) — `micromamba create -f environment.yml` now fails loudly on unresolved packages, so a create success is the guarantee.

### Fixed
- Config: tilde expansion for `microctSrc` from a file; reject zero/negative retry and port values; reject unknown config keys; single `loadConfig()` per enqueue.
