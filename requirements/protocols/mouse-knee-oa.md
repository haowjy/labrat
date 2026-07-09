# First Protocol: Mouse-Knee OA Geometric Indices

## Source skills (from Claude Science)

- `microct-3d-analysis` — methodology (render→reason→validate loop)
- `bonemorph-oa-mouse-knee` — Tang et al. protocol (operational rules,
  ground-truth gates, reference figures). Name TBD — "bonemorph" is
  inaccurate for geometric indices.
- `microct-review-artifact` — evidence generation patterns

## Sample data

`../prompts/microct-analysis/data/OA6-1RK/` — 877-slice DICOM series,
~453 MB, real mouse OA specimen (right knee), Scanco VivaCT 40,
10.5 µm isotropic voxels.

## Protocol phases

### 1. Intake
Load DICOM → convert to HU (rescale slope/intercept). Check spacing,
scanner profile, histogram. Derive segmentation thresholds.

### 2. Segmentation
Denoise (3D median at 2× downsample). Threshold (>2500 HU, Amira
convention). Morphological cleanup (closing radius 1, keep largest CC).
Seeded watershed to split femur/tibia (seeds from diaphyseal ends).
Verify cut quality (interface band ~1.4mm). Identify bones (condyle-count
discriminator — margin matters, flag if low).

### 3. Landmarks
The tedious loop the agent automates. For each landmark:
render → reason from anatomy → write detection code → place → validate
against ground truth → adjust → re-render → loop until gates pass.

**Femoral (3D surface):**
- Intercondylar notch — distal-most midline bone point
- Trochlear groove top — proximal-most slice of sustained anterior-midline
  concavity (flanks ≥6 vox ahead of midline). NOT "where condyles merge"
- Lateral/medial condyle edges — ML-extreme bone points in distal slab

**Tibial (2D slice):**
- Plateau borders — medial/lateral on frontal ortho
- Growth plate boundary — bone-fill-ratio drop along long axis
- Compartment heights — plateau midpoint to epiphyseal line

### 4. ROI
Growth-plate-relative VOI for trabecular morphometry. Isolate trabecular
compartment (exclude cortical shell).

### 5. Measurement
- Femoral width (3D distance, lat↔med condyle edges)
- Femoral length (3D distance, groove top↔notch)
- **W/L ratio** — primary femoral OA index. Normal <1.28, OA >1.30
- Tibial width (frontal ortho slice)
- Compartment heights (medial/lateral)
- **IIOC H/W ratio** — primary tibial OA index. Normal >0.28, OA <0.28
- BV/TV, Tb.Th, Tb.N, Tb.Sp on subchondral VOI

## Ground-truth gates

| Measurement | Gate | Source |
|---|---|---|
| Distal femur length | [2.0, 2.7] mm | Fig 2E/4A scatter (figure-read) |
| Distal femur width | [2.3, 4.2] mm | Fig 2B/4A (figure-read) |
| Femur W/L ratio | [1.0, 1.8]; <1.28 normal, >1.30 OA | Paper text (exact) |
| Tibial width | [2.2, 3.8] mm | Fig 3B/4B (figure-read) |
| Tibial IIOC max height | [0.5, 1.2] mm | Fig 3C/4B (figure-read) |
| Tibial IIOC H/W ratio | [0.15, 0.40]; cutoff 0.28 | Paper text (exact) |
| Compartment height | [0.3, 1.1] mm | Fig 3D/3E (figure-read) |
| Growth plate thickness | [0.1, 0.35] mm | Literature (soft) |

mm gates are figure-read sanity limits (wide, catches gross errors).
Ratio thresholds are verbatim from paper text.
