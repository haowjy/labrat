# Measurement — Tang OA geometric indices (final)

## Methodology

Compute published geometric indices from placed landmarks and segmentation
labels. ROI/trabecular morphometry is **stubbable** for the hackathon demo
(design §15) — this phase focuses on core femoral W/L and tibial IIOC indices.

**Primary driver:**

```python
from microct_analysis.stages.measurement import run_measurement

report = run_measurement(
    landmark_artifacts={"positions": "landmarks/positions.json"},
    roi_artifacts={},  # empty when ROI phase skipped
    segmentation_artifacts={"labels": "labels.nii.gz"},
    workflow_measurements=WORKFLOW_MEASUREMENTS,  # from mouse-knee OA fixture
    workflow_roi_defs=[],
    spacing=(0.0105, 0.0105, 0.0105),
    output_dir="measurements",
)
```

**Measurement functions** (`measurements/geometry.py` via driver):

| Index | Kind | Function |
|-------|------|----------|
| `distal_femoral_length` | `surface_distance` or `distance` | `compute_surface_distance` / `compute_distance` |
| `distal_femoral_width` | `surface_distance` | `compute_surface_distance` |
| `distal_femoral_ratio` | `ratio` | `compute_ratio` |
| `tibial_width` | `frontal_projected_width` | `compute_frontal_projected_width` |
| `tibial_iioc_height` | `boundary_slice_count` | `compute_boundary_slice_count` × voxel mm |
| `tibial_iioc_ratio` | `ratio` | `compute_ratio` |

**Voxel size for slice-count metrics:** **0.0105 mm** (10.5 µm) per `voxel_size_um.value`.

**Workflow binding:** compile specs via
`microct_analysis.measurements.workflow_binding.compile_measurement_specs`.

**Outputs:**

- `measurements/results.json` — canonical numeric results
- `measurements/qc_overlays.json` — per-measurement QC payloads
- `measurements/summary.md` — human-readable table
- `measurements_final.json` — harness copy of results + gate evaluation

**Agentic validation loop** (mandatory):

Load `assets/ground_truth.json` and gate **every** computed value. Measurement
driver sets stage confidence `high` internally — **do not trust that**; reviewer
and worker both apply ground-truth gates explicitly.

```python
import json
gt = json.load(open("assets/ground_truth.json"))
# For each result: assert gate[0] <= value <= gate[1]
```

## Verification

**Correct output looks like:**

- `measurements/results.json` contains all six core measurements with units
- Ratios are unitless; distances in **mm**
- `measurements_final.json` includes per-field `gate_pass: true/false` vs `ground_truth.json`
- QC overlays reference landmark names used in each measurement

**Reviewer computes (all gates from `assets/ground_truth.json`):**

| Measurement | Gate key | Gate range / threshold |
|-------------|----------|------------------------|
| Distal femur length | `distal_femur_length_mm` | **[2.0, 2.7] mm** |
| Distal femur width | `distal_femur_width_mm` | **[2.3, 4.2] mm** |
| Femur W/L ratio | `femur_width_length_ratio` | gate **[1.0, 1.8]**; phenotype: normal **< 1.28**, OA **> 1.30** |
| Tibial width | `tibial_width_mm` | **[2.2, 3.8] mm** |
| Tibial IIOC max height | `tibial_IIOC_max_height_mm` | **[0.5, 1.2] mm** |
| Tibial IIOC H/W ratio | `tibial_IIOC_height_width_ratio` | gate **[0.15, 0.40]**; cutoff **0.28** |
| Compartment heights | `compartment_height_mm` | **[0.3, 1.1] mm** each; medial ≈ lateral |
| Growth plate thickness | `growth_plate_thickness_mm` | **[0.1, 0.35] mm** |
| Voxel size consistency | `voxel_size_um` | **10.5 µm** in spacing used for mm conversion |

**Cross-checks:**

1. Recompute W/L from width and length independently; must match `distal_femoral_ratio` within 1%.
2. `tibial_iioc_height` ≈ `boundary_slice_count × 0.0105 mm`.
3. IIOC ratio = height / width using same slice definitions as landmarks.
4. If ROI skipped, trabecular metrics absent — not a failure for geometric-indices demo.

**Failure modes:**

- Length in gate but W/L fails → groove placement wrong (width may be fine)
- Width in gate but W/L fails → condyle edges wrong
- IIOC ratio below 0.28 with height still in gate → width underestimated
- Compartment asymmetry >> 0.2 mm with both in gate → growth plate placement error
- Values inside gate but biologically implausible for specimen phenotype → flag for human review

**Ground-truth gates:** full `assets/ground_truth.json` — this is the terminal verification surface for the demo.
