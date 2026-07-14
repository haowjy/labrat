# Segmentation — OA7-4L (task-2026-07-13-005)

Full-pipeline segmentation driver (`microct_analysis.stages.segmentation`,
threshold → marker-based watershed → seed assignment → prune → sanity) plus a
residual-body naming pass. Deliverables: a labeled knee scene (`labels.nii.gz`,
labels 1–9) and per-structure masks/geometry. **Femur and tibia — the two bones
that carry both ratio indices — are measured and independently verified; every
other structure is auto-proposed or escalated for review.**

## Threshold (subphase: pass, medium)
- Intake established the histogram is **NOT bimodal** on this HU-rescaled scan
  (RescaleSlope 0.3911 / Intercept −1000; air ≈ −941, soft-tissue ≈ −35, bone
  shoulder ~5000–6000). The Scanco *unitless* thresholds (220/270/320) are on the
  wrong scale here. The **Amira mineralized-bone** parameters are scale-appropriate.
- The histogram method would raise `histogram-not-bimodal`, so **manual thresholds**
  were supplied: **mask = 2500 HU** (Otsu = 2563, near-exact agreement), **marker =
  3500 HU**. `filtered.nii.gz` = median-filtered (iters=3, radius=1), isotropic
  10.5 µm (no resample needed). Bone mask ≈ 16.9 M voxels, traces the cortical shell.
- Recorded in `metadata.json.threshold_observations`.

## Watershed (subphase: pass, high)
- **First pass → `needs-seeds` (`ambiguous-bone-identity`), exactly as intake
  predicted.** At marker = 3000 the femur and tibia dense cores fuse into one
  10.5 M-voxel marker component spanning the whole z-axis — no watershed split is
  possible. At **marker = 3500** the cores separate into distinct z-clustered
  components (femur ~5.0 M @ high-z, tibia ~3.8 M @ low-z).
- **Critical curation:** the driver's `superior/inferior` naming is `z<half / z>=half`,
  which is **opposite** to this scan's anatomy (femur is HIGH z). Auto-proposed
  seeds therefore *swapped* the labels. Seeds were curated to **femur = component
  z574 (high-z, bicondylar)**, **tibia = component z229 (low-z, single plateau)**,
  and the seeded re-run produced `status: ready`.
- A persistent bridging marker component (~2.9 M vox spanning the joint) is **not
  seeded**; watershed divides it at the joint constriction (~z380).
- Post-clean (largest-CC per bone): **femur CC = 1, tibia CC = 1**; interface
  localized (z-overlap 12.6 % of the smaller bone; femur touches only `z_max`,
  tibia only `z_min` = FOV crop faces). Anatomy matches the reference
  (`bone-split__femur-tibia-fibula`): femur superior/bicondylar, tibia
  inferior/plateau, meeting in a thin joint band. Evidence: `split_verification.png`.

## Structure assignment (subphase: pass, medium)
- **Bicondylar discriminator (mandatory): PASS** — fem_frac 0.85 vs tib_frac 0.50
  (min 0.60, margin 0.15). The femur-labeled bone is the clearly-more-bicondylar
  one; identity is confirmed by geometry, not by z-position or volume order.
- **Sesamoid/osteophyte protection of femoral width: clean** — femur condyle ML
  edges x∈[109, 375]; **0** sesamoid/osteophyte voxels lie lateral to those edges,
  and those bodies are separate labels, so they cannot inflate the femur-label width.
- Named from **position-invariant** anatomy: **fibula** (label 9) = the long
  lateral low-x bone that defines the lateral side; **ossa_sesamoidea** (label 8) =
  large free-standing dense periarticular body (fabella-class, ~0.72 mm³) + small
  dense bodies — the confounder, labeled as its own structure so it is never read
  as osteophyte or swept into condyle width. **medial/lateral osteophytes** (6/7) =
  small dense residual bodies at the joint margin, split by ML side (**proposed**).
- Scene render `labeled_scene.png` matches the reference layout.

### Escalated / not segmented (needs review — do NOT treat as measured)
- **Patella (label 3): not segmented.** No reliable free-standing anterior body was
  separable from the femur (it may be merged into the trochlea), and the
  **anterior–posterior axis is not yet locked** — the skill forbids AP-dependent
  naming against a guessed axis. Escalated to the orientation/landmark phase.
- **Menisci (4/5): not segmented.** A lower-threshold (≥1500 HU) joint-gap pass
  produced a spurious ~300 k-voxel partial-volume blob; emitting it as a measured
  volume would be worse than omitting it ("do not invent its boundary"). Escalated.
- **Osteophyte vs peri-meniscal identity** at the joint margin also depends on the
  locked AP axis — the 6/7 labels are proposals only.

## Impact on downstream measurements
- **Femoral W/L and tibial IIOC H/W** (the two OA ratio indices) rest entirely on
  the femur and tibia labels, which are clean (CC=1) and verified. Ready.
- **Patella volume** and **peri-meniscal volumes** require the escalated structures
  — the orientation phase must lock the AP axis and confirm/segment them before
  those volumes can be reported.

## Known limits
- Fibula (context, ~4.8 mm³) is large and may include lateral cortical bone the
  watershed left unassigned; it is not a measured structure, but review should
  confirm it did not steal the tibial lateral wall (tibial IIOC width).
- All non-measured structures are auto-proposed; the reference pack is one specimen
  + published figures, so flag any anatomy it doesn't cover.

## Key artifacts
- `artifacts/labels.nii.gz` (+ `artifacts/segmentation/`), `artifacts/masks/`,
  `structure_assignments.json` (with `review_flags`), `geometry.json` (1.58 MB,
  6 decimated meshes), `filtered.nii.gz`, `seeds.json` (curated), `metadata.json`,
  `stage_report.json` (status ready, confidence medium).
- Evidence: `probe_mips.png`, `probe_zprofile.png`, `residuals.png`,
  `split_verification.png`, `labeled_scene.png`.
