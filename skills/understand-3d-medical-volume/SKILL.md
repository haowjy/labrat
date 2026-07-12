---
name: understand-3d-medical-volume
description: Inspect, navigate, orient, segment, contour, annotate, measure, and verify volumetric medical or preclinical imaging data using a reference-grounded loop between 3-D views and linked 2-D slices. Use for DICOM, NIfTI, NRRD, MHA/MHD, TIFF stacks, µCT, CT, MRI, or derived masks when an agent must understand anatomy in 3-D, define ROIs, place landmarks, apply thresholds or classical image tools, validate results spatially, or adapt a sparse protocol without a task-specific 3-D model.
---

# Understand 3-D Medical Volumes

Use a frontier visual model as the controller and interpreter. Use deterministic imaging tools for voxel operations and numerical measurements. Ground protocol-specific anatomy in a small reference pack rather than assuming a pretrained model exists.

## Non-negotiable principles

1. Preserve the original volume unchanged.
2. Never lose the mapping among scanner/world, voxel, and anatomical coordinate frames.
3. Use 3-D views for context and connectivity; use linked 2-D slice neighborhoods for voxel-level decisions.
4. Reproject every local edit into 3-D, then cross-check it in the other slice planes.
5. Compute coordinates, distances, volumes, and ratios with tools; do not estimate them visually.
6. Record evidence, parameters, assumptions, uncertainty, and human interventions.
7. Escalate ambiguous anatomy instead of forcing a confident answer.
8. Do not optimize landmarks or ROIs toward known reported measurements.

## Load only the references needed

- Read [references/spatial-workflow.md](references/spatial-workflow.md) for coordinate frames, orientation, linked-view behavior, and the full 3-D/2-D loop.
- Read [references/technique-catalogue.md](references/technique-catalogue.md) when deciding how to locate a landmark, verify a concavity, detect a boundary, or choose between computational and visual methods.
- Read [references/evidence-and-qc.md](references/evidence-and-qc.md) when producing masks, ROIs, landmarks, measurements, batch outputs, or validation results.
- Read [references/reference-pack.md](references/reference-pack.md) when creating or using annotated reference images and protocol demonstrations.

Study-specific anatomy and workflow notes live in the protocol skill that composes this one (e.g. `microct-oa-mouse-knee`'s `resources/`), not here — this methodology stays study-agnostic.

## Choose the operating mode

### Exploration

Use when the anatomy, orientation, or task is not yet established. Inspect broadly, identify structures, and form explicit hypotheses. Do not produce final quantitative claims from screenshots alone.

### Protocol execution

Use when a written SOP or paper defines the target anatomy, ROIs, landmarks, and calculations. Compile the protocol into explicit steps and mark each parameter as confirmed, inferred, proposed, or missing before acting.

### Batch analysis

Use only after orientation, segmentation, ROI, landmark, and escalation rules have been locked on a pilot set. Process routine cases automatically and route uncertain cases for review.

## Core workflow

### 1. Ingest and protect

- Identify the input format and complete series.
- Preserve the source read-only and work from a versioned copy.
- Inspect voxel spacing, slice order, orientation, intensity scaling, laterality, and missing/corrupt images.
- Refuse physical measurements when voxel-to-world scaling is absent or unresolved.

### 2. Establish global context in 3-D

- Render the complete volume conservatively.
- Identify expected anatomy, gross orientation, connected components, cropping, and artifacts.
- Treat the rendering as a navigation aid, not ground truth; surfaces depend on threshold and transfer function.

### 3. Orient in linked views

- Open axial, coronal, sagittal, and 3-D views with one shared crosshair.
- Define anatomical axes and a rigid transform.
- Save translation, rotation, rotation order, center of rotation, and the 4×4 transform.
- Apply the same transform to the intensity volume, masks, ROIs, landmarks, and measurements.

### 4. Select a target and evidence question

State the next bounded task, such as:

- separate two connected bones;
- locate a growth plate;
- contour a subchondral ROI;
- distinguish an osteophyte from a sesamoid;
- place a landmark;
- measure a distance or volume.

Identify the evidence required to accept the result before selecting a tool.

### 5. Inspect a linked 2-D neighborhood

- Navigate to the target with the shared crosshair.
- Inspect adjacent slices and at least one orthogonal plane; use oblique reformats when anatomy is not axis-aligned.
- Adjust window/level or threshold preview without modifying the source.
- Compare the target with the relevant protocol references, including negative and difficult examples.

### 6. Act with an explicit tool and parameters

Prefer the simplest auditable operation that answers the task:

- thresholding;
- manual contour or brush;
- connected components;
- region growing;
- marker-based watershed;
- morphological cleanup;
- ROI intersection or split;
- landmark/ruler placement.

Record the operation, inputs, parameters, software, output version, and operator/agent decision.

### 7. Verify locally and globally

- Inspect the output overlay in the source plane, adjacent slices, and orthogonal planes.
- Reproject the output into 3-D.
- Check anatomy, topology, continuity, object relationships, and protocol constraints.
- Return any suspicious 3-D feature to the source slices before accepting it.

### 8. Decide and update state

Choose exactly one:

- accept and store evidence;
- revise with a documented operation;
- inspect another slice neighborhood;
- request human confirmation;
- exclude using a predefined rule;
- proceed to the next task;
- stop because the required evidence package is complete.

## Tool policy

Use available purpose-built DICOM or volumetric tools first. If unavailable, use reliable local libraries or command-line tools for metadata, conversion, rendering, masks, coordinates, and measurements. A 2-D visual model must not be treated as if it directly consumed or measured the entire 3-D volume.

Do not introduce a pretrained clinical segmentation or image-text model merely because it exists. First assess species, anatomy, modality, resolution, intensity scale, and acquisition domain. For high-domain-shift preclinical data, prefer references plus deterministic tools and human escalation.

## Human escalation

Require confirmation when any of the following affects a final result:

- unresolved laterality or coordinate frame;
- missing physical spacing or intensity calibration;
- multiple plausible orientations or target planes;
- ambiguous boundary, ROI, or landmark;
- connected calcified tissues with unclear ownership;
- absent or pathologically destroyed landmark;
- result sensitive to a small threshold change;
- conflict among 3-D view, slice evidence, and protocol description;
- proposed exclusion or large manual correction;
- new anatomy or failure mode absent from the reference pack.

## Completion gate

Do not report a final mask, ROI, landmark, or measurement until:

- source identity and coordinate mapping are preserved;
- orientation and transform are saved;
- the result is checked in a slice neighborhood, orthogonal planes, and 3-D;
- numerical outputs derive from saved coordinates or masks;
- assumptions and uncertainty are explicit;
- required screenshots, overlays, and state records exist;
- any required human confirmation is complete.

