# Review UI — Three.js, Space, and Layout

Load when building a review artifact that uses 3D visualization. This
resource covers the technical patterns for three.js scenes, viewport
management, mobile-first layout, measurement-line overlays, the guided
landmark tour, and the evidence-led data contract.

## Who owns the geometry — reference, do not recompute

A protocol can give **several phases** a `spatial-3d` review site, but the heavy
geometry is produced **once** by whichever phase's worker first has the voxels
for it, and every later phase's author **references** it. The author never
recomputes science — it writes a `"__REVIEW_INJECT:<NAME>__"` sentinel, a
`data_sources` entry pointing at the on-disk artifact, and the correct
`produced_from` sha256; the dashboard splices the verified bytes at serve time
(hash-checked on every request). No Bash-driven mesh extraction in the author.

- **The mesh** (`REVIEW_GEOMETRY`) is emitted once by the phase that first holds
  the labeled volume — in `microct-oa-mouse-knee` that is **segmentation**, which
  writes `segmentation/geometry.json`. Downstream authors (seed-review, landmarks,
  measurement) reference that same path; they add only their **own overlay**
  (landmarks/measurement lines) from their phase's outputs.
- **The volume** (`REVIEW_VOLUME`) for a mesh-less **volume-only render** (a phase
  that has grayscale but no segmentation yet — e.g. **intake**) is emitted once by
  that phase (`intake/volume.json`) and referenced by that phase's author.
- **Owner path ≠ shared path.** The producing phase writes to its **own**
  namespaced output (`segmentation/geometry.json`, `intake/volume.json`), NOT the
  final `review-artifact` phase's `review/geometry.json` / `review/volume.json`.
  Injection re-hashes the artifact on every serve, so if two phases wrote the same
  path the last writer would break every earlier phase's already-published site.

### The reference pattern a downstream author writes

Reference the shared artifact by its **artifacts-relative path** (no `artifacts/`
prefix — the server resolves under `<taskDir>/artifacts/`), and add each phase's
own overlay source under its own `produced_from` key:

```js
window.REVIEW_GEOMETRY = "__REVIEW_INJECT:REVIEW_GEOMETRY__";  // shared mesh
window.REVIEW_MANIFEST = {
  // ...
  data_globals: ["REVIEW_MANIFEST", "REVIEW_EVIDENCE", "REVIEW_GEOMETRY"],
  data_sources: {
    // shared mesh, produced by segmentation, referenced (not recomputed) here:
    REVIEW_GEOMETRY: { artifact: "segmentation/geometry.json", transform: "identity" }
  },
  produced_from: {
    geometry: "segmentation/geometry.json@<sha256>",   // the shared mesh's real hash
    landmarks: "landmarks/positions.json@<sha256>",     // this phase's OWN overlay
    measurement: "measurements/results.json@<sha256>"   // (measurement adds its lines)
  }
};
```

`REVIEW_EVIDENCE` (landmarks, measurement lines, rules) is still built by the
author as a static literal from the phase's own overlay outputs — that is the
per-phase overlay. Only the big binary mesh/volume is injected.

### `landmarks_available` — declare it honestly

`REVIEW_MANIFEST.landmarks_available` (boolean, default `true`) tells the G9 gate
whether this phase legitimately has a landmark source. Set it **`false` only** for
a phase with **no landmark source yet** — intake, segmentation, seed-review — so
the mesh-only (or volume-only) scene passes without a non-empty landmark set.
Leave it `true` (the default) for **landmarks and measurement**, and cite the
**real** placed landmarks from `landmarks/positions.json`; G9 still hard-fails an
empty-but-claimed landmark set on those phases. **Never** set it `false` and then
fabricate landmarks, and never claim landmarks a phase does not have.

## Three.js in the review artifact

Three.js passed strict CSP validation (R6 probe: real task geometry,
zero violations, zero relaxation). It provides orbit controls and
raycasting out of the box. The official r185+ minified distribution
inlines at ~745-785KB.

**Why three.js, not alternatives:**
- Plotly requires `'unsafe-eval'` (its bundle calls `eval` internally) —
  contradicts the CSP and the G5 linter's exec-sink detection
- Raw WebGL works at strict CSP but requires hundreds of bespoke lines
  for orbit controls, raycasting, and material management
- `regl` (~85KB) is the fallback if three.js ever fails strict CSP

## Scene structure

