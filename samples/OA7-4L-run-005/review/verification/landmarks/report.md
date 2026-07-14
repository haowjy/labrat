# Landmarks phase verification — task-2026-07-13-005 (OA7-4L)

All checks below were computed independently from `artifacts/segmentation/labels.nii.gz`,
`artifacts/landmarks/positions.json`, `artifacts/landmarks/orientation_frame.json`, and
`phases/landmarks/measurements.json` — not restated from the worker's prose.

## Confirmed

- **Segmentation pre-flight CC gate (mandatory before landmark placement): PASS.**
  Recomputed connected components directly on `labels.nii.gz`: label 1 (femur)
  `n_components=1` (7,103,993 vox), label 2 (tibia) `n_components=1` (5,020,023 vox).
- **Femoral W/L reproduces exactly from persisted voxels.** Using
  `lateral_condylar_edge` (390,248,141), `medial_condylar_edge` (373,328,341),
  `intercondylar_groove_midpoint` (534,352,241), `intercondylar_notch`
  (397,262,241) and spacing 0.0105 mm: 3-D width = **2.2688 mm**, ML width =
  **2.1000 mm**, length = **1.7211 mm**, ratio3D = **1.3182** — matches
  `measurements.json` (`femoral_width_mm_3d 2.2688`, `femoral_width_mm_ml 2.1`,
  `femoral_length_mm 1.7211`, `distal_femoral_wl_ratio_3d 1.3182`) to full
  floating-point precision.
- **Femoral width landmarks are the true femur-label ML extremes, sesamoid/osteophyte-proof.**
  Recomputed the min/max-x femur-label (label 1) voxel in the distal condylar
  slab z∈[364,408]: min-x = **141**, max-x = **341** — exactly the reported
  landmark x-coordinates. Separately confirmed lateral osteophytes (label 7) and
  ossa sesamoidea (label 8) do extend more lateral in raw space (voxels at
  x<141, even x<109) but this is irrelevant to the width measurement because
  they are a **different label** — the femur-label extent itself is untouched.
  The "confounder protection" claim in `positions.json` evidence is verified,
  not just asserted.
- **Tibial IIOC height reproduces exactly through the persisted transform** — the
  reproducibility invariant the phase skill requires (native voxel + persisted
  transform, not a stale scalar). Projected `articular_surface_proximal` (391,286,100)
  and `growth_plate_proximal` (335,294,109) through `orientation_frame.json`'s
  `tibial_reorientation` (R, pivot, grid_center): reoriented rz = 585.63 and
  528.35 (reported 586/528, consistent with rounding), height = **57.276 vox /
  0.60140 mm**, matching `iioc_height_vox`/`iioc_height_mm` in
  `orientation_frame.json` to 8+ significant figures, and `measurements.json`'s
  `tibial_iioc_max_height_mm 0.6014`.
- **Tibial width and H/W ratio reproduce from persisted condyle-edge voxels.**
  Projecting `lateral_tibial_condyle_edge`/`medial_tibial_condyle_edge` through
  the same transform and taking the ML (x) span gives 261.94 vox / 2.7503 mm —
  matches `measurements.json`'s `tibial_width_vox 261.9` / `tibial_width_mm
  2.7503` exactly, and H/W = 0.60140/2.7503 = **0.2187**, matching
  `tibial_iioc_hw_ratio`.
- **Orientation discipline followed**: `orientation_applied: false` on all
  landmarks (native ZYX preserved), tibial rigid transform persisted alongside
  (rotation matrix, pivot, grid center, forward/inverse maps) rather than
  applied to labels — matches the phase skill's explicit requirement.
- **Interpretation-not-gate discipline respected**: phenotype cutoffs
  (W/L <1.24 normal / >1.3 OA; H/W OA <0.282) are applied only in
  `measurements.json`'s `interpretation_applied_after_NOT_a_gate` block, and the
  summary explicitly reports the femoral W/L as straddling the boundary
  (1.22–1.32) rather than nudging it — no evidence of a landmark placed to hit
  a cutoff.
- Evidence PNGs (16 files) are all valid, non-trivial images (sizes 360×630 up to
  1620×630+); spot-checked `landmarks_native_qc.png` and `groove_confirm.png` —
  all 8 landmarks sit on bone, the femoral length line runs groove-top→notch
  (not condyle-merge→notch), and the intercondylar notch sits at the midline
  bridge, not off-bone.

## Concerns

- **Stale/inconsistent field**: `orientation_frame.json`'s
  `tibial_reorientation.tibial_width_vox` is **266**, but the value actually
  reported downstream in `measurements.json` (**261.9**) is what recomputes
  correctly from the persisted condyle-edge landmarks + transform. The 266
  figure appears to be a leftover from an earlier pass and is simply wrong/unused
  — doesn't affect the reported measurement, but should be corrected or removed
  to avoid confusing a future reader who trusts `orientation_frame.json` over
  `measurements.json`.
- **Compartment-symmetry sanity-check numbers don't reconcile with the final
  reported height.** `measurements.json.iioc_height_compartment` states "lateral
  (max of medial/lateral; medial ~0.69mm, lateral ~0.75mm at auto-gp;
  symmetric)" but the actually-reported `tibial_iioc_max_height_mm` is 0.6014 mm
  — neither 0.69 nor 0.75. No script was left under `phases/landmarks/` (only
  evidence PNGs) to reproduce the 0.69/0.75 "auto-gp" figures independently, so
  this cross-check is not verifiable from disk; it appears to come from a
  different (automatic, pre-confirmation) growth-plate placement than the one
  finally used. `tibia_compartment_intensity.png` does show qualitatively
  similar intensity-transition onsets (~rz 525–530) for both compartments,
  which is consistent with "not grossly misplaced," but the specific mm figures
  in the JSON should be regenerated from the same landmark used for the final
  height, or removed/relabeled as a superseded estimate.
- **Growth-plate and groove-top landmarks remain medium-confidence with
  `requires_user_confirmation: true`**, per the phase skill's own escalation
  rule (confidence ≤ medium). This is expected/correct behavior for this
  phase, not a defect, but downstream review should not treat the femoral W/L
  or IIOC height as final without that confirmation.

No blocking issues: every reproducibility invariant the phase skill requires
(CC gate, W/L from voxels, IIOC height/width from persisted native voxels +
transform) checks out exactly against independently recomputed values.
