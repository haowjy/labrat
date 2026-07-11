# Review UI — Three.js, Space, and Layout

Load when building a review artifact that uses 3D visualization. This
resource covers the technical patterns for three.js scenes, viewport
management, mobile-first layout, measurement-line overlays, the guided
landmark tour, and the evidence-led data contract.

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
- Landmark spheres with colored ring + confidence-scaled halo — bright
  for high confidence, dim/pulsing for `needs_confirmation`. Visible
  against both light bone surface and dark background.
- **Measurement lines drawn between their contributing landmarks**, labeled
  with the mm value AND the index they feed (e.g. "femoral length: 1.81 mm").
  These are the primary spatial evidence — "the line ends in the wrong
  place" is visible because the line exists.

## Measurement-line overlays

The measurement lines are the spatial evidence for the decisive ratios in
the evidence banner. Each line in `REVIEW_EVIDENCE.decisive[].measurement_lines`
becomes a visible overlay in the 3D scene:

- **Geometry:** `THREE.Line2` (fat lines) or `THREE.BufferGeometry` line
  segments between the `from` and `to` landmark positions. Use a
  contrasting color from the bone surface — typically white or yellow with
  a dark outline for visibility.
- **Label:** a `THREE.Sprite` or CSS2DRenderer label at the line midpoint
  showing the mm value and the index name. The label faces the camera.
- **State coloring:** when the contributing index is `concern` or `fail`
  (from `REVIEW_EVIDENCE.decisive[].state`), tint the line and label to
  match the banner's state color — the spatial view and the banner use the
  same visual language.
- **Highlight on tour:** during the guided landmark tour, the measurement
  lines that the current landmark contributes to are highlighted (full
  opacity); others dim. This answers "what measurement does this landmark
  affect?" without the reviewer having to reason about it.
- **Live update on drag:** when the reviewer drags a landmark, the
  measurement lines update in real time — the mm value recomputes from the
  new position and the label updates. Emit `metrics-updated` via the
  bridge with the new values.

## Camera and controls

- `OrbitControls` for rotate/pan/zoom — three.js built-in, no custom code
- **Initial camera position:** frame the full specimen with the most
  concerning measurement line visible (the one flagged in the evidence
  banner). The reviewer should see the problem, not hunt for it.
- **Preset camera angles** as buttons: anterior, lateral, superior,
  posterior. Standard anatomical views without manual rotation.
- **Orientation aid** — an `AxesHelper` or corner orientation cube showing
  A/P/S/I/M/L directions. The operational rules are direction-relative
  ("proximal-most," "distal midline") — the reviewer needs to know which
  way is proximal.
- `touch-action: none` on the canvas so pinch/rotate/pan don't scroll
  the page on mobile
- Unified Pointer Events (works for mouse + touch)

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
  chips, ordered by concern (low confidence first, then flagged, then
  high confidence). The current landmark is highlighted. Tapping any
  chip jumps to that landmark.
- **Per-landmark card** — a compact overlay (not a modal) showing:
  1. The landmark name and confidence badge
  2. The operational rule (the exact text from the protocol)
  3. The measurement lines it contributes to, with current values
  4. Any flags or known-limit narratives
- **Camera fly-to** — `camera.position` animates (GSAP or
  `requestAnimationFrame` lerp) to frame the landmark at a good
  inspection distance. The specimen doesn't jump — it smoothly reframes.
- **Slice sync** — all three slice sliders jump to the landmark's voxel
  position. The crosshairs center on it. The reviewer sees the landmark
  in 3D AND in all three orthogonal planes simultaneously.
- **Drag-to-adjust** — after the tour presents the evidence and rule,
  the landmark becomes draggable. An edit handle appears (not shown by
  default). Dragging updates the measurement lines live and emits
  `interaction` + `metrics-updated` via the bridge.
- **Next/Previous** — arrow buttons or keyboard arrows advance the tour.

### Tour is opt-out, not opt-in

The tour starts automatically for landmarks with `confidence` below `high`
or with flags. The reviewer can dismiss it and free-roam at any time. But
the default path is guided — the reviewer who follows the tour has verified
every flagged landmark with its rule, its measurement context, and its
spatial evidence.

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

**Split views within one context:** Use scissor rendering for side-by-side
views (e.g., 3D + orthogonal 2D) sharing one WebGL context. Cheaper than
multiple contexts and stays within the browser limit.

**No per-tab data loading.** All data is present in the document at load
time. Tabs switch which data is *rendered*, not which data is *loaded* —
the iframe cannot fetch additional data at runtime (`connect-src 'none'`).

## Evidence-led layout

The layout serves the information hierarchy in
`review-ui-information-hierarchy.md`: evidence banner → spatial views →
guided tour → agent conclusion → supporting data.

```
┌──────────────────────────────────────────────────┐
│  Evidence Banner (always visible, ~60-80px)       │
│  [■ W/L 1.33 vs 1.30 ▲concern] [■ IIOC 0.309…] │
├──────────────────────────────────────────────────┤
│  [ 3D scene ] [ Advanced slices ] [ Values ]      │  ← tabs
├──────────────────────────────────────────────────┤
│                                                    │
│     3D Scene (scene3d) — the hero, fills the area  │
│     + measurement overlays + derived ratio         │
│     + named landmark markers + orientation aid     │
│                                                    │
├──────────────────────────────────────────────────┤
│  Tour bar: Step N of M · [notch] [groove●] [...]  │
│  Card: "Groove top — proximal to condylar bulge"  │
│  [Adjust landmark] [‹ Prev] [Next ›]              │
└──────────────────────────────────────────────────┘
```

**Desktop:** the 3D scene fills the main area — it is the review surface,
not one pane among four. The evidence banner spans full width at the top;
the tour bar (step indicator, chips, Prev/Next, Adjust landmark) sits at
the bottom. Orthogonal slices, when shipped, live behind the **"Advanced
slices" tab**, not beside the scene.

**Mobile:** the same 3D scene fills the width (drag to orbit, pinch to
zoom); evidence banner at top, tour bar at the bottom, verdict panel near
the bottom edge. The Advanced-slices tab collapses to a bottom sheet.

**Tabs for secondary content:** "Values" tab shows the full measurement
table. "Interpretation" tab shows the OA-progression read. These are
secondary — the evidence banner + spatial views are the primary surface.

**Layout priorities:**
1. Evidence banner: fixed top, always visible across all views
2. 3D canvas + measurement overlays: fills the main area (the hero)
3. Tour bar + card: fixed bottom (step indicator, chips, Adjust landmark)
4. Advanced slices: a tab (optional), not competing with the 3D scene
5. Values/interpretation: a tab, shown after the spatial evidence

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
// artifact review/geometry.json (transform: identity), shape:
// {
//   "meshes": {
//     "<name>": { "vertices": [...], "faces": [...] }
//   }
// }
```

Injected via `data_sources`. Meshes decimated to ~10K vertices per
structure. Landmarks are NOT nested here — they live in `REVIEW_EVIDENCE`.

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

## Orthogonal slice scrubber (optional drill-down)

The 3D scene is the review surface. Orthogonal slices are **optional
secondary evidence** behind an **"Advanced slices" tab** — not the hero
view. They earn their place when they add something the surface hides: a
clean-looking 3D surface can mask a label bleeding through a slice or a
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
