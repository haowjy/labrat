# Intake — load the scan and derive calibration

## Procedure

The artifact: `intake/volume_metadata.json` (spacing, scanner scaling, intensity
stats, histogram analysis), `intake/orientation_report.md`,
`intake/stage_report.json`, and `spacing.json`. Intake does **not** resample or
emit a full intensity volume — resampling is deferred to segmentation.

Follow the ingest-and-protect method in `understand-3d-medical-volume` ("Ingest
and protect"): preserve the source read-only, work from a copy, and refuse
physical measurement if voxel→world scaling is absent. Write the code yourself
with off-the-shelf tools — there is no bespoke loader.

- Load the DICOM series (`pydicom`; `nibabel` for NIfTI/NRRD). Read voxel spacing,
  slice count and order, laterality, and intensity scaling (rescale
  slope/intercept).
- Compute the intensity histogram and check it is **bimodal** — a soft-tissue peak
  and a separate mineralized-bone peak. Save a histogram PNG to
  `phases/intake/evidence/`.
- Record calibration context, do not apply it yet: Scanco unitless thresholds
  (220 bone/soft-tissue, 270 plate/cortical, 320 3-D) vs the Amira >2500 HU mask —
  resolve which scale this scan is on (SKILL.md). Segmentation applies it.
- Extract `spacing` to `spacing.json`.

Study expectations: Scanco VivaCT 40, 10.5 µm isotropic voxels.

## Verification

**Look first.** Open the intake histogram. Bimodal → the load and calibration are
sound. A single peak or a flat field means the load or scaling is wrong, and no
downstream threshold will separate bone. This is the primary evidence; the numbers
below only confirm it.

**Then the derivation:**

1. Slice count ≥ `expects.min_slices` (100).
2. Spacing isotropic ≈ 0.0105 mm/axis (10.5 µm ± 2%), the Scanco spec (SKILL.md).
3. Intensity scaling present and recorded; the scan's scale (Scanco unitless vs
   HU) resolved.
4. `stage_report.json` has `confidence ∈ {high, medium, low}` and
   `recommended_action ∈ {proceed, flag, pause}`.
5. If the histogram is not bimodal, expect the `needs-seeds` path at segmentation —
   record it here, don't fail.

**Failure modes:** corrupt/missing DICOM or wrong modality (fail intake); unknown
intensity scale (thresholds unreliable — escalate at segmentation); single-peak
histogram (expect needs-seeds); single-slice or empty stack (fail immediately).

The demo fixture is one specimen — read shape and spacing from the scan's own
metadata; do not hardcode a specimen's values.
