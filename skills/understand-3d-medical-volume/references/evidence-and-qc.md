# Evidence, QC, and Autonomy

## Contents

1. Analysis state
2. Evidence package
3. Uncertainty and escalation
4. Batch-analysis gates
5. Validation metrics
6. Anti-leakage rules

## 1. Analysis state

Maintain a structured state such as:

```yaml
source:
  series_id: ""
  sample_id: ""
  laterality: ""
  modality: ""
  voxel_spacing_mm: []
coordinate_frames:
  source_affine: []
  anatomical_transform: []
objects:
  masks: []
  rois: []
  landmarks: []
measurements: []
evidence: []
assumptions: []
uncertainties: []
operations: []
human_interventions: []
disposition: "in_progress"
```

Each accepted object must identify its source, coordinate frame, transform, creation operation, parameters, version, and reviewer status.

## 2. Evidence package

For a final spatial result, save:

- source metadata and identity;
- raw orthogonal views;
- complete 3-D overview;
- orientation before/after views;
- numeric transform;
- raw-versus-mask or contour overlays;
- target slice neighborhood;
- orthogonal cross-checks;
- 3-D reprojection;
- landmark coordinates or mask file;
- measurement calculation and units;
- assumptions and unresolved issues;
- reader/agent and human-review record.

Evidence must make the result reproducible without relying on hidden conversation context.

## 3. Uncertainty and escalation

Use explicit levels:

- **Low:** one protocol-consistent interpretation, stable across views and small parameter changes.
- **Moderate:** plausible result with a documented ambiguity that does not materially change the conclusion.
- **High:** multiple plausible boundaries, landmarks, orientations, or object identities that materially affect output.

Automatically escalate high uncertainty. Escalate moderate uncertainty when the result enters a final quantitative analysis.

The system should aim for exception-based human review, not unreviewed autonomy. Record intervention time and reason so the workflow can improve.

## 4. Batch-analysis gates

Before batch execution:

1. Lock the protocol version.
2. Validate orientation and spatial rules on normal, moderate, and severe pilot cases.
3. Define automatic failure checks and exclusion criteria.
4. Define what requires human confirmation.
5. Hide reported target measurements from the measurement agent.
6. Run on held-out cases.
7. Preserve all failed and corrected outputs.

Route cases to review when a rule fails, confidence is high but evidence conflicts, or the anatomy lies outside the reference pack.

## 5. Validation metrics

Use metrics appropriate to the object:

- segmentation Dice score;
- surface distance and Hausdorff distance;
- landmark error in voxels and millimeters;
- raw measurement absolute and percentage error;
- bias and limits of agreement;
- intraclass correlation coefficient;
- orientation error;
- failure-detection sensitivity;
- autonomous completion rate;
- human minutes and interventions per specimen;
- repeatability across runs and software versions;
- generalization to held-out scanners, cohorts, and protocols.

Accuracy without reliable failure detection is insufficient for low-intervention batch analysis.

## 6. Anti-leakage rules

- Use reported measurements only to audit a completed development reconstruction, not to tune landmarks during blinded validation.
- Separate development, validation, and held-out cases.
- Do not expose the expected answer to the operating agent when evaluating generalization.
- Freeze protocol rules before measuring held-out specimens.
- Record post hoc corrections and exclude them from claims of autonomous performance unless reported separately.