```
Scene
├── Mesh: femur (translucent material, distinct color)
├── Mesh: tibia (translucent material, distinct color)
├── Group: landmarks
│   ├── Sphere: landmark_1 (colored ring + confidence halo)
│   ├── Sphere: landmark_2
│   └── ...
├── Group: measurement lines
│   ├── Line: femoral_length (from→to landmarks, labeled with mm + index name)
│   ├── Line: femoral_width
│   └── ...
└── Lights: ambient + directional
```

**Key patterns:**
- One mesh per anatomical structure with distinct materials — the
  reviewer identifies structures by color
- Translucent surfaces where internal features need to be visible
  (landmarks inside a bone)
- Landmark markers scaled to a **constant on-screen size** (recompute the
  sphere scale each frame from camera distance) with a high-contrast dark
  outline and a larger invisible hit sphere for easy selection. Unselected
  markers dim; the selected marker gets an unmistakable DOM selection ring
  (pulsing, always drawn on top) plus its leader line. A compact confidence
  legend maps color/ring to high vs. review-needed.
- **Measurement lines drawn between their contributing landmarks.** The mm
  value rides in a small DOM badge placed OUTSIDE the bone silhouette (not a
  world-space sprite), shown only for the line(s) the selected landmark feeds.
  These are the primary spatial evidence — "the line ends in the wrong place"
  is visible because the line exists.

## Measurement-line overlays

The measurement lines are the spatial evidence for the decisive ratios in
the evidence banner. Each line in `REVIEW_EVIDENCE.decisive[].measurement_lines`
becomes a visible overlay in the 3D scene:

- **Geometry:** `THREE.Line2` (fat lines) or `THREE.BufferGeometry` line
  segments between the `from` and `to` landmark positions. Use a
  contrasting color from the bone surface — typically white or yellow with
  a dark outline for visibility.
