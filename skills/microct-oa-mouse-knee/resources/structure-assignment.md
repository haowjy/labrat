# Structure assignment — name the full knee scene

## Procedure

Subphase **structure-assignment** of segmentation, and the phase's headline
deliverable: the watershed components **named** into the full labeled scene, with
per-structure masks. There is no pretrained model for this anatomy — naming is a
visual-reasoning step grounded in `resources/reference-pack.md`, following
`understand-3d-medical-volume`'s "select a target → inspect linked 2-D → name →
verify" loop. Classical tools split the blobs; the pack and the landmarks say
which is which.

**The structure set** (label → what it is → role):

| Label | Structure | Role |
|-------|-----------|------|
| `femur` | distal femur (two condyles) | measured (W/L) — CC == 1 |
| `tibia` | proximal tibia (single plateau) | measured (IIOC) — CC == 1 |
| `patella` | anterior sesamoid in the extensor tendon | measured (volume); anterior anchor |
| `medial_meniscus` | peri-meniscal calcified synovium, medial | measured (volume) |
| `lateral_meniscus` | peri-meniscal calcified synovium, lateral | measured (volume) |
| `medial_osteophytes` | osteophytes, medial | grounding — kept OUT of femoral width |
| `lateral_osteophytes` | osteophytes, lateral | grounding — kept OUT of femoral width |
| `ossa_sesamoidea` | fabellae / periarticular sesamoids | grounding — the confounder; label so it is never read as osteophyte |
| `fibula` | context (early bone pass) | context; drops out of the measured set |

- Name each component by comparing to the pack: femur = two condyles near one scan
  end; tibia = single plateau block; patella = anterior body; menisci at the joint
  line, medial/lateral; **ossa sesamoidea = small rounded posterior bodies** — the
  confounder (`figure2-scene__patella-sesamoid-vs-osteophyte__paper.png`).
- **Fix the anterior–posterior axis before splitting sesamoid from osteophyte.**
  The "posterior body = sesamoid" test depends on the AP axis, which comes from the
  patella (anterior). If the patella is small, atrophied, or ambiguous — common in
  the aged/OA specimens this protocol studies — resolve orientation first (the
  parent method's orientation workflow) or escalate; do not apply the posterior
  rule against a guessed axis, or a sesamoid can be folded into femoral width before
  "posterior" was ever defined.
- **Fibula establishes laterality:** its side is lateral. Label it as context when
  visible, then confirm the selected side in linked 3-D/2-D views so a posterior or
  wrong-side component is not accepted. It is not required for measurement —
  assign it if present, don't manufacture it if absent.
- Segment menisci with a **lower intensity range than bone**. The ligament
  attachment is not visible in this µCT view; do not invent its boundary.
- Interpret osteophytes against a normal specimen: they are abnormal new bone
  expected after meniscal destabilization, not any periarticular mineralized body.
- Treat patellar enlargement relative to normal as an OA parameter.
- Write `labels.nii.gz`, per-structure `masks/<structure>.nii.gz`, and
  `structure_assignments.json`.

**Femur/tibia identity** carries both ratio indices and is only moderately
reliable on an unlabeled scan (condyle-count discriminator) — confirm in review.

## Verification

**Look first — against the reference.** Color the full scene and compare to
`labeled-scene__all-structures__3d-linked__workflow.jpg`: femur superior, tibia
inferior, patella anterior, menisci at the joint line, sesamoids as separate small
bodies. Confirm each 3-D label agrees with its 2-D contour in all three planes. A
swap, or a sesamoid fused to the femur, is obvious here and invisible in the
numbers.

**Then the checks:**

1. **Assignment JSON** — distinct positive labels; femur and tibia present
   (measurement can't proceed without them); grounding structures (osteophytes,
   sesamoids) and context (fibula) present when visible in the scan.
2. **Connected-components gate (femur + tibia)** — re-apply the watershed CC check;
   each exactly 1. The independent-review moment — fail if either ≠ 1. Menisci /
   osteophytes / sesamoids may be multi-component.
3. **Sesamoid / osteophyte separation (required)** — no `ossa_sesamoidea` or
   `*_osteophytes` voxels inside the femoral condyle slab used for width. This is
   what protects the W/L index; check it explicitly.
4. **Volume ordering** — femur voxels ≥ tibia, unless documented.
5. **Identity confidence** — a low condyle-count margin → flag
   `ambiguous-bone-identity` (→ seed-review).

**Failure modes:** ambiguous identity (needs seed-review — expected on the first
pass); swapped femur/tibia (fix via seeds); a sesamoid or osteophyte merged into
femur (inflates width — re-seed to split); multiple CC per bone (fragmentation).

Compare structures to each other, not to a specimen's absolute voxel counts.
