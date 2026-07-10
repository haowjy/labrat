# Cleaning & preprocessing

## Load to physical units first
Micro-CT stacks store integer attenuation, not Hounsfield units. Apply the
DICOM `RescaleSlope`/`RescaleIntercept` (`HU = raw*slope + intercept`) before
any thresholding, so a threshold means the same thing across scans and matches
the reference method (e.g. bone at >2500 HU for the Amira marker-based
pipeline; note the Scanco scanner itself uses separate *unitless* thresholds —
220 bone/soft-tissue, 320 for 3D, 270 for cortical/plate — not HU, so keep the
two systems distinct).
`mc_load_stack` does this and returns `(vol_hu, voxel_mm)`.

Confirm the long axis and voxel size: print the HU percentiles and the
per-slice bone-area profile. The long axis is the one along which bone area
varies most (shaft → joint).

## Denoise — 3D median, not Gaussian
A **3D median filter** (size 2–3) removes speckle while preserving the sharp
mineralization edge that thresholding depends on. Gaussian blurs that edge and
shifts apparent bone volume — avoid it before thresholding. Median is the
denoise step in the Amira/Scanco workflows for the same reason.

Cost scales with volume: full-resolution 3D median on a ~200 M-voxel stack is
minutes. Two practical options:
- **Downsample for segmentation/geometry** (2×, ≈21 µm) — landmark distances
  are millimetre-scale, so 21 µm sampling is far finer than needed and runs
  ~8× faster. Keep full resolution only for trabecular morphometry on a small
  cropped VOI, where microstructure matters.
- Median cost by factor (this hardware, ~800-slice mouse knee): 2×≈11 s,
  3×≈3 s, 4×≈1 s. The distance transform (used for watershed) scales similarly.

## Morphological cleanup
After thresholding, a single **binary closing** (radius 1) bridges one-voxel
gaps from noise; then **keep the largest connected component** to drop
detached specks. Do not over-close — a large structuring element fuses
structures that should stay separate (e.g. bridges the joint space you are
about to split). `mc_clean(mask, closing=1, keep_largest=True)`.

Order matters: denoise → threshold → close → keep-largest. Closing before
thresholding is meaningless; keep-largest before closing can discard a piece
that closing would have reconnected.
