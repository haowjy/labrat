# Scientific Context

## Why microCT for osteoarthritis research

Historically, OA progression in preclinical mouse models has been assessed
with **histology** — extracting the bone, cutting it into slides, staining,
and scoring under a microscope. This is the standard and would be more
broadly applicable as a protocol.

MicroCT is better for detecting OA progression for three reasons:

1. **Quantification.** MicroCT gives measurable geometric indices (W/L
   ratio, IIOC H/W ratio, trabecular morphometry) that track progression
   numerically, compared to subjective scoring from X-ray or histology
   slides.

2. **3D structure.** You get a full volumetric dataset — the entire joint
   in 3D — not a single 2D section that depends on exactly where you cut.

3. **Non-destructive / longitudinal monitoring.** This is the big one.
   Histology requires you to **kill the mouse and cut up the bone**. That
   means you need separate cohorts of mice sacrificed at each time point —
   you can never monitor the same animal over time. With in-vivo microCT,
   you scan the same mouse repeatedly and watch the disease progress in
   the same joint. Fewer animals, better data, longitudinal signal.

## The lab

Dr. Hani Awad's bone biology lab, University of Rochester. Preclinical
microCT imaging for osteoarthritis research. NIH-funded. The co-founder
is the first person exploring this workflow with Claude Science — this
is a real early-adopter collaboration, not a hypothetical user.

Scans come off a Scanco VivaCT 40 scanner, stored in shared folders,
processed one at a time by lab members following a written protocol.

## Why this protocol first

- Real user, real data, real scientific need
- The analysis is tedious (landmark placement is hours of look→adjust→look)
  but the judgment is learnable (ground-truth gates exist, anatomy is
  well-defined)
- MicroCT + OA geometric indices is a complete end-to-end story: scan in,
  measurements out, reviewable at every step
- If we have time, histology scoring would demonstrate breadth — "same
  harness, different protocol" — and reaches a much larger user base

## Demo pitch angle

"Dr. Awad's lab scans 30 mouse knees per study. Each one takes a grad
student an hour to process — rotating the 3D view, placing landmarks,
adjusting, checking. That's 30 hours of tedious work where the scientific
judgment is maybe 5 minutes per scan. LabRat does the tedious part
autonomously and presents the finished analysis for expert review."
