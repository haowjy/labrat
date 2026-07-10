---
name: microct-3d-analysis
description: >-
  Methodology for analyzing 3D micro-CT (or any volumetric) scans of bone and
  joints — cleaning, thresholding, separating fused structures, aligning to an
  anatomical axis, placing landmarks, and measuring geometry. Use this whenever
  the task involves a micro-CT / µCT / CT volume, a DICOM or TIFF image stack, a
  segmented bone/joint, trabecular morphometry, osteophyte or growth-plate
  measurement, or any "measure a structure from a 3D scan" request — even when
  the user only says "I have a scan" or names a bone (femur, tibia, vertebra).
  Its core discipline is the 3D↔2D loop: never trust a single 2D slice or a lone
  number — render the actual 3D view, look at it, find what is wrong, fix it in
  2D or in parameters, and re-render until the geometry is right.
---

# 3D micro-CT analysis methodology

This skill is the *method*, not a specific pipeline. It applies to any
volumetric bone/joint scan. For the packaged mouse-knee osteoarthritis
pipeline that implements this method end-to-end, see the companion skill
`bonemorph-oa-mouse-knee`.

## The one principle that matters: this is an AGENTIC loop, not a pipeline

Mouse micro-CT is not well represented by any foundation model — the installed
bio foundation models are sequence/structure (scGPT, Evo 2, AlphaFold/OpenFold,
DiffDock), and no volumetric-imaging segmenter (MedSAM, SAM, nnU-Net) is
preinstalled. **So the intelligence has to come from you, the agent, reasoning
over the actual voxels of this specimen — not from a pretrained model, and not
from a frozen heuristic that always does the same thing.**

The single most common failure is trusting a computation you never *looked* at,
or a heuristic you never *checked against known biology*. A landmark can sit at
the right coordinate on one slice and be wrong in 3D; a value can pass every
axis-alignment check and still be 2× off the true anatomy (this happened — a
frozen groove detector returned a femur length of 1.08 mm when the paper's
ground truth is ~2.3 mm, and nothing caught it).

So each operation — segment, align, place a landmark, measure — is an **agentic
loop**:

1. **Do** the operation (start from the packaged heuristic as a *first guess*).
2. **Render** the actual 3D scene + orthogonal slices of THIS specimen.
3. **Look and reason** from anatomy — is this where the structure really is?
   Use a vision model (`vision_critique`), grounded on the paper's reference
   figure, and your own inspection.
4. **Validate against ground truth** — gate the value against the paper's
   published range (`resources/ground_truth.json`). **This gate is mandatory**;
   it is what turns "plausible number" into "checked number".
5. If it fails the gate or looks wrong, **write/adjust detection code for this
   specimen** — or print and read the raw profile and place the point from what
   the data shows — then re-render and re-check. Iterate.

Three complementary checks catch different errors — run all three:
- **Ground-truth range gate** (`ground_truth.json`): is the *value* biologically
  plausible? Catches the 2×-off error that axis checks miss.
- **Numeric/geometric** (`refine3d.assess_placement`): is each line on the axis
  it should be (width→medial-lateral, length→proximal-distal)?
- **Visual** (`vision_check.vision_critique`): does each point sit on the
  structure it names, when you look at the render (ideally next to the paper's
  reference figure)?

The frozen heuristics in `bonemorph/geometry.py` are **first-guess seeds**, not
final answers. The full method is in `resources/reference-calibration.md` —
read it first; it is the heart of this skill.

## Workflow spine

```
search existing methods/models FIRST       → resources/search-methods-first.md
load volume (DICOM/TIFF → HU) → resources/cleaning.md
  → denoise + threshold                     → resources/segmentation.md
  → separate fused bones (seeded watershed) → resources/segmentation.md
  → align to anatomical axis                → resources/alignment.md
  → place landmarks (slice-by-slice)        → resources/landmarks.md
  → ══ AGENTIC LOOP ══════════════════════   → resources/reference-calibration.md
  →   render → look/reason → validate vs        (the heart of the skill)
  →   ground truth → write code → iterate     → resources/3d-visual-check.md
  → measure (rotation-invariant 3D distances)
  → human review / confirm
```

