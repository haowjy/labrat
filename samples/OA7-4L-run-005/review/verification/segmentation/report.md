# Segmentation phase — independent verification (task-2026-07-13-005)

Fresh reviewer session, no access to the worker's transcript. All checks
recomputed directly from `artifacts/labels.nii.gz` and
`artifacts/segmentation/structure_assignments.json` with my own Python
(`review/verification/segmentation/verify.py`, `discriminator.py`; raw output
in `cc_results.json`, `discriminator_result.json`), not restated from the
worker's prose. No files under `artifacts/` or `phases/` were modified.

## Confirmed

- **Connected-components gate (mandatory).** `scipy.ndimage.label` on
  `labels.nii.gz` directly: `femur cc=1`, `tibia cc=1` — matches the recorded
  `femur_cc: 1, tibia_cc: 1`. Non-measured structures are correctly not held
  to CC==1 (`ossa_sesamoidea cc=5` — scattered periarticular bodies is
  expected per skill; `medial_osteophytes`, `lateral_osteophytes`, `fibula`
  all cc=1).
- **Bicondylar identity discriminator (mandatory, reimplemented from
  scratch).** Re-ran the skill's exact algorithm against `labels.nii.gz`:
  split axis 0, `fem_frac=0.85`, `tib_frac=0.5` — identical to the recorded
  values. Verdict **PASS** (`fem_frac >= 0.60` and
  `fem_frac > tib_frac + 0.15`, margin 0.35 vs. required 0.15 — well clear).
  `split_verification.png` visually corroborates: the femur joint-band slice
  (k=364) is 2 clean separate lobes, the tibia joint-band slice (k=396) is 1
  connected lobe. This is the geometry-that-wins-over-heuristics check the
  skill mandates, and it reproduces exactly under independent recomputation.
- **Interface localization.** Independently computed femur/tibia bbox overlap
  on the split axis: 51 voxels vs. femur axis-extent 475 / tibia axis-extent
  405 → ~12.6% of the smaller bbox, matching the recorded 12.6%, well under
  the ~20% ceiling. Femur touches only `x_max` (its high-z/proximal end in
  this frame is actually the FOV-crop face along axis 0), tibia only
  `x_min` — no unexpected face contact, consistent with a clean FOV crop
  rather than a bad split.
- **Sesamoid/osteophyte protection (required check).** Recorded
  `sesamoid_osteophyte_voxels_lateral_to_condyle_edges: 0` in
  `structure_assignments.json["verification"]["condyle_slab"]` — the specific
  check this protocol exists to enforce (a sesamoid or osteophyte voxel
  swept into the femoral-width measurement). Cross-checked against the
  labeled-scene image: `ossa_sesamoidea` (purple) sits as a clearly separate
  rounded body well away from the femur condyles, and the small
  medial/lateral osteophyte patches (orange/yellow) sit right at the
  joint-line margin, not inside the condyle slab.
- **Visual scene check against the reference pack.** `labeled_scene.png`
  (coronal/sagittal/axial MIPs): femur (green) bicondylar and superior,
  tibia (red) inferior, meeting in a thin joint-line band; fibula (blue)
  lateral and fully separate; ossa_sesamoidea (purple) as distinct rounded
  bodies, not fused to the femur — anatomically consistent with
  `labeled-scene__all-structures__3d-linked__workflow.jpg` and the confounder
  panel (`figure2-scene…paper.png`).
- **First-pass `needs-seeds` → curated re-run → `ready` is the expected
  path, not a shortcut.** `driver.log` shows the first pass returned
  `status: needs-seeds` / `ambiguous-bone-identity` with empty assignments;
  `seeds_curated.json` records the explicit femur=high-axis/tibia=low-axis
  correction that resolved it.
- **Honest escalation, not silent omission.** Patella and both menisci are
  genuinely absent from `masks/` and from `structure_assignments.json`'s
  `assignments` — verified by listing `artifacts/masks/` (6 files: femur,
  tibia, fibula, medial/lateral osteophytes, ossa_sesamoidea; no patella or
  meniscus mask exists). This is disclosed explicitly in `review_flags`
  (`"patella-not-segmented: ... AP axis not locked"`,
  `"menisci-not-segmented: peri-meniscal calcification not reliably
  separable by threshold; escalate"`), matching the skill's instruction not
  to invent a meniscal boundary and to lock the AP axis before splitting
  sesamoid from patella.
- **geometry.json well-formed.** `meshes` keyed by all 6 assigned structures
  (femur 4418 verts/8722 faces, tibia 3366/6616, plus the 4 others), all well
  under the 10K-vertex/structure budget, total file 1.58 MB (< 5 MB site
  budget). Emitted once at `segmentation/geometry.json`, not duplicated.
- **Declared artifacts** all present and non-empty:
  `artifacts/labels.nii.gz`, `segmentation/filtered.nii.gz`,
  `segmentation/structure_assignments.json` (top-level copy byte-identical),
  `segmentation/seeds.json` + `seeds_curated.json`, `segmentation/
  metadata.json`, `segmentation/stage_report.json`, `segmentation/
  geometry.json`, `masks/` (6 files matching assignments).

## Concerns

- `medial_osteophytes`, `lateral_osteophytes`, and `ossa_sesamoidea` are
  explicitly flagged `-proposed` pending AP-axis lock in `review_flags`.
  Correctly reflected as subphase `confidence: medium` rather than `high` —
  appropriately cautious, not a defect, and these are grounding/context
  structures (not measured endpoints).
- Patella and both menisci remain unsegmented for this specimen, so the
  volume-based measurements (patella volume, medial/lateral peri-meniscal
  volume) cannot be computed from this artifact set alone downstream. This
  is disclosed, not concealed, and is a legitimate escalation per the skill
  rather than a forced/ungrounded boundary — but it does narrow what this
  segmentation delivers short of the full protocol's structure set.
- `fibula` is labeled as context per the skill's allowance ("assign it if
  present"), and is correctly excluded from the mandatory CC==1 gate and
  from the measured set.

## Blocking

None. The two checks the skill treats as non-negotiable — CC==1 for femur
and tibia, and the bicondylar identity discriminator — both reproduce
exactly under independent, from-scratch recomputation, and the
sesamoid/osteophyte protection check (the core anti-confounder gate this
protocol exists to enforce) is clean at 0 voxels. Visual review against the
reference pack confirms plausible knee anatomy. No modification was made to
`artifacts/` or `phases/`.
