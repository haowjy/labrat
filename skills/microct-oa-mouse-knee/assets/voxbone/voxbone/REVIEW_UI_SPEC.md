# voxbone review UI — design specification

The review tool is the human confirmation step for an automated micro-CT
osteoarthritis pipeline whose landmark placement is **not yet trustworthy
without inspection** (see "Open problem" below). Its job: let a researcher
confirm or correct, on any device, what the pipeline segmented and measured,
and export that judgement as a machine-readable record.

## What it must show and do

1. **3D scene — read-only "how I measured" display.**
   - Femur, tibia, growth-plate surfaces (semi-transparent bones so the plate
     shows through).
   - All landmarks as markers; **hover reveals** name, bone, and mm coordinates.
   - **Measurement lines** drawn between the landmark pairs that define each
     index (femur width = lateral↔medial condyle; femur length = notch↔groove;
     tibia width = medial↔lateral condyle), each line's hover showing the mm
     value. The 3D view explains the geometry; it does **not** edit it.
   - **Legend toggles every trace** (click to cross out / hide a structure or
     line; double-click to isolate one).
2. **2D ortho slices — the editor (per bone).**
   - Multi-planar reconstruction: coronal (frontal — the paper's measurement
     plane), sagittal, axial, from the **anatomically aligned** volume.
   - **Linked cursor:** tapping a point in one plane moves the other two to the
     slices through that point, and drops a cursor marker into the 3D scene —
     so every view is connected to every other.
   - **Place mode:** with a landmark selected, tapping sets its position; width/
     length/W-L recompute live as 3D straight-line distances.
   - Slice quality is the **cleaned/denoised** volume at full segmentation
     resolution (~21 µm), contrast-windowed to bone.
3. **Measurements panel.** Live values next to the auto values; the W/L ratio
   with the paper's interpretation band (normal < 1.28, OA > 1.30).
4. **Review panel.** Per-item verdict (each landmark, the femur/tibia split,
   growth plate, alignment) = approve / needs-fix / reject; overall verdict;
   free-text notes; **Export review JSON** (edited landmarks, recomputed
   measurements, all verdicts, provenance).
5. **Honesty surfaces.** A low-confidence femur/tibia call (margin < 0.15) shows
   a warning banner; alignment residual tilt is shown; growth-plate stats shown.

## Connect everything

State (verdicts, notes, edited landmarks, last 3D cursor) is held in one place
and **persists across pages/tabs** (browser localStorage keyed by sample id).
Editing a landmark on the femur slice page updates the 3D measurement line and
the review export without a reload. This is the "everything connects to
everything" requirement: no view is a dead end.

## Delivery model

- **Multi-file folder** (`index.html` + `femur.html` + `tibia.html` +
  `shared.css` + `shared.js` + `data/*.js`), shipped as one zip. Each page loads
  only its own data, so no single page carries the whole dataset — essential for
  mobile. This beats one inline file once full-resolution slices push a single
  file past ~30–50 MB.
- **`file://`-safe:** data ships as `.js` files assigning to `window` globals
  loaded via `<script>` tags, **not** `fetch()` (browsers block `fetch` of
  local files under the `file://` CORS policy; script tags work). The artifact
  therefore opens by double-click, with nothing installed, years later.
- Static only: Plotly from CDN (vendor it into the folder for a fully offline
  bundle). Zero build step.

## Mobile / touch techniques (required)

- **Tabs, never a scrolling page.** Bottom tab bar (thumb reach); each tab pane
  is exactly one viewport (`height:100dvh`, `overflow:hidden` on body). Only
  designated inner panels (measure/review lists) scroll internally.
- **Touch targets ≥ 44 px** on every interactive control — buttons, chips,
  verdict labels, **and range sliders** (a 30 px scrub slider is a bug).
- **Unified Pointer Events** (`pointerdown`/`pointermove`) so one code path
  serves mouse, touch, and pen; `touch-action:none` on canvases so a drag edits
  instead of scrolling the page; `touch-action:manipulation` on buttons to kill
  the 300 ms tap delay.
- **Pinch-zoom / rotate** in 3D (Plotly native); diagrams and canvases pan/pinch.
- **Viewport meta** `width=device-width, initial-scale=1`; layouts designed for
  a ~375 px width first, wider screens as enhancements (CSS grid reflow).
- **Light default theme** with a ☀/🌙 toggle that adds `.dark` to `<html>` and
  re-themes the 3D scene; colours driven by CSS custom properties on `:root`.
- Marker visibility: colored ring **plus white halo**, never a single colour
  that can vanish on a matching background (e.g. white-on-bone).

## Open problem (why the human step exists)

Automatic landmark placement picks the ML-extreme voxels independently per
landmark, so the four femur points can land on very different AP slices (~2.9 mm
spread on the demo sample) and the notch/groove can sit on edge cortex rather
than true intercondylar anatomy. The measured distances are internally
consistent and rotation-invariant, but the **placement is not yet anatomically
reliable**.

What the paper actually does (source docx): distal-femur **length and width are
direct 3D straight-line distances between manually placed voxels** on the 3D
model — length = groove-upper-midpoint to intercondylar notch, width = lateral
to medial condyle edge — with **no ortho-slice/frontal-plane constraint**. The
max-compartment-height **ortho slice is tibia-specific** (used only to pick the
tibial subchondral frontal section for compartment measurement).

So voxbone's automatic placement must reproduce the paper's *hand* voxel
placement, and the reliable path to that is human confirmation in this review
UI. As an **engineering aid** (not the paper's method), voxbone additionally
offers a 3D refinement that re-picks the two WIDTH endpoints on a common frontal
plane so the width line lies along the medial-lateral axis rather than across a
diagonal; this is a heuristic to make the automatic first guess more plausible,
and its result is still subject to review. Until placement is validated against
the user's own manual measurements, every sample must pass through this review
UI before its geometry is trusted.
