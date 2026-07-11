# Subchondral morphometry — out-of-scope extension (not wired)

A **design note for a future add-on**, not part of the running protocol. The
active protocol measures geometric indices + volumes; the tibial subchondral
trabecular morphometry family is deliberately excluded. Nothing loads this file —
it parks the design so the extension is a clean add, not a rediscovery.

## Why it's excluded

The paper (Figure 1, Methods, Table S1) measures subchondral bone partly to argue
it is an *unreliable* OA metric: "subchondral sclerosis and osteopenia represent
two opposing biological processes," so bone-mass changes point both ways by stage.
Their own data shows it — BV/TV barely moved in WT MMS; only total volume dropped,
and only medially. The geometric indices exist as the robust replacement. Adding
subchondral morphometry as a peer endpoint would work against that argument.

## What it would add

A VOI-morphometry phase, distinct in kind from landmark geometry — place a volume
of interest and run trabecular statistics over its bone voxels, rather than
placing points.

- **VOI:** tibial IIOC subchondral region, articular surface → growth plate, split
  medial / lateral through the center of the proximal tibia (Methods l.198–216).
  Scanco threshold 270.
- **Metrics** (standard guidelines): BV/TV, Tb.N, Tb.Th, Tb.Sp, plus subchondral
  plate thickness (slice-count, articular surface → first trabecular bone).
- **Direction:** BV/TV, Tb.N, Tb.Th fall and Tb.Sp rises with OA/aging; the medial
  compartment leads post-MMS.

## Verification (same discipline)

No expected-value table. Verify the *VOI placement* visually (the box sits under
the plateau, excludes growth plate and cortex) and the *derivation* structurally
(threshold consistent, medial/lateral split through the tibial center). The
published S1 table (116 specimen rows, group means) is **held-out validation data
for the meta-skill**, not a runtime gate — use it to check the extension recovers
the paper's values, never to grade a specimen.

## Phases touched

A new `subchondral-morphometry` phase after `measurement`, its own VOI-placement
resource, and volume / plate-thickness entries surfaced in the review artifact.
