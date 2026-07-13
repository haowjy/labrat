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

## Emit the review render volume — `intake/volume.json` (once)

Segmentation has not run, so the intake review site is a **volume-only 3D
render** (raw grayscale, no mesh, no labels, no landmarks). Emit
`intake/volume.json` so the per-phase author can inject it, hash-verified, with
no recompute. This is a **downsampled visualization volume only** — it does NOT
resample the analysis volume (that stays deferred to segmentation).

- Downsample the loaded grayscale to a small isotropic grid (**96–128³ is plenty**
  for a review render) and window-normalize intensities to `uint8` 0–255.
- Serialize as base64 with the grid shape and the downsampled voxel spacing.
  No labels, no RLE, no landmarks — intake has none. Shape:

  ```json
  {
    "shape": [nz, ny, nx],
    "spacing_mm": [sz, sy, sx],
    "axes": { "axial": 0, "coronal": 1, "sagittal": 2 },
    "grayscale_b64": "<base64 uint8, length nz*ny*nx, window-normalized 0..255>"
  }
  ```

- Keep it well within the 5 MB site budget (uint8 at 112³ ≈ 1.4 MB raw, base64
  ~1.9 MB). It is a visualization artifact — the scientific gate checks it exists
  and is well-formed like any other output; it does not affect calibration.
- **Do not write to `review/volume.json`** (that path belongs to the final
  `review-artifact` phase — sharing it would break intake's hash-verified site
  when that phase overwrites the file).

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
