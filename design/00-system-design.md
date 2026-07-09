# LabRat — System Design

> Audience: implementation lead + build agents.
> Altitude: module boundaries, interfaces, data flow, lifecycles, build order.
> SDK: `@anthropic-ai/claude-agent-sdk@0.3.205`, proven by a live POC
> (`evidence/poc-results.md`). Evidence in `evidence/`.

## 1. Goals

1. **Working end-to-end demo** — file in → worker runs → reviewer checks →
   dashboard shows a reviewable chain.
2. **Genuinely independent reviewer** — fresh session per gate, reads artifacts
   off disk, applies a verification rubric. Not theater.
3. **Extends Claude Science** — loads skills from `~/.claude-science/`, feeds
   suggestions back to the skill author.
4. **Harness is code** — the harness owns orchestration, compaction, provenance.
   LLM judgment only for ambiguous cases.

## 2. Two loops, one contract

The **authoring loop** lives in Claude Science: a scientist works through an
analysis interactively, refining it until the protocol is solid. The **execution
loop** lives in LabRat: the harness runs that protocol autonomously on new data.

The contract between them is the **protocol skill** — a single Claude Science
skill (`type: protocol`) with a `protocol.yaml` inside it. The skill contains
the entire protocol: phase methodology as resources, verification criteria,
reference images, and the execution plan. One skill to author, publish, and
iterate on.

The protocol can also reference standalone skills from the registry for domain
or generic methodology (e.g., `segmentation-bone-ct`, `microct-3d-analysis`).
These are reusable across protocols.

The skill author writes it (or `/to-protocol-skill` structures a manual session
into one). LabRat reads `protocol.yaml` and knows how to run the protocol.

```
Authoring (Claude Science)              Execution (LabRat)

scientist + claude                      router → which protocol?
  run workflow manually                     ↓
  capture steps, permissions            protocol-loader
       ↓                                 reads protocol.yaml
  /to-protocol-skill                      resolves skills (local resources
  one protocol skill                        + registry skills)
    protocol.yaml                           ↓
    resources/ (phase methodology)      hybrid orchestrator
    assets/ (reference images)            code loop: walk phases
       ↓                                 each phase = agent + skills
  skill on disk                           reviewer gates each step
  ~/.claude-science/.../skills/              ↓
       ↓                                dashboard + feedback
  suggestions ←←←←←←←←←←←←←←←←←←←←←←←     ↑
```

### Skill types

- `type: protocol` — protocol skill. Has `protocol.yaml` with phases, agent
  definitions, and skill references (local resources + registry skills). LabRat's
  router lists these.
- No type — normal Claude Science skill. May be referenced by a protocol as
  domain or generic methodology (e.g., `segmentation-bone-ct`,
  `microct-3d-analysis`). These skills can declare their own `requires:` in
  frontmatter so the harness knows what runtime deps they need.

### Router

Three layers — code does the extraction, LLM confirms the decision:

1. **Inspection script** (code, deterministic) — a prepared script runs on the
   incoming data and extracts structured metadata: modality, body part, species,
   resolution, slice count. Generic DICOM inspector ships with the harness. Each
   protocol can optionally ship its own `inspect.py` in `assets/` for
   domain-specific checks.

2. **Haiku confirmation** (one-shot, ~500 tokens) — reads the inspection output
   and the available protocols' `expects` declarations. Confirms which protocol
   matches. Catches things rigid rules wouldn't: "this says `hindlimb` not
   `knee`, but 877 slices at 12µm from a Scanco scanner — that's the mouse knee
   protocol."

3. **Bash fallback** — if the inspection script output is ambiguous or Haiku
   can't decide, Haiku has Bash access to write more inspection code and dig
   deeper into the data.

For the hackathon: generic inspection script + one configured protocol. Haiku
confirms it's valid DICOM and matches the expected profile. No multi-protocol
routing needed yet.

## 3. Disk is the contract

Every exchange that crosses a boundary — agent↔harness, harness↔dashboard,
phase↔phase — goes through the task directory. Harness modules coordinate in
memory internally; the contract is that nothing an agent or the dashboard
consumes lives only in memory. SSE carries notifications that disk changed,
never the primary data.

Why:
- Dashboard builds against fixtures before the harness exists.
- State survives a crash — inspectable, demoable even if a live run fails.
- The audit trail IS the runtime state.
- Reviewer independence falls out of it — the reviewer has only the folder.

**Atomicity rule:** every status file is written temp-file → fsync → rename. SSE
state events fire only after writes land. Live `log` events are the one
exception — ephemeral, visually separated, never authoritative.

## 4. Module decomposition

Two processes, one shared disk contract.

