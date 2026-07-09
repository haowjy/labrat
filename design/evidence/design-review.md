# LabRat system-design review

## What I reviewed

- Design under review: `$MERIDIAN_ACTIVE_WORK_DIR/design/00-system-design.md`
- Requirements source of truth: `requirements/README.md`, `requirements/architecture/*.md`, `requirements/protocols/*.md`, `requirements/demo.md`
- SDK audit: `$MERIDIAN_ACTIVE_WORK_DIR/findings/agent-sdk-capabilities.md`
- Runtime findings: `$MERIDIAN_ACTIVE_WORK_DIR/findings/cs-skills-map-full.md`
- Spot-checked actual Claude Science skills under `~/.claude-science/.../skills/` and the OA6-1RK data/dependency state.

## Verdict

**Request changes.** The design has the right macro-shape (disk contract, fresh reviewer, harness orchestrator), but the phase-boundary design is currently missing the durable computational artifacts that make later phases possible. If implemented as written, the Wed vertical slice can write pretty phase folders and still fail the actual landmark/measurement path because the data needed by later phases lived only in Python memory or in untracked intermediate files.

## Ranked findings

### 1. P0 — Session-per-phase compaction drops the only state downstream phases need

**What is wrong**

Design §6 says each phase runs as its own fresh `query()` and only carries forward a “compact digest of prior phase summaries” read from `summary.md` (design lines 152-177). The disk contract lists prose/JSON/evidence/code phase files, but not durable machine-readable intermediates such as the loaded HU volume, label volume, bone masks, transform/orientation, meshes, landmark session cache, or segmentation assignment map (design lines 91-103; requirements `task-directory.md` lines 13-72).

That is not enough for the next phase. Landmark placement needs the actual segmented labels/masks/meshes, not a summary and PNGs. Measurement needs landmark coordinates plus transforms and voxel spacing. The design’s “disk is the contract” claim is correct only for review UI artifacts, not for computational continuity.

The Python state question is the highest-risk part: the SDK audit confirms the worker can run `Bash` (SDK audit lines 333-359), but it does **not** establish a persistent Python kernel/process across Bash tool calls or across `query()` sessions. The runtime audit also found the claimed `mc_*` kernel helpers do not exist and no `kernel.py` ships with the microCT skills (`cs-skills-map-full.md` lines 113-120, 134-176). Therefore the design must assume that in-memory DICOM volumes/NumPy arrays die at every script invocation and definitely at a fresh `query()` boundary unless explicitly persisted.

**Concrete failure scenario**

Wednesday succeeds superficially: intake loads the 453 MB / 877-slice OA6-1RK DICOM series and segmentation writes `summary.md`, `measurements.json`, and screenshots. Then the orchestrator starts a fresh landmarks session. The worker sees only “segmentation complete” plus a few evidence PNGs. It has no label volume or mesh path, so it either:

1. re-loads DICOM and re-runs segmentation from scratch, burning demo time and risking non-identical outputs; or
2. places landmarks from screenshots/prose, which is scientifically invalid; or
3. stalls because the expected `mc_*`/kernel state is gone.

Even within a single phase, if the agent writes `python segment.py` repeatedly via Bash, any loaded arrays disappear between Bash invocations unless scripts serialize them. Killing the agent session is not the only problem; the design has no durable computational state contract at all.

**Fix direction**

Make computational artifacts first-class in the disk contract before implementing phase compaction:

- Add a `work/` or `artifacts/` layer for large machine-readable outputs, e.g. `work/intensity.npy|zarr|nii.gz`, `phases/segmentation/artifacts/labels.nii.gz`, `bone_assignments.json`, `spacing.json`, `transforms.json`, `meshes/*.npz`, `landmarks.json`.
- Add those paths to `manifest.yaml` and to each phase’s schema as typed inputs/outputs, not as incidental files.
- Prompt every fresh phase with **artifact paths**, not just summaries: “load labels from X, intensity from Y, spacing from Z.”
- Decide explicitly whether each phase re-runs prior code or reloads cached artifacts. For a live demo, prefer reload cached artifacts and benchmark it.
- Add a Wed gate: run intake → segmentation → fresh process landmarks smoke test using only disk artifacts.

