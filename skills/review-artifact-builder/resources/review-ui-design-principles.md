# Review UI — Design Principles

These principles govern the review component — the content inside the
shell's iframe. The shell (sidebar, phase tabs, task navigation) is
dashboard code, not the skill's concern. The skill designs what the
reviewer sees and interacts with for one phase.

## The review component is the task's evidence

The system is currently task-scoped: one review site per task, served at
`/api/tasks/:id/review-site/index.html`. The shell loads it into an iframe.
The component shows the task's evidence, lets the reviewer interact with it,
and communicates verdict-relevant events back to the shell via the postMessage
bridge.

The component does not know about other phases, the sidebar, or task
navigation. It shows evidence and supports interaction. The shell handles
everything else.

## Evidence fills the viewport

The **evidence banner** (decisive numbers, flags, states) occupies a fixed
strip at the top of every view — it frames the spatial evidence below.
The 3D viewer and slice panes fill the remaining space. Don't shrink the
spatial views to make room for data tables; don't hide the banner behind
a tab.

**For a 3D scene with multiple views, use fixed-viewport layout, not a
scrolling page.** The full surface is one viewport (`height: 100dvh`,
`overflow: hidden` on body): evidence banner at top, spatial views in the
middle, tour bar at bottom. Secondary content (values table,
interpretation) lives in a tab. The evidence banner and spatial views
must never scroll off — a reviewer who has scrolled the evidence out of
view has lost the primary evidence. This also respects the one-WebGL-context
constraint (see `review-ui-threejs-and-layout.md`, which owns the layout
mechanics). Interaction controls live in a fixed zone or their own tab,
sized around the scene.

When the content is small and single-pane (a values table, a single
plot), everything fits in one viewport without tabs. If it runs a little
taller than the viewport, a short scroll is fine — but that is the simple
single-column case only, never the multi-view 3D case above.

## Layout is protocol-specific

The phase resource specifies what layout the review component needs.
There is no one-size-fits-all review layout.

**Single pane** — one primary view (a plot, a values table, a single
image). The simplest case. Evidence + interaction + notes in one viewport.

**Multi-pane** — a primary 3D scene with optional secondary views behind
tabs. For micro-CT: the 3D scene is the hero; orthogonal 2D slices (axial,
coronal, sagittal) live behind an "Advanced slices" tab when shipped, and
hidden entirely when no volume is exported. When present they link —
selecting a landmark (or a tour step) scrolls the slices to that position and
centers the crosshair. The surface is read-only: rotate, examine, tour, read.

**On mobile:** multi-pane collapses to preview panels. Show preview
thumbnails of the panes (the screen can't fit 4 usable interactive
views). Tap any preview to go fullscreen for actual interaction. This
isn't a mobile-only pattern — on desktop too, the reviewer should be
able to expand any pane to fill the view. Previews give the overview;
fullscreen gives the interaction.

The protocol decides: how many panes, what each pane shows, which panes
link to each other.

## Data flows from phases into the template

The review component consumes what earlier phases produced. The data
contract must align end-to-end:

```
measurement phase outputs    →    worker extracts / prepares    →    manifest declares data_sources
  results.json                      (already JSON)                    artifact: "results.json"
  labels.nii.gz                     → mesh extraction → geometry.json artifact: "geometry.json"
  landmarks.json                    (already JSON)                    artifact: "landmarks.json"
```

Mesh extraction from binary formats (e.g. `.nii.gz` to JSON geometry) is
a worker step that produces a JSON artifact on disk. The server's
`data_sources` injection reads that JSON file verbatim (`transform:
"identity"`) -- the server does no format conversion.

When writing the protocol skill set, explicitly map each earlier phase's
outputs to what the review template needs. If the measurement phase
outputs `results.json` with fields `{femur_length, tibia_width, ...}`,
the review template's evidence globals must expect exactly those
fields. If the segmentation phase outputs `labels.nii.gz`, the review
template needs the mesh extraction step to turn it into geometry.

