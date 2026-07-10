---
name: microct-review-artifact
description: Use to generate a self-contained interactive HTML review site for confirming micro-CT / 3D-scan geometry — a read-only 3D scene showing landmarks and measurement lines, per-bone 2D ortho (MPR) editors for repositioning, live metric recompute, and a verdict/export form. Reach for it whenever auto-proposed 3D measurements need human confirmation or correction in a browser, especially offline / file:// / mobile.
---

# Interactive micro-CT review artifact

Automated 3D measurements are **auto-proposed, not final** — they need a human
to confirm or correct them. This skill builds the review surface: a static,
self-contained HTML site a domain expert opens in a browser (including offline
and on a phone) to inspect what was measured, fix what is wrong, and sign off.

**Leading word: confirm.** The artifact exists so a human confirms the research.
Every design choice serves that: show *how* each number was measured, let the
expert correct a landmark and watch the number update, and capture their
verdict.

## Load the methodology
Pair with `microct-3d-analysis` (the review loop that produces the geometry
this site displays) and the concrete protocol skill (e.g.
`microct-oa-mouse-knee`, whose `build_review_site()` emits this artifact).

## What the site must contain
- **Read-only 3D scene** — bone surfaces (translucent), landmark points
  (hover to identify), and **measurement lines drawn as you measured them**
  (each line labeled with its mm value and what it represents). The legend is
  click-to-toggle so the reviewer can cross items out. This view shows *how*,
  it does not edit.
- **Per-bone 2D ortho (MPR) editors** — coronal / sagittal / axial slices with
  a linked crosshair; Place-mode to reposition a landmark; a **live mini-3D**
  that updates as the point moves so the reviewer sees the 3D consequence of a
  2D edit; Save / Cancel provisional placement; metrics recompute live.
- **Measurements panel** — each value with its ground-truth gate status, and
  honesty surfaces (confidence flags, e.g. a low-margin femur/tibia call).
- **Review panel** — per-item verdicts, notes, overall verdict, Export JSON.
- **Connect everything** — 3D, MPR, metrics, and verdicts share state (a
  localStorage store keyed by sample_id); a change in one view reflects in all.

## Honesty surfaces (do not hide the uncertainty)
The site is where the pipeline's limits become the reviewer's job. Surface them:
low-confidence identity calls, landmarks that only pass on distance not on clean
placement, a criss-cross between two bones' lines (a faithful sign of inter-bone
rotational mismatch when the protocol measures each bone in its own frame — keep
it, label it). The reviewer confirms *with* these flags visible, not despite
them.

## Delivery constraints (learned the hard way)
- **Multi-file folder, cross-linked** (index + per-bone pages + shared css/js +
  data), delivered as one zip. Full resolution; each page loads only its data.
- **file:// safe** — browsers block `fetch()` of local files under file:// CORS.
  Ship data as `.js` files that assign to `window` globals, loaded via
  `<script>` tags — NOT as `.json` fetched at runtime.
- **No build step, no runtime** — static HTML/CSS/JS, Plotly from CDN (vendor a
  copy for true offline). There is usually no node/deno in the sandbox, so
  validate the JS **statically** (balanced braces, all referenced element IDs
  present on the page) and render a preview to confirm layout.
- **Kaleido/Chrome static export of Plotly needs a browser** the sandbox lacks;
  render self-check images with matplotlib 3D instead, and deliver Plotly as the
  interactive layer for the human.

## Mobile / touch (required)
- **Tabs, never a scrolling page.** Bottom tab bar (thumb reach); each pane is
  exactly one viewport (`height:100dvh`, `overflow:hidden` on body).
- **≥44px touch targets** — every button, chip, and slider thumb. (Range
  sliders especially — the default thumb is far under 44px.)
- **Unified Pointer Events** for tap-to-place (works for mouse + touch);
  `touch-action:none` on the canvas so pan/pinch/rotate don't scroll the page.
- **Viewport meta** + **light default with a dark toggle** via CSS custom
  properties.
- **Marker halo** — colored ring + white halo so a landmark is visible against
  both light bone and dark background (a bare white marker vanishes on bone).

## Generating it
The packaged `build_review_site(seg, fem, tib, out_dir, gp_mask, sample_id,
slice_step, mesh_step)` (in `bonemorph`) emits the full folder. `slice_step=1`
is full resolution; `mesh_step` controls surface decimation. The full UI
contract lives in the package's `REVIEW_UI_SPEC.md`.

## The end state
Auto-propose + human review — never "fully automatic". The artifact's job is to
make the proposal legible enough that a human can confirm it or fix it in a few
taps, then export a verdict that becomes the record.
