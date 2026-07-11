---
name: microct-oa-mouse-knee
description: >-
  The Tang et al. mouse-knee osteoarthritis protocol — segment the full knee
  scene from a µCT stack and grade OA severity with geometric indices: the
  distal-femur width/length osteophyte ratio and the tibial IIOC height/width
  ratio, plus patella and peri-meniscal calcified-synovium volumes. Reach for it
  when a task names mouse or rat knee OA, femoral W/L ratio, tibial IIOC,
  osteophyte quantification, patella/meniscus volume, or knee-µCT segmentation
  and measurement.
---

# microct-oa-mouse-knee — mouse-knee OA segmentation + geometric indices

The concrete protocol for one study: Tang et al., *Evaluating Osteoarthritis
Severity in Mice Using µCT-Derived Geometric Indices* (*Biology* 2026, 15, 262;
[doi:10.3390/biology15030262](https://doi.org/10.3390/biology15030262)), cited in
`resources/source-paper.md`. The reusable 3-D method — the render→reason→validate
loop, coordinate frames, classical segmentation and landmarking technique — lives
in `understand-3d-medical-volume`, composed alongside this skill. This skill
carries only what is specific to Tang's study: the scanner, the structures, the
measurements, the operationalized landmark rules, and how to tell a sound result
from a broken one.

## What this protocol produces

Two reviewed deliverables:

1. **A labeled segmentation of the whole knee scene** — femur, tibia, patella,
   both menisci, both osteophyte groups, ossa sesamoidea, fibula. A result in its
   own right, not scaffolding for the numbers.
2. **The geometric indices and volumes** derived from that scene.

There is no pretrained model for this anatomy. The scene is built with classical
image tools (threshold → marker-based watershed → connected components →
morphology) and **named** by a visual model grounded in
`resources/reference-pack.md` and constrained by the placed landmarks — the
method is `understand-3d-medical-volume`; this skill supplies the structures and
parameters.

## What this protocol measures

Two ratio indices grade OA severity; three volumes track the same OA/aging
process in soft-tissue calcification. Ratios survive scan-to-scan scale
differences.

- **Femoral W/L ratio** — the osteophyte index. **Width** (lateral↔medial
  condylar edges, front view) *rises* with OA as osteophytes widen the condyles.
  **Length** (intercondylar-groove upper-line midpoint → intercondylar notch) is
  a stable denominator OA does not change. Rising width over stable length is the
  signal. It is the paper's answer to a hard problem: osteophyte volume can't be
  measured directly because sesamoids are misread as osteophytes, so
  width-over-length stands in for it.
- **Tibial IIOC H/W ratio** — height (articular surface → growth plate, counted
  in slices) over tibial width, on a maximum-height frontal slice. *Falls* with
  OA as the subchondral bone collapses.
- **Patella volume** and **medial / lateral peri-meniscal volume** (calcified
  synovium–capsule adjacent to each meniscus) — voxel-counted off the segmented
  labels. All three *enlarge* with age and OA; the lateral peri-meniscal volume
  is an early change. Figure-grounded markers, not diagnostic-cutoff indices —
  report the volume, not a normal/OA call.

Out of scope (documented so it's a clean add-on, not a hole): the tibial
subchondral trabecular morphometry family (BV/TV, Tb.N/Th/Sp, plate thickness;
Figure 1 / Table S1). The paper measures it partly to show subchondral *bone
mass* is a contradictory OA metric — sclerosis and osteopenia pull it opposite
ways — which is why the geometric indices exist. Adding it means a separate
VOI-morphometry phase.

## What this protocol segments (and why more than it measures)

Segmentation is the **superset** of measurement. The measured endpoints need only
femur, tibia, patella, and the two menisci — but the protocol also labels
**medial and lateral osteophytes and the ossa sesamoidea** as their own
structures. This is not decoration; it is how the measured indices stay honest.

- **Sesamoid disambiguation is the point.** "Normal ossa sesamoidea near the
  joints are commonly identified as separated osteophytes" — the paper's central
  difficulty. A sesamoid positively labeled as its *own* structure cannot be
  swept into the femoral condyle width. Segmenting the bone you don't measure
  protects the bone you do. The confounder is the marquee reference in
  `resources/reference-pack.md`.
- **Orientation anchor.** Once patella (anterior) and both bones are labeled, the
  superior–inferior and anterior–posterior axes are fixed from anatomy.
- **Landmark constraint.** The menisci sit in the joint space between condyles and
  plateau; their location bounds where the articular surfaces must be.
- **Reviewer verification.** A complete labeled scene lets the reviewer confirm
  the whole segmentation is anatomically sane at a glance, against the pack.

**Display convention (ours, not the paper's law).** The paper renders the joint
several color ways across figures; the workflow reference reuses green for femur
*and* patella. We orient **femur superior, tibia inferior, patella anterior** (the
pose the reference frames use) and pick one color map for the review artifact,
labeled *ours*. Display only — landmarks stay in native volume ZYX.

## Scanner and data

Scanco VivaCT 40, 10.5 µm isotropic voxels, 55 kVp / 145 µA / 300 ms,
linear-attenuation DICOM stack.

Two threshold systems appear in the source and must not be conflated. The
**Scanco** thresholds are *unitless* attenuation values: 220 (bone/soft-tissue),
320 (3-D images, = 2.56 cm⁻¹), 270 (= 2.16 cm⁻¹, subchondral plate + cortical
bone). The **Amira** geometric workflow uses a separate mineralized-bone mask
(>2500 HU, watershed markers 3000–5000 HU) and is explicitly *not*
scanner-dependent. Different intensity scales — resolve the scan's own scaling
before applying either.

## Operationalized landmark rules (what the paper left to judgment)

The paper defines these; these rules pin the operational definition. They are the
most load-bearing text in this skill — left vague, they are what made an early
automation return a femur length half its true value.

- **Intercondylar notch** — distal-most midline bone point (between the condyles,
  the ACL/PCL attachment). *Eroded-notch fallback (paper §2.3):* when the notch is
  deeply eroded, use the notch-entrance edge where it meets surrounding healthy
  bone.
- **Intercondylar-groove upper line** — the proximal-most slice of the *sustained
  anterior-midline concavity* (the anterior surface dips behind the flanking
  trochlear ridges), taken just proximal of the condylar bulge. Femoral length
  runs from its **midpoint** to the notch. **Not** "where the condyles merge" —
  that lands ~1 mm distal and collapses the length, inflating W/L even when width
  is correct.
- **Condyle edges** — mediolateral-extreme bone points in the distal condylar
  slab, on the front view.
- **Tibial plateau borders** — medial and lateral condyle borders **at the level
  of the growth plate**, on the slice where both are clearly visualized and their
  separation is maximal after reviewing all slices.
- **Growth-plate boundary** — the drop in bone-fill ratio along the tibial long
  axis; the epiphyseal line, not the marrow below it.

Do not confuse **femoral length** (groove upper-line midpoint → notch, the W/L
denominator) with **femoral groove length** (upper → lower groove-line midpoints,
a separate OA metric that lengthens with MMS). They share the upper point only.

## Telling a sound measurement from a broken one

A real run **discovers this specimen's geometry** — there is no answer key, and
deliberately no expected-value table to check against (a range gate would fail a
genuinely unusual specimen for being unusual, smuggling back the "correct answer"
this protocol exists to discover). Verification checks the *derivation and the
anatomy*, never the value:

- **Look at it.** Every measurement is drawn on the scan as a QC overlay, and the
  segmentation is rendered against the reference pack. A landmark off the anatomy
  is wrong whatever its number — the classic half-length femur shows up as the
  length line ending at the condyle merge instead of the groove, *visible on the
  overlay*. Trust the picture over the number.
- **Reproduce it.** Recompute from the saved coordinates: W/L must equal
  width/length; voxel→mm must use the scan's spacing (10.5 µm here). Structural
  invariants must hold — one connected component per bone, and on a normal control
  the medial and lateral compartment heights are comparable (large asymmetry ⇒ a
  growth-plate boundary placed too deep on one side).

**Phenotype cutoffs are interpretation, applied after — not a gate.** Reported
once a measurement stands on its own evidence, to say which side a finished result
falls on. State them honestly, per model, with their provenance:

- **Femoral W/L** — normal joints stayed **<1.24**, all OA joints **>1.3** (text).
  ROC cutoffs (per model): PTOA **>1.245** (4 wk) / **>1.312** (8 wk); AROA
  **>1.282**. Group means: WT normal 1.19 ± 0.04, MMS 4 wk 1.33 ± 0.05, 8 wk
  1.47 ± 0.1.
- **Tibial IIOC H/W** — ROC cutoff **<0.282** (both PTOA timepoints); AROA
  **<0.294**. A **gray zone 0.28–0.30 is inconclusive** (3/8 aged joints there
  were histologically normal) — let other indices decide. Group means: normal
  0.304 ± 0.011, MMS 4 wk 0.25 ± 0.02, 8 wk 0.24 ± 0.02.

There is no general "single cutoff" — use the per-model values above, not a
rounded stand-in. **Never place a landmark to hit a cutoff** — forcing a
borderline value across the line fabricates the finding. The volumes carry no
cutoff: report the number, and note that medial peri-meniscal volume is
intrinsically variable (near-zero is normal). Which side of a line a result lands
is a *result*, never a gate.

## Known limits (state them; do not paper over)

- **Femur/tibia identity** is only moderately reliable on a single unlabeled scan
  (condyle-count discriminator) — confirm in review.
- **Auto landmark placement** is auto-*propose*, not final — confirm in review.
- **Femoral length** rides entirely on the groove rule above; a broken groove
  inflates W/L even when width is right.
- **Growth-plate boundary** placed too deep on one side inflates that
  compartment's height — on a normal control, medial and lateral heights should be
  comparable; large asymmetry signals a misplaced boundary.
- **Peri-meniscal / patella volumes** depend on the soft-tissue calcification
  threshold and clean separation from adjacent bone; medial peri-meniscal volume
  is intrinsically noisy (paper group difference n.s.).
- The reference pack is one specimen plus published figures, not an
  author-approved contrastive set — flag anatomy it doesn't cover for review.

## Composition

`understand-3d-medical-volume` (the 3-D method, composed alongside) + this skill's
study-specific facts = the full protocol. Each phase pulls the general technique
from the methodology skill and the study parameters from this skill's
`resources/<phase>.md`, grounded by `resources/reference-pack.md`. The terminal
`review-artifact` phase composes `review-artifact-builder` to package the vetted
indices into a self-contained review site a human confirms. These rules were
produced by applying `paper-protocol-to-skill` to the source methods section.