**How data enters the template:** the manifest declares `data_sources`
entries mapping artifact files to `window` globals. The worker writes
sentinel placeholders (`window.<NAME> = "__REVIEW_INJECT:<NAME>__";`)
for each injected global. The dashboard server fills each placeholder
with the hashed artifact at serve time — the browser receives a
self-contained document identical to a fully-inlined template. Small data
(a few values-table rows) can still be inlined as static literals. The
worker never transcribes large data; it writes only the render code and
layout.

The `produced_from` hashes in `REVIEW_MANIFEST` (checked by gate G8)
enforce provenance — the review artifact must prove it was built from the
actual data, not from stale or swapped values.

## The review-artifact phase owns the display

Building the review artifact is its own phase. It runs after earlier
phases produce measurements and the reviewer approves them. This phase
loads two things:

- A **`review-artifact-builder` methodology skill** — reusable across
  protocols. Teaches how to build an evidence-led review component: build
  `REVIEW_EVIDENCE` from measurement outputs, generate the HTML with
  evidence banner + spatial views + guided tour, render and inspect, run
  the linter (G1–G9).
- The **protocol's `resources/review-artifact.md`** — protocol-specific.
  Maps this protocol's measurement outputs to the evidence: which ratios
  are decisive, which landmarks carry them, what operational rules to
  state, what views to show.

The worker in this phase has authority to edit the template — adjust the
layout, add views, customize the data display. The template is a starting
pattern, not a locked-down form. The worker:

1. Reads the approved measurement outputs from earlier phases
2. Builds `REVIEW_EVIDENCE` — decisive ratios with cutoffs/states/flags,
   measurement lines, per-landmark operational rules, interpretation
3. Declares `data_sources` for large data (geometry, volume) with
   `produced_from` hashes; inlines `REVIEW_EVIDENCE` as a static literal
4. Generates the HTML: evidence banner, spatial views with measurement
   overlays, guided tour, values/interpretation tab
5. Inspects — evidence banner shows the right flags? Measurement lines
   connect the right landmarks? Tour walks flagged items first?
6. Iterates if it doesn't read well
7. Runs the linter to validate the structural contract

The linter checks structure. The worker checks quality. Both must pass
before the reviewer sees it.

## The verdict state machine

The verdict widget is part of the trusted shell (VerdictPanel), not the
review component. But the component drives state transitions through the
bridge.

```
                    ┌─────────────────────┐
                    │   Pass (default)    │
                    └──────────┬──────────┘
                               │ reviewer adjusts something
                               │ (bridge: interaction message)
                               ▼
                    ┌─────────────────────┐
                    │    Corrected        │
                    └──────────┬──────────┘
                               │
                               │ reviewer clicks Fail
                               ▼
                    ┌─────────────────────┐
                    │       Fail          │
                    └─────────────────────┘
```

- **Pass** is the default state. The reviewer views the evidence and, if
  satisfied, submits pass.
- **Corrected** — auto-triggered when the reviewer adjusts something
  (moves a landmark, changes a threshold). The interaction itself is the
  judgment. There is currently no way to revert an adjustment once made —
  reverting is a planned shell-to-iframe `reset` message, not yet built
  (see `review-ui-interactions.md`).
- **Fail** — always available. Overrides corrected. If the evidence is
  wrong and the reviewer doesn't want to fix it, they fail the phase.

Free text notes accompany every verdict state. The reviewer writes what
they observed, what they adjusted, or why they failed.

## The artifact is the answer; everything else is depth

The reviewer opens a phase and sees the evidence — not metadata, not
provenance hashes, not the gate's prose. The artifact fills the viewport.
Verdict controls sit below the fold. The review chain and measurement
tables collapse behind disclosure: available on tap, invisible by default.

This hierarchy applies at every layer:

**The shell already puts the artifact first.** The iframe is the largest
element; verdict, review chain, and evidence panels follow below the fold
in collapsed `<details>`. The component doesn't need to replicate this
hierarchy — it should fill its viewport with evidence, not chrome.

