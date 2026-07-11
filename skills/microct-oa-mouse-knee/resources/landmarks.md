# Landmarks — Tang mouse-knee geometric indices

## Procedure

Place the operational landmarks for distal-femur width/length, tibial width, IIOC
height, and growth-plate boundaries (definitions in SKILL.md). The artifact:
`landmarks/positions.json` (each landmark: name, voxel ZYX, confidence, evidence)
and `landmarks.json` for handoff. Landmarks stay in native volume ZYX
(`orientation_applied: false`); display alignment is the parent skill's job.

Use the visual/agent path — render, reason, **write detection code**, validate,
iterate — the core discipline of `understand-3d-medical-volume`. There is no
frozen heuristic and no package: you write the detection code with
`scipy`/`skimage`/`numpy`, check it on the render, and revise. Ground every
placement in the pack (`femoral-length-line…`, `femoral-width-line…`,
`figure3-tibia…`, `landmark-inspection…`).

**Pre-flight (mandatory):** the segmentation CC gate must pass (CC == 1 per bone).
Placement on a broken mask is wasted — abort and fix segmentation if it doesn't.

**The operational rules that carry the result (SKILL.md):**

| Landmark | Operational rule |
|----------|------------------|
| Intercondylar notch | distal-most midline bone point (eroded-notch fallback: notch-entrance edge at healthy bone) |
| Trochlear groove top | proximal-most slice of the sustained anterior-midline concavity, proximal to the condylar bulge — **not** where the condyles merge |
| Condyle edges | ML-extreme bone points in the distal condylar slab, front view |
| Tibial width | ML extremes on the max-height frontal ortho slice, at growth-plate level |
| Growth plate | epiphyseal line — bone-fill-ratio drop along the tibial long axis |
| IIOC interval | articular ↔ growth-plate slice span |

Femoral length runs from the groove-top **midpoint** to the notch. The tibial
measures need the long-axis reorientation first (the parent method's orientation
workflow; the tibia-rotation correction is per-specimen).

## Verification

**Look first — this is the whole point of the phase.** Render each landmark on the
3-D surface and in orthogonal slices and check it sits where the anatomy says:

- The **groove top** on the sustained anterior concavity, *proximal* to the
  condylar bulge — not at the condyle merge (the merge is ~1 mm distal and halves
  the length).
- The **notch** at the distal midline; the **condyle edges** at the true ML
  extremes on a common frontal plane (not on different AP depths, which makes a
  diagonal "width").
- The **growth-plate boundary** at the epiphyseal line, not sunk into marrow.

A landmark that looks wrong is wrong, regardless of whether its distance falls in
any range.

**Then — reproduce and structurally check the placement** (never against an
expected distance — a range gate would fail a genuinely unusual specimen):

- **See the error, don't infer it.** The classic half-length femur is a groove
  landed at the condyle merge — the length line visibly ends in the wrong place on
  the overlay. Broken placement is *seen*, not read off an out-of-range number.
- **Structural invariants:** segmentation pre-flight (CC == 1 per bone);
  compartment symmetry — |medial − lateral| height small on a normal control
  (large asymmetry ⇒ growth plate too deep on one side); IIOC slice interval a
  plausible fraction of the tibial span (a slice-count invariant of the region,
  not a specimen value).

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
