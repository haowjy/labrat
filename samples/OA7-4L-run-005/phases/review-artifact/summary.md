# Review artifact — OA7-4L (task-2026-07-13-005)

Packaged the vetted measurement + segmentation outputs into a self-contained,
evidence-led **spatial-3d** review site a human confirms in the dashboard's
sandboxed iframe. **No science was done here** — the measurement phase already
gated every index against its own evidence; this phase assembles the review
surface and verifies the packaging. All G1–G9 gates pass under the served CSP.

## What was built

`artifacts/review-site/index.html` — the spatial-3d template with its three data
blocks replaced from THIS run's verified disk outputs, plus three bounded,
data-driven template edits (the stock template is single-decisive-metric; this
protocol has **two** decisive ratios and **8** landmarks across two bones):

- **REVIEW_MANIFEST** (static literal) — `sample_id` = task-2026-07-13-005,
  `review_layout: spatial-multipane`, `required_views: ["scene3d"]` (3D is the
  hero; slices optional), `landmarks_available: true`. `produced_from` hashes the
  **measurement source** (`measurements/results.json`) and the **shared mesh**
  (`segmentation/geometry.json`); `data_sources.REVIEW_GEOMETRY` references that
  mesh for serve-time injection (not recomputed here).
- **REVIEW_GEOMETRY** — sentinel `"__REVIEW_INJECT:REVIEW_GEOMETRY__"`; the server
  splices the hash-verified `segmentation/geometry.json` (6 decimated meshes:
  femur, tibia, medial/lateral osteophytes, ossa sesamoidea, fibula) at serve
  time. ~1.6 MB injected → total served ~2.3 MB (< 5 MB budget).
- **REVIEW_EVIDENCE** (static literal) — the decisive ratios, their cutoffs/
  states/flags, the measurement-line geometry, the 8 per-landmark operational
  rules + mesh-frame positions, the OA-progression interpretation, structural
  checks, and the 9-row values table.

### The three template edits (data-driven, G4/G5-clean)
- **E1** — the 3D scene draws measurement lines from **all** decisive entries
  (not just `decisive[0]`), so the tibial width + IIOC-height lines render and the
  tour can highlight the tibial landmarks' lines.
- **E2** — the evidence banner renders **both** ratios (femoral W/L and tibial
  IIOC H/W), flagged-first, with a combined "review required" status; generalized
  to cutoff `oa_above` (femoral) **and** `oa_below` (tibial).
- **E3** — the Values tab renders all **nine** rows (4 sub-measurements, 2 ratios,
  3 volumes) with per-row honesty flags, null-safe (volumes render "unavailable").

## Coordinate frame (the load-bearing mapping)

Mesh frame is `[x,y,z]mm = [vx·s, vy·s, vz·s]` (`geometry.json.frame:
"label-volume ZYX*spacing -> [x,y,z] mm"`), i.e. mesh position = `physical[::-1]`.
Landmark markers were placed by reversing each landmark's saved `physical`
(`[vz·s, vy·s, vx·s]`) into mesh XYZ. Verified: all 8 markers fall inside the mesh
bounding box; the anterior/lateral QC projection shows each on its bone and the
**femoral length line spanning the full groove-top→notch distance** (not the
half-length condyle-merge trap).

## Decisive evidence surfaced (verbatim from measurement, not re-derived)

| Ratio | Value | Cutoff | State | Flag |
|---|---|---|---|---|
| Distal femoral W/L (osteophyte index) | **1.318** | OA > 1.30 | concern | groove-top subjective → precise ROC bin needs human confirm; OA-vs-normal robust (band [1.302,1.515] all > 1.30) |
| Tibial IIOC H/W | **0.218** | OA < 0.282 (gray 0.28–0.30) | concern | growth-plate weakest landmark ±10 vox; OA call robust (band [0.182,0.258] all < 0.282), height value uncertain |

Both flagged → both sort first in the banner. Interpretation (shown AFTER the
evidence): **established OA, low confidence** — direction concordant (osteophyte
index up, subchondral index down) but severity magnitudes disagree (W/L ≈ 4-wk-MMS
level, H/W below the 8-wk mean); the enlargement axis (patella + peri-meniscal
volumes) is unavailable (escalated/not segmented); single specimen.

## Volumes — honestly absent
patella / medial+lateral peri-meniscal volumes render **"unavailable"** with a
review-needed flag (not segmented — escalated upstream). No value is fabricated.

## Verification (all pass)
- **G1–G9 all pass, `fidelity: verified`** under the harness-equivalent
  invocation (served CSP `connect-src 'none'` supplied, `measurementsRoot =
  artifacts/`, `expectedSampleId = task-2026-07-13-005`). Report saved at
  `phases/review-artifact/evidence/check_review_site.json`. (Under the bare CLI
  with no served CSP, G5 fail-closes on three.js's internal `fetch` — identical to
  the canonical `review-site-spatial` fixture; the served CSP downgrades it to a
  warning, as documented.)
- **Referential integrity OK** — every measurement-line `from`/`to` references a
  real landmark; every landmark's `measurement_lines` id exists among the decisive
  lines.
- **Provenance** — `produced_from` hashes recomputed by G8 match on disk
  (geometry `6870f383…`, results `de5e0a92…`).
- **Anatomy** — QC projection (`evidence/packaged_spatial_evidence.png`) shows
  femur superior / tibia inferior / ossa sesamoidea as its own label; measurement
  lines connect the correct landmarks; femoral length line is full-length.

## Note on review/volume.json (declared deliverable, not wired this run)
`artifacts/review/volume.json` is a valid REVIEW_VOLUME (downsampled 104×66×60,
window-normalized grayscale + RLE labels, ~740 KB). The current spatial-3d
template renders volume slice-planes **only in mesh-less mode**; with meshes
present it ignores REVIEW_VOLUME, and declaring `slice-*` views would fail G9
(the template lacks the four-up `data-review-slice` scrubber markers). Per the
protocol resource ("ship the 3D scene alone first"), the HTML ships 3D-only and
this file is a prepared drill-down deliverable a slice-enabled template can
consume directly. Not injected into the HTML → does not affect the size budget.

## Known limits carried into review
- Femoral groove-top 'A' subjective → controls the precise W/L ROC/severity bin
  (OA-vs-normal is robust).
- Tibial growth-plate is the weakest landmark (±10 vox) → H/W OA call robust,
  height value uncertain; lateral tibial width may include metaphyseal-flare onset.
- Patella + peri-meniscal volumes unavailable (escalated / not segmented).
- Femur/tibia identity independently confirmed upstream (bicondylar discriminator),
  but single unlabeled scan → confirm in review.
- Prior-run conflict: task-2026-07-13-004 (same specimen) used opposite polarity
  and reported W/L ~2.11 (the >1.5 anomaly); task-005 stands on its own evidence
  (femur=high-z, sane W/L ~1.32). Surfaced for reviewer awareness.
