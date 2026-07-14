# Structure assignment — name the full knee scene

## Procedure

Subphase **structure-assignment** of segmentation, and the phase's headline
deliverable: the watershed components **named** into the full labeled scene, with
per-structure masks. There is no pretrained model for this anatomy — naming is a
visual-reasoning step grounded in `resources/reference-pack.md`, following
`understand-3d-medical-volume`'s "select a target → inspect linked 2-D → name →
verify" loop. Classical tools split the blobs; the pack and the landmarks say
which is which.

**The structure set** (label → what it is → role):

| Label | Structure | Role |
|-------|-----------|------|
| `femur` | distal femur (two condyles) | measured (W/L) — CC == 1 |
| `tibia` | proximal tibia (single plateau) | measured (IIOC) — CC == 1 |
| `patella` | anterior sesamoid in the extensor tendon | measured (volume); anterior anchor |
| `medial_meniscus` | peri-meniscal calcified synovium, medial | measured (volume) |
| `lateral_meniscus` | peri-meniscal calcified synovium, lateral | measured (volume) |
| `medial_osteophytes` | osteophytes, medial | grounding — kept OUT of femoral width |
| `lateral_osteophytes` | osteophytes, lateral | grounding — kept OUT of femoral width |
| `ossa_sesamoidea` | fabellae / periarticular sesamoids | grounding — the confounder; label so it is never read as osteophyte |
| `fibula` | context (early bone pass) | context; drops out of the measured set |

- Name each component by comparing to the pack: femur = two condyles near one scan
  end; tibia = single plateau block; patella = anterior body; menisci at the joint
  line, medial/lateral; **ossa sesamoidea = small rounded posterior bodies** — the
  confounder (`figure2-scene__patella-sesamoid-vs-osteophyte__paper.png`).
