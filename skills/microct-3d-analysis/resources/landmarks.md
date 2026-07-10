# Landmark placement & measurement

## Find the joint end from the neighbour, not from a guess
The joint (measurement) end of a bone is the end **adjacent to the companion
bone** — read it directly from the contact interface (the end whose extreme is
closest to the companion's centroid), rather than guessing from which end is
wider. This is robust across specimens; ML-spread guesses flip.

## Measure as 3D straight-line distance between two voxels
Reproduce the reference method's definition literally. When it says "distance
between the edges of the lateral and medial condyle" it means the **3D
straight-line distance between two manually placed voxels**, not a single-axis
extent. Use `dist3 = ||p - q|| * voxel_mm`. A single-axis extent will disagree
with the 3D distance whenever the two points differ on another axis, and it is
not what the protocol defines.

## The common-plane trap (and fix) for WIDTH lines
If you pick the two width endpoints as global ML-extremes over a whole
epiphysis slab, they can land at **different anterior-posterior depths and
different long-axis heights**, so the connecting line runs diagonally, not
along the true medial-lateral width. Fix: constrain both endpoints to a
**common frontal plane** — the AP position where the epiphysis is widest in ML
— then take the ML extremes within a thin band around that plane. Keep the
change only if it *reduces* the off-axis fraction (verify, do not assume).

Note this common-plane constraint is a **placement heuristic**, appropriate
when the protocol itself uses a frontal ortho-slice. If the protocol places
voxels freely on the 3D model (as some femoral measurements do), the heuristic
is an engineering aid to make the automatic first guess plausible, not a
reproduction of the protocol — label it honestly, and let the human confirm.

## Step-detection landmarks (e.g. a groove where two condyles merge)
Some landmarks are defined by a **shape transition**, not an extreme. Example:
the femoral intercondylar groove is where the open notch (AP-depth ≈ 0 at the
distal tip) steps up to the merged condylar block (AP-depth ≈ plateau). Locate
it by profiling the relevant quantity along the axis (here midline AP-depth vs.
distance from the tip) and marching from a robust anchor (the distal-most
midline voxel = notch) proximally to the **first level crossing a fraction
(~50%) of the plateau reference**. Tune the fraction against the observed
profile, not a guessed number, and inspect the profile before trusting it.

## Go slice-by-slice to verify, not just to place
After auto-placement, render **each landmark on its own 2D slice** (they will
generally sit on *different* slices). Placing all landmarks on one slice hides
the ones that are off-plane. This slice-by-slice check is where you catch a
point that sits on cortex edge, on the wrong condyle, or off the bone — then
correct it and re-run the 3D check. This is the "2D" half of the 3D↔2D loop.
