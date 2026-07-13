# Review artifact — evidence-led spatial OA review site

## Procedure

This phase does **no science** — the `measurement` phase already vetted every
index against its evidence. Here the worker *packages* the vetted segmentation,
landmarks, numbers, and flags into an **evidence-led** review site a human
confirms. The method — the data contract, the single-inlined-file rule, the
trust boundary, the evidence banner, the measurement overlays, the guided tour,
the **inlined three.js 3D scene** (optional slice scrubber), and the G1–G9
linter — is the
**`review-artifact-builder`** skill (composed for this phase). This resource adds
what is specific to this protocol: which ratios are decisive, which landmarks
carry them, which spatial views to show, and what operational rules to state.

**Evidence-led, not interaction-led.** The previous artifact showed a 3D mesh
with draggable dots — the decisive ratios (femoral W/L vs. the OA cutoff, IIOC
H/W vs. 0.28) were invisible. The independent agent reviewer caught the real
defect by recomputing values by hand, not through that screen. This version
leads with the decisive numbers, overlays the measurement geometry on the bone,
and guides the reviewer through each landmark with its operational rule — so the
call is verified, not just the anatomy explored.

## The evidence banner — what the reviewer sees first

Build `REVIEW_EVIDENCE.decisive` from `measurements/results.json` and
`measurements_final.json`. Each decisive ratio against its OA cutoff,
colored by state, flagged items first:

| Decisive ratio | Cutoff | State logic |
|---|---|---|
| **Distal femoral W/L** (osteophyte index) | normal <1.24 / OA >1.30 (ROC: 1.245 / 1.312 / 1.282) | `fail` if outside ROC extremes; `concern` if between normal/OA cutoffs or if `requires_human_review`; `pass` otherwise |
| **Tibial IIOC H/W** | OA <0.282; gray zone 0.28–0.30 | `concern` if in the gray zone or if `requires_human_review`; `fail` if contradicts expected phenotype; `pass` otherwise |

Each decisive entry carries:
- `value`, `unit`, `cutoff` range
- `state` — `pass` / `concern` / `fail`
- `requires_human_review` — from the worker's own flag in `measurements_final.json`
- `known_limits` — the worker's known-limit narrative (e.g. "iterated 4x on groove
  placement for this specimen")
- `sub_measurements` — the length and width values that produce the ratio
- `measurement_lines` — the lines to draw in 3D, connecting the contributing
  landmarks with their mm values

**Sort flagged items first.** `requires_human_review` entries appear before
passing ones. Within flagged items, sort by distance from cutoff (closer =
more concerning).

## The measurement lines — what to draw in 3D

These lines are the spatial evidence for the banner's numbers. Each line
connects two landmarks and shows the derived mm value:

| Line id | From landmark | To landmark | Value = |
|---|---|---|---|
| `femoral_length` | `trochlear_groove_top` | `intercondylar_notch` | distal femoral length (mm) |
| `femoral_width` | `lateral_condylar_edge` | `medial_condylar_edge` | distal femoral width (mm) |
| `tibial_width` | `lateral_tibial_condyle_edge` | `medial_tibial_condyle_edge` | tibial width (mm) |
| `iioc_height` | `articular_surface_proximal` | `growth_plate_proximal` | IIOC height (mm) |

The reviewer sees the line AND the number. "The line ends in the wrong place"
— the classic groove-at-condyle-merge failure — is visible because the length
line visibly spans half the expected distance.

## The guided tour — per-landmark verification

Build `REVIEW_EVIDENCE.landmarks` with the operational rule from
`resources/landmarks.md` for each landmark. Order by concern: low confidence /
`requires_confirmation` / flagged first.

| Landmark | Operational rule (shown in tour card) | Key failure mode |
|---|---|---|
| `trochlear_groove_top` | "Proximal-most sustained anterior-midline concavity, proximal to the condylar bulge — not where the condyles merge" | Groove at condyle merge → length ~half, W/L inflated |
| `intercondylar_notch` | "Distal-most midline bone point" | Wrong midline point → length distorted |
| `lateral_condylar_edge` | "ML-extreme bone point in the distal condylar slab, front view" | Off AP-depth → diagonal width |
| `medial_condylar_edge` | "ML-extreme bone point in the distal condylar slab, front view" | Off AP-depth → diagonal width |
| `lateral_tibial_condyle_edge` | "ML extreme on the max-height frontal ortho slice, at growth-plate level" | Wrong level → width distorted |
| `medial_tibial_condyle_edge` | "ML extreme on the max-height frontal ortho slice, at growth-plate level" | Wrong level → width distorted |
| `articular_surface_proximal` | "Superior articular surface boundary" | Too deep → IIOC inflated |
| `growth_plate_proximal` | "Epiphyseal line — bone-fill-ratio drop along the tibial long axis" | In marrow → IIOC compressed |

