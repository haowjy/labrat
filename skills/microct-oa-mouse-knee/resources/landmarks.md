# Landmarks — Tang mouse-knee geometric indices

## Procedure

Place the operational landmarks for distal-femur width/length, tibial width, IIOC
height, and growth-plate boundaries (definitions in SKILL.md). The artifact:
`landmarks/positions.json` (each landmark: name, voxel ZYX, confidence, evidence)
and `landmarks.json` for handoff. Landmarks stay in native volume ZYX
(`orientation_applied: false`); display alignment is the parent skill's job.

Use the **compute-to-propose, visualize-to-confirm** discipline from
`understand-3d-medical-volume/references/technique-catalogue.md`. Write detection
code with `scipy`/`skimage`/`numpy` that produces a measurable candidate (an
inflection point, an extremum, a threshold crossing), then confirm the candidate
visually in 3-D and orthogonal slices. Never place a landmark from visual
inspection alone — there must always be a quantitative step that proposed the
answer first. Ground every placement in the reference pack
(`femoral-length-line…`, `femoral-width-line…`, `figure3-tibia…`,
`landmark-inspection…`).

**Required techniques by landmark:**

| Landmark | Proposal technique | Confirmation |
|---|---|---|
| Trochlear groove top | Depth profile along femoral axis — find onset of sustained anterior concavity (first slice where depth dips below the diaphyseal baseline and stays low). The groove is the femoral surface of the patellofemoral joint; onset is proximal to the condylar bulge. | 3-D marker at the inflection slice + sagittal raw slice showing anterior concavity begins there |
| Intercondylar notch | Cross-sectional fill-ratio profile — find distal-most slice with midline bone (fill ratio > threshold at the AP midpoint). Or: mesh vertex search for minimum-z midline point. | Coronal slice showing the notch floor + 3-D marker at the distal midline |
| Condyle edges (ML extremes) | Mesh vertex coordinates in the distal condylar slab, filtered to the frontal plane, then ML-extreme points | 3-D front view confirming endpoints at true lateral/medial edges on a common frontal plane |
| Growth plate | Bone-fill-ratio profile along tibial axis — locate the **onset** of the drop (epiphyseal → growth plate cartilage transition): the first slice where the fill ratio departs from the epiphyseal baseline, operationalized as the most-proximal slice crossing a fixed fractional threshold ~10–20% below the epiphyseal baseline. This matches the paper's literal definition ("the most proximal appearance of the growth plate") — **not** the half-max/midpoint of the drop, which sits distal of onset and systematically undercounts IIOC height. | Coronal or sagittal slice at the transition showing the plate line begins here |
| IIOC interval | Articular surface slice (first bone contact from proximal end) and growth-plate slice define the span | Linked views at both boundary slices confirming anatomy |

**Pre-flight (mandatory):** the segmentation CC gate must pass (CC == 1 per bone).
Placement on a broken mask is wasted — abort and fix segmentation if it doesn't.
Any Magic Wand / connected-component selection used before measurement must operate
on the full **volume**, never only the displayed slice.

> **Researcher note:** Landmark placement remains manual and subjective. Prefer
> repeatable grooves or holes, and verify every endpoint lies on bone. Even the
> choice of "the middle" can vary by operator; record that uncertainty rather than
> implying an exact anatomical center.

**The operational rules that carry the result (SKILL.md):**

| Landmark | Operational rule |
|----------|------------------|
| Intercondylar notch | distal-most midline bone point (eroded-notch fallback: notch-entrance edge at healthy bone) |
| Trochlear groove top ("A", `intercondylar_groove_upper_midpoint`) | **Single authoritative rule (use this and only this):** proximal-most slice of the sustained anterior-midline concavity, proximal to the condylar bulge — **not** where the condyles merge. Do **not** switch to the alternative "well up the anterior surface, proximal of the condylar bulge" / AP-taper-anchor reading — that second definition is explicitly disallowed. Pick this one rule for run-to-run **consistency** (attempts that toggled between the two readings drove the high-W/L outliers), not to match any ground-truth value. |
| Condyle edges | ML-extreme bone points in the distal condylar slab, front view |
| Tibial width | ML extremes on the max-height frontal ortho slice, at growth-plate level |
| Growth plate | epiphyseal line — **onset** of the bone-fill-ratio drop (first departure from the epiphyseal baseline, ~10–20% below it) along the tibial long axis, i.e. the most proximal appearance of the growth plate — **not** the half-max midpoint of the drop |
| IIOC interval | articular ↔ growth-plate slice span |

> **Researcher note:** The "A" groove-top landmark is inherently subjective — the
> paper places it by eye with a manual Ruler tool and gives no geometric criterion.
> The paper's own between-rater agreement on the femoral W/L ratio (ICC 0.853, and
> as low as 0.667 in the aging AROA cohort) bounds the accuracy achievable on this
> landmark: a single fixed operational rule can make the automated placement
> *consistent* run-to-run, but cannot make it certainly match a human rater's
> visual call. Choosing one rule buys reproducibility, not ground-truth match.