Reference package note: `/home/jimyao/gitrepos/prompts/microct-analysis/src/microct_analysis/processing/session_cache.py` already models this idea by persisting paths/mesh state and requiring explicit volume reloads. Use that pattern instead of relying on vanished Python memory.

### 2. P0 — `record_phase` cannot magically terminate the SDK async-generator loop

**What is wrong**

Design §6/§8 says the `record_phase` tool handler “returns a terminal result that ends the phase turn-loop” and then the orchestrator starts a new `query()` (design lines 163-172, 209-212). The SDK audit confirms custom tools are in-process (SDK audit lines 157-205), but it does **not** show a tool-result type that terminates `query()`. The exposed control primitives are on the `Query` object (`interrupt()`, `close()`, `streamInput()`, etc.; SDK audit lines 74-86), not on a tool handler return.

**Concrete failure scenario**

The worker calls `record_phase({phase:"segmentation"})`. The handler validates and appends the manifest. The model receives “recorded” and continues in the same old session: “Now I will proceed to landmarks…”, writes `phases/landmarks/`, maybe calls `record_phase` again. Meanwhile the orchestrator, assuming the loop ended, starts a second fresh landmarks `query()`. Now two sessions race on the same task directory and the dashboard sees duplicate/inconsistent phase state.

The opposite failure is also possible: the harness closes the query too early from inside/around the handler and the tool result never reaches the model cleanly, leaving the SDK session in an error state.

**Fix direction**

Design the handoff as an explicit orchestrator protocol:

- `record_phase` handler validates/appends manifest, sets an in-process `phaseComplete` flag, and returns a plain tool result that says “phase recorded; stop now; do not start the next phase.”
- The outer `for await (const msg of query(...))` loop observes the tool use/result or `phaseComplete` flag, then calls `query.close()`/`query.interrupt()` at a safe point and awaits session end.
- The next `query()` starts only after the previous query is fully closed.
- Add a Wed SDK spike that proves this exact flow with a fake worker calling `record_phase` and attempting to continue.

Do not encode “terminal result” as a design assumption unless the SDK proves it.

### 3. P0 — Reviewer is specified to write files but is not allowed to write

**What is wrong**

Design §7 says the reviewer writes `review/reviewer_report.md` and `review/verdict.json` (design lines 194-198). Design §8 then sets reviewer `allowedTools` to `Read`, `Grep`, `Glob`, and `explore_anchor` only, explicitly “no Bash/Write” (design lines 217-220). That is an internal contradiction and will block the Thursday reviewer/dashboard milestone.

**Concrete failure scenario**

The reviewer runs, forms a verdict, but cannot persist it. The dashboard keeps polling `review/verdict.json`, sees nothing, and the task never reaches “review-complete” except through an ad hoc harness hack. If someone fixes this by granting broad `Write`, the reviewer can accidentally mutate worker phase artifacts, destroying the independence/trust boundary.

**Fix direction**

Pick one explicit output path:

- Preferred: reviewer returns a structured final JSON/prose response in the SDK stream; the harness validates it and writes `review/reviewer_report.md` and `review/verdict.json`. Reviewer stays read-only with respect to task artifacts.
- Alternative: allow `Write` only inside `tasks/{task-id}/review/` via sandbox/permissions and keep phase dirs read-only.

If reviewer evidence is required (`task-directory.md` lines 77-80), either make it harness-generated or grant a tightly scoped write area for `review/reviewer_evidence/`.

### 4. P1 — Reviewer independence is weaker than the design claims

**What is wrong**

The design correctly avoids forking the worker conversation, but then seeds the reviewer with worker-authored summaries/one-liners and makes `decisions.md`/anchors the natural review surface (design lines 187-199). Requirements say the reviewer’s primary surface is structured outputs and evidence, and anchors are selective drill-down only (`agents.md` lines 21-41; `reviewer-anchoring.md` lines 22-25, 126-135).