```
Process A: harness (Node/TS, @anthropic-ai/claude-agent-sdk)
  watcher         — fs.watch on incoming dir → detect new DICOM series/zip
  inspector       — prepared script extracts metadata (modality, body part, resolution, slices)
  router          — one-shot Haiku confirms protocol selection from inspector output + expects
  queue           — FIFO, one task at a time, persists to disk
  orchestrator    — code-loop; walks protocol phases
  protocol-loader — read protocol.yaml, resolve skills (local resources + registry), merge requirements
  session/worker  — build phase agent (incl. SDK subagent definitions), run turn loop, capture conversation
  session/review  — build gate reviewer agent (fresh per gate), capture conversation
  tools           — MCP server: record_phase, mark_subphase, submit_gate_decision, blocked
  provenance      — append phase entries to manifest.yaml on record_phase
  runtime-setup   — ensure python env: imaging deps + microct_analysis importable
  events          — in-proc bus → SSE

Process B: dashboard (Express + SSE + static HTML/JS)
  api             — GET task list / task / phase / manifest (reads disk)
  sse             — /events stream
  static          — vanilla HTML/JS review-chain UI
  suggestions     — POST suggestion → suggestions.json

Shared:
  schema          — TS types + validators for all disk shapes. The only shared
                    code dependency.

External (read-only):
  claude-science dir   skills + runtime + conda python
                       resolved: config → CLAUDE_SCIENCE_HOME → ~/.claude-science/

Disk (read-write):
  tasks/{task-id}/     input, phases/, artifacts/, provenance/, anchors/,
                       review/, suggestions/
```

**Dependency direction:** schema is most stable; everyone depends on it.
Dashboard depends on schema + disk, NOT on the harness. Nothing depends on the
dashboard.

**Process boundary:** harness and dashboard are separate processes. The dashboard
survives a harness crash and keeps serving the last good state from disk.

## 5. Disk layout

Per-task tree (extends `requirements/protocols/task-directory.md`):

```
tasks/{task-id}/
├── task.json               # harness-owned state (current phase, completed phases)
├── artifacts/              # machine-readable state phases hand off
│   ├── intensity.nii.gz
│   ├── labels.nii.gz
│   ├── masks/{femur,tibia}.nii.gz
│   ├── bone_assignments.json
│   ├── spacing.json
│   ├── transforms.json
│   ├── meshes/*.npz
│   ├── landmarks.json
│   └── roi/*.nii.gz
├── phases/{phase}/         # review-UI surface (human/reviewer/dashboard)
│   ├── summary.md
│   ├── decisions.md
│   ├── measurements.json
│   ├── confidence.json
│   ├── subphases.json      # subphase marks (if phase has subphases)
│   ├── evidence/
│   └── code/
├── review/
│   ├── gates/{phase}.json  # per-phase gate decisions
│   ├── verification/{phase}/  # reviewer's verification code + output
│   ├── subphases/{phase}/{subphase}/attempt-{n}.json  # mid-phase reviews
│   ├── verdict.json        # final verdict
│   └── reviewer_report.md
├── provenance/
│   └── manifest.yaml       # per-phase provenance records (append-only)
├── anchors/                # index.yaml + turns/*.md
└── suggestions/
    └── suggestions.json
```

### Two surfaces

`phases/{phase}/` is for humans — prose, numbers, evidence PNGs. `artifacts/` is
for the next phase — the actual volumes, meshes, coordinates. A prose summary is
not enough to place landmarks; the landmark phase needs `labels.nii.gz` + meshes.

Each phase's `protocol.yaml` entry declares `inputs` and `outputs` (artifact
paths). The harness validates inputs exist before starting a phase. Phases reload
cached artifacts; they do not re-run prior phases.

### Task state

```json
{ "id": "task-2026-07-09-001",
  "protocol": "bonemorph-oa-mouse-knee",
  "input": "input/OA6-1RK/",
  "state": "running",
  "currentPhase": "segmentation",
  "phasesComplete": ["intake"],
  "createdAt": "...", "updatedAt": "..." }
```

Task-id: `task-YYYY-MM-DD-NNN`. Allocated by scanning `tasks/task-YYYY-MM-DD-*`
and taking `max(NNN) + 1`.

## 6. Orchestrator

A hybrid code-loop that walks the protocol phases, with LLM judgment for
ambiguous cases.

```
phases = protocol.yaml.phases
pointer = 0
while pointer < phases.length:
  worker = query(...)                  // SDK persists conversation by session ID
  reviewer = query(...)                // fresh session, SDK persists separately

  gate result (from submit_gate_decision tool call):
    pass              → update task.json; pointer++
    pass-with-concerns→ update task.json; pointer++ (concerns are advisory)
    fail              → retry same phase (fresh agent)
    fail-upstream(p)  → pointer = indexOf(p)
    no decision (2×)  → LLM judgment session decides
```

**Strictly serial at gates.** The worker session ends before the reviewer starts.
The reviewer finishes before the next worker starts. One task at a time.

**No hard rewind limit.** The reviewer decides whether to rewind. Safeguard
against infinite loops: overall task timeout or max total sessions (configurable
in protocol.yaml), not rewind count.

### No separate orchestrator log

The disk IS the orchestrator state. No separate log file. The timeline is
derived from what's already on disk:

- `task.json` — current phase, completed phases, state
- `phases/` directories — what ran (existence = completed)
- `phases/{phase}.attempt-{n}/` — what was retried/rewound (archived attempts)
- `review/gates/{phase}.json` — gate decisions with timestamps
- SDK session storage — conversation transcripts (referenced by session ID in provenance)

