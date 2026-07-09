# Phase Compaction and Provenance

## The problem

A microCT analysis session generates massive context — 3D render output,
slice arrays, code iterations, measurement tables. Normal compaction loses
findings. Manual compaction requires human intervention.

## The mechanism: `record_phase`

The agent has a `record_phase` tool. The skill instructs: "when you are
satisfied that a phase is complete — gates pass, evidence looks right —
write your phase record to the phase directory, then call `record_phase`."

The agent decides when a phase is converged. The tool triggers compaction.

### What the agent writes (structured folders, not a JSON blob)

The agent writes to a structured phase directory. Each phase is a folder
with separate files for different concerns:

```
tasks/{task-id}/phases/segmentation/
├── summary.md              # what happened, in prose
├── decisions.md            # what was decided and why
├── measurements.json       # just the numbers (structured data)
├── confidence.json         # level, flags, iterations
├── evidence/
│   ├── bone_mask_axial.png
│   ├── bone_mask_coronal.png
│   ├── watershed_split.png
│   └── cut_quality.png
└── code/
    └── segment.py          # the code the agent wrote for this phase
```

The summary and decisions are markdown — human-readable, reviewable,
diffable. Measurements and confidence are small JSON because they're
structured data the dashboard parses. Evidence images go in a subfolder.
The code the agent wrote goes in `code/` for provenance.

### What the agent calls

```
record_phase({ phase: "segmentation" })
```

That's it. The tool call is tiny. All data is already on disk.

### What the harness does

1. Reads the phase directory from `phases/{phase}/`
2. Appends a phase entry to `tasks/{task-id}/provenance/manifest.yaml`
3. Triggers context compaction via Agent SDK
4. Agent continues with clean context
5. Dashboard reads the phase directories directly

### The provenance manifest

Follows the prov-model from the microct-analysis provenance skill:

```yaml
analysis_run:
  id: task-2024-07-09-001
  protocol: bonemorph-oa-mouse-knee
  data:
    - path: input/OA6-1RK/
      kind: dicom-series

phases:
  - id: segmentation
    technique: threshold-watershed
    status: complete
    confidence: medium
    flags:
      - low-margin-bone-identity
    iterations: 3
    artifacts:
      - phases/segmentation/evidence/bone_mask_axial.png
      - phases/segmentation/evidence/watershed_split.png
    measurements_ref: phases/segmentation/measurements.json
    decisions_ref: phases/segmentation/decisions.md
    code_ref: phases/segmentation/code/segment.py
```

## Why agent-called, not harness-timed

The agent might do segmentation in one pass or iterate 4 times before gates
pass. Only the agent knows when a phase is converged. The skill guides
*when* to call it. The agent decides *that the step is done*. The harness
handles *mechanics*.

## Skill instruction pattern

```markdown
## After each major phase
When you are satisfied that a phase is complete — gates pass, evidence
looks right — write your phase record to the phase directory:
- summary.md (what you did, in prose)
- decisions.md (what you decided and why)
- measurements.json (the numbers)
- confidence.json (level, flags, iteration count)
- evidence/ (rendered images showing your work)
- code/ (the analysis code you wrote)

Then call `record_phase` with just the phase name. This persists your
work and frees context for the next phase. Do not proceed to the next
phase without recording.
```

General — any protocol skill can use `record_phase` without hardcoding
phase names.