Worker summaries and decisions are not chain-of-thought, but they are still the worker’s narrative. If the reviewer reads “threshold set to 2500 HU based on histogram bimodality” before inspecting the histogram/mask evidence, it is primed to accept the worker’s rationale. Anchor target files can also contain full turn content (`reviewer-anchoring.md` lines 67-69, 90-113), so careless anchor use reintroduces the same bias the architecture is trying to avoid.

**Concrete failure scenario**

The worker misidentifies femur/tibia with a low margin but writes a confident explanation in `decisions.md`. The reviewer prompt includes that explanation and only checks that measurements fall inside broad gates. The live demo shows “independent reviewer passed” even though the reviewer never independently inspected the segmentation evidence or challenged bone identity.

**Fix direction**

Make the reviewer workflow evidence-first and enforce it in the prompt/schema:

1. Read manifest/file paths, measurements, confidence flags, and evidence images first.
2. Produce an independent checklist/gate table from artifacts.
3. Only then read `decisions.md` and use anchors for discrepancies or uncertainty.
4. Keep anchor lookup bounded and label it as worker-history context, not primary evidence.

Do not seed reviewer with worker “compact digest” beyond phase names, artifact paths, and machine values.

### 5. P1 — Disk-as-contract is undermined by non-authoritative SSE/log state and non-atomic updates

**What is wrong**

Design §2 says SSE only carries notifications that disk changed, never primary data (design lines 22-26). Design §10 then adds a live `log` event “tapped from the streamed worker messages” with “no disk dependency” (design lines 232-246). State transitions are also written to `task.json` and emitted as SSE events, but the design does not specify atomic write ordering (design line 130).

**Concrete failure scenario**

During the demo, the ticker streams “gate check: femur length 2.42mm PASS” from assistant text before `measurements.json` is written/validated. The worker later revises or `record_phase` rejects the phase dir. The dashboard has already shown a pass that never existed in authoritative disk state. Similarly, if `phase-complete` SSE fires before `manifest.yaml`/`task.json` are atomically flushed, the dashboard re-reads disk and renders a missing/partial phase.

**Fix direction**

- Treat `log` events as explicitly ephemeral transcript snippets, visually separate from validated phase status.
- Emit `phase-complete` only after temp-file → fsync/rename writes for phase validation, manifest, and `task.json` have completed.
- Use atomic write helpers for `task.json`, `manifest.yaml`, `verdict.json`, `suggestions.json`.
- Consider putting the live ticker lines into `logs/worker.jsonl` first, then SSE “new log line” as a notification, preserving the disk contract even for demo logs.

### 6. P1 — Build order underprices the real Wed critical path: DICOM/segmentation/rendering performance

**What is wrong**

The design adds `runtime-setup` first, which is good, but the Wed gate only says “verify a DICOM loads” and then run intake + segmentation (design lines 253-264). It does not price the harder live-demo risks:

- current shell `python3` lacks `pydicom`, `skimage`, `scipy`, `matplotlib`, and `nibabel` (verified locally; runtime audit also notes missing deps at `cs-skills-map-full.md` lines 113-120);
- the real sample is 877 DICOM files / 453 MB (requirements `mouse-knee-oa.md` lines 11-15; verified locally);
- headless 3D PNG evidence generation can fail or be slow depending on backend/browser/mesh size; the review skill explicitly warns that static Plotly/Kaleido export needs a browser the sandbox may lack and recommends matplotlib self-check images instead (actual `microct-review-artifact/SKILL.md` lines 47-59).

**Concrete failure scenario**

Wednesday spends most of the day installing dependencies and getting DICOM load working. Segmentation finally runs, but 3D evidence rendering fails headlessly or takes minutes per view. Thursday dashboard has no compelling images, and Friday’s live ticker stalls on a long reload/re-render.

**Fix direction**

Move these to the first Wed acceptance test, before schema polish:

