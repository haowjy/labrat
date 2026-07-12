# Technique Catalogue

Techniques for understanding structure in a 3-D medical volume. Organized by
role in the decision loop: **propose** (quantitative techniques that narrow an
answer), then **confirm** (visual techniques that verify the answer makes
anatomical sense).

This catalogue is maintained as a living resource. Upstream sources for new
techniques: 3D Slicer/SlicerMorph morphometrics docs, ITK/SimpleITK examples,
and published micro-CT morphometry pipelines. When adapting a technique from
these sources, describe what question it answers, when to use it, and how it
fails — not just how to call the function.

## Governing principle

**Compute to propose, visualize to confirm.**

1. **Compute** — run a technique that produces a candidate answer with a
   measurable feature (inflection, extremum, threshold crossing).
2. **Visualize the candidate** — render the candidate in context (3-D marker,
   slice overlay, linked views) and check whether the anatomy at that location
   matches what the protocol definition requires.
3. **Accept or iterate** — if the visual confirms, accept. If it contradicts,
   return to step 1 with different parameters or a different technique.

Neither step is optional. Visual-only placement fails on gradual transitions
(the surface looks plausible everywhere). Compute-only placement misses gross
structural errors (wrong bone, leaky mask, anatomical variant).

---

## Volume types beyond raw intensity

Not every volume is a single-channel CT intensity stack. The techniques below
apply to all of these — adapt the "what to measure" to the available channels:

| Volume type | What each voxel carries | Technique adaptation |
|---|---|---|
| **Raw CT/micro-CT** | Hounsfield units or scanner-native intensity | Standard — depth, curvature, profiles all operate on intensity |
| **Pre-labeled material map** | Discrete material class (bone, cartilage, marrow, implant) | Skip thresholding. Profile fill-ratio by material class. Curvature on the inter-material boundary surface. |
| **Density-calibrated** | Physical density (mg/cm3 HA equivalent) or BMD | Profiles and projections carry physical units directly. Thresholds map to material transitions (e.g., 400 mg/cm3 = cortical boundary). |
| **Mechanical property map** | Elastic modulus, hardness, or stiffness per voxel (from nanoindentation or FE-derived) | Profile mechanical gradients. Landmarks at property transitions (stiff cortex → compliant trabecular). |
| **Multi-channel** | Multiple co-registered scalars (T1+T2 MRI, dual-energy CT, PET+CT) | Run proposal techniques on each channel independently, then fuse: a landmark must be consistent across channels. |
| **Segmentation + intensity** | Both the raw scan and a derived label mask | Use the mask to restrict analysis regions. Compute profiles within a single labeled structure. Curvature on the mask boundary, intensity on the raw volume. |

When the volume carries richer-than-intensity data, use it — a material label
removes the need for thresholding; a density calibration removes the need for
scanner-specific HU interpretation; a mechanical map answers structural questions
directly. The compute-to-propose principle still applies: measure the property,
propose the candidate, then confirm visually.

---

## Proposal techniques

These produce a candidate answer. Each answers a specific question about the
volume. Choose by what you need to know.

### Depth profiles

**Question answered:** Does a groove/ridge/depression exist at this location, and
where does it start or reach its extremum?

**Method:** Extract the surface mesh (marching cubes). Define a reference plane
or axis (e.g., condylar tangent line, bone long axis). For each point along the
axis, compute the perpendicular distance from the reference to the surface.
Plot distance vs. position — a groove is a sustained local minimum; a ridge is a
sustained local maximum.

**Implementation:** Extract mesh (marching cubes), project vertices onto the
reference axis, bin by position, compute mean/min depth per bin.

**Use when:**
- Verifying a groove/concavity landmark exists (not just that the surface
  *looks* concave from one viewing angle)