**Inside the artifact**, a "Hide labels" toggle strips provenance paths,
source hashes, badge pills, and confidence strings. What remains is the
decisive content: claim statements, key numbers, state indicators, and
excerpts. The templates in `assets/templates/` include this toggle;
preserve it when authoring.

**On phones**, build mobile-first: single scrolling column is the base.
Side-by-side split is a desktop enhancement. Sections need clear visual
boundaries (distinct backgrounds, borders, spacing) so they read as
separate panels, not a wall of similar-looking cards. Touch targets are
44px minimum.

## Interaction controls are separate from evidence

Interaction controls (sliders, parameter adjustments, threshold editors)
live in their own zone, below or beside the evidence panels. They are
not overlaid on the evidence.

The separation keeps the evidence view clean for initial inspection. The
reviewer looks first, then scrolls to or reaches for the controls when
they want to probe. Overlaying controls on the 3D scene clutters the
initial impression and biases toward adjusting before observing.

Exception: camera controls (rotate, pan, zoom) are part of the evidence
interaction and live on the canvas — they're viewing, not adjusting.

## The 3D review methodology

For protocols with 3D data, the **3D scene is the review surface**, and the
review component supports a specific inspection loop:

1. **See the 3D scene.** Full scene with all structures, named landmarks,
   and measurement lines with their values and the derived ratio. Orbit it
   (drag rotates the camera) — get the overall picture, does it look right?
2. **Walk the guided tour.** Step through each landmark (Prev/Next, "Step N
   of M"), lowest confidence first, with its operational rule. The camera
   frames each landmark; verify the placement against the rule.
3. **Read the decisive evidence.** The evidence banner leads with the
   result — big ratio, the cutoff it crosses, the signed delta, and a
   labelled review/confidence status; the Values tab holds the full table.
   The artifact is **read-only**: the reviewer verifies each placement
   against its operational rule and, if the evidence is wrong, comments and
   marks the phase for revision through the shell rather than editing
   landmarks in-scene (in-scene editing recomputes the line/ratio while the
   banner and Values stay put — an internally inconsistent review surface).
4. **Drill into slices only if needed.** When the optional Advanced-slices
   tab is shipped, expand the orthogonal slices (axial, coronal, sagittal)
   to confirm slice-by-slice what a clean 3D surface can hide — a bled label
   or an off-by-a-slice landmark. Then return to 3D.

This loop is the primary methodology for any 3D review (micro-CT, MRI, any
volumetric data). The 3D scene stands on its own; slices are optional
secondary evidence, linked to the scene when present.

**The 3D scene is required and gated; slices are optional.** A spatial review
must ship a **real three.js scene** — OrbitControls (drag rotates), mesh
rendering, named landmark markers, and measurement overlays — not a static
painted canvas (the exact defect p80 found). Declare the layout in the
manifest, and the **G9 linter gate enforces it** (see `review-ui-testing.md`):

```js
review_layout: "spatial-multipane",
required_views: ["scene3d"],          // 3D is the hero; slices optional
// When the downsampled volume is exported, add the optional slices:
// required_views: [..., "slice-axial", "slice-coronal", "slice-sagittal"],
// linked_views: true,
```

The buildable pattern — the inlined three.js scene, the measurement overlays,
the guided tour, and (optional) the injected downsampled-volume slice
scrubber — lives in `review-ui-threejs-and-layout.md`. A single-pane
`values-table` review omits these fields and G9 does not apply. If the
protocol's review is spatial, the resource declares `required_views` and the
gate makes the **3D scene** non-skippable (a painted canvas fails G9); the
slice scrubber, when declared, must be complete and linked.

## What the component communicates

The component talks to the shell only through the postMessage bridge —
3 message types out (`ready`, `interaction`, `metrics-updated`). A
shell-to-iframe direction (`highlight`, `reset`) is planned but not yet
built — the shell currently never postMessages to the iframe. The
component never reads or writes the verdict and never knows about other
phases. The full contract — payloads and trust invariants — lives in
`review-ui-interactions.md`.
