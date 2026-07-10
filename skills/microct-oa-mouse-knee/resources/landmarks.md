# Landmarks — Tang mouse-knee geometric indices

## Methodology

Place operational landmarks for distal femur width/length, tibial width, IIOC
height, and growth-plate boundaries per `SKILL.md`. Use the **visual/agent path**
(Path B in `bonemorph-map`) — not the semi-retired PCA `landmarks_orientation` driver.

**Pre-flight** (mandatory before placement):

```python
from microct_analysis.processing.rendering import (
    validate_segmentation_for_landmarking,
    prepare_landmark_session,
    render_surface_view,
    render_slice_view,
)

ok, reason = validate_segmentation_for_landmarking(labels, assignments)
# Abort if not ok — fix segmentation first
```

**Placement support:**

- `prepare_landmark_session()` — dual meshes + KDTrees for snapping
- `microct_analysis.processing.snapping.snap_to_surface` — femoral 3D condyle points
- `microct_analysis.processing.snapping.snap_to_slice` — tibial 2D slice landmarks
- `microct_analysis.processing.backstop.compute_backstop` — per-landmark signal ensemble + retry feedback
- `microct_analysis.processing.femoral_frame.build_femoral_frame` — ML/AP/SI frame from condyles

**Emit artifacts:**

```python
from microct_analysis.stages.visual_landmarks import emit_positions

report = emit_positions(
    placed_landmarks=[...],  # list of dicts with name, voxel_zyx, confidence, evidence
    workflow_orientation={...},
    spacing=(0.0105, 0.0105, 0.0105),
    source_artifacts={"labels": "labels.nii.gz", "filtered": "segmentation/filtered.nii.gz"},
    output_dir="landmarks",
)
```

Copy `landmarks/positions.json` → `landmarks.json` for harness handoff.

**Study-specific landmark rules (`SKILL.md`):**

| Landmark | Operational rule |
|----------|------------------|
| Intercondylar notch | Distal-most midline bone point |
| Trochlear groove top | Proximal-most slice of sustained anterior-midline concavity (flanks − mid ≥ **6 voxels**), proximal to condylar bulge — **not** condyle merge |
| Condyle edges | ML-extreme bone points in distal condylar slab (common frontal plane) |
| Tibial width | ML extremes on max-height frontal ortho slice |
| Growth plate | Epiphyseal line — bone-fill-ratio drop on tibial slice scans |
| IIOC interval | Articular ↔ growth_plate slice span |

**Agentic loop** (`microct-3d-analysis/resources/reference-calibration.md`):

RENDER → REASON → WRITE detection code → VALIDATE vs `assets/ground_truth.json` → ITERATE.

Frozen heuristics are first guesses only. Gate every auto-proposed distance before emit.

**Orientation note:** `orientation_applied: False` — PCA reorientation is retired;
landmarks are in native volume ZYX. Display alignment uses `alignment.md` (parent skill).

## Verification

**Correct output looks like:**

- `landmarks/positions.json` with all required landmark names for femoral + tibial indices
- Per-landmark `confidence` in `{high, medium, low}`; stage low if any landmark low
- `orientation_applied: false` in positions.json
- Preliminary 3D distances gate against `ground_truth.json` **before** measurement phase

**Reviewer computes:**

1. **Segmentation pre-flight** — `validate_segmentation_for_landmarking` must pass (CC == 1 per bone).
2. **Femoral length gate** — 3D distance notch ↔ groove top ∈ `distal_femur_length_mm.gate` **[2.0, 2.7] mm**.
   Catches the classic 1.08 mm heuristic failure (groove at condyle merge).
3. **Femoral width gate** — condyle edge distance ∈ `distal_femur_width_mm.gate` **[2.3, 4.2] mm**.
4. **W/L ratio gate** — width/length ∈ `femur_width_length_ratio.gate` **[1.0, 1.8]**; compare to
   `normal_max: 1.28`, `oa_min: 1.30` for phenotype interpretation (OA6-1RK OA specimen expects > 1.30).
5. **Tibial width gate** — `tibial_width_mm.gate` **[2.2, 3.8] mm**.
6. **IIOC height gate** — compartment height ∈ `tibial_IIOC_max_height_mm.gate` **[0.5, 1.2] mm**.
7. **IIOC ratio gate** — height/width ∈ `tibial_IIOC_height_width_ratio.gate` **[0.15, 0.40]**;
   cutoff **0.28** (normal > 0.28, OA < 0.28).
8. **Compartment symmetry** — |medial_height − lateral_height| small vs `compartment_height_mm.gate` **[0.3, 1.1] mm**;
   large asymmetry on normal control → growth plate too deep on one side.
9. **Growth plate thickness** — segmented plate ∈ `growth_plate_thickness_mm.gate` **[0.1, 0.35] mm**.
10. **IIOC slice interval** — articular↔growth_plate slice count:
    - **Code/backstop plausibility:** **[1, 100]** slices (`visual_landmarks._check_iioc_interval`)
    - **Workflow acceptance (stricter):** **[50, 100]** slices — flag `medium` if in 1–49

**Failure modes:**

- Groove at condyle merge → length ~half true value; W/L inflated
- Width endpoints on different AP depths → diagonal "width" line
- Growth plate swallowed into marrow → compartment asymmetry
- IIOC interval < 50 slices → landmark on wrong tibial level
- `requires_user_confirmation: true` on any landmark → stage confidence ≤ medium

**Ground-truth gates:** all `assets/ground_truth.json` mm and ratio entries listed above.
