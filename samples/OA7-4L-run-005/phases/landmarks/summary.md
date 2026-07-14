# Landmarks — OA7-4L (task-2026-07-13-005)

Placed the 8 operational landmarks for the femoral W/L and tibial IIOC H/W
indices, using **compute-to-propose, visualize-to-confirm** throughout. All
landmarks are in **native volume ZYX** (`orientation_applied: false`); the tibial
long-axis transform is persisted (not applied to the labels). Stage confidence
**medium → flag**: femur width/length landmarks are high-confidence; the
subjective groove-top and the ambiguous growth plate need review confirmation.

## Orientation established (was escalated from segmentation)
- **Polarity re-verified independently**: femur = label 1 = **high-z**, bicondylar
  (0.25 vs tibia 0.05); tibia = label 2 = **low-z**, plateau. Femur distal condyles
  at the LOW-z (joint) end; tibia plateau at its HIGH-z end.
- **AP axis locked**: **anterior = +y (high-y)**, posterior = low-y. Three
  independent anchors agree — (1) intercondylar notch opens toward low-y, (2)
  fibula sits posterolateral at low-y, (3) trochlear groove (anterior) is the
  high-y midline concavity. **The femoral-frame builder independently confirmed
  this AP sign via mesh density (`ap_verification: mesh_density_confirmed`,
  frame confidence high).** This resolves the segmentation-phase AP escalation.

## Femur (label 1) — high confidence on the W/L drivers
- **lateral_condylar_edge** (390,248,141), **medial_condylar_edge** (373,328,341):
  ML extremes in the distal two-condyle slab z[364,408]. Confounder protection
  verified: label-7 osteophytes lie lateral to the edge but are a SEPARATE label
  and cannot inflate femur-label width.
- **intercondylar_notch** (397,262,241): distal-most midline bridging bone (fossa
  roof); not eroded, no fallback.
- **intercondylar_groove_midpoint "A"** (534,352,241): proximal-most slice of the
  SUSTAINED anterior-midline concavity (z504–534 band, dies at z540), proximal to
  the condylar-bulge band (z410–452) and **distinct from the condyle merge (z412)**
  — the classic half-length trap avoided. SUBJECTIVE (paper places by eye, ICC
  0.667–0.85); defensible z-range [505,537]; `requires_user_confirmation`.

Femoral **width** 2.10 mm (ML) / 2.27 mm (3D, 80-vox AP spread), **length**
1.72 mm, **W/L = 1.22 (ML) – 1.32 (3D)**.

## Tibia (label 2) — reoriented, medium confidence
- Long axis fit by centroid-vs-z over **fixed diaphyseal crop z[80,280]** (straight
  shaft, excludes flare z>290 and FOV artifacts); **tilt 11.56°**, stable across
  crops (±0.2°). Transform (R, pivot, grid-center, forward/inverse maps) **persisted
  in `orientation_frame.json:tibial_reorientation`**.
- **articular_surface_proximal** (391,286,100) rz=586; **growth_plate_proximal**
  (335,294,109) rz≈528; **lateral/medial_tibial_condyle_edge** (326,308,44)/
  (358,296,304) at growth-plate level rz=526.
- IIOC **height 0.60 mm**, **width 2.75–2.79 mm**, **H/W = 0.219** (band 0.18–0.26
  across growth-plate ±10 vox). Compartment symmetry OK (medial ~0.69 / lateral
  ~0.75 mm at auto-gp) → growth plate not misplaced on one side.

## Verification (quantitative + visual, both required)
- Every landmark proposed by a numeric feature (fill-drop onset, ML extreme,
  midline-bridge onset, anterior-concavity profile) THEN confirmed on the scan
  (`landmarks_native_qc.png`, `femur_verify.png`, `groove_confirm.png`,
  `tibia_growthplate_intensity.png`).
- **Reproducibility invariant holds**: IIOC height recomputed from the persisted
  native voxels through the persisted transform = stored value (0.601 mm). W/L =
  width/length. voxel→mm uses 10.5 µm.
- Segmentation CC gate (femur/tibia CC==1) passed pre-flight.

## Genuine uncertainties / flags for review
- **growth_plate_proximal is the weakest landmark** (±10 vox; thin cartilage +
  trabecular noise). Fill-drop onset and reoriented-intensity agree ~rz525–535.
  H/W **classification** (OA, <0.282) is robust across the whole band, but the
  reported height value is not — `requires_user_confirmation`.
- **groove-top "A"** is subjective; proximal-most rule chosen for run-to-run
  consistency, which gives the LOWEST (most conservative) W/L. A more distal groove
  would raise W/L.
- **Femoral W/L straddles the normal/OA boundary** (1.22–1.32). Reported honestly;
  NOT nudged to a cutoff. Tibial H/W (0.219) is clearly OA-side. Both point OA-ward
  and W/L is not an implausible >1.5 anomaly.
- **Tibial width** may include onset of lateral metaphyseal flare (edge x=44).
- **Inter-run inconsistency (NOT resolved here)**: task-2026-07-13-004, same
  specimen OA7-4L, assigned the OPPOSITE femur/tibia z-polarity and reported
  femoral W/L 2.11 (width 3.2 mm) — the >1.5 anomaly the skill flags as a likely
  identity/landmark error. task-005's own seg + seed-review + this phase all
  independently confirm femur=high-z with a sane W/L~1.3. Flagging for reviewer
  awareness; task-005 geometry stands on its own evidence.

## Interpretation applied AFTER (not a gate)
Femoral W/L cutoffs normal<1.24 / OA>1.3; tibial H/W OA<0.282 (gray 0.28–0.30).
This specimen: W/L borderline, H/W OA-consistent. Reported to say which side a
finished measurement falls on — never used to place a landmark.

## Key artifacts
- `artifacts/landmarks/positions.json`, `artifacts/landmarks/orientation_frame.json`
  (+ persisted `tibial_reorientation`), `artifacts/landmarks.json`,
  `artifacts/landmarks/transform_matrix.json`, `oriented_labels.npy` (identity).
- Evidence: `landmarks_native_qc.png` (all 8 on the scan), `femur_verify.png`,
  `groove_confirm.png`, `groove_profile.png`, `tibia_shaft.png`,
  `tibia_growthplate_intensity.png`, `tibia_iioc_frontal.png`, `probe_orientation2.png`.