- **Label:** a **DOM badge** (an absolutely-positioned element over the
  canvas, projected from the line midpoint each frame) showing the mm value,
  nudged OUTSIDE the bone silhouette so it never sits on the anatomy. Do NOT
  use a world-space `THREE.Sprite` with `depthTest:false` — fixed-world-height
  sprites grow huge on zoom, billboard, overlap, and draw over the bone (the
  #1 defect p96 found). DOM/CSS2D labels are CSP-clean (plain HTML/CSS).
- **State coloring:** when the contributing index is `concern` or `fail`
  (from `REVIEW_EVIDENCE.decisive[].state`), tint the line and label to
  match the banner's state color — the spatial view and the banner use the
  same visual language.
- **Highlight on tour:** during the guided landmark tour, the measurement
  lines that the current landmark contributes to are highlighted (full
  opacity); others dim. This answers "what measurement does this landmark
  affect?" without the reviewer having to reason about it.
- **Static values (read-only review).** The artifact is a review surface,
  not an editor: landmarks are not draggable and the mm values never
  recompute in-scene. In-scene editing produced an internally inconsistent
  artifact (the line/legend recomputed to a new ratio while the banner and
  Values tab stayed at the original); the reviewer instead comments and marks
  the phase for revision through the shell.

## Camera and controls

- `OrbitControls` for rotate/zoom — three.js built-in, no custom code.
  Disable panning (`controls.enablePan = false`); a review surface only
  rotates and zooms.
- **Auto-fit the joint at load.** Frame the landmark cloud (the distal
  femur / tibial plateau), NOT the full mesh — the long femoral shaft
  otherwise dominates and crops the joint. Compute a `Box3` over the
  landmark positions, target its center, and derive the camera distance from
  the bounding radius and the vertical FOV (`r / sin(fov/2)` × margin).
- **Constrain the orbit** so the reviewer can't reach a useless close-up or
  edge-on pose: set `minDistance`/`maxDistance` around the fit distance and
  clamp `minPolarAngle`/`maxPolarAngle` (e.g. 0.16π–0.84π).
- **Visible controls:** a prominent **Reset view** button plus 1–2
  anatomical presets (Front/anterior, Side/lateral) and zoom in/out buttons,
  overlaid in a corner of the canvas.
- **Onboarding hint:** a dismissible "Drag to rotate · scroll to zoom" pill
  that hides on the first orbit (OrbitControls' `start` event) or on tap of
  its close button. Set `cursor: grab` on the canvas and `grabbing` while
  dragging so the drag affordance is discoverable.
- **Raised opacity + silhouette outline.** Render bones at ~0.82 opacity
  (not 0.55 — pale translucent surfaces blend together) with distinct
  warm/cool colors and an inverted-hull dark back-face outline for clean
  contour separation between femur and tibia.
- **Orientation aid** — an `AxesHelper` tucked into a lower-anterior corner
  of the joint box showing the A/P/S/I/M/L directions. The operational rules
  are direction-relative ("proximal-most," "distal midline").
- `touch-action: none` on the canvas so pinch/rotate don't scroll the page
  on mobile. Unified Pointer Events (mouse + touch).

## Guided landmark tour

The tour replaces free-roam hunting with a structured verification path.
It walks the reviewer through each landmark, low-confidence first, with
the context they need to verify each one.

### Tour data — from `REVIEW_EVIDENCE`

Each landmark in `REVIEW_EVIDENCE.landmarks` carries:
- `name`, `position` (mesh-frame XYZ for the 3D marker), `confidence`, `color`
  (and `voxel` only when slices are shipped)
- `operational_rule` — the specific placement rule from the protocol
  (e.g. "proximal-most sustained anterior-midline concavity, proximal to
  the condylar bulge — not where the condyles merge")
- `measurement_lines` — which measurement lines this landmark contributes
  to (by id, referencing `REVIEW_EVIDENCE.decisive[].measurement_lines`)
- `flags` — any `requires_human_review` or known-limit narratives

### Tour UX

- **Tour bar** — a horizontal step indicator showing all landmarks as
  chips, ordered by concern (review-flagged / low confidence first). The
  current chip is highlighted; visited chips are marked done. Tapping any
  chip jumps to that landmark.
- **Human titles, technical id secondary.** Show "Trochlear groove top" as
  the step title with the raw `trochlear_groove_top` id and a confidence
  badge beside it — not the bare id.
- **Canonical camera pose per landmark.** Store a legible viewing direction
  per landmark (mostly anterior) and fly to a consistent framing each step
  (`requestAnimationFrame` lerp with smoothstep). Every step lands on the
  same good pose, pairs with its clearly-selected marker (selection ring +
  leader), and shows only the measurement badge(s) that landmark feeds.
- **Per-landmark rule** — the operational rule (exact protocol text) shows
  in the tour bar under the title.
- **Completion + restart** — once every landmark is visited, show a
  completion note ("All N landmarks reviewed") and turn the Next control
  into a **Restart** that clears the visited set and returns to step 1.
- **Slice sync (only when slices ship)** — all three slice sliders jump to
  the landmark's voxel position and the crosshairs center on it.
- **Next/Previous** — buttons advance the tour. On mobile the tour opens as
  a collapsed bottom sheet (title + Prev/Next) that expands to the rule and
  chips on tap, so the scene fills the viewport.

### Tour is opt-out, not opt-in

The tour starts automatically for landmarks with `confidence` below `high`
or with flags. The reviewer can dismiss it and free-roam at any time. But
the default path is guided — the reviewer who follows the tour has verified
every flagged landmark with its rule, its measurement context, and its
spatial evidence.

## Landmark labels — DOM overlay, not sprites

Labels are the #1 thing that can ruin a spatial review: world-space
`THREE.Sprite` labels at a fixed world height with `depthTest:false` grow
huge as the camera nears, billboard, overlap each other, and always draw
over the bone (p96). Use **DOM/CSS2D labels** instead:

- A transparent `#label-layer` div (plus an SVG `#leader-layer`) overlays the
  canvas. Each frame, project the landmark world position to screen and
  position an HTML label (~12–14px, human-readable name) with a thin leader
  line back to the marker.
- **Default to the selected landmark's label only.** The tour drives
  selection, so exactly one label shows at rest and the anatomy stays clearly
  visible. Reveal others on hover/tap or via an optional "Show all labels"
  toggle; on narrow (mobile) screens, clamp to selected-only.
- **Edge-clamp** every label inside the viewport with a margin so it never
  clips off-canvas, and offset it away from the marker so the leader reads.
- Measurement mm values are small DOM badges placed OUTSIDE the bone
  silhouette, shown only for the selected landmark's line(s).
- **"Labels" toggle in scene controls.** A single button (`#btn-labels`)
  hides ALL DOM overlays — labels, measurement badges, legends — so the
  reviewer sees the raw geometry without visual clutter. On mobile this is
  essential: the overlays compete for limited screen space. The template
  wires `body.hide-labels` to `display: none` on `.line-labels`,
  `.line-label`, `.orient-legend`, and `.conf-legend`. Preserve this
  toggle when authoring; do not remove it.

## Raycasting

- Click to select/highlight a landmark or structure
- Hover to show tooltip with identity, confidence, and contributing measurements
- Selection syncs to the verdict panel via the postMessage bridge
  (`interaction` message)
- Raycast against landmark spheres first (smaller targets, higher
  priority), then mesh surfaces

## Viewport management

**One WebGL context at a time.** Browsers limit concurrent contexts
(~8-16). If your template shows multiple 3D views on tabs (e.g.
per-bone), unmount/remount the WebGL canvas when the tab changes, not
just hide it — a hidden canvas still holds a context against the
browser limit.

**Resize the existing renderer — never recreate it.** On resize, call
`renderer.setSize(w, h, false)` and update `camera.aspect`; do not build a
new `WebGLRenderer`. Recreating the context on every resize thrashes the GL
context (p96 saw Context Lost/Restored under repeated resize). Add
`webglcontextlost`/`webglcontextrestored` listeners (preventDefault on lost,
re-`resize()` on restored) so a dropped context recovers cleanly.

**Split views within one context:** Use scissor rendering for side-by-side
views (e.g., 3D + orthogonal 2D) sharing one WebGL context. Cheaper than
multiple contexts and stays within the browser limit.

**No per-tab data loading.** All data is present in the document at load
time. Tabs switch which data is *rendered*, not which data is *loaded* —
the iframe cannot fetch additional data at runtime (`connect-src 'none'`).

## Four-up spatial layout

The default view is a **four-up multiplanar layout** — four equal quadrants
filling the viewport. No evidence banner: the decisive numbers are shown by
the dashboard shell's EvidencePanel (trusted, from disk). The artifact's job
is spatial evidence.

```
┌─────────────────────┬─────────────────────┐
│                     │                     │
│     3D Scene        │    Axial (Z)        │
│     orbit, markers, │    crosshair,       │
│     measurement     │    label overlay,   │
│     lines + badges  │    slice slider     │
│                     │                     │
├─────────────────────┼─────────────────────┤
│                     │                     │
│    Coronal (Y)      │   Sagittal (X)      │
│    crosshair,       │    crosshair,       │
│    label overlay,   │    label overlay,   │
│    slice slider     │    slice slider     │
│                     │                     │
└─────────────────────┴─────────────────────┘
  Tour bar: Step N of M · Groove top ● · rule
  chips [Groove top][Notch][Lat][Med]   [‹Prev][Next›]
  [ Spatial evidence ] [ Values ] [ Interpretation ] [ Reference ]
```

**Each quadrant gets 50% width × 50% height.** The 3D scene is one of four
equal views, not a hero. Selecting a landmark in any pane — raycast in 3D,
click on a slice — drives all four views to that position: the 3D marker
highlights, all three slice crosshairs center, and the tour card updates.

**Per-quadrant expand.** Each quadrant has a small expand button (corner
icon) that promotes it to fill the full stage area. The other three
quadrants hide. A collapse button returns to the four-up. The expand is a
CSS class swap on the grid container — no remount, so the 3D context and
slice state survive. Use this to inspect fine detail in one plane (e.g.,
checking a growth-plate slice at full resolution) then return to the
linked four-up.

**Measurement values appear on the lines** in the 3D quadrant as DOM badges
(e.g., "2.41 mm" on the width line). No separate evidence banner — the
numbers are spatial context, not chrome.

**Desktop:** four quadrants fill the stage. Tour bar sits below. Tabs
(Values / Interpretation / Reference) below the tour bar for secondary
content.

**Mobile:** the four-up collapses to a stacked layout (3D full-width on top,
three slices as a horizontal scrollable strip below). Tour bar and tabs at
the bottom. Touch targets ≥ 44px.

**Layout priorities:**
1. Four-up spatial views: fill the viewport equally
2. Tour bar: below the views (step indicator, human title, rule, chips, Prev/Next)
3. Tabs for secondary content: Values, Interpretation, Reference
   Hidden panels must win: `.panel[hidden]{display:none!important}` so a
   hidden tab never leaks under the spatial views.

## Mobile patterns

The reviewer may be on a phone at a bench. Design for this.

- **Touch targets ≥ 44px** — every button, chip, slider thumb. Default
  range slider thumbs are far under 44px.
- **Tour chips at thumb reach** — bottom of viewport, swipeable.
- **Viewport meta** — `<meta name="viewport" content="width=device-width, initial-scale=1">`
- **Light default with dark toggle** — CSS custom properties on `:root`.
  Light mode for bench/lab lighting. Dark toggle via class on `<html>`.
- **No hover-dependent interactions** — everything that shows on hover
  must also work on tap.

## Delivery constraints

- **Self-contained.** Single inlined HTML document. No external network
  requests at runtime. Data as `<script>` globals assigning to `window`
  (not fetched JSON — `file://` blocks `fetch()` of local files).
- **No build step.** Static HTML/CSS/JS. The sandbox may not have Node
  or a bundler.
- **CSP:** `script-src 'unsafe-inline'` only. No `'unsafe-eval'`. No
  external origins unless in `protocol.yaml`'s `cdn_allowlist`.
- **Size budget:** 2–5MB total. Three.js (~785KB) + mesh data + evidence
  data + volume data + UI code. Meshes decimated to ~10K vertices per
  structure at extraction time. All data for all tabs is present in the
  document at load time (`connect-src 'none'` prevents the iframe from
  fetching anything at runtime); the size budget must account for the total.

## Data contract

Review sites use `window` globals assigned in inline `<script>` tags.
`REVIEW_MANIFEST` is always a static object literal. Data globals are
either static literals (small data) or sentinel placeholders filled by
the server at serve time (large data).

### `REVIEW_EVIDENCE` — the decisive numbers and landmark context

This global carries the domain content the evidence banner and guided tour
render. It is a **static object literal** (small data — ratios, flags, and
landmark metadata, not geometry). The worker builds it from the measurement
outputs and the protocol's operational rules.

```js
window.REVIEW_EVIDENCE = {
  // The decisive ratios — what the reviewer is verifying
  decisive: [
    {
      id: "distal_femoral_ratio",
      label: "Distal femoral W/L (osteophyte index)",
      value: 1.33,
      unit: "ratio",
      cutoff: { normal_below: 1.24, oa_above: 1.30 },
      state: "concern",           // "pass" | "concern" | "fail"
      requires_human_review: true,
      known_limits: "femoral_notch_and_groove: iterated 4x on this specimen",
      // The sub-measurements that produce this ratio
      sub_measurements: [
        { id: "distal_femoral_length", label: "Distal femoral length",
          value: 1.81, unit: "mm" },
        { id: "distal_femoral_width", label: "Distal femoral width",
          value: 2.41, unit: "mm" }
      ],
      // The measurement lines to draw in 3D — connecting landmarks
      measurement_lines: [
        { id: "femoral_length", from: "trochlear_groove_top",
          to: "intercondylar_notch", value_mm: 1.81 },
        { id: "femoral_width", from: "lateral_condylar_edge",
          to: "medial_condylar_edge", value_mm: 2.41 }
      ]
    }
    // ... one entry per decisive ratio
  ],

  // The OA-progression interpretation — shown AFTER evidence
  interpretation: {
    stage: "early",
    confidence: "low",
    basis: "W/L 1.29 is just over the 4-week ROC cutoff and IIOC H/W 0.29 is in the gray zone; the signals only weakly agree and this is a single specimen."
  },

  // Per-landmark details for the guided tour
  landmarks: [
    {
      name: "intercondylar_notch",
      position: [0.0, 0.35, -0.1],  // XYZ in the mesh frame (mm) — where the
                                    // 3D marker sits; the PRIMARY placement
      voxel: [120, 85, 64],         // ZYX in the downsampled volume frame —
                                    // only when slices are shipped (optional)
      confidence: "high",
      operational_rule: "Distal-most midline bone point (eroded-notch fallback: notch-entrance edge at healthy bone)",
      color: [255, 100, 100],
      flags: [],
      // Which decisive ratios this landmark contributes to (by id)
      contributes_to: ["distal_femoral_ratio"]
    }
    // ... one entry per landmark
  ],

  // Structural checks the reviewer should know about
  structural: {
    segmentation_cc: { femur: 1, tibia: 1 },
    compartment_symmetry: { medial_height: 0.42, lateral_height: 0.44,
                            delta: 0.02, status: "pass" }
  }
};
```

**`REVIEW_EVIDENCE` is declared in `data_globals` and checked by G3.**
It does not need `data_sources` or injection — it is small enough to
inline as a static literal. Its `produced_from` entry in the manifest
hashes the measurement source files it was built from.

### `REVIEW_GEOMETRY` — mesh data (injected)

```js
window.REVIEW_GEOMETRY = "__REVIEW_INJECT:REVIEW_GEOMETRY__";
// artifact <owner-phase>/geometry.json (transform: identity) — e.g.
// segmentation/geometry.json, produced ONCE by the phase that owns the mesh
// and referenced by every downstream phase. Shape:
// {
//   "meshes": {
//     "<name>": { "vertices": [...], "faces": [...] }
//   }
// }
```

Injected via `data_sources`. Meshes decimated to ~10K vertices per
structure. Landmarks are NOT nested here — they live in `REVIEW_EVIDENCE`.

**Mesh-without-landmarks is valid.** A phase that owns/references the mesh but has
no landmark source yet (segmentation, seed-review) ships `REVIEW_GEOMETRY` with an
empty `REVIEW_EVIDENCE.landmarks` and `landmarks_available: false` — a bare labeled
mesh, no overlay. G9 tolerates this when `landmarks_available` is false.

**Volume-only, no mesh, is valid.** A phase with grayscale but no segmentation
(intake) ships `REVIEW_VOLUME` and NO `REVIEW_GEOMETRY` (`landmarks_available:
false`); the template renders the grayscale volume without any `meshes`.

### `REVIEW_VOLUME` — downsampled slice data (injected, OPTIONAL)

Only needed when the optional Advanced-slices tab ships. The 3D scene does
not use it. The 2D slices need grayscale pixels the mesh doesn't carry, so
the worker exports one injected artifact — a downsampled volume — from
`segmentation/filtered.nii.gz` + `labels.nii.gz`. Downsampling the full
NIfTI is the hardest extraction step; the demo's first pass ships 3D without
it and adds slices later:

```js
window.REVIEW_VOLUME = "__REVIEW_INJECT:REVIEW_VOLUME__";
// artifact review/volume.json (transform: identity), shape:
// {
//   "shape": [nz, ny, nx],
//   "spacing_mm": [sz, sy, sx],
//   "axes": { "axial": 0, "coronal": 1, "sagittal": 2 },
//   "grayscale_b64": "<base64 uint8, length nz*ny*nx, window-normalized 0..255>",
//   "labels_rle": [[value, count], ...],
//   "label_colors": { "1": [r,g,b], ... },
//   "label_names": { "1": "femur", "2": "tibia", ... }
// }
```

Declare via `data_sources.REVIEW_VOLUME` + a `produced_from` hash.
Landmarks are NOT in this global — they live in `REVIEW_EVIDENCE.landmarks`
with their `voxel` coordinates in this volume's downsampled frame.

**Volume-only mode (intake).** For a pre-segmentation phase there are no labels
and no mesh: the artifact carries just `shape`, `spacing_mm`, `axes`, and
`grayscale_b64` (no `labels_rle` / `label_colors` / `label_names`), the manifest
ships `REVIEW_VOLUME` **without** `REVIEW_GEOMETRY`, and the template renders the
grayscale volume alone. The owner phase writes its own namespaced path
(`intake/volume.json`), never the `review-artifact` phase's `review/volume.json`.

**Size budget constraint.** three.js (~785KB) + mesh geometry + this
volume must stay under 5MB. Grayscale uint8 at ~112³ ≈ 1.4MB (base64
~1.9MB); labels compress to almost nothing as RLE. Downsample so the
total fits — 96–128³ is plenty for review-grade slices. If a specimen
still exceeds budget, fall back to **pre-rendered JPEG slice stacks**
(`REVIEW_SLICES`: per-axis arrays of `data:image/jpeg` URIs at a slice
stride).

### Manifest for an evidence-led spatial review

The 3D scene is the primary view; `scene3d` is the only required view.
Ship the **3D scene alone first** — it needs only `REVIEW_GEOMETRY` (mesh)
and `REVIEW_EVIDENCE` (numbers, landmarks, rules). Slices are optional
drill-down evidence: add the `slice-*` views, `REVIEW_VOLUME`, and
`linked_views: true` only when the downsampled volume is exported.

```js
window.REVIEW_MANIFEST = {
  sample_id: "<task-id>",
  produced_from: {
    measurement: "measurements/results.json@<sha256>",
    geometry: "review/geometry.json@<sha256>"
    // volume: "review/volume.json@<sha256>"   // only if slices are shipped
  },
  verdict_schema: "review-verdict/1",
  review_layout: "spatial-multipane",
  required_views: ["scene3d"],                  // 3D is the hero; slices optional
  data_globals: ["REVIEW_MANIFEST", "REVIEW_EVIDENCE", "REVIEW_GEOMETRY"],
  data_sources: {
    REVIEW_GEOMETRY: { artifact: "review/geometry.json", transform: "identity" }
  }
  // When slices ARE shipped, add to the above:
  //   required_views: [..., "slice-axial", "slice-coronal", "slice-sagittal"],
  //   linked_views: true,
  //   data_globals: [..., "REVIEW_VOLUME"],
  //   data_sources.REVIEW_VOLUME: { artifact: "review/volume.json", transform: "identity" },
  //   produced_from.volume: "review/volume.json@<sha256>"
};
```

G3 validates all `data_globals` exist. G8 validates all `produced_from`
hashes. G9 validates the 3D scene (real three.js + OrbitControls) and, when
present, the optional slice markers. `REVIEW_EVIDENCE` is inlined (no
`data_sources` entry) — G3 confirms it is a non-empty static literal.

**Inline / vendor three.js — no CDN.** The artifact runs in an opaque-origin
CSP sandbox that drops every external subresource, so the three.js UMD build
and OrbitControls are inlined in `<script>` blocks (not `<script src>`).
Vendor a build that passes strict CSP: no `eval`/`new Function` (rules out
Plotly; three.js is clean). The `validation/fixtures/review-site-spatial`
fixture inlines the r137 UMD build + classic `OrbitControls` this way.

## Orthogonal slice scrubber (three quadrants of the four-up)

The orthogonal slices are **primary evidence** — three of the four equal
quadrants in the four-up layout. They verify what the 3D surface hides: a
clean-looking surface can mask a label bleeding through a slice or a
landmark sitting one slice off the bone. Ship them when the downsampled
volume is exported; the demo's first pass ships 3D alone.

When slices ARE shipped they must be **linked**: three 2D panes (axial,
coronal, sagittal) the reviewer can scrub, with the 3D scene and the slices
sharing one position. G9 gates that a *declared* slice view is complete and
linked — an incomplete scrubber is worse than none.

### The panes — static markers (when slices are shown)

The `scene3d` view is always required. Each slice pane, when shipped,
carries a `data-review-view` plus a canvas and range slider with
`data-review-slice-*` attributes. These markers are what the **G9 gate**
checks statically (it can't execute the wiring), so once a slice view is
declared they are not optional decoration — a missing marker fails the gate:

```html
<section data-review-view="scene3d"><canvas id="scene3d-canvas"></canvas></section>

<section data-review-view="slice-axial">
  <canvas data-review-slice-canvas="axial" id="slice-axial-canvas"></canvas>
  <input type="range" data-review-slice-slider="axial" min="0" max="{nz-1}" step="1"
         aria-label="Axial slice">
</section>
<section data-review-view="slice-coronal">  <!-- same pattern --></section>
<section data-review-view="slice-sagittal"> <!-- same pattern --></section>
```

Slider thumbs must be ≥44px (default range thumbs are far under — style
them up). On mobile the slice panes collapse to preview thumbnails behind the
Advanced-slices tab; tap to fullscreen.

### Render and link

- `drawSlice(axis, index)` — extract the 2D plane at `index` along
  `axes[axis]` from `REVIEW_VOLUME.grayscale_b64`, draw it to that pane's
  canvas; overlay `labels_rle` colors at low alpha (so the reviewer sees
  the segmentation *on* the anatomy); draw any landmark from
  `REVIEW_EVIDENCE.landmarks` whose voxel lies on this plane as a colored
  ring + halo; draw the crosshair at the shared position.
- A slider's `input` event sets that axis's index → redraw its pane and
  move the crosshair in the other two.
- **Landmark selection drives everything:** a landmark click in the 3D
  scene (raycast) OR a tour step sets all three sliders to that
  landmark's voxel indices, centers every crosshair, highlights the
  contributing measurement lines, and shows the tour card with the
  operational rule. Emit `interaction` (`action: "select-landmark"`,
  `id`, `position`) via the bridge.

Canvas 2D only — no `eval`, no external origins (CSP + G5 clean). All
slice data is present at load; the iframe cannot fetch more.
