# Watershed — femur/tibia split at the joint line

## Procedure

Subphase **watershed** of segmentation. Separates the fused distal femur and
proximal tibia that share one connected component after thresholding. The
general seeded-watershed method (markers, distance transform, cut quality) is in
`microct-3d-analysis/resources/segmentation.md`. This resource adds only the
mouse-knee joint context: femur and tibia touch at the tibiofemoral interface;
the cut must land at that constriction, not through shaft cortex.

Processing inside `run_segmentation` after threshold:
`processing.segmentation.{connected_components, extract_label, seed_from_region,
watershed_segment}`, `processing.watershed` (grow markers, prune disconnected
CCs), `processing.sanity.check`.

**First-pass behavior is often `needs-seeds`, and that is expected.** An
unseeded run on ambiguous identity returns `status: needs-seeds` with flags like
`calibration-unverified` / `ambiguous-bone-identity` — not a failure. Watershed
still writes `segmentation/components.nii.gz` and `segmentation/seeds.json` for
seed-review. (On the demo fixture the first pass returned exactly this.)

**Re-run with curated seeds** (after seed-review):

```python
run_segmentation(
    dicom_path="input/<series-dir>",
    output_dir="segmentation",
    scanner="auto",
    threshold_method="histogram",
    seeds_path="segmentation/seeds.json",
    render_qc=False,
)
```

The seeded pass should reach `status: ready` with `ambiguity-resolved-via-seeds`.

## Verification

**Look first.** Render femur and tibia in distinct colors and rotate. They
should meet at a thin band at the joint line, each a single clean solid. Two
merged shafts, a cut through mid-diaphysis, or a bone in pieces is visible
immediately — find it here before trusting any count.

**Then the structural gate (this is the critical, always-on check):**

1. **Label inventory** — femur and tibia labels present with voxel counts > 0
   (the watershed split target). Other structure labels may also be present
   (patella, menisci, osteophytes, sesamoids, assigned in bone-assignment) —
   they are not required at this subphase.
2. **Connected components — each bone is exactly one.** This is a *process*
   check (a real bone is one solid), not a specimen measurement:

   ```python
   from scipy import ndimage
   import nibabel as nib, numpy as np, json

   labels = np.asanyarray(nib.load("labels.nii.gz").dataobj)
   assigns = json.load(open("segmentation/structure_assignments.json"))["assignments"]
   for bone in ("femur", "tibia"):        # CC == 1 required only for the measured bones
       lid = assigns[bone]
       _, n = ndimage.label(labels == int(lid))
       assert n == 1, f"{bone} label {lid}: {n} components (expected 1)"
   # menisci / osteophytes / sesamoids may be multi-component (scattered calcification)
   ```

   Equivalent:
   `processing.rendering.validate_segmentation_for_landmarking(labels, assignments)`.
   **Do not pass watershed or bone-assignment while any bone's CC ≠ 1.** (On the
   demo fixture, femur came back as 4 components — 3 sub-100-voxel specks — until
   largest-CC cleanup ran. That defect is exactly what this gate exists to
   catch.)
3. **Interface localized** — femur/tibia bounding-box overlap ≤ 20% of the
   smaller bbox; no bone label touches more than 2 volume faces (FOV crop).
4. If `needs-seeds` on the first pass only: confirm `components.nii.gz` and
   `seeds.json` exist; watershed passes with `confidence: low` pending
   seed-review.

**Failure modes:** multiple CC per bone (fragmentation / wrong seeds /
incomplete pruning — gate fail); `articular-bridging-suspected` (an osteophyte
connects the bones — may need manual seeds); wide interface band (seeds on the
wrong axis); `pruning-dropped-bone:*` (a bone lost entirely).
