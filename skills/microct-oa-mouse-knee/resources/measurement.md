# Measurement — Tang OA geometric indices (final)

## Procedure

Compute the published geometric indices from the placed landmarks and the
segmentation labels. The artifact: `measurements/results.json` (canonical
numbers), `measurements/qc_overlays.json`, `measurements/summary.md`, and
`measurements_final.json`. Write the geometry with `numpy`/`scipy` from the saved
coordinates and spacing — no bespoke measurement package; the general
distance/ratio method is in `understand-3d-medical-volume`.

**Geometric indices** (from landmarks + spacing):

| Index | From | Definition |
|-------|------|-----------|
| `distal_femoral_length` | groove-top midpoint → notch | straight-line mm |
| `distal_femoral_width` | lateral ↔ medial condyle edges | straight-line mm |
| `distal_femoral_ratio` | width / length | ratio |
| `tibial_width` | medial ↔ lateral tibial borders (growth-plate level) | straight-line mm |
| `tibial_iioc_height` | articular surface → growth plate | slice count × voxel mm |
| `tibial_iioc_ratio` | height / width | ratio |

**Volumes (from labels, not landmarks)** — voxel count × (10.5 µm)³ off the
per-structure masks:

The automated derivation (voxel count × spacing³) produces the same quantity that
Amira reports in its Material Statistics **Volume** column (mm³). **Count** is the
raw voxel tally before spacing conversion — not the measurement.

| Index | From mask | Unit |
|-------|-----------|------|
| `patella_volume` | `masks/patella.nii.gz` | mm³ |
| `medial_meniscus_volume` | `masks/medial_meniscus.nii.gz` | mm³ |
| `lateral_meniscus_volume` | `masks/lateral_meniscus.nii.gz` | mm³ |

All three enlarge with age/OA and carry **no diagnostic cutoff** — report the
number. Emit them as `results.json` entries alongside the geometric indices. Any
stage confidence written internally is not to be trusted — apply the checks below.

## Verification

**Look first.** Open the QC overlays — each measurement line drawn on the scan as
it was measured (references: `femoral-length-line…`, `femoral-width-line…`,
`figure3-tibia…`). Femoral width spans condyle to condyle; length runs groove-top
to notch; the tibial lines on the max-height frontal slice. A line that runs
diagonally or lands off the surface is a wrong measurement, whatever its value.

**Then — reproduce the derivation** (check the math and the anatomy, never the
value against an expected range):

1. Recompute W/L from width and length; must match `distal_femoral_ratio` within 1%.
2. `tibial_iioc_height` must be reproduced by projecting `articular_surface_proximal` and `growth_plate_proximal` (from `positions.json`) through the persisted reorientation transform (`orientation_frame.json`) and differencing along the reoriented axis; this recomputed value must match the reported height to within 1 slice (~1%). A verification script that reads the reported height back out of an upstream file instead of recomputing it from the two landmark voxels does not satisfy this check.
3. IIOC ratio = height / width, using the same slice definitions as landmarks.
4. Voxel size for mm conversion matches `spacing.json` (10.5 µm here).
5. Structural invariants hold — CC == 1 per bone; on a normal control the medial
   and lateral compartment heights are comparable (large asymmetry ⇒ a
   growth-plate boundary too deep on one side).

**Volumes are only as good as their labels.** Confirm each mask is the clean
structure on the overlay — patella not fused to the femur, peri-meniscal
calcification not swallowing the tibial plateau. Medial peri-meniscal volume is
intrinsically variable; near-zero is normal, not an error.

**Required sensitivity band (both ratios).** Before classifying, compute and report
a sensitivity band for **both** `distal_femoral_ratio` (W/L) and
`tibial_iioc_ratio` (IIOC H/W) by sweeping that ratio's dominant landmark over its
defensible range and recording the resulting ratio interval — e.g. sweeping the
femoral "A" landmark over its defensible z-range `A z∈[523,645] → W/L 1.12–1.79`,
and sweeping the tibial growth-plate landmark over its defensible range for H/W.
This band is a **required output** of `results.json` / `summary.md` for each ratio,
not an optional escalation note.

**Interpretation, applied after — not a gate.** With the measurements standing on
their own evidence, classify per model (SKILL.md): femoral W/L normal <1.24 / OA
>1.3 (ROC 1.245 4 wk / 1.312 8 wk / 1.282 AROA); tibial IIOC H/W OA <0.282 (AROA
<0.294) with a 0.28–0.30 gray zone. Report which side the specimen falls on; do not
adjust a measurement to move it. A value whose *lines* look wrong is still wrong —
trust the overlay over the number.

**Indeterminate rule (mandatory).** If a ratio's required sensitivity band
**straddles its classification cutoff** — i.e. the band spans both sides of the
relevant cutoff so the point estimate's side is not robust to defensible landmark
placement — the `phenotype_call` for that index **must** be
`"indeterminate — requires human confirmation"`, naming the specific landmark to
check (femoral "A" groove-top for W/L; tibial growth-plate for IIOC H/W). Do **not**
emit a confident NORMAL/OA call for that index in this case. Cutoff *values* are
unchanged; this rule only governs when a confident call may be reported. The other
index is called normally if its own band does not straddle its cutoff.

**Failure modes:** length looks right but W/L off (groove placement wrong); width
looks right but W/L off (condyle edges wrong); IIOC ratio low with height right
(width underestimated); compartment asymmetry (growth-plate placement). Send any of
these back to landmarks — don't patch the number here.