When something needs the timeline (LLM judgment session, dashboard), the
harness assembles it from disk state at that moment. Always current, can't
drift from reality.

### Conversation storage

The SDK persists conversations natively:

```
~/.claude/projects/<project>/<session_id>.jsonl
~/.claude/projects/<project>/<session_id>/subagents/agent-<id>.jsonl
```

The harness does not build its own conversation storage. It records session IDs
in the provenance manifest so conversations are traceable. The SDK handles
persistence, subagent transcript nesting, and resume.

For audit/debugging, the SDK's stored conversations can be read via
`list_subagents()` / `get_subagent_messages()` or directly from the JSONL
files. The dashboard can render these for the audit trail.

### Invalidation on retry and rewind

On **retry** (same phase, fresh agent): archive/reset the target phase's
`phases/{phase}/` dir (including `subphases.json`), its `review/gates/{phase}.json`,
and all artifact paths declared in that phase's `outputs`. Fresh agent starts
clean — no stale artifacts from the failed attempt.

On **rewind** (back to an upstream phase): archive/reset the target phase AND
every downstream phase — their phase dirs, review gates, sessions, subphase marks,
and declared artifact outputs. Downstream work built on now-invalid inputs cannot
survive.

Archive path: `phases/{phase}.attempt-{n}/`. The `task.json` records which
attempt is current.

## 7. Protocol skill (protocol.yaml)

A protocol skill is a single Claude Science skill that contains the entire
protocol — all phase methodology, verification criteria, reference images, and
the execution plan. One skill to author, publish, and iterate on.

The execution plan lives in `protocol.yaml`. The harness reads it and knows how
to decompose the protocol into phases, agents, and skills — no hardcoded phase
lists.

### Skill layout

```
bonemorph-oa-mouse-knee/
├── SKILL.md                            # protocol overview
├── protocol.yaml                       # execution plan
├── resources/
│   ├── intake.md                       # protocol-specific phase methodology + verification
│   ├── threshold.md
│   ├── watershed.md
│   ├── bone-assignment.md
│   ├── landmarks.md
│   └── measurement.md
└── assets/
    ├── expected_ranges.json
    └── reference/
        ├── segmentation_overlay.png
        └── landmark_placement.png
```

Each resource carries both methodology and verification for its phase:

```markdown
# Threshold Calibration

## Methodology
[how to calibrate thresholds — histogram analysis, bimodal separation...]

## Verification
[what correct thresholds look like, failure modes,
 reference histogram comparison]
```

### Skill levels

Skills referenced by a protocol exist at three levels:

| Level | Where it lives | Who reuses it | Example |
|---|---|---|---|
| Protocol-specific | Resource inside the protocol skill | Only this protocol | Tang et al. mouse knee thresholds |
| Domain-specific | Standalone skill in registry | Any protocol in this domain | `segmentation-bone-ct` (no good pretrained model, use watershed) |
| Generic | Standalone skill in registry | Any protocol | `microct-3d-analysis` (3D volume understanding) |

The boundary between levels is an authoring decision. A resource starts inside
the protocol skill. When a second protocol needs the same methodology, the
author extracts it to a standalone skill. The framework doesn't enforce
categories — it resolves names and layers them into the prompt.

### Skills declare requirements

Skills aren't just knowledge — they declare what they need to run. A bone µCT
segmentation skill needs `scipy` and `scikit-image`. A brain MRI segmentation
skill needs `freesurfer`. The skill carries that:

```yaml
# In the skill's SKILL.md frontmatter (standalone skills)
# or in protocol.yaml per-resource (protocol-specific skills)
requires:
  worker:
    tools: [Bash, Read, Write]
    runtime: [scipy, scikit-image, nibabel]
  reviewer:
    runtime: [nibabel]           # reviewer may need to read volumes for verification
```

Requirements are **role-scoped** — `requires.worker` applies to the worker agent,
`requires.reviewer` applies to the reviewer agent. This prevents a skill's
worker tool needs (Bash, Write) from bleeding into the reviewer's read-only
boundary.

**Validation:** the harness merges requirements per role from all skills loaded
for a phase. Merged worker tools must be a subset of the worker agent profile's
allowlist. Merged reviewer tools must be a subset of the reviewer profile's
allowlist. Mismatch → configuration error at protocol load time, not at runtime.

**Runtime deps** are merged across roles (union). If a skill declares
`runtime: [freesurfer]`, the harness ensures FreeSurfer is available before
starting that phase regardless of which role needs it. Skills are portable
because they carry their requirements.

### Phases and subphases

A **phase** is a top-level execution unit — one agent session, one reviewer gate
at the end. Intake, segmentation, landmarks, measurement. Phases represent
logical boundaries where the work changes character. The orchestrator sequences
phases. The reviewer gates each phase. Rewind targets a phase.

A **subphase** is a checklist item within a phase — a unit of work that must be
completed and reviewed before the phase can close. Subphases are not necessarily
sequential. Independent subphases can run in parallel (the agent spawns
subagents for concurrent work). Dependent subphases declare their dependencies.

