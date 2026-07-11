# Reference pack — grounding the structure naming

No pretrained model segments a murine knee µCT into femur / tibia / patella /
menisci / osteophytes / sesamoids. Classical image tools (threshold → watershed →
connected components → morphology) produce the blobs and split touching bone, but
they cannot **name** the pieces. Naming is done by a frontier visual model
comparing the scene against the annotated references below, constrained by the
placed landmarks. This pack is that anatomical knowledge — the parent method is
`understand-3d-medical-volume/references/reference-pack.md`; this file is the
mouse-knee instance.

## How to use it

- Retrieve only the reference relevant to the current target (naming the patella?
  pull the labeled-scene and the confounder panel — not the tibial-line panel).
- Compare **anatomy and operational criteria**, not image style. The references
  use different color maps and a different specimen than the scan under analysis.
- Treat a reference as **guidance, not proof** that this specimen matches a known
  class. A specimen outside every reference → escalate, don't force a match.
- **Never** surface the paper's reported measurement *values* to the naming step.
  The pack teaches *what a structure is*, not *what number it should produce* —
  see "Provenance and honesty."

## The assets

| Asset | Teaches | Acceptance rule it grounds |
|---|---|---|
| `labeled-scene__all-structures__3d-linked__workflow.jpg` | the full labeled scene, femur-superior, with linked 3D↔ortho contours | every mineralized body is assigned to exactly one structure; the 3D label and its 2D contour agree in all three planes |
| `bone-split__femur-tibia-fibula__3d__workflow.jpg` | the femur/tibia cut at the joint line; fibula as context | femur (two condyles) and tibia (single plateau) meet in a thin band at the joint, each one solid piece |
| `figure2-scene__patella-sesamoid-vs-osteophyte__paper.png` | **the confounder** (panel A): patella, ossa sesamoidea (white arrows), osteophytes (red arrows) in one panel | see "The confounder" below — the single most load-bearing reference |
| `femoral-length-line__3d__workflow.jpg` | the length line: groove upper-midpoint → intercondylar notch | the line runs groove-top to notch, not condyle-merge to notch |
| `femoral-width-line__3d__workflow.jpg` | the width line: lateral↔medial condyle edges, front view | endpoints at the true mediolateral extremes on one frontal plane, not at different AP depths |
| `tibial-orient-extract__3d__workflow.jpg` | tibia isolation + long-axis reorientation before tibial measures | tibia reoriented so IIOC width/height are read on a frontal ortho slice |
| `figure3-tibia__iioc-width-height-lines__paper.png` | tibial IIOC width and height lines at growth-plate level | height spans articular surface → growth plate; width spans the tibial borders at the plate on the max-height slice |
| `landmark-inspection__sagittal__workflow.jpg` | inspecting a placed landmark in a linked sagittal view | a landmark is confirmed in an orthogonal plane, not from the 3D render alone |
| `bone-mask-threshold__ortho__workflow.jpg` | a correct bone mask tracing the cortical shell | mask follows the bone surface, no marrow flood, no eaten shell |
| `reorient-mask__multiplanar__workflow.jpg` | the reorient + mask step in four-up multiplanar view | reorientation aligns the tibial shaft to the vertical axis |
| `segmentation-volumes__patella-menisci__fig4f__paper.png` | patella + peri-meniscal volumes, young vs aged | a normal-vs-enlarged example for the volume readouts (context, not a cutoff) |

## The confounder (read this one twice)

`figure2-scene…paper.png` panel A shows, in a single view, the exact mistake this
protocol exists to prevent: **ossa sesamoidea** (white arrows — small rounded
bodies, the fabellae, posterior to the condyles) sit right where **osteophytes**
(red arrows — irregular bony outgrowths at the condylar margins) form. "Normal
ossa sesamoidea near the joints are commonly identified as separated osteophytes"
is the paper's central motivation.

The rule: **label ossa sesamoidea as their own structure.** A sesamoid must never
be folded into the osteophyte label *or* swept into the distal-femoral condyle
width — either error inflates the W/L osteophyte index. Segmenting the body you do
not measure is what keeps the body you do measure honest.

## Provenance and honesty

- **Workflow frames** (`…__workflow.jpg`) are one specimen ("Rong-Duan") from the
  authors' Amira session — Amira ~3000 HU mask, 10.5 µm isotropic. Illustrative of
  method and appearance, not a population.
- **Paper panels** (`…__paper.png`) are published figures — correct anatomy, but
  their sample IDs, orientations, and thresholds are not all known per the caption.
- These are **reference context, not ground truth.** The ideal author-approved set
  (normal + severe, contrastive look-alikes, threshold-leakage and absent
  growth-plate failure examples) is still to be built; until then, flag anatomy the
  pack doesn't cover for review.
- Color is display-arbitrary and inconsistent across references (the workflow
  reuses green for femur *and* patella — disambiguate by location, never by hue).
