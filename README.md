# LabRat

LabRat is an autonomous execution harness for repeatable scientific protocols.
It combines reusable scientific skills, specialized agent roles, automatic
sample ingestion, independent review, and human-facing evidence in one
disk-backed workflow.

Published computational methods often remain expensive to reuse. Each new
dataset may require manual operation of specialized software, consistent 3D
orientation, anatomical judgment, and repeated quality checks. LabRat packages
that established work as a protocol that agents can execute phase by phase.

## System components

LabRat combines three parts:

1. **Scientific skills and agent roles**

   The included skills define how to inspect 3D medical volumes, execute a
   mouse-knee micro-CT protocol, and construct interactive review artifacts.
   Protocols assign separate worker, gate-reviewer, monitor, artifact-author,
   and feedback-routing roles.

2. **Automatic protocol execution**

   The harness ingests a sample, resolves its protocol, runs each phase, applies
   independent review gates, and records the complete run under a task
   directory. Samples can enter through the CLI, the dashboard, or a watched
   folder.

3. **Claude Science skill integration**

   Protocol skills are authored and refined in Claude Science. LabRat uses the
   Claude Science skill format and registry, provides import and export
   commands, and executes registered protocols through the harness. The
   repository vendors the project-specific skills for distribution and review.

## Micro-CT reference protocol

The initial scientific protocol is based on Tang et al., [“Evaluating
Osteoarthritis Severity in Mice Using μCT-Derived Geometric
Indices”](https://pubmed.ncbi.nlm.nih.gov/41677733/) (*Biology*, 2026;15(3):262,
[doi:10.3390/biology15030262](https://doi.org/10.3390/biology15030262)). The
paper defines micro-CT-derived geometric indices for assessing post-traumatic
and age-related osteoarthritis in mice.

The protocol processes a mouse-knee scan through six phases:

```text
intake → segmentation → seed review → landmarks → measurement → final review
```

The workflow segments and orients the knee in 3D, places anatomical landmarks,
computes the published femoral and tibial indices, and preserves the
coordinates and geometry used for each result. Interactive review sites expose
the corresponding 3D anatomy, landmarks, and measurement lines.

The included `OA7-4L` scan is a healthy control from the paper's cohort.
Published values are provided for evaluation and are never used as landmark
targets. See [data/README.md](data/README.md) for sample provenance and reference
measurements.

## Execution and review model

```text
Claude Science authoring
          │
          ▼
Claude Science skill registry ◀── import/export ──▶ vendored skills/
          │
          ▼
Input sample ──▶ worker ──▶ independent gate-reviewer ──▶ monitor
                    │                    │                    │
                    └──────── phase outputs and decisions ──┘
                                         │
                                         ▼
                              disk-backed task record
                                         │
                                         ▼
                         3D review + provenance dashboard
                                         │
                                accept or send back
                                         │
                                         ▼
                                  phase-level rerun
```

Disk is the contract between the harness, agents, and dashboard. Phase outputs,
reviewer verification, monitor verdicts, human feedback, events, and provenance
are written under the task tree. The dashboard renders that record directly.

The worker and gate-reviewer run in separate sessions behind a trust boundary.
The reviewer cannot alter worker outputs or inspect the worker's private session
state. The monitor audits the review evidence before the gate is accepted.

## Implemented capabilities

| Capability | Implementation |
|---|---|
| Protocol execution | Declared phases run in order, with review gates between phases. |
| Independent review | A separate gate-reviewer reproduces phase checks and records its own verification. |
| Reviewer audit | A monitor detects inadequate or rubber-stamped review evidence. |
| Per-phase 3D review | Micro-CT phases publish rotatable 3D evidence; landmark and measurement phases include overlays. |
| Human correction loop | A researcher can comment, send a phase back, rerun it, and review the returned attempt. |
| Provenance | Phase outputs, gates, session records, events, and human verdicts remain linked on disk. |
| Review export | The dashboard exports the review chain as JSON. |
| Sample ingestion | CLI enqueue, dashboard submission, and folder-watch ingestion are available. |
| Claude Science bridge | Skills can be listed, imported from the registry, and exported from the repository. |

## Skills and roles

The vendored skill set includes:

- [`understand-3d-medical-volume`](skills/understand-3d-medical-volume/) for the
  reusable 3D render, reason, and validation workflow.
- [`microct-oa-mouse-knee`](skills/microct-oa-mouse-knee/) for the Tang et al.
  mouse-knee method and its phase definitions.
- [`review-artifact-builder`](skills/review-artifact-builder/) for sandboxed,
  self-contained review sites.
- [`toy-stats`](skills/toy-stats/) for a fast, imaging-free harness check.

The active agent profiles are declared by each protocol. Files under
[`agents/`](agents/) document the project-level role defaults included with the
Claude plugin.

## Installation

### Prerequisites

- Node.js 24
- Claude Science with an organization under `~/.claude-science`
- Claude Agent SDK credentials available to the local runtime
- `micromamba` for the protocol's Python 3.11 imaging environment

### Install dependencies and export skills

```bash
npm install
cp labrat.config.example.json labrat.config.json
scripts/export-skills-to-claude-science.sh
```

The repository's `skills/` directory is the distributable source of truth. The
current runtime resolves protocols from the Claude Science registry, so the
export step installs the vendored definitions into that registry before
execution.

## Running the included sample

```bash
mkdir -p data/OA7-4L
unzip data/OA7-4L.zip -d data/OA7-4L
npm run dev -- enqueue data/OA7-4L microct-oa-mouse-knee
```

`enqueue` starts the dashboard with the run unless `--no-dashboard` is passed.
The default address is `http://localhost:4600`.

Run the imaging-free smoke protocol with:

```bash
npm run smoke
```

Additional commands:

```bash
npm run dev -- skills
npm run dev -- import-skill <name> [--force]
npm run dev -- watch
npm run dev -- resume <task-id>
npm run dev -- rerun <task-id> [from-phase]
```

## Current boundaries

- Protocol authoring remains in Claude Science. The LabRat dashboard executes
  and reviews registered protocols.
- The mouse-knee workflow is the first implemented 3D scientific protocol.
  `toy-stats` provides a second runnable protocol for harness validation.
- The paper's geometric indices were developed using severe osteoarthritis
  induced by medial meniscectomy. Their applicability to mild osteoarthritis
  requires further investigation.
- Automatically placed landmarks remain proposals for human review. Numerical
  plausibility does not establish anatomical correctness.
- Human feedback can trigger phase-level reruns. Automatic skill revision from
  aggregated feedback is future work.

## Repository layout

- [`src/`](src/) — execution harness, trust boundaries, dashboard, and CLI
- [`skills/`](skills/) — vendored scientific and review skills
- [`agents/`](agents/) — project-level agent role definitions
- [`data/`](data/) — OA7-4L sample and provenance
- [`validation/`](validation/) — smoke, end-to-end, and trust-boundary checks

LabRat is an open-source Claude plugin built on the Claude Agent SDK. The code
is licensed under the [MIT License](LICENSE). The included sample data is CC BY
4.0 as documented in [data/README.md](data/README.md).