Each subphase is marked when complete:

- `pass` (confidence: `high | medium | low`) — reviewed and satisfied
- `fail` — reviewed and found wanting, will retry within the phase
- `human-review` (confidence: `high | medium | low`) — uncertain, flags for the
  phase gate reviewer

**Everything gets reviewed.** Whether the agent does the work itself or
delegates to a subagent (via SDK `Task` tool), the result goes through review
before the subphase is marked. Self-assessment is the lightest form; spawning a
reviewer subagent via `Task` provides independent verification. Delegated work (spawned worker subagent) gets a reviewer
on its output before the result returns to the parent.

Human-review marks become explicit review topics for the phase gate reviewer.
The reviewer sees all subphase marks and specifically scrutinizes anything flagged
`human-review`.

**Subphase deps in protocol.yaml** (`depends_on`) serve two purposes:

1. **Agent guidance** — the skill's methodology describes the logical order, but
   the dep graph makes it machine-readable. The agent knows what can be
   parallelized without parsing prose.
2. **Dashboard visualization** (stretch) — the dashboard renders the phase +
   subphase graph from protocol.yaml, highlights the current position, and
   updates marks live via SSE. The viewer sees where the task is at a glance.

The harness validates only completeness: all subphases marked before
`record_phase` accepts. It does not enforce dep ordering — the agent owns that,
guided by the graph and the skill.

### protocol.yaml

```yaml
kind: protocol
name: bonemorph-oa-mouse-knee
version: 1

expects:                                  # router matches incoming data against this
  modality: CT
  body_part: [knee, hindlimb]
  species: [mouse, rat]
  min_slices: 100
inspect: assets/inspect.py                # optional protocol-specific inspection script

phases:
  - id: intake
    skills: [resources/intake]
    outputs: [intensity.nii.gz, spacing.json, transforms.json]

  - id: segmentation
    skills:
      - segmentation-bone-ct              # domain skill (standalone, from registry)
      - resources/threshold               # protocol-specific (resource in this skill)
      - resources/watershed
      - resources/bone-assignment
    inputs: [intensity.nii.gz, spacing.json]
    outputs: [labels.nii.gz, masks/, bone_assignments.json, meshes/]
    subphases:
      - id: threshold
      - id: watershed
        depends_on: [threshold]
      - id: bone-assignment
        depends_on: [watershed]

  - id: seed-review
    skills: [resources/seed-review]
    inputs: [labels.nii.gz, bone_assignments.json]
    outputs: [labels.nii.gz, bone_assignments.json]    # may overwrite
    # no when:/optional: — agent reads disk and decides if work is needed

  - id: landmarks
    skills:
      - resources/landmarks
    inputs: [labels.nii.gz, masks/, spacing.json, meshes/]
    outputs: [landmarks.json]

  - id: measurement
    skills: [resources/measurement]
    inputs: [landmarks.json, spacing.json, labels.nii.gz]
    outputs: [measurements_final.json]

sanity_checks: assets/expected_ranges.json

runtime:
  substrate: microct_analysis
  deps: [nibabel, pydicom, scikit-image, scipy, matplotlib]

parent_skills:
  - microct-3d-analysis                   # generic (loaded into every phase)
  - microct-review-artifact

agents:
  worker:
    tools: [Bash, Read, Write, Edit, Glob, Grep, Task,
            record_phase, mark_subphase, blocked]
    subagents:                            # passed as SDK agents parameter
      reviewer:
        description: "Use when uncertain about a subphase and want independent verification"
        tools: [Bash, Read, Write, Grep, Glob]
        writable: [review/verification/]
  gate-reviewer:                          # harness-initiated, NOT a subagent
    tools: [Bash, Read, Write, Grep, Glob, submit_gate_decision]
    writable: [review/verification/]
    max_findings: 5                       # cap on concerns per gate (keeps output focused)
```

**Subagent spawning uses the SDK's `Task` tool.** The worker's `subagents`
block maps directly to the SDK's `agents` parameter on `query()`. The worker
decides when to spawn a reviewer subagent — the SDK handles the mechanics.
The `gate-reviewer` is separate — the harness spawns it as a fresh `query()`
after the worker finishes.

**Skill resolution:** names starting with `resources/` resolve to resources
inside this protocol skill. All other names resolve from the Claude Science
skill registry. The harness tries local first, then registry, then errors.

**Agent definitions:** `agents` declares named profiles. Each phase can specify
`agent: <name>` to override the default `worker`. Phases that don't specify get
`worker`.

**Skill ordering in `skills[]` implies layering** — general before specific.
`segmentation-bone-ct` (domain approach) loads before `resources/threshold`
(protocol-specific parameters). Both land in the same agent session.

A skill without `protocol.yaml` is a normal Claude Science skill. One with it is
a LabRat-executable protocol.

## 8. Agents and skills

Agents are thin — **permission boundaries + tool allowlists**, defined in
`protocol.yaml`'s `agents` block. Skills carry the substance — knowledge,
methodology, verification criteria, and runtime requirements.

