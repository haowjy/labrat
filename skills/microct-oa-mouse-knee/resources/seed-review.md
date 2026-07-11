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
curate seeds before landmarks. If `status: ready` on the first pass, record
seed-review as a no-op in `phases/seed-review/summary.md` ("seeds not required")
and proceed — don't fabricate seed work.

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

**Look first.** After the re-run, color the bones and confirm femur (two condyles,
near one scan end) and tibia (single plateau) are labeled correctly against
`bone-split__femur-tibia-fibula__3d__workflow.jpg` — seed curation exists to fix a
*visible* identity error, so verify it visually.

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
5. **Plausibility** — femur centroid near a scan end with two condyle components in
   joint-adjacent slices; tibia single-plateau geometry.

**Failure modes:** seed points outside components (fix `seeds.json`); re-run still
needs-seeds (incomplete curation); swapped bones after seeds (heuristic overridden
wrong); persistent multi-CC (a watershed/pruning issue, not seed identity — send
back to watershed).
