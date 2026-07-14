# Measurement — OA7-4L (task-2026-07-13-005)

Computed the Tang OA geometric indices directly from the saved landmarks + spacing
(numpy/scipy), reproduced the tibial IIOC height through the persisted reorientation
transform, produced the **required** sensitivity band for **both** ratios, drew every
measurement on the scan as a look-first QC overlay, and honestly recorded the
patella/menisci volume endpoints as **unavailable** (those structures were escalated /
not segmented). No expected-value gate was applied — verification checks the derivation
and the anatomy, never the value.

## Results

| Index | Value |
|-------|-------|
| distal_femoral_length | **1.721 mm** (groove-top A → intercondylar notch, 3D) |
| distal_femoral_width | **2.269 mm** (lateral↔medial condyle, frontal-projected front view) |
| **distal_femoral_ratio (W/L)** | **1.318** |
| tibial_width | **2.754 mm** (medial↔lateral border at growth-plate level, 3D) |
| tibial_iioc_height | **0.601 mm** (articular → growth plate, reoriented long axis) |
| **tibial_iioc_ratio (H/W)** | **0.218** |

## Required sensitivity bands
- **Femoral W/L**: sweeping groove-top "A" over defensible z [505,537] → **W/L [1.302, 1.515]**.
  The band lies **entirely above** the OA cutoff 1.30 (and above normal<1.24, 4wk ROC 1.245,
  AROA 1.282) — so **OA-vs-normal is robust**. It straddles **only** the 8-wk PTOA ROC cutoff 1.312,
  so the precise ROC/severity bin depends on the subjective groove-top and needs human confirmation.
- **Tibial IIOC H/W**: sweeping growth-plate over defensible rz [518,538] → **H/W [0.182, 0.258]**.
  The entire band is **below** the OA cutoff 0.282 → **robustly OA-consistent**.

## Phenotype calls (interpretation applied AFTER; never a gate)
- **Femoral W/L 1.318 → OA-consistent (>1.30); precise ROC/severity bin requires human confirmation.**
- **Tibial IIOC H/W 0.218 → OA-consistent (<0.282), robust.**

Both indices point OA-ward, consistent with the landmarks phase. No landmark was placed to hit a cutoff.

## Volumes — NOT computed (honest gap, not a hole)
patella_volume, medial_meniscus_volume, lateral_meniscus_volume are **unavailable**: the patella
and menisci were escalated / not segmented (no reliable free-standing patella separable from femur;
peri-meniscal calcification not threshold-separable). Emitting a value would fabricate a boundary.
Flagged for review / optional re-segmentation. Reference bone volumes (measured, CC=1):
femur 8.224 mm³, tibia 5.811 mm³.

## Verification (all pass)
- W/L reproduces width/length within 1%.
- IIOC height recomputed **from the two native landmark voxels through the persisted transform**
  (not read back from an upstream file) = 0.601 mm, matches the landmark-frame value within 1 slice.
- H/W reproduces height/width; voxel→mm uses 10.5 µm.
- Structural invariant CC==1 per bone (femur 1, tibia 1). Compartment heights comparable (growth
  plate not misplaced on one side).
- Look-first: every measurement drawn on the scan; length line runs groove-top→notch (half-length
  trap avoided); labeled scene matches the reference pack with ossa sesamoidea as its own label.

## Flags for downstream (review-artifact)
- Femoral groove-top "A" subjective → controls precise W/L ROC bin (OA-vs-normal robust).
- Tibial growth-plate weakest landmark (±10 vox) → H/W OA call robust, height value uncertain;
  lateral tibial width may include metaphyseal-flare onset (visible on the overlay).
- Patella + menisci volumes unavailable (escalated).
- Prior-run conflict: task-2026-07-13-004 (same specimen) used opposite femur/tibia polarity and
  reported W/L ~2.11 (the >1.5 anomaly the skill flags as a likely identity/landmark error);
  task-005 independently confirms femur=high-z and a sane W/L~1.32. task-005 geometry stands on its own evidence.