### Agent definitions

The protocol defines named agent profiles. Each phase references one by name
(or gets the default `worker`). The reviewer is always the `reviewer` profile.

```yaml
# In protocol.yaml (same as §7)
agents:
  worker:
    tools: [Bash, Read, Write, Edit, Glob, Grep, Task,
            record_phase, mark_subphase, blocked]
    subagents:
      reviewer:
        description: "Use when uncertain about a subphase"
        tools: [Bash, Read, Write, Grep, Glob]
  gate-reviewer:
    tools: [Bash, Read, Write, Grep, Glob, submit_gate_decision]
```

A phase can override: `agent: visual-worker` to use a profile with additional
tools. Agents not declared in the protocol.yaml inherit a default `worker`
profile with the standard tool set.

### Skill loading per phase

The harness builds each agent's prompt from the phase's `skills[]` list:

1. Resolve each entry: `resources/` prefix → resource in this skill; otherwise →
   skill name from the Claude Science registry.
2. Merge `requires:` from all resolved skills (tools, runtime deps).
3. Layer into the prompt in list order (general before specific).

Both the worker and reviewer load the same skills. The worker follows
methodology sections; the reviewer evaluates against verification sections. The
harness role instruction tells each agent which section applies.

For a phase with subphases, the agent works through subphase checkpoints
sequentially and calls `mark_subphase` at each one. The reviewer receives
subphase marks (with confidence and notes) as explicit review topics.

### System prompt assembly

```
── static prefix (protocol-level, cached) ──
[1] Parent skills                 (from protocol.yaml parent_skills — generic/domain)
[2] Protocol overview             (protocol skill's SKILL.md)
── SYSTEM_PROMPT_DYNAMIC_BOUNDARY ──
[3] Phase skills                  (resolved from skills[] — domain before protocol-specific)
[4] Role instruction              ("Follow Methodology" / "Evaluate against Verification")
[5] Subphase marks                (reviewer only — marks, confidence, notes from worker)
[6] Task context                  (scan metadata, task dir, artifact paths, runtime note)
```

`[1]+[2]` are byte-stable across all phases (cacheable within 1-hour TTL).
`[3]`–`[6]` change per phase and per role.

Everything the harness needs to build agents comes from `protocol.yaml`: agent
profiles, skill references (local + registry), runtime requirements.

## 9. Per-phase sessions

Each phase runs as its own `query()`. The harness sequences phases as a list
with rewind.

### Why per-phase (not one long-lived session)

- The SDK has no `query.continue(message)` method. `continue: true` and
  `resume: sessionId` both start a new `query()`.
  (`evidence/interrupt-continue-research.md`)
- Each phase gets a narrower, focused prompt — less context noise.
- Retry = fresh conversation with feedback — no accumulated confusion.
- No compaction concern — each session is short.
- The disk contract handles cross-phase state — `artifacts/` is the handoff.

### Phase-gate protocol

The agent signals "I'm done" by calling `record_phase`. The harness validates,
gates the transition, and keeps the agent alive if it stalls.

```ts
const q = query({ prompt: phasePrompt, options: { model: 'sonnet', ... } })
for await (const msg of q) {
  if (phaseComplete flag set) {
    break
  }
}
// → run reviewer gate → advance, retry, or rewind
```

**`record_phase({ phase })`** — validates `phases/{phase}/` + required
`artifacts/` outputs against the schema. If the phase has subphases, all must be
marked via `mark_subphase` before `record_phase` accepts. Returns "Phase
recorded. Stopping for review." Sets the `phaseComplete` flag.

**Stall handling:** if the agent's turn ends without `record_phase`, the harness
starts a new `query()` with `continue: true` and sends a reminder. After 3
reminders without progress → task failed.

**`blocked({ reason })`** — the agent can't proceed. Harness pauses the task,
emits `task-paused` SSE, escalates to the user via dashboard.

### Bash statelessness

Each `Bash` python invocation is a fresh OS process. Nothing survives in memory
between tool calls. The worker serializes intermediate state to `artifacts/`
between turns. This is how `microct_analysis` already works. (POC Q5 confirmed.)

## 10. Reviewer

A fresh session per gate. The reviewer loads the same phase skill as the worker
but applies only the verification section.

### What the reviewer does

The reviewer does **computational verification**, not just visual inspection.
It can write and run verification code — quantitative checks, statistical
comparisons, measurement validation — in addition to reading evidence images
and comparing against expected ranges.

Example verification code the reviewer might write:

```python
import nibabel as nib
import numpy as np
labels = nib.load('artifacts/labels.nii.gz').get_fdata()
unique = np.unique(labels[labels > 0])
print(f"Unique labels: {unique}")          # expect [1, 2] for femur + tibia
for u in unique:
    voxels = np.sum(labels == u)
    print(f"Label {int(u)}: {voxels} voxels")
```

Expected ranges from `expected_ranges.json` (e.g., femur length 2.0–3.5mm for
this mouse strain) catch gross measurement errors as a pre-filter — there is no
ground truth for novel data. The real verification is the skill's computational
and structural checks applied to the actual data and evidence images.

