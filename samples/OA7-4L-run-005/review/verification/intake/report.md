# Intake verification — task-2026-07-13-005

## Confirmed

- **Slice count**: 830 DICOM files in `input/`, matches `volume_metadata.json`
  (`fingerprint.slice_count=830`), `stage_report.json`, and `measurements.json`.
  Comfortably above the `min_slices=100` gate.
- **Spacing**: independently read `PixelSpacing=[0.0105,0.0105]` and
  `SliceThickness=0.0105` from raw DICOM headers (`pydicom`). Also confirmed
  isotropic via `ImagePositionPatient` z-delta between slice 0 and 1
  (123.3535−123.343 = 0.0105 mm). Matches Scanco VivaCT 40 spec (10.5 µm ± 2%)
  and the reported `spacing.json` / `original_spacing` exactly (0.010500000000000013
  is float noise from the same value).
- **Intensity scaling resolved**: raw header has `RescaleSlope=0.391063`,
  `RescaleIntercept=-1000`, confirming the summary's claim of a rescaled
  (non-Scanco-unitless) HU-like scale. `Manufacturer="SCANCO Medical"`,
  `ManufacturerModelName="10"` match `scanner_profile: scanco` detection.
  `TransferSyntaxUID` (1.2.840.10008.1.2.1) matches the fingerprint.
- **Bimodality / Otsu check, recomputed independently**: rebuilt the Otsu
  threshold from the raw `histogram_sample` counts (512 bins, range
  [-500, 20000]) stored in `volume_metadata.json` using a from-scratch
  between-class-variance Otsu implementation → **2562.988**, matching the
  reported `otsu_threshold: 2562.98828125` exactly. The histogram PNG
  (`phases/intake/evidence/histogram.png`) visually shows a clear
  air/soft-tissue double peak plus a distinct low-prominence bone shoulder
  around 5000–6000, consistent with `is_bimodal=false` (two-peak detector
  only caught air/soft-tissue) alongside a real, separable bone signal
  (separability 0.836). This supports the summary's "needs-seeds, not a
  failure" framing rather than a load/calibration defect (SKILL.md
  distinguishes single-peak-flat-field failure from a real-but-low-prominence
  third peak).
- **`stage_report.json` enums valid**: `confidence="medium"` ∈
  {high,medium,low}; `recommended_action="flag"` ∈ {proceed,flag,pause},
  consistent with the not-fully-bimodal histogram.
- **`intake/volume.json` well-formed and within budget**: decoded
  `grayscale_b64` length (1,474,410 bytes) exactly equals
  `shape[0]*shape[1]*shape[2]` = 118×105×119. `spacing_mm` in the downsampled
  grid (0.0735, 0.0525, 0.042 mm) is exactly the original 0.0105 mm spacing
  scaled by the per-axis downsample factors (830/118≈7.03→7, 528/105≈5.03→5,
  478/119≈4.02→4), confirming a consistent, non-corrupted downsample. File
  size 1.97 MB, well under the 5 MB site budget. No labels/RLE/landmarks
  present, correctly reflecting that segmentation has not run.
- **No premature resampling**: no full-resolution analysis volume is emitted
  by intake artifacts; resampling is correctly deferred to segmentation per
  the phase skill and confirmed in `summary.md`.
- **Source preserved**: original DICOMs in `input/` untouched; work products
  are separate copies under `artifacts/`.

## Concerns

- None material. The histogram-not-bimodal flag is expected behavior for
  this scan (per skill: "expect the needs-seeds path"), not a defect, and is
  correctly surfaced (not silently passed) via `segmentation_ready=false`,
  `flags:["histogram-not-bimodal"]`, and `recommended_action:"flag"`.

## Blocking

None.