- Finding onset of a sustained morphological feature (e.g., "proximal-most slice
  of anterior concavity")
- Distinguishing a true concavity from a flat surface that appears grooved under
  one lighting/angle

**Failure modes:**
- Reference plane poorly defined or noisy — propagates error into the whole
  profile. Always verify the reference geometry first.
- Partial-volume artifacts near the surface create false concavities — apply
  light smoothing (Savitzky-Golay on the 1-D profile or Laplacian smoothing on
  the mesh) before interpreting.

### Surface curvature

**Question answered:** What is the local shape (convex/flat/saddle/concave) at
each surface point, independent of viewing angle?

**Method:** Compute per-vertex principal curvatures (k1, k2) on the mesh.
Classify regions: both positive = convex, both negative = concave, mixed signs =
saddle, near-zero = flat. Cluster contiguous regions of the same sign to find
anatomical features (grooves, ridges, condylar domes).

**Implementation:** Compute per-vertex principal curvatures on the mesh (trimesh
or VTK). Threshold and label connected regions by curvature sign.

**Use when:**
- Automatically proposing landmark candidates (curvature extrema correlate with
  anatomical landmarks)
- Distinguishing genuine concavities from rendering artifacts
- Detecting structural features (ridges, notches, condylar domes) without
  committing to a reference axis

**Failure modes:**
- Sensitive to mesh noise/resolution. Always smooth before computing curvature
  (Laplacian mesh smoothing with conservative iterations).
- Breaks down on pathological/deformed bone where curvature signatures deviate
  from the healthy model.

### Cross-sectional profiles along an axis

**Question answered:** How does a scalar property (area, fill ratio, perimeter,
thickness) change along the bone's long axis?

**Method:** For each slice perpendicular to the axis, compute the target scalar
(e.g., bone voxel count = cross-sectional area; bone count / convex-hull count =
fill ratio). Plot the profile. Landmarks and boundaries correspond to inflections
or threshold crossings (e.g., growth plate = bone-fill-ratio drop; isthmus =
area minimum).

**Implementation:** Per-slice voxel counting (or regionprops) scaled by spacing.

**Use when:**
- Locating a transition boundary (growth plate, metaphyseal-diaphyseal junction)
- Verifying segmentation continuity (sudden area jumps flag leaks or
  mis-segmentation)
- Confirming a feature onset by where the profile inflects rather than by visual
  impression

**Failure modes:**
- Axis misalignment distorts the profile (oblique bone through cardinal slices).
  Reorient to the bone's principal axis first.
- Partial bones at volume edges create artifactual area drops. Exclude slices
  within a margin of the volume boundary.

### Projections (MIP, MinIP, AIP, slab)

**Question answered:** What is the extreme or average value along a line of
sight, collapsing depth into 2-D?

**Methods:**

| Projection | Numpy | Shows | Misses |
|---|---|---|---|
| MIP (maximum) | `np.max(vol[z0:z1], axis=0)` | Dense structures, cortical continuity, sclerotic foci | Low-density features; depth ordering |
| MinIP (minimum) | `np.min(vol[z0:z1], axis=0)` | Cavities, channels, canals, resorption pits | Structures behind higher-density material |
| AIP (average) | `np.mean(vol[z0:z1], axis=0)` | Overall density gradient, noise-smoothed overview | Sharp discrete features (thin fractures, small cavities) |

**Slab variant:** Restrict the z-range (5-20 slices) before projecting.
Full-volume projections superimpose all depths and destroy overlap information.
Slab projections preserve depth localization while still bridging inter-slice
gaps.

**Use when:**
- Surveying continuity or density trends across a region thicker than one slice
- Locating a lesion's z-extent by scanning a moving slab
- Creating an overview image for a report or QC step

**Failure modes:**
- Full-volume MIP/MinIP collapses all depth — a foreground structure's density
  appears at a background location. Always prefer slab to full-volume.
- MIP hides defects behind dense material. MinIP hides structures behind cavities.
  Use the complementary projection when the result seems implausible.

### Curved planar reformation (oblique MPR)

**Question answered:** What does the anatomy look like along a non-planar path
(a curved groove, a tortuous canal)?

**Method:** Define a centerline through the structure of interest. Resample
intensity values along perpendicular planes at each path point. The result is a
single 2-D image "unfolded" along the curve.

**Implementation:** Define the path as ordered 3-D points; at each point,
resample intensity on a perpendicular plane (map_coordinates or SimpleITK).

**Use when:**
- The structure doesn't align with any cardinal plane (curved groove, tortuous
  vessel, oblique growth plate)
- Standard orthogonal slices cut the feature obliquely and distort its appearance

**Failure modes:**
- Quality depends entirely on centerline accuracy. A poorly placed centerline
  shows the wrong cross-section.
- Does not quantify concavity by itself — pair with depth profile or curvature
  for quantitative decisions.

---

## Confirmation techniques

These verify a candidate answer visually. They do not make the precision
decision; they catch gross errors and structural mistakes.

### Linked orthogonal views (MPR)

**Purpose:** Verify that a candidate position actually sits at the correct
location in raw intensity data — not on a mesh artifact.

**Method:** Display axial, sagittal, coronal slices simultaneously with a shared
crosshair at the candidate position. The agent checks each plane independently:
does the raw anatomy at this crosshair match what the protocol definition
requires?

**Why it catches errors:** A 3-D surface render is a *derived* representation
(threshold-dependent, mesh-smoothed). Raw orthogonal slices are the ground truth.
A point that looks correct on the mesh but sits in marrow or soft tissue in raw
slices is wrong.

**Principle:** Every landmark or boundary accepted from 3-D must be re-located in
at least two orthogonal raw-intensity slices before being accepted.

### Contour overlay QC

**Purpose:** Verify that a segmentation mask tracks the actual bone/tissue edge.

**Method:** Display the mask boundary (contour line) overlaid on raw intensity in
three orthogonal planes. Grade: does the contour follow the true edge, or does
it leak, erode, or miss regions?

**Why it catches errors:** A 3-D surface can look anatomically plausible while
the underlying mask has subtle leaks or erosions — the mesh smoothing hides
them. Contour-on-raw makes every discrepancy visible.

