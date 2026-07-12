# Threshold — bone mask + watershed markers

## Procedure

Subphase **threshold** of segmentation. The artifact: a median-filtered volume
(`segmentation/filtered.nii.gz`) plus a liberal bone mask and strict, opened
markers that feed watershed. The general thresholding method (why bone is
high-contrast, fixed vs adaptive) is in `understand-3d-medical-volume`; here are
the Scanco/Tang parameters. Write the code with `scipy` / `scikit-image`.

- Load the series, resample to isotropic 10.5 µm, apply a 3-D median filter (≈3³)
  to denoise. Save `segmentation/filtered.nii.gz`.
- Threshold to a **liberal bone mask** that captures *every* mineralized structure
  — the two bones plus the ossified soft tissue this protocol also labels
  (sesamoids, osteophytes, peri-meniscal calcification) — which watershed and
  structure-assignment then separate. Pick the threshold from the histogram on the
  scan's own scale (Scanco unitless ~220–270, or the Amira ~2500–3000 HU mask) and
  verify it against the surface. Treat ~2500 as an empirical starting point, not a
  universal constant: tune it for each specimen. Do not over-raise it; excessive
  thresholds roughen the surface and make downstream landmark placement harder.
- Derive strict, morphologically-opened markers for the watershed seeds.

Record `threshold_observations` in `segmentation/metadata.json`. Mark `threshold`
pass only after `filtered.nii.gz` exists and metadata records finite thresholds. A
full pass on a real scan is heavy (minutes, several GiB) — plan long subprocess
timeouts and scale to scan size.

## Verification

**Look first.** Overlay the bone mask on a mid-stack slice of the filtered volume.
The mask should trace the cortical shell — following the bone surface, not
bleeding into soft tissue and not eaten away inside dense cortex. A mask that
floods marrow or drops the shell is a wrong threshold, whatever the numbers say
(reference: `bone-mask-threshold__ortho__workflow.jpg`).

**Then the derivation:**

1. `filtered.nii.gz` matches the loaded scan's ZYX shape; header zooms ≈ 0.0105 mm
   isotropic after resample.
2. Thresholds recorded on the scan's own scale (Scanco unitless order 10², or the
   Amira HU mask — not conflated).
3. Bone mask non-empty and not saturated: a few percent of voxels above the
   liberal threshold mid-stack, intensities in a plausible range.
4. If the histogram was not bimodal, the subphase may still pass with
   `confidence: medium` when the seeds path is planned — not a hard fail.

**Failure modes:** not-bimodal histogram (thresholds unreliable → expect
needs-seeds + seed-review); wrong intensity scale (mask empty or flooded); empty
bone mask (threshold too high or load failure).
