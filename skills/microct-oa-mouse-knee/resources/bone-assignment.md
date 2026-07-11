# Structure assignment (bone-assignment subphase) — label the full knee scene

## Procedure

Subphase **bone-assignment** of segmentation. Maps the watershed components to
anatomical structures and writes the label volume plus per-structure masks.
Segmentation is the **superset of measurement** (SKILL.md): the measured endpoints
need only femur, tibia, patella, and the two menisci, but this step also labels
the **osteophytes and ossa sesamoidea** so they cannot contaminate the measured
indices. The general "identify the joint end from the neighbor-contact interface"
method is in `microct-3d-analysis/resources/landmarks.md`; this resource adds the
mouse-knee structure set and discriminators.

**The structure set** (label → what it is → role):

| Label | Structure | Role |
|-------|-----------|------|
| `femur` | distal femur (two condyles) | measured (W/L) — CC == 1 required |
| `tibia` | proximal tibia (single plateau) | measured (IIOC) — CC == 1 required |
| `patella` | anterior sesamoid in the extensor tendon | measured (volume); anterior orientation anchor |
| `medial_meniscus` | peri-meniscal calcified synovium, medial | measured (volume) |
| `lateral_meniscus` | peri-meniscal calcified synovium, lateral | measured (volume) |
| `medial_osteophytes` | osteophytes, medial | grounding — kept OUT of femoral width |
| `lateral_osteophytes` | osteophytes, lateral | grounding — kept OUT of femoral width |
| `ossa_sesamoidea` | fabellae / periarticular sesamoids | grounding — the confounder; label so it is never read as osteophyte |
| `fibula` | context (early bone pass) | context; drops out of the measured set |

Processing inside `run_segmentation`: `processing.segmentation` (condyle-count
discriminator near the joint — femur two condyles, tibia single plateau block),
`processing.sanity.check_bone_volume_ordering` (femur ≥ tibia), label extraction →
`segmentation/masks/<structure>.nii.gz`, and `structure_assignments.json`.

**Femur/tibia identity (SKILL.md)** is the load-bearing call — it carries both
ratio indices — and is only **moderately reliable** on an unlabeled scan
(condyle-count margin ~0.11 on the demo sample). Always confirm in review.

**Sesamoid disambiguation is the point (SKILL.md).** A sesamoid or osteophyte
merged into the femur label inflates the distal-femoral width and the W/L index.
Label them as their own structures, then confirm no such label touches the condyle
edges used for width.

**Harness handoff copies:** `labels.nii.gz` (from `segmentation/labels.nii.gz`),
`bone_assignments.json` (from `structure_assignments.json`), and `masks/`.

**Terminal segmentation status:** `ready` → landmarks *after* the CC gate passes;
`needs-seeds` → stop, complete seed-review, re-run; `failed` → do not pass.

## Verification

**Look first — against the reference.** Color the full scene and compare to
`assets/figure-4f-reference.png`: femur superior, tibia inferior, patella
anterior, menisci at the joint line, sesamoids as separate small bodies. A swap,
or a sesamoid fused to the femur, is obvious here and invisible in the numbers.

**Then the checks:**

1. **Assignment JSON** — distinct positive labels; `status: ready` (after any seed
   path resolved). Femur and tibia must be present (measurement can't proceed
   without them); the grounding structures present when visible in the scan.
2. **Connected-components gate (required, femur + tibia)** — re-apply the watershed
   CC check; femur and tibia each exactly 1 component. This is the
   independent-review moment — fail if either ≠ 1. Menisci, osteophytes, and
   sesamoids may be multi-component (scattered calcification) — do **not** force
   CC == 1 on them.
3. **Sesamoid / osteophyte separation (required)** — no `ossa_sesamoidea` or
   `*_osteophytes` voxels inside the femoral condyle slab used for width. This is
   what protects the W/L index; check it explicitly, not just implicitly.
4. **Volume ordering** — femur voxels ≥ tibia, unless `check_bone_volume_ordering`
   flags it and you document an anatomical reason.
5. **Identity confidence** — if the condyle-count margin < 0.15, flag
   `ambiguous-bone-identity` (low confidence → seed-review).

**Demo fixture (OA6-1RK):** femur ≈ 7.26 M voxels, tibia ≈ 5.97 M. Those anchor
expectations for *this* specimen — on another scan, compare structures to each
other, not to these counts.

**Failure modes:** `ambiguous-bone-identity` (needs seed-review — expected on
first pass); swapped femur/tibia (condyle discriminator wrong — fix via
`seeds.json`); sesamoid or osteophyte merged into femur (inflates width — re-seed
to split); multiple CC per femur/tibia label (fragmentation — fix before
landmarks); `invalid-seeds` (curated seeds inconsistent with components).