For phases with subphases, the reviewer receives the worker's subphase marks as
explicit review topics. Any subphase marked `human-review` gets specific
scrutiny — the reviewer evaluates whether the worker's uncertainty was warranted
and whether the output is actually correct.

### Trust boundary

The reviewer gets Bash, Read, Write, Grep, Glob, and `submit_gate_decision`.
The trust boundary is not "no code execution" — it's "cannot modify worker
output":

- **Can read:** `artifacts/`, `phases/`, reference images, expected ranges
- **Can write to:** `review/verification/{phase}/` (scratch space for
  verification code and output)
- **Cannot modify:** `artifacts/`, `phases/` (harness validates post-session
  that no worker outputs were altered)

This makes the reviewer genuinely independent: it verifies the worker's output
computationally without being able to fix it.

### Gate decision

The reviewer calls `submit_gate_decision` — a tool call, not free-text JSON.
The harness captures the structured parameters and writes the gate file.

```json
submit_gate_decision({
  "decision": "pass",
  "rewind_to": null,
  "feedback": null,
  "subphase_assessments": {
    "threshold": "agree",
    "watershed": "disagree — output looks correct despite human-review flag",
    "bone-assignment": "agree"
  }
})
```

Decisions: `pass`, `fail`, `fail-upstream`, `pass-with-concerns`.
`subphase_assessments` is a flat map — subphase ID to a short assessment string.
Present when the phase has subphases.

### Independence

- Fresh session per gate — no accumulated bias.
- Same skill, different role instruction — "evaluate against Verification," not
  "follow Methodology."
- Reads `phases/` and `artifacts/`, never the worker's session transcript.
- Can run verification code but cannot modify worker output.
- Feedback flows through `submit_gate_decision` tool call; the harness writes
  `review/gates/{phase}.json`, `review/verdict.json`, and
  `review/reviewer_report.md`.

If the reviewer doesn't call `submit_gate_decision` after 2 attempts, the gate
defaults to pass-with-concerns with `confidence: low`.

## 11. Tools

### MCP tools (portable protocol interface)

Four custom tools, served in-proc via `createSdkMcpServer()`. The model calls
them as `mcp__labrat__<tool>`. Any MCP-compatible client could call them — the
tool schemas ARE the portable interface spec.

| Tool | Agent | Effect |
|---|---|---|
| `record_phase` | worker | validate phase dir + artifacts + subphase marks; set phaseComplete flag |
| `mark_subphase` | worker | record a subphase checkpoint assessment |
| `submit_gate_decision` | gate-reviewer | structured gate decision via tool call |
| `blocked` | worker | signal can't proceed; harness pauses + escalates |

### SDK-native tools

| Tool | Agent | Effect |
|---|---|---|
| `Task` | worker | spawn subagents (SDK built-in) — worker can spawn reviewer subagents for mid-phase verification |
| Bash, Read, Write, Edit, Glob, Grep | worker + gate-reviewer | SDK built-ins |

**Subagent spawning uses the SDK's `Task` tool**, not custom MCP tools. The
worker's `subagents` block in protocol.yaml maps to the SDK's `agents`
parameter. The worker decides when to spawn a reviewer subagent — the SDK
handles session creation, message routing, and `parent_tool_use_id` tracking.

**Phase-scoped tool loading:** the harness only injects `mark_subphase` and
`Task` (with subagent definitions) for phases that declare subphases. Phases
without subphases get a smaller tool set.

### `mark_subphase`

```json
{ "subphase": "threshold",
  "mark": "pass",
  "confidence": "high",
  "notes": "bimodal histogram, clean separation at 220" }
```

Marks: `pass`, `fail`, `human-review`. Confidence: `high | medium | low`
(required for `pass` and `human-review`). The harness appends each mark to
`phases/{phase}/subphases.json`
as an attempt entry (append-only log). `fail` means the agent will retry within
the phase — the harness doesn't intervene, but records the attempt.

A subphase's **latest mark** determines its closeable state. `record_phase`
requires every declared subphase's latest mark to be `pass` or `human-review`.
It rejects if any subphase is `fail`, unmarked, or has no attempts.

### Mid-phase verification via SDK `Task`

