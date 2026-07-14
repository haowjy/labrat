# Verification report — measurement phase (task-2026-07-13-005)

Independent recomputation via `review/verification/measurement/verify.py`, run
against `artifacts/measurements/results.json`, `artifacts/spacing.json`,
`artifacts/landmarks/orientation_frame.json`, `artifacts/landmarks/positions.json`,
`artifacts/labels.nii.gz`, and `artifacts/structure_assignments.json`. No worker
session logs were read.

## Confirmed

- **Landmark provenance**: every voxel used in `results.json` matches the
  corresponding entry in `landmarks/positions.json` exactly (lateral/medial
  condylar edges, notch, groove midpoint, articular surface, growth plate,
  tibial condyle edges).
- **W/L reproduction**: `width/length` recomputed = **1.31823**, reported
  **1.3182** (match within 1%). Length recomputed via 3-D Euclidean on the
  saved points = **1.72114 mm** (reported 1.7211); width recomputed =
  **2.26880 mm** (reported 2.2688, matches the `cross_check_3d_mm` field too).
- **IIOC height reproduced from the two native landmark voxels through the
  persisted transform** (`orientation_frame.json:tibial_reorientation`, not by
  reading the reported value back): forward-mapped rz = 585.628 (articular) /
  528.352 (growth plate) vs. reported rz 585.63 / 528.35. Recomputed height =
  57.276 vox = **0.60140 mm**, reported 0.6014 mm — within 1 slice, satisfies
  the phase skill's explicit "recompute from landmark voxels, not upstream
  file" requirement.
- **H/W reproduction**: height/width recomputed = **0.21841**, reported
  **0.2184**.
- **Voxel spacing**: `spacing.json` = 0.0105 mm isotropic, matches
  `results.json.voxel_size_mm` exactly.
- **Structural invariant CC==1**: independently labeled `labels.nii.gz` with
  `scipy.ndimage.label` — femur (label 1): 7,103,993 voxels, **1** connected
  component; tibia (label 2): 5,020,023 voxels, **1** component. Matches
  reported `femur_cc=1`, `tibia_cc=1`, and the volumes in
  `structure_assignments.json` (8.22376 / 5.811304 mm³) match
  `_reference_bone_volumes` in `results.json` exactly.
- **Sensitivity bands (required output, present for both ratios)**: recomputed
  straddle logic against the band bounds. Femoral W/L band [1.302, 1.515] does
  **not** straddle the primary OA cutoff 1.30, normal cutoff 1.24, the 4-wk ROC
  cutoff 1.245, or the AROA cutoff 1.282 — but **does** straddle the 8-wk ROC
  cutoff 1.312, exactly as claimed. Tibial H/W band [0.182, 0.258] does not
  straddle 0.282, 0.294, or the 0.28–0.30 gray zone. This correctly triggers
  the "precise ROC/severity bin requires human confirmation" language rather
  than a blanket indeterminate call, since the *primary* OA-vs-normal
  classification band does not straddle its cutoff — consistent with the
  skill's indeterminate rule (which gates on the classification cutoff, not
  every finer per-model bin).
- **Volumes correctly withheld, not fabricated**: `structure_assignments.json`
  (segmentation phase) independently flags `patella-not-segmented` and
  `menisci-not-segmented` under `review_flags`; the measurement phase reports
  `null` with an honest status string rather than inventing a boundary. This is
  the correct behavior per the skill ("Reporting a value would fabricate a
  boundary").
- **QC overlay images exist** at all three referenced paths
  (`phases/measurement/evidence/{femoral_wl_overlay,tibial_iioc_overlay,labeled_scene_front}.png`)
  and `qc_overlays.json` entries reference plausible anatomical checks
  (condyle-to-condyle span, groove-top→notch, articular→growth-plate).
- No landmark appears placed to hit a cutoff; the femoral groove-top and
  tibial growth-plate landmarks are honestly flagged
  `requires_user_confirmation: true` / `confidence: medium` in both
  `positions.json` and the summary's reviewer flags.

## Concerns

- **Tibial width discrepancy (not gated by the skill, but worth flagging)**:
  `results.json.tibial_width` (2.7535 mm, 3-D Euclidean on native landmark
  voxels) differs from `orientation_frame.json`'s own reoriented-slab width
  (`tibial_width_mm: 2.793`, from `tibial_width_vox: 266`) by ~1.4% — outside
  the 1% band used elsewhere. The phase skill's required checks (item 2) only
  mandate recomputing *height* through the transform, not width, so this is
  not a required-check failure, but the two width figures computed by the
  same pipeline for the same landmarks disagree by more than the tolerance
  applied elsewhere in this phase. Does not change the H/W phenotype call
  (band [0.182, 0.258] is robust either way), but is worth a note for anyone
  tightening tolerances later.
- Compartment-symmetry note ("medial ~0.69 / lateral ~0.75 mm") is carried
  from the landmark phase and not independently recomputed here; it is a
  soft plausibility check per the skill, not a hard gate, and the values are
  close enough to not signal a misplaced growth plate.

## Blocking

None.
