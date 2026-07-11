# Review artifact — evidence-led spatial OA review site

## Procedure

This phase does **no science** — the `measurement` phase already vetted every
index against its evidence. Here the worker *packages* the vetted segmentation,
landmarks, numbers, and flags into an **evidence-led** review site a human
confirms. The method — the data contract, the single-inlined-file rule, the
trust boundary, the evidence banner, the measurement overlays, the guided tour,
the **orthogonal slice scrubber**, and the G1–G9 linter — is the
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

## The spatial layout — 3D + 3 linked orthogonal slices

Declare the multi-pane layout so the **G9 gate makes the linked slice scrubber
non-skippable**:

```js
review_layout: "spatial-multipane",
required_views: ["scene3d", "slice-axial", "slice-coronal", "slice-sagittal"],
linked_views: true,
```

**Export the slice data.** Produce `review/volume.json` from
`segmentation/filtered.nii.gz` + `labels.nii.gz`, downsampled to stay under the
5 MB budget. Also export `review/geometry.json` for the 3D scene.

**Three panes + evidence banner + tour:**

- **Evidence banner** (top, always visible) — the decisive ratios from
  `REVIEW_EVIDENCE.decisive`, colored by state, flagged first.
- **3D scene** — the full labeled segmentation (all structures, distinct colors,
  femur superior), the placed landmarks (colored rings + confidence halos), and
  the **measurement lines drawn between landmarks**. Selecting a landmark drives
  the slices AND shows the tour card.
- **Three orthogonal slices** (axial/coronal/sagittal) — grayscale with the
  segmentation overlaid at low alpha, landmark markers, crosshair, and ≥44px
  slice slider each.
- **Tour bar** (bottom) — landmark chips ordered by concern; tour card shows
  the operational rule.
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
`review_layout`/`required_views`/`linked_views` as above; `verdict_schema`;
`data_globals` including `REVIEW_EVIDENCE` (inlined), `REVIEW_GEOMETRY` (mesh,
injected), and `REVIEW_VOLUME` (slice data, injected); `data_sources` mapping
the injected globals to their artifacts; and `produced_from` hashing every
source (`measurements/results.json`, `review/geometry.json`, `review/volume.json`)
— G8 recomputes them.

```js
window.REVIEW_MANIFEST = {
  sample_id: "<task-id>",
  produced_from: {
    measurement: "measurements/results.json@<sha256>",
    geometry: "review/geometry.json@<sha256>",
    volume: "review/volume.json@<sha256>"
  },
  verdict_schema: "review-verdict/1",
  review_layout: "spatial-multipane",
  required_views: ["scene3d", "slice-axial", "slice-coronal", "slice-sagittal"],
  linked_views: true,
  data_globals: ["REVIEW_MANIFEST", "REVIEW_EVIDENCE",
                 "REVIEW_GEOMETRY", "REVIEW_VOLUME"],
  data_sources: {
    REVIEW_GEOMETRY: { artifact: "review/geometry.json", transform: "identity" },
    REVIEW_VOLUME:   { artifact: "review/volume.json",   transform: "identity" }
  }
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
(inline real data temporarily). The 3D scene shows the labeled knee + landmarks
+ **measurement lines drawn between landmarks**; each slice pane scrubs with its
slider; **selecting a landmark in 3D jumps all three slices to it AND shows the
tour card with the operational rule**. Confirm the measurement lines connect the
right landmarks and the mm values match the banner.

**Walk the tour.** Step through each landmark. Does the camera frame it well?
Do the slices show the landmark in all three planes? Is the operational rule
stated correctly? Does the drag-to-adjust update the measurement lines live?

**Then the structural + fidelity gate.** The harness runs the `check_review_site`
linter (G1–G9). G9 enforces the scrubber. Read
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
