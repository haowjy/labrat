---
name: review-artifact-builder
description: >-
  Methodology for building a review artifact — the self-contained, offline,
  mobile-friendly HTML component a human uses to confirm, correct, or reject a
  protocol phase's auto-proposed results inside the dashboard's sandboxed
  iframe. Use whenever a protocol has a review-artifact phase: it composes this
  method (the contract, the trust boundary, the build loop, the layout patterns)
  with a protocol-specific resource that supplies the rows and views. Covers the
  values-table pattern and the 3D-first interactive pattern (inlined three.js +
  OrbitControls as the primary view, with an optional linked orthogonal slice
  scrubber), the REVIEW_MANIFEST/REVIEW_EVIDENCE
  data contract (and the legacy REVIEW_DATA pattern for values-table-only
  protocols), and the G1-G9 linter.
---

# Review Artifact Builder

**Leading word: verify.** Automated results are auto-*proposed*, never final.
The review artifact is where a human verifies the call — not explores a scene.
Your job is to package a phase's vetted outputs into an **evidence-led**
component: the decisive numbers lead, the spatial views serve as drill-down
evidence, and a guided tour walks the reviewer through each flagged item with
its operational rule. The reviewer verifies the call in seconds, then drills
into spatial detail only where the evidence demands it.

## What you build (and what you don't)

You build the **content inside one phase's iframe** — the evidence the reviewer
looks at and the controls they interact with. You do **not** build the shell
(sidebar, phase tabs, task navigation) or the verdict widget — those are
trusted dashboard code. The artifact shows evidence and communicates
verdict-relevant events to the shell; the shell owns the verdict.

The artifact **exports nothing**. It never writes the verdict, never navigates,
never phones home. Verdict capture and export live in the trusted shell. An
in-iframe export/download/navigation sink is a linter hard-fail (G5), by design
— it's the structural guarantee that a sandboxed review page can't exfiltrate.

## The generic contract

The contract and the linter are **identical for every protocol**. Only the
evidence, views, and operational rules are protocol-specific. Emit exactly one
self-contained file:

```
review-site/
  index.html   inline <style>, then inline <script> data blocks
               (window.REVIEW_MANIFEST first; then data globals — either
               static literals or sentinel placeholders for injection),
               then the inline app <script> (renders, holds verdict state in
               memory — no export/download/navigation)
```

**Single inlined document — no separate files.** The dashboard embeds the site
in an opaque-origin sandboxed iframe that silently drops every external
subresource: a `<script src>` or `<link href>` to a separate file renders the
page blank. So inline everything — CSS in `<style>`, data and app logic in
`<script>` blocks. Ship data as `window.*` globals. **Small data** (evidence
ratios, flags, landmark metadata) is a static object/array literal assigned
directly — specifically `REVIEW_EVIDENCE`. **Large data** (geometry meshes,
volume slices) goes via serve-time injection: assign a sentinel placeholder
`window.<NAME> = "__REVIEW_INJECT:<NAME>__";` and declare the source in the
manifest's `data_sources` — the server fills the placeholder with the hashed
artifact at serve time. The linter parses the manifest statically and never
executes it — computed assignments are invisible to it. Never `fetch` local
JSON; `file://` and the CSP block it.

```js
window.REVIEW_MANIFEST = {
  sample_id: "<the task id from your prompt>",   // the run id, not the specimen label
  produced_from: { measurement: "<source-file>@<sha256>" },  // hashed by G8
  verdict_schema: "review-verdict/1",
  data_globals: ["REVIEW_MANIFEST", "REVIEW_EVIDENCE", ...],
  // When using serve-time injection for large data:
  data_sources: {
    REVIEW_GEOMETRY: { artifact: "<path-under-artifacts>", transform: "identity" }
  }
};
```

`produced_from` must point at the actual source-of-truth file the numbers came
from, hashed — the linter (G8) recomputes it to prove the site describes *this*
run, not a stale or swapped one.

**`REVIEW_EVIDENCE`** is the new core global. It carries the decisive numbers
(ratios vs. cutoffs, states, flags), measurement-line geometry (which landmarks
connect), per-landmark operational rules and confidence, and the interpretation.
It is always inlined as a static literal — small enough that injection is
unnecessary. The full shape is in `resources/review-ui-threejs-and-layout.md`.

## The build loop — the worker owns the template

The review artifact is worker-authored per run. The template is a starting
pattern, not a locked form — you have authority to adjust the layout, add
views, and customize the display so it reads well for the reviewer. The loop:

1. **Read the approved outputs** from the earlier phases (the vetted numbers,
   masks, landmark positions, flags). The upstream measurement phase already
   gated the science; this phase does **no science** — it packages.
