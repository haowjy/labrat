# OA7-4L — micro-CT OA run (task-2026-07-13-005)

A complete end-to-end LabRat run on specimen **OA7-4L**, a healthy normal-control
mouse left knee. This is the reference "demo hero" run: DICOM in → 6 protocol
phases → an independent reviewer gates each phase → an interactive 3D review site
per phase, with a full provenance + review chain on disk.

## What the run found — read this before the number

The pipeline measured OA7-4L as **OA-consistent on both geometric indices**:

| Index | Result | Cutoff | Call |
|---|---|---|---|
| Distal femoral W/L | 1.318 (band [1.302, 1.515]) | OA > 1.30 | OA-consistent |
| Tibial IIOC H/W | 0.218 (band [0.182, 0.258]) | OA < 0.282 | OA-consistent |

The published ground truth for this healthy specimen is **NORMAL on both**
(Tang et al.: femoral W/L 1.233, tibial IIOC 0.320). So both calls are
**false positives** — and the run is in this archive *because of*, not in spite
of, that fact.

**The system does not assert the false call.** It flags both indices
`Review required · Medium confidence`, reports sensitivity bands, marks
`requires_human_review: true`, names the two weak landmarks driving the
uncertainty (the subjective femoral groove-top and the tibial growth plate), and
withholds the patella/meniscus volumes it could not segment rather than
fabricating them. A confident wrong answer is the failure mode this pipeline is
built to avoid; a hedged, reproducible, auditable answer that defers to a human
is what it produces.

**Why the miss happens:** run-to-run variance in subjective landmark placement.
The same specimen on the same (correct) bone segmentation landed NORMAL on an
earlier run and OA on this one — the paper's own inter-rater agreement on these
landmarks is ICC 0.667–0.85, which bounds achievable accuracy. This is a known,
documented limitation, not a bug being hidden.

## What is verified and trustworthy

- **Bone identity is correct and independently proven.** A mandatory,
  code-enforced femur/tibia discriminator ran on every segmentation pass (femur
  = the clearly-more-bicondylar bone); the independent reviewer recomputed it
  from disk. This same check caught a femur/tibia swap on a sibling run.
- **Every derivation was independently reproduced** by the gate-reviewer running
  in its own session behind a trust boundary — W/L, IIOC height via the
  persisted tibial transform, connected-component gate, and the sensitivity
  bands all recompute exactly from the disk artifacts.
- **Six interactive 3D review sites** (one per phase + a whole-run site): a
  rotatable three.js scene of the segmented anatomy with the agent's landmarks
  as labeled overlays and the measurement lines drawn on the bone.

## How to display this run

The `review-sites/` files are **fully self-contained** — three.js and the mesh /
volume data are inlined into each HTML, with no CSP meta tag, no server, and no
network dependency. Just open one in a browser.

**Quickest — open a site directly:**

```bash
# macOS
open samples/OA7-4L-run-005/review-sites/whole-run.html
# Linux
xdg-open samples/OA7-4L-run-005/review-sites/measurement/index.html
```

or drag the file into any browser, or paste its `file://…` path.

**The 6 sites (suggested viewing order):**

| # | File | Shows |
|---|---|---|
| 1 | `review-sites/whole-run.html` | The run's verdict + full anatomy — start here |
| 2 | `review-sites/measurement/index.html` | W/L and IIOC measurement lines drawn on the bone |
| 3 | `review-sites/landmarks/index.html` | The 8 placed landmarks, labeled |
| 4 | `review-sites/segmentation/index.html` | The raw segmented bones (femur/tibia/…) |
| 5 | `review-sites/seed-review/index.html` | Seed-review overlay |
| 6 | `review-sites/intake/index.html` | Grayscale volume (pre-segmentation) |

In each: **drag** to orbit, **scroll** to zoom, use the **legend** to toggle
structures (femur, tibia, osteophytes, …) and landmarks on/off, and read the
**evidence banner** for the honest, hedged verdict.

**If a browser blocks `file://`** (rare — some lock down local pages), serve the
folder statically instead:

```bash
cd samples/OA7-4L-run-005/review-sites && python3 -m http.server 8000
# then open http://localhost:8000/whole-run.html
```

**Full live-dashboard experience** (optional — needs the original task tree, not
this bundle): the raw run under `tasks/task-2026-07-13-005/` re-served by the
`labrat` dashboard gives the review-chain navigation and provenance graph. The raw
task-tree site copies hold `__REVIEW_INJECT:*` placeholders and render *only*
through that dashboard (it injects `segmentation/geometry.json` + `intake/volume.json`
at serve time); this archive bakes those payloads in so the sites stand alone.

To read the numbers directly, open `artifacts/measurements_final.json`.

## What is excluded, and why

Regenerable inputs and scratch are omitted to keep the archive lean:

- `input/` — the unzipped DICOM stack (403 MB); regenerable from the source zip.
- `*.npy` — segmentation/landmark scratch arrays (204 MB); intermediates.
- `artifacts/segmentation/filtered.nii.gz` — the grayscale volume (473 MB);
  regenerable from the DICOM via intake+segmentation. Needed only to re-derive or
  re-review from grayscale, not to view or audit this run.

## Provenance

- `provenance/manifest.yaml` — the 6-phase provenance chain.
- `review/` — every gate decision, the reviewer's independent verifications and
  recomputations, and the human/monitor verdicts.
- `artifacts/measurements_final.json` — the measured indices, sensitivity bands,
  phenotype calls, flags, and honestly-withheld volumes.
- `artifacts/landmarks/positions.json`, `artifacts/structure_assignments.json` —
  landmark placements (with the subjective-landmark flags) and the bone-identity
  discriminator record.
