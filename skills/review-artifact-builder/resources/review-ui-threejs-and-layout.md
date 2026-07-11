# Review UI — Three.js, Space, and Layout

Load when building a review artifact that uses 3D visualization. This
resource covers the technical patterns for three.js scenes, viewport
management, and mobile-first layout.

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
│   ├── Sphere: landmark_1 (colored ring + white halo)
│   ├── Sphere: landmark_2
│   └── ...
├── Group: measurement lines
│   ├── Line: femur_length (labeled with mm value + name)
│   └── ...
└── Lights: ambient + directional
```

**Key patterns:**
- One mesh per anatomical structure with distinct materials — the
  reviewer identifies structures by color
- Translucent surfaces where internal features need to be visible
  (landmarks inside a bone)
- Landmark spheres with colored ring + white halo — visible against
  both light bone surface and dark background. A bare white marker
  vanishes on bone; a bare colored marker vanishes on dark backgrounds.
- Measurement lines drawn as the protocol measured them, labeled with
  value and what they represent

## Camera and controls

- `OrbitControls` for rotate/pan/zoom — three.js built-in, no custom code
- **Initial camera position:** show the full specimen with the primary
  measurement visible. The reviewer should not have to navigate to find
  what they're reviewing.
- **Preset camera angles** as buttons: anterior, lateral, superior,
  posterior. The reviewer shouldn't have to manually rotate to standard
  anatomical views.
- `touch-action: none` on the canvas so pinch/rotate/pan don't scroll
  the page on mobile
- Unified Pointer Events (works for mouse + touch)

## Raycasting

- Click to select/highlight a landmark or structure
- Hover to show tooltip with identity and current measurement
- Selection syncs to the verdict panel via the postMessage bridge
  (`interaction` message)
- Raycast against landmark spheres first (smaller targets, higher
  priority), then mesh surfaces

## Viewport management

**One WebGL context at a time.** Browsers limit concurrent contexts
(~8-16). If your template shows multiple 3D views on tabs (e.g.
per-bone), unmount/remount the WebGL canvas when the tab changes, not
just hide it -- a hidden canvas still holds a context against the
browser limit.

**Split views within one context:** Use scissor rendering for side-by-side
views (e.g., 3D + orthogonal 2D) sharing one WebGL context. Cheaper than
multiple contexts and stays within the browser limit.

**No per-tab data loading.** All data is present in the document at load
time. Tabs switch which data is *rendered*, not which data is *loaded* —
the iframe cannot fetch additional data at runtime (`connect-src 'none'`).
In a future per-phase model where the shell loads separate review-site
documents per tab, each document would load independently; that model is
planned but not built.

## Space efficiency

**Tabs, not scrolling.** Each review surface is one viewport
(`height: 100dvh`, `overflow: hidden` on body). The reviewer sees one
complete view at a time. Tabs switch between: 3D scene, per-bone 2D
slices, data/measurements. A scrolling page where the 3D scene disappears
off the top is the wrong pattern.

**The 3D scene gets the most space.** It's the primary evidence. The
verdict panel, measurement table, and controls are secondary — they fit
around the scene, not the other way around.

**Layout priorities:**
1. 3D canvas: fills available space (flex-grow or calc)
2. Verdict panel: fixed-height sidebar or bottom panel
3. Measurement table: tab or collapsible, not always visible
4. Reference context: popover or expandable, not inline

## Mobile patterns

The reviewer may be on a phone at a bench. Design for this.

- **Touch targets ≥ 44px** — every button, chip, slider thumb. Default
  range slider thumbs are far under 44px.
- **Tabs at thumb reach** — bottom tab bar, not top. The reviewer holds
  the phone one-handed.
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
- **Size budget:** 2–5MB total. Three.js (~785KB) + mesh data + UI code.
  Meshes decimated to ~10K vertices per structure at extraction time. All
  data for all tabs is present in the document at load time (`connect-src
  'none'` prevents the iframe from fetching anything at runtime); the size
  budget must account for the total.

## Data contract

Review sites use `window` globals assigned in inline `<script>` tags.
`REVIEW_MANIFEST` is always a static object literal. Data globals are
either static literals (small data) or sentinel placeholders filled by
the server at serve time (large data).

**Inline pattern** (small data, e.g. a values table):

```js
window.REVIEW_MANIFEST = {
  sample_id: "task-2026-07-10-008",
  produced_from: {
    measurement: "results.json@<sha256>"
  },
  verdict_schema: "review-verdict/1",
  data_globals: ["REVIEW_MANIFEST", "REVIEW_DATA"]
};

window.REVIEW_DATA = {
  items: [
    { id: "femur_length", label: "Femur length", value: 2.41,
      unit: "mm", honesty_flag: null, honesty_detail: null },
    // ...
  ]
};
```

**Injection pattern** (large data, e.g. geometry):

```js
window.REVIEW_MANIFEST = {
  sample_id: "task-2026-07-10-008",
  produced_from: {
    measurement: "landmarks/positions.json@<sha256>"
  },
  verdict_schema: "review-verdict/1",
  data_globals: ["REVIEW_MANIFEST", "REVIEW_GEOMETRY"],
  data_sources: {
    REVIEW_GEOMETRY: {
      artifact: "landmarks/positions.json",
      transform: "identity"
    }
  }
};

