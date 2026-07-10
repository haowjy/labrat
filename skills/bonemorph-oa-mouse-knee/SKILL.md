---
name: bonemorph-oa-mouse-knee
description: Use for the Tang et al. mouse-knee osteoarthritis micro-CT protocol — computing the distal-femur width/length osteophyte ratio, tibial subchondral IIOC height/width, growth-plate segmentation, and trabecular morphometry from a Scanco VivaCT DICOM stack via the bonemorph package. Reach for it whenever the task names mouse OA, MMS/PTOA/AROA knee, femoral W/L ratio, tibial IIOC, or osteophyte quantification from µCT.
---

# bonemorph — mouse-knee OA geometric indices

This is the concrete protocol for **one specific study**: Tang et al.'s CT
geometric indices for osteoarthritis in mice (distal-femur width/length ratio =
osteophyte index; tibial secondary-ossification-center height/width). It
implements that protocol as the installable `bonemorph` package
(`assets/bonemorph-0.1.0.tar.gz`).

## Load the methodology first
This skill is an **application** of `microct-3d-analysis`. Load that skill
first — it carries the render→reason→validate review loop, alignment, and the
ground-truth gating discipline that make the numbers here defensible. This skill
adds the study-specific landmark definitions, thresholds, and package.

## The protocol in one screen
- **Scanner/data:** Scanco VivaCT 40, 10.5 µm isotropic voxels, linear-
  attenuation DICOM. Scanner thresholds are UNITLESS (220 bone/soft-tissue, 320
  for 3D, 270 cortical/plate). The Amira bone mask uses >2500 HU — a *separate*
  system; do not conflate the two.
- **Femoral width** = 3D straight-line distance between lateral and medial
  condylar edges (osteophyte index numerator). Increases with OA.
- **Femoral length** = 3D straight-line distance between the upper midpoint of
  the intercondylar (trochlear) groove and the intercondylar notch. A STABLE
  reference denominator — does not change with OA.
- **W/L ratio** = width / length. **Normal < 1.28, OA > 1.30** (text-quoted,
  exact). THE primary femoral index.
- **Tibial width** = medial↔lateral tibial-condyle borders, on a max-height
  frontal ortho slice.
- **Compartment heights** = tibial-plateau midpoint → epiphyseal line (growth
  plate), medial and lateral.
- **Tibial IIOC height/width ratio**: normal > 0.28, OA < 0.28 (single stated cutoff).
- **Trabecular morphometry** (BV/TV, Tb.Th, Tb.Sp, Tb.N) on the proximal-tibial
  subchondral VOI, per Bouxsein 2010.

## Operationalized landmark rules (what the paper left to judgment)
The paper defines these conceptually; `bonemorph` pins the operational rule.
These are the details that, left vague, made an early automation return a femur
length 2× too short:
- **Intercondylar notch** = distal-most midline bone point.
- **Trochlear groove top** = proximal-most slice of the *sustained anterior-
  midline concavity* (anterior surface dips ≥6 voxels behind the flanking
  trochlear ridges), taken just proximal of the condylar bulge — NOT "where the
  condyles merge" (that lands ~1 mm distal and collapses the length).
- **Condyle edges** = ML-extreme bone points within the distal condylar slab.

## Ground-truth gates
`assets/ground_truth.json` holds the paper's published values as machine-
readable gates. **Gate every auto-computed value.** Provenance is tagged: ratio
thresholds (1.28/1.30, 0.28) are text-exact; mm ranges are figure-read
soft estimates (gates set wide to catch gross errors, not to pinpoint). A value
outside its gate is presumptively wrong → run another review-loop iteration.
`assets/reference_figures/` holds Fig 2 (femoral width/groove-length/W-L) and
Fig 3 (tibial width/heights) — the schematics that draw each measurement line;
use them to ground your reasoning and the vision check.

## Using the package
```python
import bonemorph as bm
vol = bm.load_volume(dicom_zip_or_dir)
seg = bm.segment_knee(vol.hu, vol.voxel_mm, threshold_hu=2500, downsample=2,
                      femur_end="auto")          # auto femur/tibia identity
res = bm.run_sample(path, sample_id, do_morphometry=True)  # full pipeline
bm.build_review_site(seg, fem, tib, out_dir="review_site") # see microct-review-artifact
bm.analyze(df, group_col="group")                # cohort stats + plots
```
Run at 2× downsample for segmentation/geometry (21 µm, far finer than the mm
landmarks); morphometry runs at full resolution on the cropped VOI.

## Known limits on this data (state them; do not paper over)
- **Femur/tibia identity** is only moderately reliable on a single unlabeled
  scan (condyle-count discriminator; margin ~0.11 on the demo sample). Confirm
  in the review UI.
- **Auto landmark placement** is auto-*propose*, not final — confirm in review.
- **Femoral length** depends on the trochlear-groove rule above; verify it
  against the W/L gate every run (a broken groove inflates W/L even when width
  is right).
- **Growth-plate boundary** placed too deep on one side inflates that
  compartment's height — check medial≈lateral symmetry against the gate on
  normal controls.
- The synthetic demo cohort uses literature-typical values, NOT real biology.

## Composition
`microct-3d-analysis` (methodology, load first) + this skill = the full
protocol. Add `microct-review-artifact` to generate the interactive review site
for human confirmation. This skill's operational rules and gates were produced
by applying `paper-protocol-to-skill` to the source methods section.