### 3-D surface rendering with marker

**Purpose:** Verify that a candidate point sits in the correct anatomical region
and has plausible spatial relationships to surrounding structures.

**Method:** Render the surface mesh with a visible marker (sphere, crosshair) at
the candidate position. Rotate to multiple viewing angles. Check: is the marker
on the expected anatomical feature? Is it at the expected relative position
(proximal/distal, medial/lateral)?

**Why it catches errors:** Orthogonal slices show local correctness but not
global context. A point in the right local anatomy but wrong global region (e.g.,
correct bone, wrong end) is visible only in 3-D.

**Limitation:** 3-D rendering alone cannot distinguish gradual transitions.
Never use as the sole basis for a precision decision on a smooth surface.

### Multi-view independence principle

A genuine confirmation uses a **structurally different representation** from the
one that generated the candidate:

| Candidate source | Independent confirmation |
|---|---|
| Mesh/surface analysis | Raw-intensity orthogonal slices |
| Axial slice detection code | Sagittal or coronal raw slice at the same point |
| Intensity threshold | Curvature or fill-ratio (structure-based, not intensity-based) |
| Computed profile inflection | 3-D surface rendering at the inflection point |

Rotating or re-rendering the same derived mesh is not independent confirmation —
it shows the same data from a different angle. Confirmation must come from a
representation that could contradict the candidate.

---

## Supporting techniques

Use when the primary proposal or confirmation techniques need additional evidence.

### Distance/thickness maps

Compute local cortical thickness or distance-to-surface perpendicular to the
mesh. Use when a landmark definition references a structural extremum ("thinnest
point," "distance from reference surface") or when verifying that a detected
boundary coincides with an actual thickness transition.

### DRR (Digitally Reconstructed Radiograph)

Simulates a plain-film X-ray by integrating attenuation along rays through the
volume. Use for correlating with reference radiographs or verifying gross
orientation. Same depth-collapse limitation as MIP — do not use for precision
localization.

### Volume rendering with transfer functions

Assigns opacity and color per intensity value, enabling simultaneous
visualization of internal and external structures (e.g., trabecular structure
through translucent cortex). Use when the task requires understanding internal
architecture in context. Transfer-function choice is subjective — declare the
function used and do not draw quantitative conclusions from opacity appearance.

---

## Decision rules

### Which technique for which task

| Task | Primary proposal technique | Confirmation |
|---|---|---|
| Locate a groove/ridge landmark | Depth profile along bone axis | 3-D marker + orthogonal slices at the inflection point |
| Locate a transition boundary (growth plate, isthmus) | Cross-sectional area or fill-ratio profile | Orthogonal slices + contour overlay at the threshold crossing |
| Verify a concavity exists | Surface curvature (negative k1 region) | Depth profile + 3-D render from multiple angles |
| Place endpoints at extremes (condyle edges, ML bounds) | Mesh vertex coordinates filtered by region | 3-D front view + coronal slice at the candidate |
| Detect a cavity or channel | MinIP slab + cross-sectional area profile | Orthogonal slices through the detected feature |
| Confirm segmentation correctness | Contour overlay in 3 planes + CC count | 3-D surface render + MIP slab comparison |
| Verify orientation/alignment | Anatomical axis alignment (transform validation) | Linked orthogonal views + DRR comparison to reference |

### When to research before escalating

When the catalogued techniques don't solve the problem — the profile is ambiguous,
the standard approach produces contradictions, or the anatomy is novel — **search
for domain-specific techniques online before escalating to a human.** The
catalogue above covers common patterns, not every morphometric method that exists.

Research when:
- The standard proposal technique produces a flat or ambiguous signal and you
  suspect a more specialized method exists (e.g., curvature-based skeletonization
  for complex joint geometry, parametric surface fitting for deformed anatomy).
- The anatomy or modality is outside the catalogue's scope (e.g., cartilage
  thickness mapping, trabecular orientation analysis, cortical porosity detection).
- A contradiction between proposal and confirmation suggests the reference
  geometry assumption is wrong, and you need a different analytical frame.

Search for: the specific morphometric measurement + "micro-CT" or "murine" or the
relevant modality + "automated" or "algorithm" or "method." Prefer papers with
method descriptions over tools-only repos. Adapt what you find into detection code
following the same compute-then-confirm discipline.

### When to escalate to a human

Escalate (don't just iterate or research) when:

- The proposal technique shows no clear feature (no inflection, no extremum,
  flat profile) at any plausible candidate location, and online research found
  no alternative approach.
- The proposal and confirmation disagree and re-computation with different
  parameters still disagrees.
- The anatomy is absent, destroyed, or variant (pathological erosion, fracture,
  developmental anomaly) and neither the reference pack nor online resources
  cover the case.
- The candidate sits in a low-curvature / smooth region where landmark
  repeatability is inherently poor (literature: >2mm inter-observer error on
  smooth surfaces).