2. **Build `REVIEW_EVIDENCE`.** Extract the decisive ratios, their cutoffs,
   states, and flags from the measurement outputs. Map each ratio to its
   contributing landmarks and the measurement lines connecting them. Attach
   each landmark's operational rule from the protocol's resource. Build the
   interpretation. This is the domain content the reviewer verifies — get it
   right before touching the layout.
3. **Declare the data contract.** `REVIEW_EVIDENCE` is inlined as a static
   literal. Large data (geometry, volume) uses `data_sources` entries +
   sentinel placeholders. `produced_from` must name each source file with its
   sha256 — G8 enforces provenance.
4. **Generate `index.html`** — evidence banner at top, spatial views in the
   middle, tour bar at bottom, values/interpretation in a tab. CSS and app
   logic inlined. Data globals are either static literals or sentinel
   placeholders; the server fills placeholders at serve time.
5. **Inspect it.** Does the evidence banner show the right flags? Do the
   measurement lines connect the right landmarks? Does the tour walk through
   flagged items first with correct operational rules? Temporarily inline real
   data and open via `file://` to spot-check. Before final submission, swap
   large data to sentinel placeholders
   (see `resources/review-ui-testing.md`).
6. **Iterate** until it reads well. You check quality; the linter checks
   structure. Both must pass.
7. **Run the linter.** The harness runs it automatically at the gate, but run
   it yourself while authoring:
   `tsx src/review-site/cli.ts check-review-site <site-dir> ...`
   (see `resources/review-ui-testing.md` — there is no `labrat` bin yet).

## Generic vs. protocol-specific

| Generic (this skill) | Protocol-specific (the protocol's `resources/review-artifact.md`) |
|---|---|
| The contract (manifest/data globals, single inlined file) | Which ratios are decisive; their cutoffs, states, flags |
| The G1-G9 linter and how to pass it | Which views — values table, or a 3D-first scene (required) with optional linked slices, declared as `review_layout`/`required_views` |
| The trust boundary (exports nothing) | The layout, and how phase outputs map to `REVIEW_EVIDENCE` |
| The layout *patterns* (single-pane, multi-pane, 3D) | Which pattern this protocol uses |
| The evidence banner + guided tour patterns | Which landmarks carry which ratios; the operational rules per landmark |
| Data injection (`data_sources`, sentinel placeholders) | Which artifacts map to which globals; the `produced_from` entries |
| `REVIEW_EVIDENCE` shape (decisive, landmarks, interpretation) | The specific decisive entries, landmark rules, and interpretation logic |

The data contract must align end-to-end: what the earlier phases output is what
the review globals consume. For spatial reviews, `REVIEW_EVIDENCE` carries the
decisive ratios, flags, measurement lines, and per-landmark rules — all derived
from measurement outputs. For simple values-table reviews, `REVIEW_DATA` carries
the rows directly. When authoring the protocol's resource, map each output field
to a review item explicitly.

## Resources

Load by what the protocol's review needs:

- `resources/review-ui-design-principles.md` — evidence fills the viewport,
  protocol-specific layout (single/multi-pane, preview→fullscreen), the verdict
  state machine (pass → corrected → fail), the 3D review methodology
  (3D → slices → reorient → repeat). **Read first.**
- `resources/review-ui-information-hierarchy.md` — what the reviewer sees and in
  what order (evidence → question → conclusion-after → supporting → reference),
  honesty surfaces, anti-patterns.
- `resources/review-ui-interactions.md` — the verdict panel, the postMessage
  bridge (the full message-type contract and trust invariants live here),
  adjust→observe→confirm, linked views.
- `resources/review-ui-threejs-and-layout.md` — for 3D reviews: the inlined
  three.js scene (WebGLRenderer + OrbitControls — drag rotates the camera), mesh
  rendering, named landmark markers, measurement overlays + derived ratio, the
  guided tour, adjust-landmark mode, camera/raycasting, one-WebGL-context
  viewport management, mobile, the data contract shapes, and the **optional**
  orthogonal slice scrubber (behind an Advanced-slices tab — the injected
  downsampled-volume contract + the pane/slider/crosshair/linking pattern the G9
  gate checks only when a slice view is declared).
- `resources/review-ui-testing.md` — the linter (G1-G8), the CLI, validating
  without the dashboard, the CSP contract, the authoring checklist.

Working references: `microct-oa-mouse-knee`'s `resources/review-artifact.md`
(the values-table pattern), the fully-inlined fixture at
`validation/fixtures/review-site/index.html`, and the injection fixture at
`validation/fixtures/review-site-injected/` (sentinel placeholders +
`data_sources`). Mirror their structure.
