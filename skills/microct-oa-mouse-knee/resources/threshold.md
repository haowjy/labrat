# Threshold — Scanco mouse-knee bone mask

## Procedure

Subphase **threshold** of segmentation. Builds the liberal bone mask and strict
opened markers that feed watershed splitting. The mask captures every mineralized
structure — the two bones plus the ossified soft tissue this protocol also labels
(sesamoids, osteophytes, peri-meniscal calcification) — which watershed and
bone-assignment then separate. The general thresholding method
(fixed-HU rationale, why bone is high-contrast) is in
`microct-3d-analysis/resources/segmentation.md`; this resource adds the Scanco
parameters.

**Entry point** (the full segmentation pipeline runs this subphase first):

```python
from microct_analysis.stages.segmentation import run_segmentation

report = run_segmentation(
    dicom_path="input/<series-dir>",
    output_dir="segmentation",
    scanner="auto",
    threshold_method="histogram",
    render_qc=False,
)
```

Threshold-specific processing inside the driver: `processing.dicom.load_dicom`
(reload + isotropic resample), `processing.preprocess.median_filter` (3×3×3),
`processing.calibration.{analyze_segmentation_histogram,
derive_segmentation_thresholds}`, `processing.threshold.binary_mask` (liberal
mask + strict markers).

**Study-specific parameters (Tang / Scanco):**

- Use **scanner-profile thresholds**, not Amira HU. Scanco unitless values are
  ~220 / 320 / 270 for soft-tissue / 3D / cortical-plate contexts; the driver
  selects them when `scanner="auto"`.
- `threshold_method="histogram"` is the proven recipe.

**Performance:** the first full segmentation pass is heavy — on the demo fixture
it ran ~318 s wall and ~12.4 GiB peak RSS. Plan for long Bash subprocess
timeouts; scale expectations to the scan size, don't assume the fixture's.

**Outputs at this subphase:** `segmentation/filtered.nii.gz` (median-filtered
intensity) and `threshold_observations` in `segmentation/metadata.json`. Mark
`threshold` pass only after `filtered.nii.gz` exists and metadata records finite
threshold values.

## Verification

**Look first.** Overlay the bone mask on a mid-stack slice of the filtered
volume. The mask should trace the cortical shell — following the bone surface,
not bleeding into soft tissue and not eaten away inside dense cortex. A mask
that floods the marrow or drops the shell is a wrong threshold, whatever the
numbers say.

**Then the derivation:**

1. `segmentation/filtered.nii.gz` matches the loaded scan's ZYX shape; NIfTI
   header zooms ≈ 0.0105 mm isotropic after resample.
2. `metadata.json` → `threshold_method` is `histogram` (or a documented
   override); `threshold_observations` are on the Scanco unitless scale
   (order 10², not HU 10³).
3. Bone mask non-empty and not saturated: a few percent of voxels above the
   liberal threshold in a mid-stack slice, intensity p50/p90 in a plausible
   Scanco range (no all-zero volume, no flat field).
4. If `flags` contains `histogram-not-bimodal`, the subphase may still pass with
   `confidence: medium` when the seeds path is planned — not a hard fail.

**Failure modes:** `histogram-not-bimodal` (thresholds unreliable → expect
`needs-seeds` + seed-review); `missing-profile`/`unknown-scanner` (wrong
threshold family); empty bone mask (threshold too high or load failure);
`anisotropic-resampled` flag (note in decisions).