Each landmark's tour step shows:
1. The operational rule text
2. The measurement lines it contributes to, with current values
3. Camera flies to frame this landmark; slices jump to its voxel position
4. Drag-to-adjust offered AFTER the evidence and rule are presented

## The spatial layout — 3D-first, slices optional

The **3D scene is the review surface**. Declare the spatial layout so the
**G9 gate makes the real 3D scene non-skippable** (a painted 2D canvas fails):

```js
review_layout: "spatial-multipane",
required_views: ["scene3d"],          // 3D is the hero; slices optional
linked_views: true,                   // only when slices are shipped
```

**Export the geometry.** Produce `review/geometry.json` — one decimated mesh per
structure (femur, tibia, …) at **~10K vertices each** (marching cubes on each
label of `labels.nii.gz`, in mm, quadric-decimated), shape
`{"meshes":{"<name>":{"vertices":[...],"faces":[...]}}}`, within the 5 MB site
budget. Inline the r185+ three.js UMD build + OrbitControls (CSP-sandboxed — no
CDN). This is the same mesh shape the **segmentation** phase emits once to
`segmentation/geometry.json` for the earlier phases' 3D sites; this phase writes
its **own** `review/geometry.json` (a distinct path, so its recompute never
disturbs those earlier hash-verified sites).

**Slices are optional drill-down.** The downsampled-volume export is the
hardest step; ship the 3D scene alone first. When you add slices, produce
`review/volume.json` from `segmentation/filtered.nii.gz` + `labels.nii.gz`
(downsampled under the 5 MB budget), add the `slice-*` views + `REVIEW_VOLUME`
+ `linked_views: true`, and they appear behind an **"Advanced slices" tab**.

**3D scene + evidence banner + tour:**

- **Evidence banner** (top, always visible) — the decisive ratios from
  `REVIEW_EVIDENCE.decisive`, colored by state, flagged first.
- **3D scene** (the hero, fills the main area) — the full labeled segmentation
  (all structures, distinct colors, femur superior), the placed landmarks
  (colored rings + confidence halos, **named**), the **measurement lines drawn
  between landmarks** with values + the derived ratio, and an orientation aid.
  OrbitControls drag rotates the camera; selecting a landmark shows the tour card
  (and drives the slices when present).
- **Tour bar** (bottom) — landmark chips ordered by concern, "Step N of M",
  Prev/Next, and an **Adjust landmark** mode that recomputes lines live.
- **Advanced slices** (tab, optional) — when shipped: axial/coronal/sagittal
  grayscale with the segmentation overlaid at low alpha, landmark markers,
  crosshair, and a ≥44px slice slider each, linked to the 3D scene.
- **Values + interpretation** (tab) — the rows below plus the OA-progression read
  (shown AFTER spatial evidence, to prevent anchoring).

## The values tab — all nine rows

Read the vetted numbers from `measurements/results.json` (`name`, `value`,
`unit`) and the phenotype calls from `measurements_final.json`:

| `id` | Label | Unit |
|---|---|---|
| `distal_femoral_length` | Distal femoral length | mm |
| `distal_femoral_width` | Distal femoral width | mm |
| `distal_femoral_ratio` | Distal femoral W/L (osteophyte index) | ratio |
| `tibial_width` | Tibial width | mm |
| `tibial_iioc_height` | Tibial IIOC height | mm |
| `tibial_iioc_ratio` | Tibial IIOC height/width | ratio |
| `patella_volume` | Patella volume | mm³ |
| `medial_meniscus_volume` | Medial peri-meniscal volume | mm³ |
| `lateral_meniscus_volume` | Lateral peri-meniscal volume | mm³ |

**Honesty flag per row:** `confirmed` when the QC overlay shows the
measurement on the right anatomy; `low-margin` when a ratio sits near its
cutoff (the W/L ROC range, the IIOC 0.28–0.30 gray zone); `criss-cross`
when landmark lines cross between bones; `review-needed` when the stage
flagged `requires_user_confirmation`.

## The interpretation — shown after the evidence

The capstone of the values tab, shown AFTER the reviewer has seen the
decisive ratios AND the spatial evidence. Three parts:

1. **Stage, from the magnitude — not the binary cutoff.** femoral W/L ≈1.19
   normal → ≈1.33 (4 wk MMS, established) → ≈1.47 (8 wk, advanced); tibial
   IIOC H/W ≈0.304 normal → ≈0.25 → ≈0.24. A W/L of 1.30 reads *early*;
   1.45 reads *advanced*.
2. **Concordance across signals.** The osteophyte index (W/L, rising), the
   subchondral-collapse index (IIOC H/W, falling), and the enlargement
   volumes should tell one story; when they disagree, say so and lower
   confidence.
3. **Confidence, and its basis.** Each ratio's distance from its per-model
   cutoff, whether IIOC H/W sits in the gray zone, the per-row honesty
   flags, and the single-specimen limit.

Build `REVIEW_EVIDENCE.interpretation = { stage, confidence, basis }` from the
measurement outputs.

## Data contract

`REVIEW_MANIFEST` with `sample_id` = the **task id from your prompt**;
`review_layout`/`required_views` as above; `verdict_schema`; `data_globals`
including `REVIEW_EVIDENCE` (inlined) and `REVIEW_GEOMETRY` (mesh, injected);
`data_sources` mapping the injected globals to their artifacts; and
`produced_from` hashing every source (`measurements/results.json`,
`review/geometry.json`) — G8 recomputes them. The 3D scene needs only these;
`REVIEW_VOLUME` + the `slice-*` views + `linked_views: true` are added only when
the optional Advanced-slices tab ships.

```js
window.REVIEW_MANIFEST = {
  sample_id: "<task-id>",
  produced_from: {
    measurement: "measurements/results.json@<sha256>",
    geometry: "review/geometry.json@<sha256>"
    // volume: "review/volume.json@<sha256>"   // only if slices are shipped
  },
  verdict_schema: "review-verdict/1",
  review_layout: "spatial-multipane",
  required_views: ["scene3d"],                  // 3D is the hero; slices optional
  data_globals: ["REVIEW_MANIFEST", "REVIEW_EVIDENCE", "REVIEW_GEOMETRY"],
  data_sources: {
    REVIEW_GEOMETRY: { artifact: "review/geometry.json", transform: "identity" }
  }
  // When slices ARE shipped, add: required_views +[slice-axial/coronal/sagittal],
  // linked_views: true, data_globals +REVIEW_VOLUME,
  // data_sources.REVIEW_VOLUME, produced_from.volume.
};
```

`REVIEW_EVIDENCE` is inlined as a static literal (no `data_sources` entry) — it
carries ratios, flags, landmark metadata, and operational rules, not large binary
data. G3 confirms it is a non-empty static literal in `data_globals`.

## Verification

**Look first at the evidence banner.** The decisive ratios appear with their
states. Flagged items are sorted first. Does the evidence banner surface the
right flags? Are the states correct given the cutoffs?

**Then the spatial evidence.** Open `review-site/index.html` via `file://`
(inline real data temporarily). The 3D scene shows the labeled knee + **named
landmarks** + **measurement lines drawn between landmarks** with values + the
derived ratio; **a mouse-drag rotates the scene** (OrbitControls — verify this,
it is the p80 defect); selecting a landmark shows the tour card with the
operational rule (and drives the slices when present). Confirm the measurement
lines connect the right landmarks and the mm values match the banner.

**Walk the tour.** Step through each landmark ("Step N of M", Prev/Next). Does
the camera frame it well? Is the operational rule stated correctly? Does the
Adjust-landmark mode update the measurement lines and derived ratio live? (If
slices are shipped, do they show the landmark in all three planes?)

**Then the structural + fidelity gate.** The harness runs the `check_review_site`
linter (G1–G9). G9 enforces the real 3D scene (WebGLRenderer + OrbitControls;
a painted canvas fails) and, when slices are declared, the linked scrubber. Read
`review/verification/review-artifact/check_review_site.json`; gate `pass` only
if `"ok": true` and every finding is `"ok": true`.

**Confirm the interpretation is honest — not that it's "right."** The reviewer
checks only that the progression read follows from the shown indices and the
spatial evidence: the stage matches their magnitudes, the stated confidence
matches concordance and honesty flags. An over-confident read on discordant or
low-margin indices fails back to the worker.

**Failure modes:** any G1–G9 `ok: false`; a measurement line connecting the
wrong landmarks; a decisive ratio with the wrong state given its cutoff; a
missing operational rule in the tour; an OA-progression read whose confidence
overclaims what the concordance and honesty flags support.