1. install/import deps in the exact environment the worker will use;
2. load all 877 DICOM slices and record wall time/memory;
3. run threshold + watershed on the real sample and persist labels;
4. generate the exact PNG evidence set headlessly using the chosen backend;
5. reload persisted labels in a fresh process and render landmarks smoke-test.

If any step exceeds demo tolerance, precompute/cache artifacts and make that an honest part of the demo design.

### 7. P1 — Skill loading is underspecified and may omit required methodology/resources

**What is wrong**

Requirements define the first protocol as a composition of three Claude Science skills: `microct-3d-analysis`, `bonemorph-oa-mouse-knee`, and `microct-review-artifact` (`mouse-knee-oa.md` lines 3-10). The actual `bonemorph-oa-mouse-knee` skill says to load `microct-3d-analysis` first (skill lines 14-18). The design’s system prompt says “[1] Skill instructions (SKILL.md body for the protocol)” singular and ground-truth gates (design lines 138-145), then later says it does not use native skill loading but injects SKILL.md + gates manually (design lines 336-340).

That can easily load only the application skill and miss the detailed methodology resources (`reference-calibration.md`, segmentation/alignment/landmark resources) that tell the worker how to do the render→reason→validate loop.

**Concrete failure scenario**

The worker receives the bonemorph overview and the runtime note saying `mc_*` helpers do not exist, but not the full `microct-3d-analysis` resource map. It falls back to running a fixed package pipeline or ad hoc heuristics, undermining the “agentic code writing” requirement and increasing landmark errors.

**Fix direction**

Define a protocol bundle loader:

- explicitly concatenate or stage the required source skills in a stable order: `microct-3d-analysis` methodology, `bonemorph-oa-mouse-knee` protocol, selected `microct-review-artifact` evidence-generation guidance;
- include exact resource/asset paths for progressive disclosure;
- inject the LabRat `record_phase` rule and the runtime substrate note after the skill content;
- make the static prefix byte-stable for caching.

### 8. P2 — ROI/trabecular morphometry is silently downgraded

**What is wrong**

The mouse-knee protocol includes an ROI phase and trabecular morphometry outputs (BV/TV, Tb.Th, Tb.N, Tb.Sp) (`mouse-knee-oa.md` lines 46-57; task layout lines 53-72). Design §11 says the ROI phase is skippable and E2E can go landmarks → measurement if time is tight (design lines 281-283).

That may be a reasonable demo cut, but it is not labeled as a protocol deviation in the data model or demo narrative.

**Concrete failure scenario**

The final dashboard claims “OA mouse-knee protocol complete” while omitting the trabecular VOI/morphometry part of the stated protocol. A judge or domain user asks where BV/TV/Tb.Th/Tb.N/Tb.Sp are, and the provenance does not clearly say they were intentionally not run.

**Fix direction**

Either keep a minimal ROI/morphometry path in scope, or explicitly narrow the demo to “geometric indices only” and record a protocol deviation in `manifest.yaml` and the dashboard. Do not present a skipped ROI as full protocol completion.

### 9. P2 — Suggestions loop is present in UI terms but not integrated with Claude Science authoring

**What is wrong**

Requirements say per-phase suggestions are stored in a local DB and accumulated suggestions are readable by the skill author in Claude Science (`system.md` lines 70-72; `demo.md` lines 47-50). The design says dashboard `POST` writes `suggestions.json + local DB` (design lines 59-64) but does not define the schema, export/read path, or how Claude Science sees it.

**Concrete failure scenario**

The demo user types “Growth plate boundary looks too deep,” the dashboard stores some text, but there is no stable artifact for the skill author to consume later. The pitch line “feeds back to Claude Science” becomes hand-wavy.

**Fix direction**

Define `suggestions/suggestions.json` now with `taskId`, `phase`, `artifactRef`, `measurementRef`, `text`, `createdAt`, and optional `author`. Add an export/copy path or documented location that Claude Science/skill author reads. This can be tiny, but it needs to be real for the demo beat.

