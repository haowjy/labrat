# Seed-review verification — task-2026-07-13-005

Independent recomputation from disk artifacts only (`artifacts/labels.nii.gz`,
`artifacts/segmentation/seeds.json`, `artifacts/structure_assignments.json`,
`artifacts/intake/volume_metadata.json`). Verification code and full stdout are
in this directory (transient; not persisted as separate files beyond this report,
each check re-run via Bash/Python against the real artifacts).

## Confirmed

- **Status transition**: input `ready` (segmentation resolved `needs-seeds` →
  `ready` internally via curated seeds), final `ready`. No re-run occurred at
  seed-review, which is a valid no-op path per the phase skill provided the
  mandatory identity discriminator is independently confirmed — it is (below).
- **Fingerprint match**: `seeds.json` and `volume_metadata.json` both carry
  `slice_uid_hash = dbeee845b4ea22df`. Confirmed by direct grep of both files.
- **Component coverage**: recomputed voxel counts directly from
  `labels.nii.gz` via `np.unique` — femur **7,103,993**, tibia **5,020,023**,
  fibula **4,146,135**, ossa_sesamoidea **624,281**, lateral_osteophytes
  **17,436**, medial_osteophytes **4,342**. Exact match to
  `structure_assignments.json` and to `phases/seed-review/measurements.json`.
- **Connected-components gate**: independently ran `scipy.ndimage.label` on
  `labels.nii.gz` — **femur CC = 1, tibia CC = 1**. Matches claim.
- **Bicondylar identity discriminator (mandatory, check 4)** — re-implemented
  the *exact* canonical algorithm from
  `skills/microct-oa-mouse-knee/resources/structure-assignment.md` (20-slice
  joint-facing band per bone, lobe count via ≥20%-of-max-lobe / ≥10-voxel
  filter, split axis = argmax centroid gap) against the real `labels.nii.gz`,
  independent of the worker's code. Result: split axis 0 (z), fem band
  z=[354,373], tib band z=[386,405], **fem_frac = 0.85, tib_frac = 0.50,
  margin = 0.35, verdict PASS** — an exact match to the "recorded canonical"
  values in the summary and `structure_assignments.json`. This is the
  authoritative check per the skill (PASS requires `fem_frac>=0.60` AND
  `fem_frac > tib_frac+0.15`; both hold). No swap.
- **Sesamoid/osteophyte separation from femoral condyle slab** (check 3,
  supporting evidence for the "sesamoid not swept into femur" claim):
  independently sliced `labels.nii.gz` at the recorded condyle slab
  (z=[354,472], x=[109,375]) — **0 ossa_sesamoidea voxels** inside it,
  confirming the sesamoid is a separate, non-confounding structure.
- **Visual check**: `evidence/identity_check.png` shows femur (orange) as the
  high-z bicondylar bone and tibia (green) as the low-z plateau, sesamoid
  (purple) as a distinct free-standing body not fused to either — consistent
  with the reference pack framing and the numeric checks above.

## Concerns

- The worker's own "full-extent" bicondylar reimplementation (area≥800 over
  all 476/406 slices, not the canonical 20-slice joint band) gives fem_frac
  0.26 — well under the 0.60 absolute threshold — and is reported as
  supplementary, not the gating computation. This is used only as directional
  corroboration ("never flips") and is correctly *not* substituted for the
  canonical check, which does pass cleanly. Non-blocking, but worth noting the
  summary leans on three different windowings; only the canonical one is
  load-bearing and it is correct.
- `identity_check.png`'s middle/right axial panels both show two blobs at the
  chosen single slices (z=366 "femur, expect 2 condyles" and z=399 "tibia,
  plateau" — caption implies single mass but shows two). This is exactly the
  "tibia plateau reads as 2 lobes in ~half its joint slices" caveat the skill
  itself calls out, not a discriminator failure (the 20-slice-band statistic,
  not a single slice, is what's authoritative, and it passes). Caption phrasing
  is mildly misleading in isolation; does not change the verdict.

## Blocking

None.
