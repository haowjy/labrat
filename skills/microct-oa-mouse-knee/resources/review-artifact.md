# Review artifact — the spatial OA review site

## Procedure

This phase does **no science** — the `measurement` phase already vetted every index
against its evidence. Here the worker *packages* the vetted segmentation, landmarks,
and numbers into a **spatial** review site a human confirms. The method — the data
contract, the single-inlined-file rule, the trust boundary, the **orthogonal slice
scrubber**, and the G1–G9 linter — is the **`review-artifact-builder`** skill
(composed for this phase). This resource adds what is specific to this protocol:
which scene, which slices, which rows.

**This is a spatial review, not a values table.** A clean 3D surface can hide a
label bleeding through a slice or a landmark sitting one slice off the bone. Declare
the multi-pane layout so the **G9 gate makes the linked slice scrubber
non-skippable** (a 3D-only or values-only site fails G9 for this protocol):

```js
review_layout: "spatial-multipane",
required_views: ["scene3d", "slice-axial", "slice-coronal", "slice-sagittal"],
linked_views: true,
```

**Export the slice data.** The 2D slices need grayscale pixels the mesh doesn't
carry. Produce one injected artifact, `review/volume.json`, from
`segmentation/filtered.nii.gz` + `labels.nii.gz` + `landmarks/positions.json` — a
downsampled volume (grayscale + RLE labels + landmark voxels), per the slice-data
contract in `review-artifact-builder`'s `review-ui-threejs-and-layout.md`.
Downsample to stay under the 5 MB budget. Also export the mesh geometry
(`review/geometry.json`) for the 3D scene.

**Three panes + a data tab:**

- **3D scene** — the full labeled segmentation (all structures, distinct colors,
  femur superior), the placed landmarks (colored ring + halo), and the measurement
  lines drawn as measured. Selecting a landmark drives the slices.
- **Three orthogonal slices** (axial/coronal/sagittal) — grayscale with the
  segmentation overlaid at low alpha, landmark markers, a crosshair, and a ≥44px
  slice slider each. This is where the reviewer confirms slice-by-slice what the 3D
  surface hides — a bled label, an off-by-a-slice landmark.
- **Values + interpretation tab** — the rows below plus the OA-progression read.

**The rows** (values tab). Read the vetted numbers from `measurements/results.json`
(`name`, `value`, `unit`) and the phenotype calls from `measurements_final.json` —
the six geometric indices and three volumes:

| `id` (results.json name) | Label | Unit |
|--------------------------|-------|------|
| `distal_femoral_length` | Distal femoral length | mm |
| `distal_femoral_width` | Distal femoral width | mm |
| `distal_femoral_ratio` | Distal femoral W/L (osteophyte index) | ratio |
| `tibial_width` | Tibial width | mm |
| `tibial_iioc_height` | Tibial IIOC height | mm |
| `tibial_iioc_ratio` | Tibial IIOC height/width | ratio |
| `patella_volume` | Patella volume | mm³ |
| `medial_meniscus_volume` | Medial peri-meniscal volume | mm³ |
| `lateral_meniscus_volume` | Lateral peri-meniscal volume | mm³ |

**Honesty flag per row** (truthful — do not launder uncertainty): `confirmed` when
the QC overlay shows the measurement on the right anatomy and the derivation
reproduces; `low-margin` when a ratio sits near its phenotype cutoff (W/L ROC
1.245 / 1.312 / 1.282; IIOC H/W 0.282, incl. the 0.28–0.30 gray zone); `criss-cross`
when landmark lines cross between bones; `review-needed` when the stage flagged
`requires_user_confirmation`. There is no expected-value bound to be "out of" — a
wrong measurement surfaces on the overlay and the slices, not as an out-of-range
flag.

**The interpretation — how far the OA has progressed.** The capstone of the values
tab: a synthesis placing this specimen on the OA-progression spectrum, so the
reviewer signs off on a *reading*, not bare numbers. Interpretation applied after —
never a gate, never a placement target. Three parts:

1. **Stage, from the magnitude — not the binary cutoff.** femoral W/L ≈1.19 normal →
   ≈1.33 (4 wk MMS, established) → ≈1.47 (8 wk, advanced); tibial IIOC H/W ≈0.304
   normal → ≈0.25 → ≈0.24. A W/L of 1.30 reads *early*; 1.45 reads *advanced*.
2. **Concordance across signals.** The osteophyte index (W/L, rising), the
   subchondral-collapse index (IIOC H/W, falling), and the enlargement volumes
   should tell one story; when they disagree, say so and lower confidence.
3. **Confidence, and its basis.** Each ratio's distance from its per-model cutoff,
   whether IIOC H/W sits in the 0.28–0.30 gray zone, the per-row honesty flags, and
   the single-specimen limit (no contralateral control here).

Example, hedged: *"Probable early OA, low confidence: W/L 1.29 is just over the
4-week ROC cutoff and IIOC H/W 0.29 is in the gray zone; the signals only weakly
agree and this is a single specimen."*

**Data contract (built by `review-artifact-builder`):** `REVIEW_MANIFEST` with
`sample_id` = the **task id from your prompt**; `review_layout`/`required_views`/
`linked_views` as above; `verdict_schema`; `data_globals` including `REVIEW_GEOMETRY`
(mesh), `REVIEW_VOLUME` (slice data), and `REVIEW_DATA` (rows); `data_sources`
mapping each to its artifact; and `produced_from` hashing every source
(`measurements/results.json`, `review/geometry.json`, `review/volume.json`) — G8
recomputes them. `REVIEW_DATA.items` = the nine rows;
`REVIEW_DATA.interpretation = { stage, confidence, basis }`.

## Verification

**Look first.** Open `review-site/index.html` via `file://` (inline real data
temporarily). The 3D scene shows the labeled knee + landmarks + measurement lines;
each of the three slice panes scrubs with its slider and shows the segmentation on
the grayscale; **selecting a landmark in 3D jumps all three slices to it**. Confirm
it fits one mobile viewport with the panes collapsing to previews. This is where a
bled label or an off-by-a-slice landmark shows up — the reason this review is
spatial, not a table.

**Then the structural + fidelity gate.** Not scientific — do not recompute the
indices. The harness runs the deterministic `check_review_site` linter (G1–G9) with
its authoritative inputs. **G9 enforces the scrubber**: it fails if a declared slice
view has no pane/slider/canvas, if `linked_views` isn't declared, or if the
slice-data global (`REVIEW_VOLUME`) is missing. Read
`review/verification/review-artifact/check_review_site.json`; gate `pass` only if
`"ok": true` and every finding is `"ok": true`. If missing or `false`, FAIL and
quote the failing findings' `detail`.

**Confirm the interpretation is honest — not that it's "right."** There is no ground
truth for the OA stage, so the reviewer checks only that the progression read
*follows from the shown indices and the spatial evidence*: the stage matches their
magnitudes, and the stated confidence matches how well the signals concord and what
the honesty flags say. An over-confident read on discordant or low-margin indices
fails back to the worker. **The final verdict comment states this progression
read** — how far the OA has progressed, or how far the evidence supports thinking it
has.

**Failure modes:** any G1–G9 `ok: false` — a slice pane with no slider or a missing
`REVIEW_VOLUME` global (G9), a separate-file `<script src>` (G2), a `produced_from`
hash / `sample_id` mismatch (G8); or an OA-progression read whose confidence
overclaims what the concordance and honesty flags support.
