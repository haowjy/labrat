# Spatial Workflow

## Contents

1. Coordinate frames
2. Linked-view workspace
3. Orientation workflow
4. 3-D/2-D operating loop
5. Spatial invariants
6. Tool-selection guidance

## 1. Coordinate frames

Track these frames explicitly:

- **Scanner/world frame:** physical coordinates supplied by the image format.
- **Voxel frame:** integer array indices.
- **Anatomical frame:** protocol-defined proximal/distal, medial/lateral, and anterior/posterior axes.

Store a 4×4 affine transform between frames. Never transform only the intensity volume while leaving labels or landmarks behind. For every derived object, retain the source series ID, transform ID, coordinate frame, units, and version.

Physical distance between world-coordinate landmarks `p` and `q`:

```text
distance = sqrt((px-qx)^2 + (py-qy)^2 + (pz-qz)^2)
```

Do not use voxel-index distance without accounting for spacing and direction.

## 2. Linked-view workspace

Use a four-view workspace:

- axial slice;
- coronal slice;
- sagittal slice;
- 3-D volume or surface rendering.

Require one shared crosshair and synchronized overlays. Selecting a 3-D point must reveal the same location in all slice views. Moving in a slice must update the other views and 3-D cursor.

When the target is oblique, generate an oblique multiplanar reformat rather than forcing a measurement onto a standard scanner plane.

## 3. Orientation workflow

1. Inspect raw orientation metadata and laterality.
2. Identify stable protocol-defined axes or landmarks.
3. Choose a center of rotation.
4. Apply translation and rotation as a rigid transform.
5. Verify orientation in all orthogonal views and 3-D.
6. Save the transform before measuring or contouring.
7. Record any anatomical ambiguity or damaged orientation landmark.

Do not use an aesthetically pleasing 3-D view as the orientation definition. Define orientation with anatomical rules and numeric transforms.

## 4. 3-D/2-D operating loop

```text
Observe complete volume in 3-D
  -> identify target or contradiction
  -> position shared crosshair
  -> inspect adjacent and orthogonal 2-D slices
  -> select one explicit operation
  -> execute and save version
  -> inspect raw-versus-result overlays
  -> reproject into 3-D
  -> accept, revise, escalate, or continue
```

Use a slice neighborhood, not a single slice, for boundaries, continuity, connectivity, and landmarks. A reasonable initial neighborhood is the target slice plus several slices on either side, adjusted for voxel size and structure thickness.

## 5. Spatial invariants

Check applicable invariants after every meaningful edit:

- expected primary anatomical objects remain distinct;
- topology and continuity are anatomically plausible;
- masks remain within or intersect the intended parent anatomy;
- medial and lateral ROIs do not overlap;
- contour change across adjacent slices is continuous unless anatomy justifies a discontinuity;
- a surface landmark lies on the intended object;
- transforms applied to images and labels are identical;
- derived coordinates map back to the original source volume;
- a local correction does not create a large implausible 3-D structure;
- threshold changes do not silently redefine the anatomy.

## 6. Tool-selection guidance

| Task | First tool | Follow-up verification |
|---|---|---|
| Separate high-contrast mineralized tissue | Threshold preview | Orthogonal overlay and 3-D connectivity |
| Separate touching objects | Markers plus watershed or connected components | Inspect contact region slice-by-slice |
| Define an anatomical ROI | Manual contour or accepted parent-mask intersection | Boundary overlays and saved contour set |
| Correct small leakage | Brush/contour edit | Adjacent slices and 3-D surface |
| Place a landmark | Linked crosshair and surface snap | Orthogonal planes plus physical coordinates |
| Measure distance | Saved world-coordinate landmarks | Formula and units audit |
| Measure volume | Accepted mask voxel count × voxel volume | Mask completeness and connected components |

