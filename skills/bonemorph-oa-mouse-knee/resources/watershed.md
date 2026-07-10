# Watershed — femur/tibia split at the joint line

## Methodology

Subphase **watershed** of segmentation. Separates the fused distal femur and
proximal tibia that share one connected component after thresholding.

**Processing chain** (inside `run_segmentation` after threshold):

- `microct_analysis.processing.segmentation.connected_components` — component labeling
- `microct_analysis.processing.segmentation.extract_label` — component extraction
- `microct_analysis.processing.segmentation.seed_from_region` — diaphyseal seed cores
- `microct_analysis.processing.segmentation.watershed_segment` — marker watershed on distance transform
- `microct_analysis.processing.watershed` — grow markers, prune disconnected CCs
- `microct_analysis.processing.sanity.check` — segmentation sanity warnings

Domain methodology for seeded watershed on bone CT lives in
`microct-3d-analysis/resources/segmentation.md` (parent skill). This protocol
adds only the mouse-knee joint context: adjacent femur/tibia touch at the
tibiofemoral interface; the cut must land at the constriction, not through shaft cortex.

**First-pass behavior (proven):** unseeded run on OA6-1RK returned
`status: needs-seeds` with flags `calibration-unverified` and
`ambiguous-bone-identity`. That is **expected** before seed curation — not a
watershed failure. Watershed still produces `segmentation/components.nii.gz` and
`segmentation/seeds.json` for seed-review.

**Re-run with seeds** (after seed-review phase):

```python
run_segmentation(
    dicom_path="input/OA6-1RK",
    output_dir="segmentation",
    scanner="auto",
    threshold_method="histogram",
    seeds_path="segmentation/seeds.json",
    render_qc=False,
)
```

Second pass should reach `status: ready` with `ambiguity-resolved-via-seeds` in flags.

## Verification

**Correct output looks like:**

- After seeds resolved: `segmentation/labels.nii.gz` with exactly labels **0, 1, 2**
  (background, femur, tibia) for this protocol
- `segmentation/metadata.json` → `pruning_stats` shows disconnected fragments removed
- No `articular-bridging-suspected` without documented review (osteophyte bridge)
- Joint interface localized — femur and tibia masks meet at a thin band, not merged shafts

**Reviewer computes:**

1. **Label inventory** — `np.unique(labels)` ⊆ `{0,1,2}`; femur and tibia voxel counts > 0.
2. **Connected-components gate (critical demo check)** — for each bone in
   `structure_assignments.json` → `assignments`:

   ```python
   from scipy import ndimage
   import nibabel as nib, numpy as np

   labels = np.asanyarray(nib.load("labels.nii.gz").dataobj)
   assigns = json.load(open("segmentation/structure_assignments.json"))["assignments"]
   for bone, lid in assigns.items():
       _, n = ndimage.label(labels == int(lid))
       assert n == 1, f"{bone} label {lid}: {n} components (expected 1)"
   ```

   Equivalent: `microct_analysis.processing.rendering.validate_segmentation_for_landmarking(labels, assignments)`.

   **Proven defect on OA6-1RK:** femur (label 1) had **4** connected components after
   seed replay — this gate **must fail** until pruning/merge is fixed. Do not mark
   watershed or bone-assignment pass while femur CC ≠ 1 or tibia CC ≠ 1.

3. **BBox overlap** — femur/tibia bounding-box overlap ≤ **20%** of smaller bbox
   volume (`validate_segmentation_for_landmarking` check 2).
4. **Boundary touch** — no bone label touches >2 volume faces (FOV crop detection).
5. If `needs-seeds` on first pass only: verify `components.nii.gz` and `seeds.json`
   exist; watershed subphase passes with `confidence: low` pending seed-review.

**Failure modes:**

- Multiple CC per bone — fragmentation, wrong seeds, incomplete pruning (gate fail)
- `articular-bridging-suspected` — osteophyte connects bones; may need manual seeds
- Wide interface band — seeds on wrong axis (see parent `segmentation.md` cut-quality)
- `pruning-dropped-bone:*` flags — a bone lost entirely

**Ground-truth gates:** none directly (geometry gates at landmarks/measurement).
