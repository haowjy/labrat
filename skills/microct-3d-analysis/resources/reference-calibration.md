# Reference calibration & the agentic detection loop

This is the most important resource in the skill. It exists because **mouse
micro-CT is not well represented by any foundation model** — the installed bio
foundation models are sequence/structure (scGPT, Evo 2, AlphaFold/OpenFold,
DiffDock); none segment or landmark a volumetric bone scan, and no MedSAM/
SAM/nnU-Net is preinstalled. So for landmark detection you cannot call a
pretrained model and you should not trust a frozen heuristic either. **The
intelligence has to come from you — the agent — reasoning over the actual
voxels of this specimen, and writing detection code on the fly.**

## Why a frozen heuristic is not enough (a real failure)
The packaged `bonemorph` ships a single-pass femoral-groove detector ("march
from the notch to where the condyles merge"). On the demo sample it returned a
femur length of **1.08 mm** and passed every axis-alignment check — yet the
distal femur length read off the paper's Fig 2E/4A scatter axes is **~2.3–2.4
mm** (a figure-read estimate; the paper's *text* only states this length
"remains unchanged" and gives no mm number). The heuristic
found the wrong anatomical feature (the condylar merge, ~1 mm distal of the true
trochlear-groove top) and nothing caught it, because the checks only tested axis
alignment, not *magnitude against known biology*. Re-running the same heuristic
would reproduce the same wrong number forever.

## The loop that fixes it
Treat each landmark/measurement as an **agentic loop**, not a function call:

```
1. RENDER the structure (3D views + orthogonal MIPs/slices of THIS specimen).
2. LOOK at it and REASON from anatomy — where should this landmark be?
   (e.g. "the trochlear groove is the ANTERIOR midline concavity, proximal to
    the condylar bulge — not the posterior notch and not the condyle merge.")
3. WRITE detection code for THIS specimen from that reasoning (a profile scan,
   a concavity test, a component rule — whatever the anatomy calls for).
4. VALIDATE the result against GROUND TRUTH (the paper's published range for
   this measurement; see resources/ground_truth.json). This gate is mandatory.
5. If it FAILS the range gate (or looks wrong on the render), ITERATE — adjust
   the code, or PRINT AND READ THE RAW PROFILE and place the point from what the
   data actually shows rather than guessing another parameter.
6. Re-render and confirm before trusting the number.
```

The frozen heuristics in `bonemorph/geometry.py` are **first-guess seeds** for
step 3 — a starting point to refine, never the final answer.

## Worked example (the groove, done right)
Reasoning "trochlear groove = anterior midline concavity proximal of the
condylar bulge", the loop:
- attempt 1 (concavity run, unbounded) → 5.08 mm → **range gate FAILED** (>2.7);
- attempt 2 (ML-block bound) → the detector found no qualifying slice and
  crashed (a *code bug*, not a gate rejection — worth distinguishing: only
  attempt 1 was a value the gate evaluated and rejected);
- **printed the anterior-surface profile and read it** — saw three bands:
  distal shallow concavity (articular surface) → condylar bulge (midline
  bulges forward) → sustained trochlear channel (flank−mid ≥ 6 vox) starting at
  z≈218;
- placed the groove at the trochlear-channel start → **2.42 mm → range gate
  PASSED**, W/L 1.33 (paper OA range >1.30, matches the expert's ~1.36).

The gate rejected two plausible-but-wrong answers and accepted only the one
consistent with the anatomy. That rejection *is* the value of the loop.

## Ground-truth gates as data
`resources/ground_truth.json` holds the paper's published ranges and thresholds
(distal femur length 2.3–2.4 mm; W/L normal <1.28 / OA >1.30; tibial IIOC
height/width OA <0.28; typical widths). Load it and gate every auto-proposal:
a value outside its range is presumptively wrong and triggers another loop
iteration — regardless of what the axis-alignment or vision check says. Extend
the file when you calibrate against a new study.

## Reference figures as landmark templates
`assets/reference_figures/` holds the paper's schematic panels that *draw the
exact measurement lines* on a 3D femur/tibia — Fig 2B (femoral width, lat↔med
condyle line), 2C/2E (femoral groove length, the anterior A→B/A→C line), Fig 3A
(tibial width + compartment heights on a coronal ortho slice). Use them two
ways:
- **For yourself**, as the visual definition of where each line belongs before
  you write detection code.
- **In the vision check** — pass the reference panel alongside your render and
  ask "does my line match how the paper draws it?". Grounding the critique on
  the template stops the vision model from PASSing a placement that merely looks
  plausible against its generic anatomy prior (which is how the wrong 1.08 mm
  groove slipped through).

## The honest end state
Even with the loop, single-scan automatic placement is auto-*propose*, then
human-confirm — the paper itself notes landmark identification in mouse µCT is
hard and orientation-sensitive. The loop makes the proposal defensible (checked
against biology, not just internally consistent); the human review UI is where
it becomes final.
