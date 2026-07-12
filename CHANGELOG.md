# Changelog

All notable changes to LabRat are documented here. Caveman style: terse, behavioral.

## [Unreleased]

### Added
- Single config seam (`labrat.config.json` + env), precedence `default < file < env < protocol.yaml < agent-def`. Set `defaultModel`, `defaultProtocol`, `scienceHome`, dashboard `port`/`url`/`user` without touching code.
- `model` and `permissions` (permissionMode) are now per-agent fields on `AgentProfile`, mirroring the SDK's `AgentDefinition`. Protocol authors pick the model per agent; run-wide defaults come from config.
- `toy-stats` demo protocol: stdlib-only (fake data → classify → OLS regression), independent reviewer recomputes and gates each phase. Runs on Haiku in seconds, no imaging deps.
- Runs now reach `state: done` and emit a `task-done` event when all protocol phases pass.
- `labrat.config.example.json` template; retry knobs via env (`LABRAT_WORKER_STALL_RETRIES`, `LABRAT_REVIEW_ATTEMPTS`, `LABRAT_PHASE_ATTEMPTS`).
- Dashboard "Reviews" view: embeds a task's review site in `<iframe sandbox="allow-scripts allow-downloads">` (opaque origin, no `allow-same-origin`) at the Lane A URL shape `/api/tasks/:id/review-site/index.html`. A phase whose recorded outputs include `artifacts/review-site/` (`getTask`'s `hasReviewSite`) gets an "Open review site" link from both the review-chain and provenance views, so the review site is a first-class node in the chain. Mobile-first: no horizontal overflow at 375px, every nav/action tap target ≥44px, the frame fills the remaining viewport via flex instead of a vh guess.
- Human-triggered send-back: dashboard "Send back" (needs a note) writes a `changes_requested` human verdict; `labrat rerun <task-id> [from-phase] [--force]` re-runs that phase + downstream, threading the human note into the worker prompt while the independent reviewer re-gates from scratch. The mark is consumed on the re-run's gate PASS (archived to `verdict/<phase>.attempt-N.json`), so a later send-back can't rewind to a stale one. `rerun` refuses a `running` task unless `--force`.
- Claude Science import bridge: `labrat skills [--builtins]` lists registry skills (with runnable / vendored / builtin flags) and `labrat import-skill <name> [--force]` copies one into the repo's `skills/` tree (inverse of the export script; `--force` is a true replace). Dashboard "Claude Science" view browses the registry; import stays a CLI action (dashboard is read-only Process B).
- Review-chain export: `GET /api/tasks/:id/export` downloads a JSON bundle (task, provenance, per-phase gate / human-verdict / measurements / suggestions); the task view gains "Export review chain" and "Copy folder path" (for handing a run back to Claude Science to improve the skill).
- G9 review-site linter gate: on `review_layout: "spatial-multipane"` artifacts, statically asserts an evidence-led 3D review surface — `scene3d` in `required_views` with its `[data-review-view="scene3d"]` element + a `<canvas>`, a real inlined three.js scene (`WebGLRenderer` + `OrbitControls` + a camera token), and a `REVIEW_EVIDENCE` global carrying a non-empty `.landmarks` array. Orthogonal-slice ingredients (range slider + canvas + `REVIEW_VOLUME`/`REVIEW_SLICES` global) are asserted only when `slice-<axis>` views are declared, so a 3D-only specimen with no volume still passes. Values-table reviews auto-pass, so single-pane protocols are unaffected. Makes the 3D landmark evidence a gate-enforced deliverable, not just skill guidance.
- Folder-watch control panel: `labrat watch` runs a supervisor daemon that claims dropped DICOM inputs by atomic move (incoming → in-progress → done) and enqueues each, driven by dashboard-written desired state (`control/watcher.json`) with live status back on disk (`control/watcher-status.json`). A single-daemon lease (atomic rename-steal + content-verify + restore) keeps two supervisors from racing the same drop; runs until SIGINT/SIGTERM. Dashboard "Watch" panel sets watched roots and shows status.
- Dashboard co-launch: `enqueue`/`run-phase`/`resume`/`rerun` start the dashboard in-process and await it listening, so the live view is up for the whole run; skip with `--no-dashboard`. The harness stays disk-first — one warning if the dashboard is unreachable, then silence (events keep hitting disk regardless).
- 3D review artifact: the spatial review site opens on a rotatable three.js scene (vendored three.js r137 + OrbitControls, fully inlined, no CDN) with the agent's landmarks as DOM leader-line labels, auto-framed anatomy, a guided landmark tour, and a mobile-first full-screen viewer. Read-only review (no landmark drag-edit); the orthogonal-slice tab is hidden when no volume was exported.

### Changed
- Runtime provisioning is now driven by a per-skill `environment.yml` (micromamba/conda env spec) instead of a hardcoded `microct_analysis` special-case (#2). `protocol.runtime.substrate` is required (no silent default); `protocol.runtime.deps` is declarative only.
- Walked phase list comes from `protocol.yaml` instead of a hardcoded two-phase constant.
- Dashboard config derives from the shared config seam; SSE dev-replay reads a real task on disk (`LABRAT_REPLAY_TASK`) instead of a hardcoded sample run.
- Reviewer sessions only skip permissions when the resolved mode is `bypassPermissions`.
- Review-chain view derives the before/after "hero" comparison from the reviewer's OWN recomputed numbers (its `recomputed`/`ratios`/`values` containers), never falling back to the worker's value: a corrected phase shows the reviewer's independent measurement, and an unverifiable one reads "pending" instead of silently echoing the worker.

### Removed
- Machine-specific defaults: personal PYTHONPATH, the `jimmy@voluma.bio` default author (now OS username), duplicated `4600`/`~/.claude-science` literals, and the silent `microct-oa-mouse-knee` default protocol (now errors clearly when no protocol is given).
- `runtime-setup/verify.ts` moved out of shipped `src/` to `scripts/` (microct-only manual smoke script).
- Hardcoded `microct_analysis` pip-install recipe (`MICROCT_ANALYSIS_PIP_SPECS`, `DEFAULT_SUBSTRATE`) and the fragile per-package import probe (`probePythonImports`) — `micromamba create -f environment.yml` now fails loudly on unresolved packages, so a create success is the guarantee.

### Fixed
- Config: tilde expansion for `microctSrc` from a file; reject zero/negative retry and port values; reject unknown config keys; single `loadConfig()` per enqueue.
