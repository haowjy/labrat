# Seed review — resolve ambiguous bone identity

## Procedure

**Seed-review is a real path, not conditional theater.** When the first unseeded
`run_segmentation` returns `status: needs-seeds` (flags `ambiguous-bone-identity`
/ `calibration-unverified`), the driver still writes `segmentation/seeds.json`
(scan fingerprint + component→bone proposals) and `segmentation/components.nii.gz`.
Curating the seeds and replaying resolves identity to `status: ready`.

**When to run:** inspect `segmentation/structure_assignments.json`. If `status`
is `needs-seeds`, or flags include `ambiguous-bone-identity` /
`calibration-unverified`, curate seeds before landmarks.

**If `status: ready` on the first pass:** record seed-review as a no-op in
`phases/seed-review/summary.md` ("seeds not required") and proceed. Do not
fabricate seed work.

**Workflow:**

1. Read `segmentation/seeds.json` and `metadata.json` → `components.top`
   (centroids, bbox, edge faces).
2. If `segmentation/components.nii.gz` is present (watershed writes it on a
   `needs-seeds` pass; a clean pass deletes it, so it is not a declared phase
   input), visualize component labels — a headless PNG via
   `processing.rendering.render_slice_view` on the filtered intensity.
3. Curate assignments — palette convention: **1** femur, **2** tibia,
   **3** patella, **4** medial meniscus, **5** lateral meniscus, **6** medial
   osteophytes, **7** lateral osteophytes, **8** ossa sesamoidea, **9** fibula,
   **0** unassigned. Femur/tibia identity is the load-bearing curation; the
   grounding structures (esp. sesamoids) matter so they are not swept into femur.
4. Write the updated `segmentation/seeds.json`, preserving the original
   `fingerprint`.
5. Re-run segmentation with `seeds_path="segmentation/seeds.json"` (see
   `watershed.md`).
6. Refresh harness copies: `labels.nii.gz`, `bone_assignments.json`, `masks/`.

General condyle-count discriminator method:
`microct-3d-analysis/resources/segmentation.md`.

## Verification

**Look first.** After the re-run, color the bones and confirm the femur (two
condyles, near one scan end) and tibia (single plateau) are labeled correctly —
seed curation exists to fix a *visible* identity error, so verify it visually.

**Then the checks:**

1. **Status transition** — if the first pass was `needs-seeds`, the final must be
   `ready`. `needs-seeds → ready` is expected success, not a failure pattern.
2. **Fingerprint match** — `seeds.json` fingerprint equals the
   `volume_metadata.json` fingerprint (same scan, no stale seeds).
3. **Component coverage** — every assigned bone maps to a component above the
   minimum voxel count.
4. **Connected-components gate** — re-apply the femur/tibia CC == 1 check on the
   post-seed `labels.nii.gz`. Seed resolution does **not** by itself guarantee
   CC == 1 (largest-CC cleanup is a separate step) — check it explicitly.
5. **Plausibility** — femur centroid near a scan end with two condyle components
   in joint-adjacent slices; tibia single-plateau geometry.

**Failure modes:** `invalid-seeds` (seed points outside components — fix
`seeds.json`); re-run still `needs-seeds` (incomplete curation); swapped bones
after seeds (heuristic overridden wrong); persistent multi-CC (a
watershed/pruning issue, not seed identity — send back to watershed).
