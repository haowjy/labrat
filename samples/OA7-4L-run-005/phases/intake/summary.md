# Intake — OA7-4L (task-2026-07-13-005)

## Load & protect
- Input: 830 DICOM slices in `input/` (the DICOMs sit directly in `input/`, not an
  `input/OA7-4L/` subdir as the task path implied). Source read-only; loaded via
  `microct_analysis.processing.dicom.load_dicom`, no resampling (deferred to segmentation).
- Volume shape (Z,Y,X) = **(830, 528, 478)**, int16.
- Slice-UID fingerprint `dbeee845b4ea22df`, transfer syntax `1.2.840.10008.1.2.1`.

## Calibration
- Spacing **isotropic 10.5 µm** (0.0105 mm on all three axes) — matches the Scanco
  VivaCT 40 spec. Written to `artifacts/spacing.json`.
- Scanner profile detected: **scanco** (Manufacturer "SCANCO Medical", Model "Model 10").
- **Intensity scaling present and resolved.** DICOM RescaleSlope 0.3911, Intercept −1000,
  so stored values are on a **HU-like rescaled scale**, not raw Scanco attenuation units.
  Peaks confirm it: air ≈ −941, soft-tissue ≈ −35. This matters downstream: the Scanco
  *unitless* thresholds (220/270/320) in `derived_thresholds` are **not** on this scan's
  scale. The **Amira mineralized-bone mask (>2500 HU)** is the scale-appropriate one here,
  and Otsu on this scan lands at **2563** — near-exact agreement. Segmentation should use
  the HU-scale (Amira-style) thresholds, not the Scanco unitless values.

## Histogram — bimodal check → **needs-seeds path** (expected, not a failure)
- The strict two-peak detector flagged only **air (−941)** and **soft-tissue (−35)** peaks;
  it did not register a discrete third bone peak, so `is_bimodal=False`,
  `segmentation_ready=False`, flag `histogram-not-bimodal`.
- **But mineralized bone is clearly separable**: the histogram (see
  `evidence/histogram.png`) shows a distinct bone shoulder/hump at ~5000–6000, and the
  segmentation analysis reports **separability 0.836** at Otsu **2563**. The bone signal is
  real but low-prominence relative to the huge air/soft-tissue peaks, so automatic two-peak
  thresholding won't cleanly pick it.
- Per methodology, this is the **needs-seeds** situation: segmentation should use
  marker-based watershed with seeds (Amira workflow: >2500 HU mask, watershed markers
  3000–5000 HU) rather than a naive automatic threshold. Recorded here; intake does **not**
  fail. `stage_report`: confidence **medium**, recommended_action **flag**.

## Review render
- `artifacts/intake/volume.json`: volume-only downsampled grayscale render, grid
  [118,105,119], uint8 window-normalized (1–99.5 pct), 1.97 MB (<5 MB). Visualization only
  — the analysis volume is NOT resampled here.

## Handoff to segmentation
- Expect the **needs-seeds** path. Use HU-scale thresholds (bone mask >~2500 HU, confirmed
  by Otsu 2563), not Scanco unitless. Spacing 10.5 µm isotropic in `spacing.json`.
