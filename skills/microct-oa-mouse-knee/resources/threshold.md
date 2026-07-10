# Threshold — Scanco mouse-knee bone mask

## Methodology

Subphase **threshold** of the segmentation phase. Builds the liberal bone mask
and strict opened markers that feed watershed bone splitting.

**Entry point** (full pipeline — preferred; proven on OA6-1RK):

```python
from microct_analysis.stages.segmentation import run_segmentation

report = run_segmentation(
    dicom_path="input/OA6-1RK",
    output_dir="segmentation",
    scanner="auto",
    threshold_method="histogram",
    render_qc=False,
)
```

**Threshold-specific processing** (inside `run_segmentation`):

- `microct_analysis.processing.dicom.load_dicom` — reload + isotropic resample
  (`processing.resample`) when starting from DICOM
- `microct_analysis.processing.preprocess.median_filter` — 3×3×3 median on intensity
- `microct_analysis.processing.calibration.analyze_segmentation_histogram`
- `microct_analysis.processing.calibration.derive_segmentation_thresholds`
- `microct_analysis.processing.threshold.binary_mask` — liberal mask + strict markers
- `microct_analysis.processing.threshold` marker percentile defaults via calibration

**Study-specific parameters (Tang / Scanco):**

- Use **scanner profile thresholds**, not Amira HU. From `ground_truth.json`:
  Scanco unitless values **220 / 320 / 270** for soft-tissue / 3D / cortical-plate
  contexts. The driver selects profile values when `scanner="auto"`.
- `threshold_method="histogram"` matches the proven runtime-proof recipe.

**Performance note:** first full segmentation pass on OA6-1RK took **~318 s**
wall time and **~12.4 GiB** peak RSS (`runtime-proof/proof-summary.json`). Plan
for long Bash subprocess timeouts.

**Outputs at this subphase** (partial — full stage completes all subphases):

- `segmentation/filtered.nii.gz` — median-filtered intensity
- Threshold observations embedded in `segmentation/metadata.json` →
  `threshold_observations`, `workflow_threshold_comparison`

Mark subphase `threshold` **pass** only after `filtered.nii.gz` exists and
metadata records finite threshold values.

## Verification

**Correct output looks like:**

- `segmentation/filtered.nii.gz` same ZYX shape as loaded scan (877×520×517 on demo)
- `segmentation/metadata.json` contains `threshold_observations` with positive
  liberal/strict values appropriate to Scanco unitless scale (order 10², not HU 10³)
- Bone mask is non-empty: >1% of voxels above liberal threshold in a mid-stack slice
- `compare_thresholds` in metadata shows workflow expectations documented

**Reviewer computes:**

1. Load `filtered.nii.gz`; assert `shape[0] == 877` for OA6-1RK fixture.
2. Parse `metadata.json` → confirm `threshold_method` is `histogram` or documented override.
3. **Histogram flag check** — if `flags` contains `histogram-not-bimodal`, subphase may
   still pass with `confidence: medium` when seeds path is planned (not a hard fail).
4. **Intensity sanity** — p50/p90 of filtered volume within plausible Scanco range
   (no all-zero volume; no saturated flat field).
5. Zooms from NIfTI header ≈ **0.0105 mm** isotropic after resample.

**Failure modes:**

- `histogram-not-bimodal` — thresholds unreliable; expect `needs-seeds` + seed-review
- `missing-profile` / `unknown-scanner` — wrong threshold family
- Empty bone mask — threshold too high or load failure
- Anisotropic input resampled (`anisotropic-resampled` flag) — note in decisions

**Ground-truth gates:** `voxel_size_um` (spacing in NIfTI header).
