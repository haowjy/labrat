---
name: microct-oa-mouse-knee
description: >-
  The Tang et al. mouse-knee osteoarthritis protocol — the geometric indices
  that grade OA severity from a µCT scan: the distal-femur width/length
  osteophyte ratio and the tibial IIOC height/width ratio, plus patella and
  peri-meniscal calcified-synovium volumes as aging/OA markers. Reach for it
  when a task names mouse or rat knee OA, femoral W/L ratio, tibial IIOC,
  osteophyte quantification, patella/meniscus volume, or measuring these
  indices from a knee µCT stack.
---

# microct-oa-mouse-knee — mouse-knee OA geometric indices

This is the concrete protocol for **one study**: Tang et al., *Evaluating
Osteoarthritis Severity in Mice Using µCT-Derived Geometric Indices* (*Biology*
2026, 15, 262; [doi:10.3390/biology15030262](https://doi.org/10.3390/biology15030262)).
The paper is vendored and formally cited in `resources/source-paper.md`. The
reusable 3D method — the render→reason→validate loop, coordinate frames,
segmentation and alignment technique — lives in `microct-3d-analysis`, loaded
alongside this skill. This skill carries only what is specific to Tang's study:
the scanner, the structures, the measurements, the operational landmark rules,
and how to tell a sound measurement from a broken one.

## What this protocol measures

Two ratio indices grade OA severity; three volumes track the same OA/aging
process in soft-tissue calcification. Ratios survive scan-to-scan scale
differences.

- **Femoral W/L ratio** — the osteophyte index. **Width** (lateral↔medial
  condylar edges, front view) *rises* with OA as osteophytes widen the condyles.
  **Length** (intercondylar-groove upper-line midpoint → intercondylar notch) is
  a stable denominator that OA does not change. Rising width over stable length
  is the signal. This is the paper's answer to a hard problem: osteophyte volume
  can't be measured directly because sesamoids are misread as osteophytes, so
  width-over-length stands in for it.
- **Tibial IIOC H/W ratio** — height (articular surface → growth plate) over
  tibial width, on a maximum-height frontal slice. *Falls* with OA as the
  subchondral bone collapses.
- **Patella volume** and **medial / lateral peri-meniscal volume** (calcified
  synovium–capsule adjacent to each meniscus) — read by Material Statistics off
  the segmented labels. All three *enlarge* with age and OA; the lateral
  peri-meniscal volume is an early change. These are figure-grounded markers,
  not diagnostic-cutoff indices — report the volume, not a normal/OA call.

Out of scope (documented so it's a clean add-on, not a hole): the tibial
subchondral trabecular morphometry family (BV/TV, Tb.N/Th/Sp, plate thickness;
paper Figure 1 / Table S1). The paper measures it partly to show subchondral
*bone mass* is a contradictory OA metric — sclerosis and osteopenia pull it
opposite ways — which is why the geometric indices exist. Adding it means a
separate VOI-morphometry phase.

## What this protocol segments (and why more than it measures)

Segmentation is the **superset** of measurement. The measured endpoints need
only femur, tibia, patella, and the two menisci — but the protocol also labels
**medial and lateral osteophytes and the ossa sesamoidea** as their own
structures. This is not decoration; it is how the measured indices stay honest:

- **Sesamoid disambiguation is the point.** The paper's central difficulty is
  that "normal ossa sesamoidea near the joints are commonly identified as
  separated osteophytes." A sesamoid positively labeled as its *own* structure
  cannot be swept into the femoral condyle width — segmenting the bone you don't
  measure is what protects the bone you do.
- **Orientation anchor.** Once patella (anterior) and both bones are labeled, the
  superior–inferior and anterior–posterior axes are fixed from anatomy, not
  assumed.
- **Landmark constraint.** The menisci sit in the joint space between condyles
  and plateau; their location bounds where the articular surfaces must be.
- **Reviewer verification.** A complete labeled scene lets the reviewer confirm
  the whole segmentation is anatomically sane at a glance.

**Display convention (ours, not the paper's law).** The paper renders the joint
three different color ways across figures; we adopt the **Figure 4F** mapping for
the review artifact and orient **femur superior, tibia inferior, patella
anterior** (the pose Fig 4F itself uses). Display only — landmarks stay in native
volume ZYX. The reference render is `assets/figure-4f-reference.png`.

## Scanner and data

Scanco VivaCT, 10.5 µm isotropic voxels, linear-attenuation DICOM stack.

Two threshold systems appear in the source and must not be conflated: the
**Scanco** thresholds are *unitless* (270 defines the tibial subchondral plate
and cortical bone; 220 bone/soft-tissue, 320 for 3D); the **Amira** geometric
workflow uses a separate mineralized-bone mask (~3000 HU). Different intensity
scales — resolve the scan's own scaling before applying either.

## Operationalized landmark rules (what the paper left to judgment)

The paper defines these; these rules pin the operational definition. They are the
most load-bearing text in this skill — left vague, they are what made an early
automation return a femur length 2× too short.

- **Intercondylar notch** — distal-most midline bone point (between the condyles,
  the ACL/PCL attachment). *Eroded-notch fallback (paper l.261):* when the notch
  is deeply eroded, use the notch-entrance edge where it meets surrounding
  healthy bone.
- **Intercondylar-groove upper line** — the proximal-most slice of the *sustained
  anterior-midline concavity* (the anterior surface dips ≥6 voxels behind the
  flanking trochlear ridges), taken just proximal of the condylar bulge. Femoral
  length runs from its **midpoint** to the notch. **Not** "where the condyles
  merge" — that lands ~1 mm distal and collapses the length, inflating W/L even
  when width is correct.
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
there is deliberately no expected-value table to check against (a range gate
would fail a genuinely unusual specimen for being unusual, smuggling back the
"correct answer" this protocol exists to discover). Verification checks the
*derivation and the anatomy*, never the value:

- **Look at it.** Every measurement is drawn on the scan as a QC overlay. A
  landmark that sits off the anatomy is wrong whatever its number — the classic
  1.08 mm femur "length" shows up as the length line ending at the condyle merge
  instead of the groove, *visible on the overlay*, not as an out-of-range value.
  Trust the picture over the number.
- **Reproduce it.** Recompute from the saved coordinates: W/L must equal
  width/length; voxel→mm must use `spacing.json` (10.5 µm here). Structural
  invariants must hold — CC == 1 per bone, and on a normal control the medial and
  lateral compartment heights are comparable (large asymmetry ⇒ a growth-plate
  boundary placed too deep on one side).

**Phenotype cutoffs are interpretation, not a gate.** Reported *after* a
measurement stands on its own evidence, to say which side a finished result
falls on: femoral W/L normal <1.28 / OA >1.28 (per-model ROC 1.245/1.311/1.282);
tibial IIOC H/W OA below ~0.28 (per-model 0.285/0.282/0.294) with an
**inconclusive band 0.28–0.30** where other indices decide. **Never place a
landmark to hit a cutoff** — forcing a borderline value across the line
fabricates the finding. The volumes carry no cutoff at all: report the number,
and note that medial peri-meniscal volume is intrinsically variable (near-zero
is normal). Which side of a line a result lands is a *result*, never a gate.

## Known limits (state them; do not paper over)

- **Femur/tibia identity** is only moderately reliable on a single unlabeled scan
  (condyle-count discriminator; margin ~0.11 on the demo sample) — confirm in
  review.
- **Auto landmark placement** is auto-*propose*, not final — confirm in review.
- **Femoral length** rides entirely on the groove rule above; a broken groove
  inflates W/L even when width is right.
- **Growth-plate boundary** placed too deep on one side inflates that
  compartment's height — on a normal control, medial and lateral heights should
  be comparable; large asymmetry signals a misplaced boundary.
- **Peri-meniscal / patella volumes** depend on the soft-tissue calcification
  threshold and on clean separation from adjacent bone; medial peri-meniscal
  volume is intrinsically noisy (paper group difference n.s.).
- The synthetic demo cohort uses literature-typical values, not real biology.

## Composition

`microct-3d-analysis` (the 3D method, loaded alongside) + this skill's
study-specific facts = the full protocol. Each phase pulls the general technique
from the methodology skill and the study parameters from this skill's
`resources/<phase>.md`. The terminal `review-artifact` phase composes
`review-artifact-builder` with a display-mapping resource to package the vetted
indices into a self-contained review site a human confirms. These rules were
produced by applying `paper-protocol-to-skill` to the source methods section.
