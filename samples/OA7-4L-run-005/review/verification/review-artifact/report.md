# Independent verification — review-artifact (task-2026-07-13-005)

## Confirmed

- **G1–G9 linter, authoritative harness run**: `review/verification/review-artifact/check_review_site.json`
  shows `"ok": true`, `"fidelity": "verified"`, all 9 gates `ok: true` (G5 passes as a
  neutralized warning under `connect-src 'none'`). I re-ran the linter manually via the
  bare CLI (`labrat check-review-site`, no served CSP) and reproduced the expected
  fail-closed G5 behavior — confirms this is the documented CSP-context artifact of my
  invocation, not a real gate failure, per `src/harness/orchestrator/review-artifact-check.ts`
  (the harness supplies `buildReviewSiteCsp(cdnAllowlist)`, my bare CLI call did not).
- **Provenance hashes (G8) recomputed independently**: `sha256sum artifacts/measurements/results.json`
  = `de5e0a92…37da43e` and `sha256sum artifacts/segmentation/geometry.json` =
  `6870f383…65da8960` — both match `REVIEW_MANIFEST.produced_from` exactly.
- **Decisive evidence values verbatim from source**: `REVIEW_EVIDENCE.decisive` values
  (femoral W/L **1.3182**, tibial IIOC H/W **0.2184**), cutoffs, sensitivity bands, and
  phenotype notes match `artifacts/measurements/results.json` / `measurements_final.json`
  character-for-character. States are `concern`/`concern`, matching the stated rule
  (`requires_human_review: true` for both) — correct per the spec's state logic.
- **Referential integrity**: every `measurement_lines[].from/to` in `decisive` resolves to
  a real landmark name in `REVIEW_EVIDENCE.landmarks` (8/8), and every landmark's
  `measurement_lines` id resolves to a real line — verified programmatically, no dangling
  references.
- **Coordinate transform verified numerically**: for all 8 landmarks, mesh `position` =
  reverse of the landmark's saved `physical` (voxel×spacing) from
  `artifacts/landmarks/positions.json` — e.g. `medial_condylar_edge` physical
  `[3.9165,3.444,3.5805]` → mesh `[3.5805,3.444,3.9165]`. All 8 positions fall inside the
  segmentation mesh bounding box (recomputed from `segmentation/geometry.json` vertices).
- **Femoral length line is NOT the half-length trap**: recomputed 3-D Euclidean distance
  between `intercondylar_groove_midpoint` and `intercondylar_notch` physical points =
  1.7211 mm, matching the reported `distal_femoral_length_mm` exactly — the groove-top
  landmark (z=534, within the reported defensible range 505–537) is genuinely proximal to
  the condylar-bulge band (z 410–452), not the condyle-merge trap this protocol calls out.
- **Connected-components independently recomputed**: `scipy.ndimage.label` on
  `artifacts/masks/{femur,tibia}.nii.gz` gives 1 component each, voxel counts
  7,103,993 / 5,020,023 — exact match to `results.json._reference_bone_volumes` and to
  the site's `structural.segmentation_cc`.
- **Values tab**: all 9 rows present (4 sub-measurements, 2 ratios, 3 volumes); the three
  volumes (`patella`, `medial_meniscus`, `lateral_meniscus`) are honestly `null` with a
  `review-needed (not segmented; escalated)` flag — no fabricated numbers, consistent with
  `results.json.volumes` marking them `"unavailable"`.
- **Real 3D scene**: `WebGLRenderer` (82 occurrences) and `OrbitControls` (16
  occurrences) both present in the inlined script — not a painted 2-D canvas.
- **`review/volume.json` (declared output) exists** (758 KB, valid downsampled volume)
  but is deliberately not wired into the shipped HTML (`window.REVIEW_VOLUME` is never
  assigned) — the site correctly declares only `required_views: ["scene3d"]` and omits
  `REVIEW_VOLUME`/`linked_views` from `data_globals`/manifest, so this is consistent
  (3D-scene-first shipping per the phase resource), not a broken half-wired feature.

## Concerns

- Both decisive ratios are flagged `requires_human_review` (subjective groove-top
  landmark; weakest growth-plate landmark) — appropriately surfaced as `concern` state
  and sorted first, but the human reviewer must actually confirm these in the dashboard
  before the OA-progression read is treated as final.
- All three volume endpoints are unavailable (patella/menisci not segmented, escalated
  upstream) — correctly reported as such here, but it means the "enlargement axis" of the
  paper's OA read is entirely missing from this artifact; the interpretation text
  correctly discloses this and keeps overall confidence "low."

## Blocking

None.

## Verdict

The harness-authoritative G1–G9 check passes with `fidelity: verified`. Independent
recomputation of hashes, connected components, landmark-to-mesh transform, referential
integrity, and the decisive-ratio values all reproduce the artifact's claims exactly. The
interpretation text's stated "low confidence" is honestly grounded in the actual flags
(subjective landmarks, missing volumes, single specimen) rather than overclaiming. Pass.
