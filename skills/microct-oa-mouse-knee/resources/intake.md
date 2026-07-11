# Intake — load the scan and derive calibration

## Procedure

Load the incoming DICOM series and derive scanner-aware calibration metadata.
Intake does **not** resample or emit a full intensity volume — resampling is
deferred to segmentation. The general method for ingesting and protecting a
volume (coordinate frames, spacing, laterality) is in `microct-3d-analysis`
(loaded alongside); this resource adds the Scanco/Tang specifics.

Use the Python interpreter and subprocess environment from your task context —
do not hardcode interpreter or `PYTHONPATH` values.

**Primary driver:**

```python
from microct_analysis.stages.intake import run_intake

metadata = run_intake(dicom_path="input/<series-dir>", output_dir=".")
```

Internally the stage uses `processing.dicom.load_dicom`,
`processing.profiles.detect`, and
`processing.calibration.{analyze_histogram, analyze_segmentation_histogram,
derive_thresholds, derive_segmentation_thresholds}`.

**Study-specific expectations:**

- Scanner: Scanco VivaCT 40, 10.5 µm isotropic voxels.
- Scanco thresholds are unitless attenuation values (220 bone/soft-tissue, 320
  for 3D, 270 cortical/plate) — not Amira HU (>2500). See SKILL.md; don't
  conflate the two scales.

**Artifacts to write for downstream phases:**

| Path | Source |
|------|--------|
| `intake/volume_metadata.json` | `IntakeArtifacts.volume_metadata` |
| `intake/orientation_report.md` | human-readable load summary |
| `intake/stage_report.json` | confidence, flags, `recommended_action` |
| `spacing.json` | `spacing` extracted from `volume_metadata.json` |

Render a histogram PNG of the loaded volume into `phases/intake/evidence/` if
the harness expects phase evidence (the driver does not auto-render).

## Verification

**Look first.** Open the intake histogram. It should be bimodal — a soft-tissue
peak and a separate mineralized-bone peak. A single peak or a flat field means
the load or calibration is wrong, and no downstream threshold will separate
bone. This is the primary evidence; the numbers below only confirm it.

**Then confirm the derivation produced usable metadata:**

- `intake/volume_metadata.json` has `spacing`, `scanner_profile`, `fingerprint`,
  `segmentation_threshold_analysis`, `segmentation_thresholds`.
- `intake/stage_report.json` has `confidence ∈ {high, medium, low}` and
  `recommended_action ∈ {proceed, flag, pause}`.

**Load and calibration checks** (they verify the load and scanner calibration,
not the specimen's biology):

1. Slice count ≥ `expects.min_slices` (100).
2. Spacing isotropic ≈ 0.0105 mm per axis (10.5 µm ± 2%), the Scanco scanner
   spec (SKILL.md).
3. Scanner profile detects Scanco (not `unknown-scanner-profile` without cause).
4. `segmentation_ready: true`, or documented `threshold_flags` plus a
   remediation plan for segmentation.
5. If `segmentation_threshold_analysis.status: not-bimodal`, expect the
   `needs-seeds` path at segmentation — record it here, don't fail.

**Demo fixture (OA6-1RK):** 877 slices, shape ≈ (877, 520, 517) ZYX. Those are
*this specimen's* values — on another scan read the shape from the scan's own
metadata; do not assert 877.

**Failure modes:** `LoadError` (corrupt/missing DICOM, wrong modality);
`unknown-scanner-profile` (thresholds unreliable — escalate at segmentation);
`not-bimodal` histogram (expect `needs-seeds`); empty or single-slice stack
(fail intake immediately).
