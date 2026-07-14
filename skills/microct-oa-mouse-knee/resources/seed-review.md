# Seed review — resolve ambiguous bone identity

## Procedure

Seed-review is a real path, not conditional theater. When the first unseeded
watershed pass returns `status: needs-seeds` (flags `ambiguous-bone-identity` /
`calibration-unverified`), it has already written `segmentation/seeds.json` (scan
fingerprint + component→bone proposals) and `segmentation/components.nii.gz`.
Curating the seeds and replaying resolves identity to `ready`. This is the
human-in-the-loop escalation `understand-3d-medical-volume` calls for — the one
call classical tools can't make alone.

**When to run:** inspect `segmentation/structure_assignments.json`. If `status` is
`needs-seeds`, or flags include `ambiguous-bone-identity` / `calibration-unverified`,
curate seeds before landmarks.

**Identity is verified on EVERY run, including `status: ready`.** A `ready`
status attests segmentation *quality* — CC == 1, clean components — NOT bone
*identity*. Identity must be independently confirmed by the bicondylar
discriminator (check 4 in `structure-assignment.md`) before landmarks,
unconditionally. That check is *comparative* — the femur is the
more-consistently-bicondylar bone at the joint, not "the tibia is single-lobed"
(the tibial plateau is itself lobed in ~half its joint slices). Run that code
discriminator against `labels.nii.gz` first:
- If it **PASSes** (`fem_frac >= 0.60` AND `fem_frac > tib_frac + 0.15`), and
  `status: ready` on the first pass, record seed-review as a no-op in
  `phases/seed-review/summary.md` — but the record must carry the discriminator
  PASS (its `fem_frac` / `tib_frac` / count arrays / verdict) as its precondition.
  "Seeds not required" is only valid once identity is confirmed; don't fabricate
  seed work beyond that.
- If it **FAILs** (`tib_frac > fem_frac + 0.15` — the tibia-labeled bone is the
  more-bicondylar one), the labels are swapped — force seed-curation / send back to
  segmentation, even on a `ready` pass. The discriminator geometry wins over the
  `ready` status.

**Workflow:**

1. Read `segmentation/seeds.json` and the component summary (centroids, bbox, edge
   faces).
2. If `segmentation/components.nii.gz` is present (watershed writes it on a
   needs-seeds pass; a clean pass deletes it, so it is not a declared phase
   input), render component labels on the filtered intensity — a headless PNG with
   `matplotlib` — and inspect against the pack.
3. Curate assignments — palette: **1** femur, **2** tibia, **3** patella,
   **4** medial meniscus, **5** lateral meniscus, **6** medial osteophytes,
   **7** lateral osteophytes, **8** ossa sesamoidea, **9** fibula, **0**
   unassigned. Femur/tibia identity is the load-bearing curation; the grounding
   structures (esp. sesamoids) matter so they are not swept into femur.
4. Write the updated `segmentation/seeds.json`, preserving the original
   `fingerprint`.
5. Re-run segmentation with the curated seeds (see `watershed.md`).
6. Refresh handoff copies: `labels.nii.gz`, `structure_assignments.json`, `masks/`.

## Verification

**Look first.** After the re-run (or on a `ready` no-op pass), color the bones and
confirm femur (two condyles, near one scan end) and tibia (single plateau) are
labeled correctly against `bone-split__femur-tibia-fibula__3d__workflow.jpg` — seed
curation exists to fix a *visible* identity error, so verify it visually. This is
backed by, not a substitute for, the code discriminator in check 5.

**Then the checks:**

1. **Status transition** — if the first pass was `needs-seeds`, the final must be
   `ready`. `needs-seeds → ready` is expected success, not a failure pattern.
2. **Fingerprint match** — `seeds.json` fingerprint equals the
   `volume_metadata.json` fingerprint (same scan, no stale seeds).
3. **Component coverage** — every assigned bone maps to a component above the
   minimum voxel count.
4. **Connected-components gate** — re-apply the femur/tibia CC == 1 check on the
   post-seed `labels.nii.gz`. Seed resolution does not by itself guarantee CC == 1
   (largest-CC cleanup is separate) — check it explicitly.
5. **Identity discriminator (MANDATORY, every run).** Run the bicondylar code
   discriminator from `structure-assignment.md` check 4 against the post-seed (or
   `ready`-pass) `labels.nii.gz`. It is *comparative*: PASS iff the bone labeled
   `femur` is the more-consistently-bicondylar bone (`fem_frac >= 0.60` AND
   `fem_frac > tib_frac + 0.15`). Do NOT expect the tibia to be single-lobed — its
   plateau reads as 2 lobes in ~half its joint slices. A FAIL (`tib_frac >
   fem_frac + 0.15`) means the labels are swapped — do not proceed to landmarks;
   force curation / send back to segmentation. This runs even when seed-review is a
   `ready` no-op.

**Failure modes:** seed points outside components (fix `seeds.json`); re-run still
needs-seeds (incomplete curation); swapped bones after seeds or on a `ready` pass
(discriminator FAILs — override the labels, don't proceed); persistent multi-CC (a
watershed/pruning issue, not seed identity — send back to watershed).