The worker can spawn a reviewer subagent via the SDK's `Task` tool when it
wants independent verification before marking a subphase. The subagent
definition comes from the `subagents` block in protocol.yaml (mapped to the
SDK's `agents` parameter).

The reviewer subagent reads the worker's output, optionally writes and runs
verification code, and returns its assessment as free text. The worker reads the
assessment and calls `mark_subphase` based on its judgment.

Subagent sessions are tracked by the SDK via `parent_tool_use_id` and captured
as part of the parent conversation. `record_phase` requires all subphases
in a closeable state (`pass` or `human-review`).

### Permissions

Worker: `permissionMode: 'bypassPermissions'`, scoped by `sandbox` +
`allowedTools`. If a permission is denied at runtime, the harness does not retry.
It pauses the task and escalates. Permissions should have been captured during
the authoring loop in Claude Science — if they didn't transfer, that's a
configuration issue for the user.

## 12. Error handling

| Failure | Behavior |
|---|---|
| Gate fail | Retry same phase (fresh agent + feedback). Second fail → task failed. |
| Gate pass-with-concerns | Next phase proceeds; concerns are advisory. Dashboard surfaces them. |
| Gate fail-upstream(phase) | Rewind to named phase. Target + downstream phases invalidated (phase dirs, artifacts, gates, subphase marks archived). No hard limit — reviewer decides. |
| Worker blocked | Task paused, reason to task.json, SSE. User resolves. |
| Worker stalls | Reminder via `continue: true`. After 3 → task failed. |
| Worker crash | Task failed, reason to task.json, SSE. Partial output stays. |
| Permission denied | Worker should call blocked. If sandbox kills the call, harness catches and pauses. |
| Reviewer no submit_gate_decision (2×) | Gate defaults to pass-with-concerns, `confidence: low`. |
| DICOM unreadable | Fail at intake. |

## 13. SSE events

Notifications only; dashboard re-reads disk for detail.

```
{ type: "task-started",      taskId, protocol }
{ type: "phase-started",     taskId, phase }
{ type: "phase-complete",    taskId, phase }
{ type: "gate-result",       taskId, phase, decision }
{ type: "task-done",         taskId }
{ type: "task-failed",       taskId, reason }
{ type: "task-paused",       taskId, reason }
{ type: "log",               taskId, line, ephemeral: true }
```

Live `log` events are ephemeral transcript snippets — visually separated in the
dashboard, never promoted to results. `phase-complete` and `gate-result` fire
only after atomic writes land.

## 14. Provenance

`provenance/manifest.yaml` — append-only, one entry per completed phase.
Records everything needed to understand what happened and reproduce it.

```yaml
- phase: intake
  attempt: 1
  started: "2026-07-09T10:15:23Z"
  completed: "2026-07-09T10:18:45Z"
  skills_loaded:
    - resources/intake (hash: abc123)
  agent: worker
  inputs: []
  outputs:
    - artifacts/intensity.nii.gz (hash: def456)
    - artifacts/spacing.json (hash: ghi789)
    - artifacts/transforms.json (hash: jkl012)
  subphases: null
  sessions:
    worker: "sess_xyz789"               # SDK session ID
    gate: "sess_uvw012"
  gate_decision: pass
  verification:
    code: review/verification/intake/
    results: review/gates/intake.json

- phase: segmentation
  attempt: 2                          # first attempt was rewound
  started: "2026-07-09T10:37:04Z"
  completed: "2026-07-09T10:42:00Z"
  skills_loaded:
    - segmentation-bone-ct (registry, hash: mno345)
    - resources/threshold (hash: pqr678)
    - resources/watershed (hash: stu901)
    - resources/bone-assignment (hash: vwx234)
  agent: worker
  inputs:
    - artifacts/intensity.nii.gz (hash: def456)
    - artifacts/spacing.json (hash: ghi789)
  outputs:
    - artifacts/labels.nii.gz (hash: yza567)
    - artifacts/masks/ (3 files)
    - artifacts/bone_assignments.json (hash: bcd890)
    - artifacts/meshes/ (2 files)
  subphases:
    threshold: pass (high)
    watershed: pass (high)
    bone-assignment: pass (high)
  session_ids:
    worker: "sess_abc123"               # SDK session ID — conversation at ~/.claude/projects/...
    gate: "sess_def456"
  gate_decision: pass
  verification:
    code: review/verification/segmentation/
    results: review/gates/segmentation.json
```

The harness appends to `manifest.yaml` when `record_phase` completes and the
gate passes. Each entry records:

- **What ran:** skills loaded, agent profile, attempt number
- **What was consumed/produced:** input and output paths
- **How it was verified:** subphase marks, gate decision, verification code
- **Session IDs:** SDK session IDs for conversation audit (SDK persists
  conversations natively — the provenance manifest just records the IDs)

The dashboard reads this for the provenance view. The scientist sees exactly
what happened, in what order, with what code, producing what outputs.

## 15. Build order

Sequenced by risk then dependency.

**1. Prove the runtime** (before any harness code):
- Install nibabel/pydicom/scikit-image/scipy/matplotlib; make `microct_analysis`
  importable.
- Load the real 877-slice / 453 MB sample — record wall time + memory.
- Threshold + watershed → `artifacts/labels.nii.gz`.
- Evidence PNGs headlessly (matplotlib, not Kaleido).
- Reload labels in a fresh process, landmark smoke test.
- **Run this from inside the SDK's sandboxed `Bash`.** If Bash can't see the
  imaging env, the worker can't do its job — fix before building the harness.

**2. Worker vertical slice** (the critical path):
- `schema` module — unblocks everything.
- Agent SDK session with protocol bundle + Bash.
- `record_phase` + `mark_subphase` + `blocked` tools + phase-gate protocol.
- SDK `Task` tool for subagent spawning (reviewer verification mid-phase).
- OA6-1RK through intake + segmentation → real phase dirs + artifacts. Gate →
  landmarks phase loads from artifacts.

**3. Reviewer + dashboard** (parallel, against the worker's disk output):
- Reviewer gate loop: fresh session, parse gate response, advance/retry/rewind.
- Dashboard: Express + SSE + vanilla UI + `review/gates/*.json`.

**4. Integrate + polish:**
- Watcher → queue → orchestrator wiring.
- Live SSE ticker, dashboard polish, Tailscale serve, record demo, push.

**Stretch:** anchors + explore_anchor; router agent; second protocol; protocol
progress visualization (render phases + subphase dep graph from protocol.yaml,
highlight current position, show marks as they arrive via SSE).

### Stubbable

- Watcher: manual "enqueue this path" CLI is fine.
- Queue: single task is acceptable.
- Anchors: reviewer works from phase dirs alone.
- ROI phase: cut if needed, but record it as a `deviations:` entry in the
  manifest and label the dashboard "geometric indices only."

## 16. Runtime substrate

The `mc_*` kernel helpers the skill documents don't exist on disk. The worker
uses **Option B**: import `microct_analysis.processing.*` (tested) for the hard
parts (DICOM, threshold, watershed, rendering) and write raw scipy/skimage for
the rest. A runtime note in the worker's prompt says so.

Runtime deps come from two sources, merged by the harness:

1. `protocol.yaml`'s `runtime` block — protocol-level deps (available to all
   phases).
2. Each skill's `requires.worker.runtime` / `requires.reviewer.runtime` —
   skill-level deps. A standalone domain skill like `segmentation-brain-mri`
   declares `runtime: [freesurfer]` in its frontmatter. When a protocol
   references that skill, the harness ensures FreeSurfer is available without
   the protocol author re-specifying it.

**Lifecycle:** `runtime-setup` runs once at task start with the global merge
(union of all phases' requirements). This avoids per-phase install latency and
ensures the full environment is validated before any work begins. If a dep fails
to resolve, the task fails immediately with a clear error.

**Requirement types:** deps are not just Python packages. The harness recognizes:
- `python:` — pip packages (validated via import)
- `binary:` — CLI tools (validated via `which`)
- `conda:` — conda packages (validated via conda list)
- `env:` — environment variables (validated via presence)

Protocol-level `runtime.deps` defaults to `python:` type for backward compat.
Skill `requires.runtime` entries can use the typed form: `runtime: [python:scipy, binary:freesurfer]`.

## 17. Suggestions

`tasks/{task-id}/suggestions/suggestions.json` — append-only:

```json
[{ "id": "sg-001",
   "taskId": "task-2026-07-09-001",
   "protocol": "bonemorph-oa-mouse-knee",
   "phase": "landmarks",
   "text": "Growth plate boundary looks too deep on the medial side.",
   "createdAt": "...", "author": "jimmy@voluma.bio" }]
```

Dashboard POST endpoint. `labrat suggestions export --protocol <name>` collates
across tasks into a digest the skill author opens in Claude Science.

## 18. SDK mechanics

`@anthropic-ai/claude-agent-sdk@0.3.205`. Full detail in
`evidence/agent-sdk-capabilities.md`.

- **Sessions:** `query({ prompt, options })` → async generator. `continue: true`
  or `resume: sessionId` on a new `query()` for multi-turn. No
  `query.continue(message)` method.
- **Caching:** `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` splits static from dynamic. No
  `cache_control` knob — prefix caching is automatic. 1-hour TTL observed.
- **Tools:** `tool()` + `createSdkMcpServer()`. In-process handlers with closure
  access. Model calls `mcp__<server>__<tool>`.
- **Compaction:** no `compact()`. Per-phase sessions are short; `autoCompact`
  stays on as safety net.
- **Hooks:** `PostToolUse` and `MessageDisplay` for anchors. `PostToolUse` for
  `record_phase` flag detection.
- **Auth:** Claude Code CLI creds, no API key needed. Model alias `sonnet`.

## 19. Review traceability

Nine findings from `evidence/design-review.md`, all addressed:

| # | Finding | Resolution |
|---|---|---|
| 1 | Compaction drops computational state | `artifacts/` surface; per-phase sessions; Bash statelessness |
| 2 | `record_phase` can't terminate the loop | Harness breaks the loop on flag; tool return is not terminal |
| 3 | Reviewer told to write but not allowed | Harness writes from structured response; reviewer is read-only |
| 4 | Reviewer independence weaker than claimed | Fresh session per gate; same skill, different role instruction |
| 5 | Non-atomic disk writes | temp → fsync → rename; SSE after writes land |
| 6 | Build order underprices runtime perf | Runtime perf gate runs first, inside sandboxed Bash |
| 7 | Skill loading underspecified | protocol.yaml `skills[]` per phase; resolve local resources then registry; skills declare `requires:` |
| 8 | ROI silently downgraded | Explicit `deviations:` entry + "geometric indices only" label |
| 9 | Suggestions not integrated | suggestions.json schema + export CLI |
