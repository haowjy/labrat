# Writing good analysis code

Analysis pipelines get reused, extended, and audited long after the first run.
The cost of sloppy code is not the first generation — it is every later change,
every reviewer who can't tell the paper's method from an ad-hoc hack, every
result nobody can reproduce. These principles adapt the general engineering
values (consistency, deep modules, deletion; see the linked `dev-principles`
skill) to scientific code, and are illustrated by the `bonemorph` package that
`bonemorph-oa-mouse-knee` ships as a worked example.

## Core beliefs (general)
1. **Code is cheap; bad code is expensive.** The drag is on every later change.
2. **Consistency beats cleverness.** Match the existing pattern before inventing
   a new one; a new idiom must be worth the learning cost.
3. **Simplicity of the system, not of the change.** The smaller diff today
   accretes parallel mechanisms and compatibility layers. Refactor and delete
   to reduce moving parts even when the diff is larger.
4. **Get it right the first time.** The default agent failure is producing
   something plausible and moving on. Read the code before changing it; handle
   the edge case now; investigate when unclear instead of guessing.

## Deep modules, one concern each
`bonemorph` splits by *concern*, so each file is small and an agent reads only
what it needs: `io` (load→HU), `segment` (clean/threshold/split), `geometry`
(landmarks/distances), `align` (display reorientation), `morphometry`
(trabecular), `refine3d` + `vision_check` (the 3D checks), `review` (UI),
`stats`. Each exposes a **deep** interface — `segment_knee(hu, voxel_mm)` hides
denoise + threshold + watershed + labelling behind one call. Don't export a
function that wraps three lines; inline it. When 3+ shallow helpers touch one
concept, bundle them.

## The scientific-code additions

**Validate the engine against something you know the answer to.** Before
trusting a metric on real data, run it on an analytical phantom: a slab of known
BV/TV and Tb.Th, a sphere of known surface-to-volume. `bonemorph` ships
`examples/validate_phantom.py`; it caught a marching-cubes surface bias
(+8.9% BS/BV) that would otherwise look like biology. A number you have never
checked against ground truth is a hypothesis, not a result.

**Verify operations, don't assume them.** A watershed always returns a
partition; a rotation always returns a volume. Compute a quality metric and
assert on it (`cut_quality` interface band, voxel-retention after alignment,
round-trip error) — the assertion is the difference between "it ran" and "it is
right". Inline `assert`s with an informative message cost nothing and catch the
silent failure.

**Docstrings must separate the protocol from your engineering choices.** The
most dangerous scientific-code error is presenting a heuristic as the reference
method. Every `bonemorph` module that deviates says so in the docstring: per-bone
alignment is "an engineering choice, NOT the paper's single-rotation protocol";
the common-plane landmark re-pick is "a heuristic … not the paper's protocol".
When you write a function that implements a published method, cite it; when you
add a heuristic the paper doesn't specify, label it. A future reader (or auditor)
must be able to tell which is which without rerunning anything.

**Report confidence, not just values.** Where a step can be wrong (a marginal
femur/tibia call, a low-confidence landmark), thread the confidence through to
the output and the QC overlay rather than emitting a clean number that hides it.

## Reproducibility hygiene (kernel specifics)
- `fig.savefig(...)`, never `plt.savefig(...)`; build on explicit `fig, ax`.
- Fetches/downloads in their own cell, read the file in the next — so a replay
  can stub the fetch.
- One concern per cell; put sanity checks inline (`assert df.shape[0] > 0`).
- Checkpoint only *expensive-to-regenerate* state (a segmented volume after
  minutes of compute), not every derived column.

## Deletion
LLMs hoard code. Delete dead branches, stale imports, and abandoned experiments
in the same change that supersedes them (e.g. when the shaft-fit aligner
replaced the centroid-fit one, the old path went — it did not linger as a
"just in case"). Rot compounds at agent speed.
