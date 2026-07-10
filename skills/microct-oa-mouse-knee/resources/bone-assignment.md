# Bone assignment — femur vs tibia identity

## Methodology

Subphase **bone-assignment** of segmentation. Maps watershed components to
anatomical names (`femur`, `tibia`) and writes label volume + per-bone masks.

**Processing** (inside `run_segmentation`):

- `microct_analysis.processing.segmentation` — heuristic seed assignment from
  condyle-count discriminator near joint (femur: two condyles; tibia: single plateau block)
- `microct_analysis.processing.sanity.check_bone_volume_ordering` — femur volume ≥ tibia
  (typical mouse knee; flag if violated)
- Label extraction → `segmentation/masks/{femur,tibia}.nii.gz`
- `structure_assignments.json` with `{status, assignments, component_assignments, flags}`

**Study-specific identity rules (`SKILL.md`):**

- Femur/tibia identity is **moderately reliable** on unlabeled scans (condyle-margin
  ~0.11 on demo). Always confirm in review — do not trust heuristic alone.
- Expected mapping on OA6-1RK: `{femur: 1, tibia: 2}` (proven in `proof-summary.json`).

**Harness handoff copies:**

| Artifact path | Source |
|---------------|--------|
| `labels.nii.gz` | copy/symlink from `segmentation/labels.nii.gz` |
| `bone_assignments.json` | copy of `segmentation/structure_assignments.json` |
| `masks/femur.nii.gz`, `masks/tibia.nii.gz` | from `segmentation/masks/` |

**Terminal segmentation status:**

- `ready` — proceed to landmarks after CC gate passes
- `needs-seeds` — stop bone-assignment; complete seed-review, then re-run segmentation
- `failed` — do not mark subphase pass

## Verification

**Correct output looks like:**

- `segmentation/structure_assignments.json`:
  - `status: ready` (after seed path resolved)
  - `assignments.femur` and `assignments.tibia` are distinct positive integers
- `labels.nii.gz` label counts consistent with `metadata.json` per-bone stats
- Femur voxel count > tibia (OA6-1RK proof: femur **7,260,584**, tibia **5,965,248**)

**Reviewer computes:**

1. **Assignment JSON** — parse `assignments`; require keys `femur` and `tibia`.
2. **Connected-components gate (required)** — same check as watershed Verification:

   ```python
   ok, reason = validate_segmentation_for_landmarking(labels, assignments)
   ```

   **Femur and tibia each exactly 1 connected component.** This is the
   independent-review moment for the demo. Fail gate if either bone has CC ≠ 1.

3. **Bone volume ordering** — `femur_voxels >= tibia_voxels` unless
   `check_bone_volume_ordering` flag documented with anatomical justification.
4. **Condyle discriminator margin** — read `metadata.json` component summary;
   flag `ambiguous-bone-identity` if margin < 0.15 (low confidence).
5. **Label coverage** — union of femur+tibia masks covers expected joint region;
   no third bone label > 1% of femur volume (patella/fibula not in core protocol).

**Failure modes:**

- `ambiguous-bone-identity` — needs seed-review (expected on first pass)
- Swapped femur/tibia — condyle discriminator wrong; fix via seeds.json
- Multiple CC per label — fragmentation; must fix before landmarks
- `invalid-seeds` — curated seeds.json inconsistent with components

**Ground-truth gates:** none at assignment (measurement gates follow landmark placement).