Each stage has a resource file with the concrete techniques, when each applies,
and the pitfalls. Read the one you need when you reach that stage. Two resources
apply throughout: `resources/reference-calibration.md` (the agentic loop + the
ground-truth gates — read this first) and `resources/code-quality.md` (how to
write analysis code that a reviewer and a future agent can trust).

## Helper functions (loaded into your kernel)

Loading this skill injects small, dependency-light helpers (scipy/skimage/
matplotlib only — no GPU, no model weights):

- `mc_load_stack(path)` → `(vol_hu, voxel_mm)` — read a DICOM dir/zip or TIFF
  stack, apply rescale slope/intercept to Hounsfield units, order slices.
- `mc_clean(mask, closing=1, keep_largest=True)` — morphological closing +
  largest-component keep.
- `mc_watershed_split(mask, long_axis)` — seeded watershed on the distance
  transform to cut two fused bones at their contact constriction; returns two
  labels. Verify the cut with `mc_cut_quality`.
- `mc_cut_quality(labelA, labelB)` → dict — unassigned/overlap fractions and
  the interface-band width in voxels (a *localized* interface = a clean cut).
- `mc_shaft_axis(mask, plateau_high, shaft_frac=(0.45,0.95))` — long-axis unit
  vector fit to the *diaphysis only* (excludes the flared epiphysis, which
  biases a whole-bone fit). Feed it to `mc_align`.
- `mc_align(mask, hu, axis_vec)` — rotate so `axis_vec` maps to +Z; display
  only, measurements stay rotation-invariant.
- `mc_render_3d(masks, landmarks, lines, out_path, angles=...)` — marching-cubes
  surfaces + landmark points + measurement lines, several camera angles.
- `mc_vision_check(image_paths, anatomy_prompt, measurements, llm)` — send the
  renders to a vision model and get a per-line critique + PASS/NEEDS-CORRECTION.

Call `help(fn)` in the kernel for signatures. These are deliberately generic;
the OA-specific landmark logic lives in `bonemorph-oa-mouse-knee`.

## What about foundation segmentation models (MedSAM, SAM, nnU-Net, TotalSegmentator)?

Search first (`resources/search-methods-first.md`), then decide by task:
- **Mineralized-bone thresholding + geometric landmarks** — do NOT reach for a
  learned segmenter. Bone is high-contrast; a fixed HU threshold + morphology +
  seeded watershed is more accurate, fully reproducible, needs no weights/GPU,
  and is what the morphometry literature (Bouxsein 2010) uses.
- **Growth-plate / trabecular-compartment segmentation** — mouse-specific deep
  models exist (2025) and can beat a hand-rolled heuristic; consider them.
- **Soft-tissue / no-intensity-edge boundaries** — a learned model may be
  warranted; general 3D CT foundation models (TotalSegmentator, SegVol,
  SAM-Med3D) are human-trained and transfer poorly to mouse µCT.

Learned models are not preinstalled and most need a GPU + weight download (this
environment is CPU-only); install from PyPI (`segment-anything`, `monai`, or the
mouse-specific repos) and run on remote GPU compute if the task justifies it.
Whichever way you decide, record the reason in the protocol skill so a future
run inherits it. See `resources/segmentation.md` and
`resources/search-methods-first.md` for the decision in full.

## Honesty about limits

Automated landmark placement on a single unlabeled scan is **not** reliable
enough to report as final without human confirmation — the correct end state is
"auto-propose + review", not "fully automatic". Say so. When a vision check
returns PASS, remember it is judging a matplotlib render whose depth cues are
weak; a PASS is evidence, not proof. Always surface confidence (e.g. how
marginal the femur/tibia identity call was) rather than presenting a clean
number.
