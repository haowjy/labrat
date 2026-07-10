# Search for existing methods before hand-rolling

Before writing a segmentation or landmarking algorithm from scratch, spend one
turn searching the literature and the skill/model catalog. Hand-rolling is
often right for this domain — but that should be a *decision made after
looking*, not a default from not looking.

## The decision, by task
- **Mineralized-bone thresholding + geometric landmarks** (OA width/length
  indices, condyle edges, trochlear groove): no learned model does this well;
  bone is high-contrast, so a fixed threshold + morphology + seeded watershed +
  the render→reason→validate loop is more accurate and fully reproducible,
  with no weights or GPU. **Hand-roll, guided by the loop.**
- **Growth plate / trabecular compartment segmentation**: mouse-specific deep
  models DO exist and can outperform a hand-rolled heuristic. Consider them
  before settling for a height-map/threshold heuristic. They need a GPU and
  weights, and are not preinstalled here.
- **General anatomy on human-like CT**: 3D CT foundation models exist
  (TotalSegmentator, SegVol, SAM-Med3D, VISTA3D) but are trained on human
  clinical CT and transfer poorly to mouse µCT; reviews report the 3D
  foundation models often underperforming slice-based 2D models zero-shot.
  Treat as a fallback, not a default.

## What to search for (run these yourself — do NOT trust remembered accessions)
The landscape moves fast and specific paper IDs drift; run a fresh `web_search`
each time rather than citing a remembered accession. As of 2025, searches that
surfaced relevant work:
- Mouse-specific µCT bone segmentation: "deep learning mouse micro-CT bone
  segmentation", "trabecular compartment segmentation growth plate deep
  learning", "murine knee subchondral bone segmentation pipeline". Several 2025
  papers (Nature Sci Rep, ScienceDirect, Frontiers Bioinformatics) report
  mouse-specific DL segmenters, some with public code — find the current one and
  check its metrics and license yourself.
- General 3D CT foundation models: "TotalSegmentator", "SegVol", "SAM-Med3D",
  "VISTA3D", and a "foundation model medical image segmentation zero-shot
  review". These are human-CT-trained; verify transfer to mouse µCT before
  relying on them.

Treat any figure you read in an abstract as a claim to re-check on the paper
itself, not a measured fact — and confirm the model is actually installable
and runnable here before committing to it.

## What to record in the protocol
Whichever you choose, **encode the decision and its reason into the protocol
skill** — "we threshold rather than use model X because bone is high-contrast
and reproducibility matters", or "we use model X for the growth plate because
the cartilage boundary has no intensity edge". A future run should inherit the
reasoning, not re-litigate it. If you adopt a learned model, record the weights
source, version, and GPU requirement.
