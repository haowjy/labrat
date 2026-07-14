# Measurement summary — OA7-4L (task-2026-07-13-005)

Tang OA geometric indices, computed from saved landmarks + spacing (10.5 µm isotropic).
All landmarks native volume ZYX. Tibial IIOC height recomputed through the persisted
reorientation transform. No expected-value gate — verification checks derivation + anatomy.

## Geometric indices

| Index | Value | Method |
|-------|-------|--------|
| distal_femoral_length | **1.7211 mm** | groove-top A → intercondylar notch (3D) |
| distal_femoral_width | **2.2688 mm** | lateral↔medial condyle edge, frontal-projected (front view) |
| **distal_femoral_ratio (W/L)** | **1.3182** | width / length |
| tibial_width | **2.7535 mm** | medial↔lateral border at growth-plate level (3D) |
| tibial_iioc_height | **0.6014 mm** | articular → growth plate along reoriented long axis |
| **tibial_iioc_ratio (H/W)** | **0.2184** | height / width |

## Required sensitivity bands (both ratios)

- **Femoral W/L**: sweep groove-top "A" over defensible z [505, 537] → **W/L [1.302, 1.515]**.
  Straddles primary OA cutoff 1.30? **False**. Straddles a per-model ROC cutoff? **True**.
- **Tibial IIOC H/W**: sweep growth-plate over defensible rz [518, 538] → **H/W [0.182, 0.258]**.
  Straddles OA cutoff 0.282? **False**.

## Phenotype calls (interpretation applied AFTER; never a gate)

- **Femoral W/L = 1.3182** → **OA-consistent (>1.30) — precise ROC/severity bin requires human confirmation**
  Point estimate 1.318. NORMAL/OA direction is ROBUST: band [1.302, 1.515] lies entirely above the OA cutoff 1.30 (and above normal<1.24, 4wk ROC 1.245, AROA 1.282). Band straddles ONLY the 8wk PTOA ROC cutoff 1.312, which is controlled by the subjective femoral 'A' groove-top landmark (requires_user_confirmation) — so the precise severity/timepoint bin is not robust, but the OA call is.
- **Tibial IIOC H/W = 0.2184** → **OA-consistent (<0.282)**
  Point estimate 0.218; band [0.182, 0.258] entirely on one side of 0.282.

Cutoffs (per model): W/L normal<1.24 / OA>1.3; ROC 1.245(4wk)/1.312(8wk)/1.282(AROA).
H/W OA<0.282 (AROA<0.294); gray zone 0.28–0.30. **No landmark was placed to hit a cutoff.**

## Volumes

| Endpoint | Value | Status |
|----------|-------|--------|
| patella_volume | — | unavailable — patella NOT segmented (escalated in segmentation: no reliable free-standing anterior body separable from femur). Reporting a value would fabricate a boundary. |
| medial_meniscus_volume | — | unavailable — medial (peri-)meniscus NOT segmented (escalated: peri-meniscal calcification not reliably separable by threshold). Note: medial peri-meniscal volume is intrinsically variable (near-zero normal). |
| lateral_meniscus_volume | — | unavailable — lateral (peri-)meniscus NOT segmented (escalated). Lateral peri-meniscal volume is the paper's early change; flagged for review/re-segmentation. |

The three protocol volume endpoints could **not** be computed: patella and menisci were
NOT segmented (escalated in segmentation — no reliable free-standing patella separable
from femur; peri-meniscal calcification not threshold-separable). Reporting a value would
fabricate a boundary. Flagged for review / optional re-segmentation.
Reference bone volumes (measured, CC=1): femur 8.22376 mm³,
tibia 5.811304 mm³.

## Verification (derivation + anatomy, never the value)

- W/L reproduces width/length within 1%: **True**
- IIOC height recomputed from the two native landmark voxels through the persisted transform
  = **0.6014 mm**, matches landmark-frame value
  (0.6014 mm) within 1 slice: **True**
- H/W reproduces height/width: **0.2184**
- voxel→mm uses spacing 10.5 µm: **True**
- Structural invariant CC==1 per bone: femur **1**, tibia **1** → gate pass **True**
- Compartment symmetry: landmark-phase: medial ~0.69 / lateral ~0.75 mm at auto-gp -> comparable; growth plate not misplaced on one side.

## Look-first QC overlays
- `evidence/femoral_wl_overlay.png` — width (front view) + length (sagittal); length runs groove-top→notch.
- `evidence/tibial_iioc_overlay.png` — IIOC height + width on reoriented frontal slab.
- `evidence/labeled_scene_front.png` — full labeled scene vs reference pack; ossa sesamoidea as own label.

## Flags for the reviewer
- **Femoral groove-top "A" is subjective** (requires_user_confirmation); it controls the precise
  W/L ROC/severity bin. OA-vs-normal is robust (band entirely >1.30).
- **Tibial growth-plate is the weakest landmark** (±10 vox); H/W OA classification robust across the band,
  but the reported height value is not. Lateral tibial width may include metaphyseal-flare onset.
- **Patella + menisci volumes unavailable** (not segmented; escalated).
- Prior-run note: task-2026-07-13-004 (same specimen) assigned opposite femur/tibia polarity and reported
  W/L ~2.11 (the >1.5 anomaly the skill flags). task-005 independently confirms femur=high-z with sane W/L~1.32.
