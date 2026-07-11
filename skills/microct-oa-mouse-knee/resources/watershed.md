# Watershed — split femur and tibia at the joint line

## Procedure

Subphase **watershed** of segmentation. The artifact: `segmentation/components.nii.gz`
— the fused distal femur and proximal tibia (one connected component after
thresholding) separated into distinct labels. The general seeded-watershed method
(markers, distance transform, cut quality) is in `understand-3d-medical-volume`;
this adds only the mouse-knee joint context: femur and tibia touch at the
tibiofemoral interface, and the cut must land at that constriction, not through
shaft cortex. Write it with `scipy.ndimage` / `skimage.segmentation.watershed`.

- Place markers (from threshold), compute the distance transform, run marker-based
  watershed inside the bone mask, prune disconnected specks (keep the largest
  connected component per bone).
- **First-pass `needs-seeds` is expected** on ambiguous identity: write
  `segmentation/components.nii.gz` and `segmentation/seeds.json` (component
  centroids / bbox / edge faces + proposed bone identity) and stop for seed-review
  — don't fail. A curated re-run resolves it to `ready`.

## Verification

**Look first.** Render femur and tibia in distinct colors and rotate. They should
meet in a thin band at the joint line, each one clean solid (reference:
`bone-split__femur-tibia-fibula__3d__workflow.jpg`). Two merged shafts, a cut
through mid-diaphysis, or a bone in pieces is visible immediately — find it here
before trusting any count.

**Then the structural gate (critical, always-on):**

1. **Connected components — each bone is exactly one.** A *process* check (a real
   bone is one solid), not a specimen measurement:

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

   **Do not pass watershed or structure-assignment while any bone's CC ≠ 1.** A
   bone that comes back as several components (a few sub-100-voxel specks) until
   largest-CC cleanup runs is exactly what this gate catches.
2. **Interface localized** — femur/tibia bounding-box overlap ≤ ~20% of the smaller
   bbox; no bone label touches more than 2 volume faces (FOV crop).
3. If `needs-seeds` on the first pass: confirm `components.nii.gz` and `seeds.json`
   exist; watershed passes with `confidence: low` pending seed-review.

**Failure modes:** multiple CC per bone (fragmentation / wrong seeds); an
osteophyte bridging the two bones (may need manual seeds); wide interface band
(seeds on the wrong axis); a bone lost entirely (pruning too aggressive).
