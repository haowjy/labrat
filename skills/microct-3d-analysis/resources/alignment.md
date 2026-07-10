# Alignment / reorientation

## Why align at all
Specimens are scanned in whatever pose they were mounted. Standard morphometry
protocols reorient the dataset so anatomical planes line up with the image axes
before taking ortho-slice measurements (e.g. "reorient to the global center,
parallel to the x/y plane, then take the frontal ortho slice"). If your
measurements are **3D straight-line distances between landmarks**, they are
**rotation-invariant** — alignment then only affects *display* (the ortho
slices a human reviews), not the numbers. State which case you are in.

## Fit the axis to the shaft, not the whole bone
The naïve long axis (PCA or centroid line of the whole bone) is **pulled by the
flared epiphysis/condyles** and comes out tilted. Fit the long axis to the
**diaphysis only** — exclude the flared ends. `mc_shaft_axis(mask,
plateau_high, shaft_frac=(0.45,0.95))` fits over the 45–95% distance-from-
epiphysis band. On a flexed mouse knee this dropped residual tilt from ~29–40°
(whole-bone fit) to ~2–3° (shaft fit), with 100% of voxels retained.

## Read the protocol: some measurements need NO reorientation
Do not assume every measurement needs a common aligned frame. Check what the
protocol actually specifies per measurement. A worked example (the mouse-knee
OA protocol) uses **two different schemes for the two bones**:
- **Femur** — measured as a **3D straight-line distance between two voxels on
  the 3D model, with no reorientation at all**. A 3D distance is rotation-
  invariant, so orientation is irrelevant to the number.
- **Tibia** — measured **on a 2D ortho slice**, after reorienting the *whole
  dataset* to a frontal tibial plane (Transform Editor → global center →
  parallel to x/y). Here orientation matters because the measurement is taken
  on a slice.

So "align the specimen" is not one step applied uniformly — it is per-
measurement: none for a 3D-distance landmark pair, a frontal-plane
reorientation for a slice-based measurement.

## Per-bone rotation is a DISPLAY choice, not a protocol
A flexed/twisted joint has the two bones in **different rotational frames** (the
mouse-knee sample had the femur and tibia rotated ~64° apart about the long
axis — see the criss-cross diagnostic below). No single rotation makes both
bones upright at once. If you want a *unified* review render with both bones
anatomically upright, you must align each bone independently — but this
**per-bone rotation is your engineering choice for the review display**, NOT
something the protocol specifies. The example protocol reorients only the
dataset-for-the-tibia-slice and does not reorient the femur at all; do not
credit per-bone alignment to it. Because the measurements are 3D distances (or
taken on each bone's own slice), per-bone display rotation does **not** change
any number — verify by computing a width in the raw frame and the aligned frame
and confirming they match to interpolation rounding (~0.01 mm).

## Criss-cross of two bones' lines = inter-bone rotational mismatch
If you render both bones' measurement lines in one shared frame and they
**criss-cross**, that is a diagnostic sign the two bones sit in different
rotational frames — each line is correct on its own bone (each bone's ML axis
picked from that bone's own condyle spread), but the bones are twisted relative
to each other, so their ML directions diverge in the shared scene. It is a
**display artifact of an un-aligned joint, not a measurement error**. Expected
on flexed/twisted specimens; resolved (for display only) by per-bone alignment.

## Fix tilt AND roll — a long-axis fit is only half the frame
Aligning the long axis to the image z-axis removes **tilt** but leaves **roll**
about that axis free — so the transverse (ML/AP) plane is still rotated by an
unknown angle. A render in this half-aligned frame is NOT a true coronal or
sagittal section, and a vision check run on it will report a width line as
"running anterior-posterior" when it is actually medial-lateral. To get a true
anatomical frame you need a **second independent direction** to pin the roll —
e.g. the posterior-condyle line for the femur (both condyles' posterior
extremes), or the tibial-plateau ML axis. Build the basis: e_pd = shaft axis;
e_ml = (roll reference) orthogonalized against e_pd; e_ap = e_pd × e_ml.

**Do not pin the roll with the vector you are about to measure.** If you define
the ML axis from the two condyle-edge landmarks and then "verify" that the
width line (those same two points) is ML-dominant, the decomposition is
circular — it comes out ML by construction and proves nothing. The roll
reference must be an *independent* anatomical feature. If you lack one, say the
3D-plane orientation is unverified rather than manufacturing a pass; the
rotation-invariant distance and the 2D slice check still stand on their own.

## Round-trip check for the review UI
If you map a cursor/landmark between the aligned display frame and the raw
frame, verify the round-trip with **self-consistent matrices** (same rotation
and center in both directions). A self-consistent round-trip is exact to float,
~0.01 mm to integer rounding. A larger error (0.2+ mm concentrated on one axis)
is a **matrix mismatch** (e.g. coords computed with a pre-alignment rotation,
tested against the post-alignment one), not "downsample rounding" — do not
explain it away; recompute the stored coords with the current transform.
