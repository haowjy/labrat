# Reference Pack Design

## Contents

1. Purpose
2. Minimum contents
3. Image pairing
4. Naming and metadata
5. Positive, negative, and difficult examples
6. Use during analysis

## 1. Purpose

A reference pack supplies sparse protocol-specific anatomical knowledge without training a task-specific 3-D model. It must teach spatial relationships, operational boundaries, acceptable variability, and failure modes.

Store image assets under `assets/reference-pack/<protocol-name>/`. Keep explanatory rules in a matching file under `references/`.

## 2. Minimum contents

Include, where relevant:

- full normal 3-D anatomy;
- diseased or altered 3-D anatomy;
- linked axial, coronal, and sagittal source slices;
- orientation axes and laterality;
- raw-versus-mask overlays;
- ROI contour examples;
- landmark examples with coordinates;
- threshold-too-low and threshold-too-high examples;
- connected-object and leakage failures;
- negative examples for look-alike structures;
- difficult but accepted cases;
- cases that require escalation.

## 3. Image pairing

Every 3-D example should link to source slices showing the same feature. Every contour, mask, ROI, and landmark example should include:

```text
3-D context
<-> target 2-D slice
<-> adjacent slices
<-> orthogonal view
<-> operation result overlay
<-> written acceptance rule
```

Avoid standalone screenshots whose sample, orientation, threshold, or source coordinates are unknown.

## 4. Naming and metadata

Recommended asset pattern:

```text
<protocol>__<sample>__<structure>__<view>__<state>__v<version>.<ext>
```

Accompany each asset with sample ID, source series, voxel size, transform ID, slice/world coordinate, threshold or window, label definitions, annotation author, and acceptance status.

## 5. Positive, negative, and difficult examples

Do not provide only ideal examples. Include:

- correct anatomy and operation;
- plausible but incorrect boundary;
- threshold artifact;
- look-alike object;
- damaged or absent landmark;
- pathology that changes the usual shape;
- explicit human-escalation example.

Contrastive examples make frontier visual understanding more reliable than a larger set of unlabeled images.

## 6. Use during analysis

Retrieve only references relevant to the current target. Compare anatomy and operational criteria, not image style alone. Treat references as guidance rather than proof that the current specimen matches a known class.

Do not show reported measurement targets during blinded execution. Use them afterward for an audit when appropriate.

