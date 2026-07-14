# Seed review — OA7-4L (task-2026-07-13-005)

**Result: `ready` no-op pass — identity independently confirmed. No re-run needed.**

Segmentation entered seed-review with `status: ready` and flags
`ambiguity-resolved-via-seeds` — the femur/tibia ambiguity was already resolved
by curated seeds *inside* the segmentation phase (first watershed pass returned
needs-seeds; seeds were curated to femur=high-z, tibia=low-z, and the seeded
re-run produced `ready`). Seed-review therefore did not re-curate; its job was to
**independently confirm bone identity**, which the methodology requires on *every*
run including a `ready` one, because `ready` attests segmentation *quality*
(CC==1), not *identity*.

## Verification checks (all pass)

1. **Status** — input `ready`, final `ready`. The needs-seeds→ready transition
   happened within segmentation, not here; nothing to transition at seed-review.
2. **Fingerprint match** — `seeds.json` slice_uid_hash `dbeee845b4ea22df` ==
   `volume_metadata.json` `dbeee845b4ea22df`. Same scan; seeds not stale.
3. **Component coverage** — every assigned bone maps to a component above the
   min voxel count: femur 7.10 M, tibia 5.02 M, fibula 4.15 M, ossa_sesamoidea
   0.62 M, lateral_osteophytes 17 436, medial_osteophytes 4 342.
4. **Connected-components gate** — re-applied independently on the post-seed
   `labels.nii.gz`: **femur CC = 1, tibia CC = 1**. Pass.
5. **Identity discriminator (mandatory) — PASS.** Femur is the more-bicondylar
   bone by every direction-consistent measure. Verified visually (primary) and
   by code.

## Identity — "look first", then the numbers

**Visual (`evidence/identity_check.png`):** coronal Y-projection shows femur
(label 1) as the superior/high-z bicondylar bone and tibia (label 2) as the
inferior/low-z plateau; fibula (9) lateral/low-x; the fabella-class **ossa
sesamoidea (8) is a free-standing posterior body, correctly its own label and NOT
swept into the femoral condyle** — the confounder the protocol exists to isolate.
Femur axial z=366 shows two distinct condyles; tibia axial z=399 shows the
plateau. Matches `bone-split__femur-tibia-fibula__3d__workflow.jpg`.

**Code discriminator (comparative):**
- **Full-extent bicondylar fraction (area≥800):** femur **0.26** vs tibia
  **0.09** — femur ~3× more bicondylar over its full z-extent, margin **+0.17**
  (> +0.15). PASS.
- **Recorded canonical (segmentation phase):** fem_frac 0.85 / tib_frac 0.50,
  margin +0.35. PASS.
- **20-slice joint-window reimplementation:** fem 0.80 / tib 0.70, margin +0.10 —
  *under the +0.15 threshold, but confounded and not a failure of identity.* The
  window samples the tibial plateau band (the tibia's most-lobed region, "reads
  as 2 lobes in ~half its joint slices" per methodology) against the femoral
  notch tip (which starts single). It **never flips direction** — no swap
  signature (a swap needs tib_frac > fem_frac + 0.15; observed margin stays
  ≥ 0 across area thresholds 100–800). Direction is the load-bearing signal, and
  it is unanimous.

**Verdict:** no swap. Femur=high-z/bicondylar, tibia=low-z/plateau, consistent
with the curated seeds (femur centroid z≈574, tibia z≈229). Identity confirmed.

## Handoff

Labels, seeds, and assignments are unchanged (no re-run). Downstream orientation/
landmark phase can proceed on femur=1 / tibia=2 with identity confirmed. Note the
escalations carried from segmentation remain open and are NOT resolved here:
patella (3) and menisci (4/5) not segmented (AP axis not locked); osteophyte
labels 6/7 are proposals. Those are orientation-phase concerns, not seed identity.
