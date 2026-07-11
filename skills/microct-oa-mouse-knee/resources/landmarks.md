# Landmarks — Tang mouse-knee geometric indices

## Procedure

Place the operational landmarks for distal-femur width/length, tibial width,
IIOC height, and growth-plate boundaries (definitions in SKILL.md). Use the
visual/agent path — render, reason, place, validate — not a frozen heuristic.
The agentic detection loop itself is the parent skill's core discipline:
`microct-3d-analysis/resources/reference-calibration.md`.

**Pre-flight (mandatory):**

```python
from microct_analysis.processing.rendering import (
    validate_segmentation_for_landmarking, prepare_landmark_session,
    render_surface_view, render_slice_view,
)
ok, reason = validate_segmentation_for_landmarking(labels, assignments)
# Abort and fix segmentation if not ok — placement on a broken mask is wasted.
```

**Placement support:** `prepare_landmark_session()` (dual meshes + KDTrees),
`processing.snapping.snap_to_surface` (femoral 3D condyle points),
`processing.snapping.snap_to_slice` (tibial 2D slice points),
`processing.backstop.compute_backstop` (per-landmark signal ensemble + retry
feedback), `processing.femoral_frame.build_femoral_frame` (ML/AP/SI frame).

**Emit:**

```python
from microct_analysis.stages.visual_landmarks import emit_positions

report = emit_positions(
    placed_landmarks=[...],   # name, voxel_zyx, confidence, evidence
    workflow_orientation={...},
    spacing=<from spacing.json>,
    source_artifacts={"labels": "labels.nii.gz",
                      "filtered": "segmentation/filtered.nii.gz"},
    output_dir="landmarks",
)
```

Copy `landmarks/positions.json` → `landmarks.json` for handoff. Landmarks stay
in native volume ZYX (`orientation_applied: false`); display alignment uses the
parent skill's `alignment.md`.

**The operational rules that carry the result (SKILL.md):**

| Landmark | Operational rule |
|----------|------------------|
| Intercondylar notch | distal-most midline bone point |
| Trochlear groove top | proximal-most slice of the sustained anterior-midline concavity (flanks − mid ≥ **6 voxels**), proximal to the condylar bulge — **not** where the condyles merge |
| Condyle edges | ML-extreme bone points in the distal condylar slab |
| Tibial width | ML extremes on the max-height frontal ortho slice |
| Growth plate | epiphyseal line — bone-fill-ratio drop along the tibial long axis |
| IIOC interval | articular ↔ growth-plate slice span |

## Verification

**Look first — this is the whole point of the phase.** Render each landmark on
the 3D surface and in orthogonal slices and check it sits where the anatomy says:

- The **groove top** on the sustained anterior concavity, *proximal* to the
  condylar bulge — not at the condyle merge (the merge is ~1 mm distal and
  halves the length).
- The **notch** at the distal midline; the **condyle edges** at the true ML
  extremes on a common frontal plane (not on different AP depths, which makes a
  diagonal "width").
- The **growth-plate boundary** at the epiphyseal line, not sunk into marrow.

A landmark that looks wrong is wrong, regardless of whether its distance falls
in range.

**Then — reproduce and structurally check the placement** (never against an
expected distance — a range gate would fail a genuinely unusual specimen for
being unusual):

- **See the error, don't infer it.** The classic 1.08 mm femur "length" is a
  groove landed at the condyle merge — the length line visibly ends in the wrong
  place on the overlay. Broken placement is *seen*, not read off an out-of-range
  number.
- **Structural invariants:** segmentation pre-flight (CC == 1 per bone);
  compartment symmetry — |medial − lateral| height small on a normal control
  (large asymmetry ⇒ growth plate too deep on one side); IIOC slice interval
  within the code's [1, 100] floor (workflow acceptance stricter at [50, 100];
  flag `medium` in 1–49 — a slice-count invariant of the region, not a specimen
  value).

**Interpretation, applied after — do NOT place landmarks to hit it.** The
phenotype cutoffs (W/L normal <1.28 / OA >1.28; IIOC H/W OA below ~0.28, with an
inconclusive band 0.28–0.30) *classify* the finished measurement. They are not
targets. A specimen whose honestly-placed landmarks yield W/L = 1.34 is
osteoarthritic; nudging a borderline specimen across the line fabricates the
finding. The run discovers which side this specimen falls on — it does not aim
for one.

**Failure modes:** groove at condyle merge (length ~half, W/L inflated); width
endpoints at different AP depths (diagonal line); growth plate in marrow
(compartment asymmetry); IIOC interval < 50 slices (wrong tibial level);
`requires_user_confirmation: true` on any landmark (stage confidence ≤ medium →
confirm in review).
