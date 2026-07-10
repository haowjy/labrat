# Segmentation

## Threshold, because bone is high-contrast
Mineralized bone has a strong intensity edge, so a **fixed HU threshold** is the
right primary segmenter — reproducible, no training, matches the literature.
Use the convention your reference method specifies (e.g. >2500 HU for the
Amira bone mask; Scanco per-compartment thresholds 320/270 for
subchondral/plate). Report the threshold you used; it is the single most
important reproducibility parameter.

## Separating fused structures — seeded watershed
Adjacent bones (distal femur + proximal tibia) touch at the joint and threshold
into **one connected component**. This is exactly why the manual Amira workflow
needs hand-placed watershed seeds. Automate it with a **seeded watershed on the
distance transform**:

1. Compute the Euclidean distance transform (EDT) of the bone mask.
2. Seed from the thick EDT cores in the first and last ~8% of the long axis
   (the two diaphyseal ends — unambiguously one bone each).
3. Flood on `-EDT`; the basins meet at the joint-line constriction (the
   thinnest bridge), which is where the anatomical cut belongs.

`mc_watershed_split(mask, long_axis)` returns two labels.

## Always verify the cut quantitatively
A watershed *always* returns a partition — that it ran tells you nothing. Verify
with `mc_cut_quality(A, B)`:
- **unassigned_frac** and **overlap_frac** should be ≈0 (every bone voxel goes
  to exactly one label).
- **interface_band** should be *localized* (a thin band, ~1–1.5 mm at the joint
  line) — a smeared interface means the cut wandered through the shaft.

A clean cut looks like: unassigned 0, overlap 0, interface band ~1.4 mm. If the
band is wide, the seeds are wrong (often the long axis is misidentified, or the
thick-region fraction is too large) — fix and re-cut. Do not proceed on an
unverified split.

## Which piece is which
After splitting you still must label the pieces. Use an **anatomical
discriminator**, not position (position flips between scans). Example: near the
joint tip the distal femur splits into two condyles (two cross-sectional
components), whereas the tibial plateau is a single block — count components per
slice near each end. Report the **margin** of this call; when it is thin
(e.g. condyle-score margin ~0.1), flag it low-confidence and require review, and
expose an override (`femur_end="high"/"low"`).

## When to use a learned/foundation segmenter instead
Decision rule: **is there an intensity edge at the boundary you want?**
- **Yes (bone, mineralized tissue)** → threshold + morphology + watershed. More
  accurate, reproducible, no GPU/weights. This is the default; do not add a
  learned model.
- **No (cartilage, soft-tissue margin, tumor, unmineralized growth plate seen
  as a *gap*)** → a learned segmenter (MedSAM/SAM2, nnU-Net, MONAI) or an
  intensity-*gap* heuristic can help. Note: unmineralized structures often show
  up as **low-density gaps between mineralized regions** — you can frequently
  segment them by locating the gap (see how the growth plate is found in
  `bonemorph-oa-mouse-knee`) without any learned model.

Foundation segmentation models are **not preinstalled** in this environment, and
most need a GPU plus a weights download (this box is CPU-only, 16 GB). If a
soft-tissue task genuinely needs one, install from PyPI (`segment-anything`,
`monai`, `nnunetv2`) and run on remote GPU compute. Search the skill catalog
first (`search_skills`) in case a model skill has since been added.