- **Fix the anterior–posterior axis before splitting sesamoid from osteophyte.**
  The "posterior body = sesamoid" test depends on the AP axis, which comes from the
  patella (anterior). If the patella is small, atrophied, or ambiguous — common in
  the aged/OA specimens this protocol studies — resolve orientation first (the
  parent method's orientation workflow) or escalate; do not apply the posterior
  rule against a guessed axis, or a sesamoid can be folded into femoral width before
  "posterior" was ever defined.
- **Fibula establishes laterality:** its side is lateral. Label it as context when
  visible, then confirm the selected side in linked 3-D/2-D views so a posterior or
  wrong-side component is not accepted. It is not required for measurement —
  assign it if present, don't manufacture it if absent.
- Segment menisci with a **lower intensity range than bone**. The ligament
  attachment is not visible in this µCT view; do not invent its boundary.
- Interpret osteophytes against a normal specimen: they are abnormal new bone
  expected after meniscal destabilization, not any periarticular mineralized body.
- Treat patellar enlargement relative to normal as an OA parameter.
- Write `labels.nii.gz`, per-structure `masks/<structure>.nii.gz`, and
  `structure_assignments.json`.

## Emit the shared 3D mesh — `segmentation/geometry.json` (once)

`labels.nii.gz` now exists, so this is the ONE place the labeled scene becomes a
surface mesh. Emit `segmentation/geometry.json` here; **every downstream phase's
3D review site references this one file** (server-side injection, hash-verified —
seed-review, landmarks, and measurement do NOT recompute geometry). Emit it once,
correctly.

- For each structure's binary mask from `labels.nii.gz`: **fill enclosed
  cavities** (`scipy.ndimage.binary_fill_holes`) and pad a one-voxel zero border
  so shaft ends cropped by the volume edge get **capped** — otherwise marching
  cubes leaves the hollow medullary wall showing through the opening. Then run
  **full-resolution** marching cubes (`skimage.measure.marching_cubes`,
  `step_size=1`): the cortical surface texture — the pitting that makes the bone
  read as real micro-CT instead of a smooth blob — lives in that detail; do not
  coarsen it away. (Crop each mask to its bounding box first — `fill_holes` on the
  full volume is far too slow — then offset vertices back to the global frame.)
- Convert to the review frame: `vertices = mc_verts[:, ::-1] * spacing_mm` (the
  label volume is indexed ZYX; the site expects `[x,y,z]` mm). That reversal is a
  reflection, so **repair winding** afterward (build the mesh in the final
  coordinate space and run `trimesh.repair.fix_normals`) — decimation plus the
  reflection otherwise leave mixed/inward normals, which `computeVertexNormals`
  averages to ~zero and the mesh renders **black**.
- **Decimate per structure to a triangle target** (quadric decimation —
  `fast-simplification`/`open3d`/`vtk`) that preserves surface detail while
  staying in budget: femur ~150K tris, tibia ~130K, fibula ~60K, sesamoids ~50K,
  small osteophytes full-res. Round coordinates to ~3 decimals (µm). This lands
  each self-contained site around 9–14 MB alongside the inlined ~785 KB three.js.
- One entry per named structure (`femur`, `tibia`, and the others you assigned);
  faces are 0-based triangle vertex indices. Shape:

  ```json
  {
    "meshes": {
      "femur": { "vertices": [[x,y,z], ...], "faces": [[i,j,k], ...] },
      "tibia": { "vertices": [...], "faces": [...] }
    }
  }
  ```

- This is a **visualization artifact only** — it does not change the science.
  The scientific gate checks it exists and is well-formed like any other output;
  the shared mesh feeds the review chain, not the measurements.
- **Do not overwrite** any `review/geometry.json` (that path belongs to the final
  `review-artifact` phase; keeping this at `segmentation/geometry.json` is what
  lets the earlier phases' hash-verified sites survive that phase's own recompute).

**Femur/tibia identity** carries both ratio indices. It is NOT settled by
z-position or volume order — those are heuristics that swap on legitimate
specimens (a scan with more tibial shaft in FOV can put more voxels in the
tibia and the femur at low z). Identity is settled only by the **mandatory
bicondylar discriminator** in Verification below — a comparative test (the femur
is the more-consistently-bicondylar bone at the joint) that runs in code on every
pass and whose geometry wins over any heuristic.

## Verification

**Look first — against the reference.** Color the full scene and compare to
`labeled-scene__all-structures__3d-linked__workflow.jpg`: femur superior, tibia
inferior, patella anterior, menisci at the joint line, sesamoids as separate small
bodies. Confirm each 3-D label agrees with its 2-D contour in all three planes. A
swap, or a sesamoid fused to the femur, is obvious here and invisible in the
numbers. This visual step is *backed by* the code discriminator in check 4 — it is
not a substitute for it.

**Then the checks:**

1. **Assignment JSON** — distinct positive labels; femur and tibia present
   (measurement can't proceed without them); grounding structures (osteophytes,
   sesamoids) and context (fibula) present when visible in the scan.
2. **Connected-components gate (femur + tibia)** — re-apply the watershed CC check;
   each exactly 1. The independent-review moment — fail if either ≠ 1. Menisci /
   osteophytes / sesamoids may be multi-component.
3. **Sesamoid / osteophyte separation (required)** — no `ossa_sesamoidea` or
   `*_osteophytes` voxels inside the femoral condyle slab used for width. This is
   what protects the W/L index; check it explicitly.
4. **Bicondylar identity discriminator (MANDATORY, EVERY pass).** The femur is the
   **more-consistently-bicondylar** bone at the joint line; the tibia is the
   less-bicondylar one. This is a *comparative* test, not an absolute one — the real
   proximal tibial plateau reads as 2 lobes in ~half its joint slices (its own
   medial/lateral condyles), so "the tibia is single-lobed" is anatomically false
   and must not be used. What separates the bones is that the femur is *consistently*
   bicondylar (a long contiguous run of 2-lobe slices) while the tibia is *noisily*
   lobed. Run this deterministic, code-runnable check whether `status` is `ready` or
   `needs-seeds`, and whether or not identity looks obvious. It is the sole thing
   that clears femur/tibia identity; the "look first" step, z-position, and volume
   order do not. Run it, in python, against `labels.nii.gz`:

   ```python
   import nibabel as nib, numpy as np
   from scipy import ndimage

   lab = nib.load("artifacts/labels.nii.gz").get_fdata().astype(int)
   FEMUR, TIBIA = 1, 2          # the integer labels assigned to femur / tibia
   BICONDYLAR_MIN = 0.60        # femur-labeled bone must itself be clearly bicondylar
   MARGIN = 0.15                # topology margin: how much MORE bicondylar the femur must be

   def centroid(m): return np.array(np.nonzero(m)).mean(axis=1)
   fm, tm = (lab == FEMUR), (lab == TIBIA)
   # Split axis = the axis along which the two bones stack (largest centroid gap).
   AX = int(np.argmax(np.abs(centroid(fm) - centroid(tm))))

   def band(mask, toward, n=20):
       # n slices of `mask` at the end of AX nearest the other bone's centroid
       idx = np.nonzero(mask.any(axis=tuple(i for i in range(3) if i != AX)))[0]
       lo, hi = idx.min(), idx.max()
       return range(hi - n + 1, hi + 1) if toward > (lo + hi) / 2 else range(lo, lo + n)

   def lobes(mask, k):
       sl = np.take(mask, k, axis=AX)
       lbl, n = ndimage.label(sl)
       if n == 0: return 0
       sizes = np.array([(lbl == i).sum() for i in range(1, n + 1)])
       # keep only substantial lobes: ≥20% of the largest in-slice component,
       # and ≥10 voxels — this drops specks and keeps two comparable condyles.
       return int((sizes >= max(10, 0.2 * sizes.max())).sum())

   ct, cf = centroid(tm)[AX], centroid(fm)[AX]
   fem_counts = [lobes(fm, k) for k in band(fm, ct)]   # femur band toward tibia
   tib_counts = [lobes(tm, k) for k in band(tm, cf)]   # tibia band toward femur
   fem_frac = sum(c >= 2 for c in fem_counts) / len(fem_counts)   # fraction bicondylar
   tib_frac = sum(c >= 2 for c in tib_counts) / len(tib_counts)
   if tib_frac > fem_frac + MARGIN:
       verdict = "FAIL"        # tibia-labeled bone is more bicondylar -> labels swapped
   elif fem_frac >= BICONDYLAR_MIN and fem_frac > tib_frac + MARGIN:
       verdict = "PASS"        # femur-labeled bone is the clearly-more-bicondylar one
   else:
       verdict = "AMBIGUOUS"   # too close -> flag ambiguous-bone-identity -> seed-review
   ```

   - **PASS** iff the bone labeled `femur` is itself clearly bicondylar
     (`fem_frac >= 0.60`) AND is the more-bicondylar bone by a clear margin
     (`fem_frac > tib_frac + 0.15`). Record `fem_frac`, `tib_frac`, both
     `fem_counts` / `tib_counts` arrays, and `verdict` into
     `structure_assignments.json` (key `bicondylar_discriminator`), and emit an
     evidence PNG of the two joint bands (labeled lobes) alongside the scene image.
   - **FAIL (swapped)** iff `tib_frac > fem_frac + 0.15` — the tibia-labeled bone is
     the more-bicondylar one, so the labels are swapped. The ASSIGNMENT IS WRONG;
     the discriminator geometry WINS over any volume-order or z-position heuristic.
     Correct the labels (swap femur↔tibia) or drop to `needs-seeds` and re-run. A
     `status: ready` must NOT stand while the discriminator FAILs.
   - **AMBIGUOUS** iff `|fem_frac - tib_frac| <= 0.15` — too close to call. Flag
     `ambiguous-bone-identity` and send to seed-review. (`MARGIN = 0.15` is a
     topology margin, not tuned to a measurement value; on real correct anatomy the
     gap is ~0.35 (fem 0.85 vs tib 0.50), well clear of it.)
5. **Volume ordering is a trigger, not an escape.** Femur voxels are *usually* ≥
   tibia, but a legitimate specimen can invert this (more tibial shaft in FOV). So
   a `bone-volume-order-wrong` situation — or any other identity ambiguity — is NOT
   cleared by a documented plausibility note. It **mandatorily requires check 4 to
   PASS** with its evidence recorded; only that PASS clears it. A discriminator
   AMBIGUOUS (the two bicondylar fractions within `MARGIN`) → flag
   `ambiguous-bone-identity` and send to seed-review.

**Failure modes:** ambiguous identity (needs seed-review — expected on the first
pass); swapped femur/tibia (discriminator FAILs → swap or re-seed); a sesamoid or
osteophyte merged into femur (inflates width — re-seed to split); multiple CC per
bone (fragmentation).

Compare structures to each other, not to a specimen's absolute voxel counts.
