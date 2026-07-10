# Seed review — resolve ambiguous bone identity

## Methodology

**Seed-review is a real path, not conditional theater.** On OA6-1RK the first
unseeded `run_segmentation` returned `status: needs-seeds` with flags
`calibration-unverified` and `ambiguous-bone-identity`. The driver still wrote
`segmentation/seeds.json` (scan fingerprint + component→bone proposals) and
`segmentation/components.nii.gz`. Replaying that seeds file produced
`status: ready` with assignments `{femur: 1, tibia: 2}`.

**When to run this phase:** inspect `segmentation/structure_assignments.json`
→ if `status` is `needs-seeds`, or flags include `ambiguous-bone-identity` /
`calibration-unverified`, perform seed curation before landmarks.

**Workflow:**

1. Read `segmentation/seeds.json` and `segmentation/metadata.json` → `components.top`
   for centroids, bbox, edge faces.
2. If `components.nii.gz` exists, visualize component labels (headless PNG via
   `microct_analysis.processing.rendering.render_slice_view` on filtered intensity).
3. Curate assignments — palette mapping from `workflows/review.py` convention:
   - **1** femur, **2** tibia, **3** patella, **4** fibula, **5** unassigned
4. Write updated `segmentation/seeds.json` preserving `fingerprint` from original.
5. Re-run segmentation:

```python
from microct_analysis.stages.segmentation import run_segmentation

report = run_segmentation(
    dicom_path="input/OA6-1RK",
    output_dir="segmentation",
    scanner="auto",
    threshold_method="histogram",
    seeds_path="segmentation/seeds.json",
    render_qc=False,
)
```

6. Refresh harness copies: `labels.nii.gz`, `bone_assignments.json`, `masks/`.

**Domain references:**

- `microct-3d-analysis/resources/segmentation.md` — condyle-count discriminator
- `domain/seed_curation.SeedState` + `workflows/review.py` — interactive pattern
  (LabRat uses artifact curation + re-run instead of PyVista when headless)

**If `status: ready` on first segmentation:** record seed-review as no-op in
`phases/seed-review/summary.md` ("seeds not required") and proceed — do not
fabricate seed work.

## Verification

**Correct output looks like:**

- After curation + re-run: `structure_assignments.json` → `status: ready`
- `flags` includes `ambiguity-resolved-via-seeds` when seeds were applied
- `assignments` stable across re-run (same femur/tibia label IDs or documented change)
- `labels.nii.gz` updated in place with femur+tibia present

**Reviewer computes:**

1. **Status transition** — if first pass was `needs-seeds`, final must be `ready`.
   `needs-seeds` → `ready` is **expected success**, not a failure pattern.
2. **Seeds fingerprint match** — `seeds.json` fingerprint matches
   `volume_metadata.json` fingerprint (same scan, no stale seeds).
3. **Component coverage** — every assigned bone maps to a component with > min voxel count.
4. **Connected-components gate** — re-apply femur/tibia CC == 1 check on post-seed
   `labels.nii.gz` (same code as watershed Verification). Seed resolution does not
   by itself guarantee CC == 1 (OA6-1RK still had femur CC=4 after seed replay).
5. **Assignment plausibility** — femur centroid closer to scan end with two condyle
   components in joint-adjacent slices vs tibia single-plateau geometry.

**Failure modes:**

- `invalid-seeds` — seed points outside components; fix seeds.json
- Re-run still `needs-seeds` — incomplete curation
- Swapped femur/tibia after seeds — condyle heuristic overridden incorrectly
- Persistent multi-CC femur/tibia — watershed/pruning issue, not seed identity alone

**Ground-truth gates:** none (geometry at segmentation CC gate + later measurement gates).