Femoral length runs from the groove-top **midpoint** to the notch. The tibial
measures need the long-axis reorientation first (the parent method's orientation
workflow; the tibia-rotation correction is per-specimen) — reference frames
`tibial-orient-extract__3d__workflow.jpg` and `reorient-mask__multiplanar__workflow.jpg`.

> **Researcher note:** Tibial slicing is the hardest operational step. Select the
> plane showing the whole, connected, widest growth plate; it supports tibial width
> and both height measurements. Prefer the reproducible bounding-box midpoint
> formula over hand rotation. **Pin the PCA long-axis fit to a consistent bone-mask
> crop every run**: fit the long axis only to the proximal tibial segment from the
> proximal articular surface down to (but excluding) the metaphyseal flare —
> concretely, crop the mask to the proximal fraction of the tibial long-axis extent
> above the flare (the same fixed fraction every run) and drop any voxels below that
> cutoff, so the flare and fibula never enter the fit. Fitting to the same crop each
> time is what keeps the reoriented-frame tilt (and therefore the height/width
> measured in that frame) stable across runs; letting the flare in or out
> run-to-run is what made the fitted tilt swing (14.68° vs 17.38°). Scan
> orientation remains an accuracy limitation: small angle changes alter 2-D
> measurements, so a consistent crop is required to keep that error from varying
> between runs.

> When tibial measurement requires a reorientation (rotation + centroid), **persist the transform itself** (rotation matrix, centroid/pivot, and any grid origin used) alongside `positions.json`, as part of the landmark artifact — not as a downstream, ad hoc addition. `articular_surface_proximal` and `growth_plate_proximal` stay in native volume ZYX like every other landmark (`orientation_applied: false`); the transform is what lets anyone reproduce the reoriented-frame height from those two native voxels alone.
>
> The reported `IIOC interval`/height is defined as: project the two *persisted* native-voxel landmarks through the *persisted* transform and take their difference along the reoriented long axis. It is **not** defined as a value read off an intermediate resampled-volume profile scan (area/fill-ratio/intensity vs. slice) — that scan is a valid *proposal* technique, but the number it produces must be re-derived from the final landmark voxels before being reported, never reported directly. If any later step (snap-to-nearest-bone-voxel, a refined column pick, etc.) moves a landmark's persisted voxel, height/width must be recomputed from the new voxel — never left as a stale scalar next to an updated voxel.

## Verification

Each landmark must pass both a **quantitative check** (does the profile/algorithm
show a feature here?) and a **visual check** (does the anatomy look right at this
location?). Neither alone is sufficient.

**Quantitative verification (first):**

- The proposal technique must show a clear feature at the candidate location — an
  inflection in the depth profile, a threshold crossing in the fill-ratio curve,
  an extremum in the coordinate search. If the profile is flat or ambiguous at the
  candidate, the placement is rejected regardless of how the render looks.
- **Structural invariants:** segmentation pre-flight (CC == 1 per bone);
  compartment symmetry — |medial - lateral| height small on a normal control
  (large asymmetry => growth plate too deep on one side); IIOC slice interval a
  plausible fraction of the tibial span.

**Visual confirmation (second):**

Render each landmark on the 3-D surface and in orthogonal slices and check it
sits where the anatomy says:

- The **groove top** on the sustained anterior concavity, *proximal* to the
  condylar bulge — not at the condyle merge (the merge is ~1 mm distal and halves
  the length). The depth profile must show concavity onset here.
- The **notch** at the distal midline; the **condyle edges** at the true ML
  extremes on a common frontal plane (not on different AP depths, which makes a
  diagonal "width").
- The **growth-plate boundary** at the epiphyseal line, not sunk into marrow. The
  fill-ratio profile must show the **onset** of the drop at this slice — the first
  departure from the epiphyseal baseline (~10–20% below it), the most proximal
  appearance of the growth plate — **not** the half-max midpoint deeper into the
  transition (which undercounts IIOC height).

A landmark that looks wrong visually is wrong, regardless of the computation. A
landmark that looks plausible visually but has no corresponding feature in the
quantitative profile is also wrong — visual plausibility on smooth surfaces is
not evidence of correct placement.

**Contradiction resolution:**

- Profile shows feature at location A; visual shows anatomy at location B =>
  re-examine the reference plane/axis definition, recompute. If still
  contradictory, escalate.
- Profile is flat (no feature anywhere) => the structure may be absent, variant,
  or pathological. Escalate with the flat profile as evidence.
- Profile shows feature; visual confirms => accept.

**Interpretation, applied after — do NOT place landmarks to hit it.** The phenotype
cutoffs (SKILL.md: W/L normal <1.24 / OA >1.3, ROC 1.245 / 1.312 / 1.282; IIOC H/W
OA <0.282 with a 0.28–0.30 gray zone) *classify* the finished measurement. They are
not targets. A specimen whose honestly-placed landmarks yield W/L 1.34 is
osteoarthritic; nudging a borderline specimen across the line fabricates the
finding. The run discovers which side this specimen falls on.

**Failure modes:** groove at condyle merge (length ~half, W/L inflated); width
endpoints at different AP depths (diagonal line); growth plate in marrow
(compartment asymmetry); IIOC interval too short (wrong tibial level);
`requires_user_confirmation` on any landmark (confidence ≤ medium → confirm in
review).