// Sentinel placeholder — the server replaces this (including its quotes)
// with the artifact's bytes at serve time.
window.REVIEW_GEOMETRY = "__REVIEW_INJECT:REVIEW_GEOMETRY__";
```

The manifest is parsed statically by the G3 gate (never executed). The
linter verifies that every `data_globals` entry exists as a non-empty
`window` assignment in the document. When `data_sources` is present, the
linter also checks consistency: each source must appear in `data_globals`
and have a matching `produced_from` hash.

## Orthogonal slice scrubber (spatial reviews)

A segmentation or landmark review is **not complete with the 3D mesh alone**. A
clean-looking 3D surface can hide a label bleeding through a slice or a landmark
sitting one slice off the bone. The reviewer needs the **linked orthogonal slice
scrubber**: three 2D panes (axial, coronal, sagittal) they can scrub, with the 3D
scene and the slices sharing one position. This is the view most often skipped —
the mesh pattern above doesn't produce it, and mesh geometry carries no grayscale
pixels — so build it deliberately. It is required and gated (G9); the markers
below are what the gate checks.

### Slice data — a downsampled volume, injected

The 2D slices need grayscale pixels the mesh doesn't carry. The worker exports one
injected artifact — a **downsampled volume** — from `segmentation/filtered.nii.gz`
+ `labels.nii.gz` + `landmarks/positions.json`:

```js
window.REVIEW_VOLUME = "__REVIEW_INJECT:REVIEW_VOLUME__";  // sentinel; server fills at serve time
// artifact review/volume.json (transform: identity), shape:
// {
//   "shape": [nz, ny, nx],           // downsampled dims
//   "spacing_mm": [sz, sy, sx],
//   "axes": { "axial": 0, "coronal": 1, "sagittal": 2 },  // array axis each pane scrolls
//   "grayscale_b64": "<base64 uint8, length nz*ny*nx, window-normalized 0..255>",
//   "labels_rle": [[value, count], ...],                   // RLE, same raster order; 0 = background
//   "label_colors": { "1": [r,g,b], ... },
//   "label_names":  { "1": "femur", "2": "tibia", ... },
//   "landmarks": [ { "name": "...", "voxel": [z,y,x], "color": [r,g,b] }, ... ]  // downsampled frame
// }
```

Declare it like any injected source — `data_sources.REVIEW_VOLUME` + a
`produced_from` hash — so G3/G8 provenance covers it.

**Size budget is the constraint.** three.js (~785KB) + mesh geometry + this volume
must stay under 5MB. Grayscale uint8 at ~112³ ≈ 1.4MB (base64 ~1.9MB); labels
compress to almost nothing as RLE. Downsample the grayscale so the total fits —
96–128³ is plenty for review-grade slices. If a specimen still exceeds budget,
fall back to **pre-rendered JPEG slice stacks** (`REVIEW_SLICES`: per-axis arrays
of `data:image/jpeg` URIs at a slice stride) — cheaper, but no free reslicing.

### The panes — required static markers

Each view carries a stable `data-review-view` attribute; each slice pane carries a
canvas and a range slider with `data-review-slice-*` attributes. These markers are
what the **G9 gate** checks statically (it can't execute the wiring), so they are
not optional decoration — a missing marker fails the gate:

```html
<section data-review-view="scene3d"><canvas id="scene3d-canvas"></canvas></section>

<section data-review-view="slice-axial">
  <canvas data-review-slice-canvas="axial" id="slice-axial-canvas"></canvas>
  <input type="range" data-review-slice-slider="axial" min="0" max="{nz-1}" step="1"
         aria-label="Axial slice">
</section>
<section data-review-view="slice-coronal">  <!-- data-review-slice-canvas="coronal"  + slider --></section>
<section data-review-view="slice-sagittal"> <!-- data-review-slice-canvas="sagittal" + slider --></section>
```

Slider thumbs must be ≥44px (default range thumbs are far under — style them up).
On mobile the four panes collapse to preview thumbnails; tap to fullscreen
(`review-ui-design-principles.md`).

### Render and link

- `drawSlice(axis, index)` — extract the 2D plane at `index` along `axes[axis]`
  from `REVIEW_VOLUME.grayscale_b64`, draw it to that pane's canvas; overlay
  `labels_rle` colors at low alpha (so the reviewer sees the segmentation *on* the
  anatomy); draw any landmark whose voxel lies on this plane as a colored ring +
  white halo; draw the crosshair at the shared position.
- A slider's `input` event sets that axis's index → redraw its pane and move the
  crosshair in the other two.
- **The linking (the whole point):** a landmark click in the 3D scene (raycast,
  per "Raycasting" above) sets all three sliders to that landmark's voxel indices
  and centers every crosshair on it — 3D selection drives the slices. Emit the
  `interaction` bridge message (`action: "select-landmark"`, `id`, `position`) so
  the shell tints the verdict "corrected" (`review-ui-interactions.md`). Declare
  `linked_views: true` in the manifest.

Canvas 2D only — no `eval`, no external origins (CSP + G5 clean). All slice data is
present at load; the iframe cannot fetch more (`connect-src 'none'`).
