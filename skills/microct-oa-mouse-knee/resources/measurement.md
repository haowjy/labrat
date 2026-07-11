# Measurement — Tang OA geometric indices (final)

## Procedure

Compute the published geometric indices from the placed landmarks and the
segmentation labels. Trabecular/ROI morphometry is stubbable for the demo; this
phase computes the core femoral W/L and tibial IIOC indices.

**Primary driver:**

```python
from microct_analysis.stages.measurement import run_measurement

report = run_measurement(
    landmark_artifacts={"positions": "landmarks/positions.json"},
    roi_artifacts={},                       # empty when ROI is skipped
    segmentation_artifacts={"labels": "labels.nii.gz"},
    workflow_measurements=WORKFLOW_MEASUREMENTS,   # mouse-knee OA fixture
    workflow_roi_defs=[],
    spacing=<from spacing.json>,
    output_dir="measurements",
)
```

| Index | Kind | Function |
|-------|------|----------|
| `distal_femoral_length` | surface_distance / distance | `compute_surface_distance` / `compute_distance` |
| `distal_femoral_width` | surface_distance | `compute_surface_distance` |
| `distal_femoral_ratio` | ratio | `compute_ratio` |
| `tibial_width` | frontal_projected_width | `compute_frontal_projected_width` |
| `tibial_iioc_height` | boundary_slice_count | `compute_boundary_slice_count` × voxel mm |
| `tibial_iioc_ratio` | ratio | `compute_ratio` |

Slice-count metrics use the scan's voxel size (10.5 µm on this study). Compile
specs via `measurements.workflow_binding.compile_measurement_specs`.

**Volumes (from labels, not landmarks).** Compute the patella and peri-meniscal
volumes directly from the per-structure masks — voxel count × (10.5 µm)³, the
Material-Statistics approach, not placed points:

| Index | From mask | Unit |
|-------|-----------|------|
| `patella_volume` | `masks/patella.nii.gz` | mm³ |
| `medial_meniscus_volume` | `masks/medial_meniscus.nii.gz` | mm³ |
| `lateral_meniscus_volume` | `masks/lateral_meniscus.nii.gz` | mm³ |

All three enlarge with age/OA and carry **no diagnostic cutoff** — report the
number. Emit them as `results.json` entries alongside the geometric indices.

**Outputs:** `measurements/results.json` (canonical numbers),
`measurements/qc_overlays.json`, `measurements/summary.md`, and
`measurements_final.json` (harness copy). The driver sets
stage confidence `high` internally — **do not trust that**; apply the checks
below explicitly.

## Verification

**Look first.** Open the QC overlays — each measurement line drawn on the scan
as it was measured. The femoral width should span condyle to condyle, the length
should run groove-top to notch, the tibial lines on the max-height frontal
slice. A line that runs diagonally or lands off the surface is a wrong
measurement, whatever its value.

**Then — reproduce the derivation** (check the math and the anatomy, never the
value against an expected range):

1. Recompute W/L from width and length; must match `distal_femoral_ratio`
   within 1%.
2. `tibial_iioc_height` ≈ boundary-slice-count × voxel mm.
3. IIOC ratio = height / width, using the same slice definitions as landmarks.
4. Voxel size used for mm conversion matches `spacing.json` (10.5 µm here).
5. Structural invariants hold — CC == 1 per bone; on a normal control the medial
   and lateral compartment heights are comparable (large asymmetry ⇒ a
   growth-plate boundary placed too deep on one side).

**Volumes are only as good as their labels.** Confirm each mask is the clean
structure on the overlay — patella not fused to the femur, peri-meniscal
calcification not swallowing the tibial plateau. Medial peri-meniscal volume is
intrinsically variable; near-zero is normal, not an error.

**Interpretation, applied after — not a gate.** With the measurements standing
on their own evidence, classify: W/L normal <1.28 / OA >1.28 (per-model ROC
1.245/1.311/1.282); IIOC H/W OA below ~0.28 (per-model 0.285/0.282/0.294) with an
inconclusive band 0.28–0.30. Report which side the specimen falls on; do not
adjust the measurement to move it. A value whose *lines* look wrong is still
wrong — trust the overlay over the number.

**Failure modes:** length looks right but W/L off (groove placement wrong); width
looks right but W/L off (condyle edges wrong); IIOC ratio low with height right
(width underestimated); compartment asymmetry (growth-plate placement). Send any
of these back to landmarks — don't patch the number here.
