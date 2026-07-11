---
name: review-artifact-builder
description: >-
  Methodology for building a review artifact — the self-contained, offline,
  mobile-friendly HTML component a human uses to confirm, correct, or reject a
  protocol phase's auto-proposed results inside the dashboard's sandboxed
  iframe. Use whenever a protocol has a review-artifact phase: it composes this
  method (the contract, the trust boundary, the build loop, the layout patterns)
  with a protocol-specific resource that supplies the rows and views. Covers the
  values-table pattern and the interactive 3D pattern (three.js, incl. the
  linked orthogonal slice scrubber), the REVIEW_MANIFEST/REVIEW_DATA data
  contract, and the G1-G9 linter.
---

# Review Artifact Builder

**Leading word: confirm.** Automated results are auto-*proposed*, never final.
The review artifact is where a human confirms, corrects, or rejects them. Your
job is to package a phase's vetted outputs into a component that makes that
judgment fast and honest.

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

The contract and the linter are **identical for every protocol**. Only the rows
and views are protocol-specific. Emit exactly one self-contained file:

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
`<script>` blocks. Ship data as `window.*` globals. **Small data** (a values table with a few
rows) can be a static object/array literal assigned directly. **Large data**
(geometry meshes, full measurement arrays) goes via serve-time injection: assign
a sentinel placeholder `window.<NAME> = "__REVIEW_INJECT:<NAME>__";` and
declare the source in the manifest's `data_sources` — the server fills the
placeholder with the hashed artifact at serve time, so the browser receives the
same self-contained document either way. The linter parses the manifest
statically and never executes it — computed assignments are invisible to it.
Never `fetch` local JSON; `file://` and the CSP block it.

```js
window.REVIEW_MANIFEST = {
  sample_id: "<the task id from your prompt>",   // the run id, not the specimen label
  produced_from: { measurement: "<source-file>@<sha256>" },  // hashed by G8
  verdict_schema: "review-verdict/1",
  data_globals: ["REVIEW_MANIFEST", "REVIEW_DATA"],
  // When using serve-time injection for large data:
  data_sources: {
    REVIEW_DATA: { artifact: "<path-under-artifacts>", transform: "identity" }
  }
};
```

`produced_from` must point at the actual source-of-truth file the numbers came
from, hashed — the linter (G8) recomputes it to prove the site describes *this*
run, not a stale or swapped one.

## The build loop — the worker owns the template

The review artifact is worker-authored per run. The template is a starting
pattern, not a locked form — you have authority to adjust the layout, add
views, and customize the display so it reads well for the reviewer. The loop:

1. **Read the approved outputs** from the earlier phases (the vetted numbers,
   masks, landmark positions). The upstream measurement phase already gated the
   science; this phase does **no science** — it packages.
2. **Declare the data contract.** For large data (geometry, full measurement
   arrays), add `data_sources` entries in the manifest pointing at the artifact
   files and write sentinel placeholders
   (`window.<NAME> = "__REVIEW_INJECT:<NAME>__";`). Small data (a few
   values-table rows) can be inlined as static literals. Either way,
   `produced_from` must name each source file with its sha256 — G8 enforces
   provenance.
3. **Generate `index.html`** — the layout the protocol's review resource
   specifies, with CSS and app logic inlined. Data globals are either static
   literals or sentinel placeholders; the server fills placeholders with the
   hashed artifact at serve time.
4. **Inspect it.** Does it render? Does the layout work? Are the right values
   showing? While iterating on layout and render, temporarily inline real data
   as static literals and open via `file://` to spot-check. Before final
   submission, swap to sentinel placeholders
   (see `resources/review-ui-testing.md`).
5. **Iterate** until it reads well. You check quality; the linter checks
   structure. Both must pass.
6. **Run the linter.** The harness runs it automatically at the gate, but run
   it yourself while authoring:
   `tsx src/review-site/cli.ts check-review-site <site-dir> ...`
   (see `resources/review-ui-testing.md` — there is no `labrat` bin yet).

## Generic vs. protocol-specific

| Generic (this skill) | Protocol-specific (the protocol's `resources/review-artifact.md`) |
|---|---|
| The contract (manifest/data globals, single inlined file) | Which values become rows; their labels, units, honesty flags |
| The G1-G9 linter and how to pass it | Which views — values table, or 3D scene + linked slice scrubber, declared as `review_layout`/`required_views` |
| The trust boundary (exports nothing) | The layout, and how phase outputs map to `REVIEW_DATA` |
| The layout *patterns* (single-pane, multi-pane, 3D) | Which pattern this protocol uses |
| Data injection (`data_sources`, sentinel placeholders) | Which artifacts map to which globals; the `produced_from` entries |

The data contract must align end-to-end: what the earlier phases output is what
`REVIEW_DATA` consumes. When authoring the protocol's resource, map each output
field to a review item explicitly.

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
- `resources/review-ui-threejs-and-layout.md` — for 3D reviews: three.js scene
  structure, camera/raycasting, one-WebGL-context viewport management, tabs (not
  scroll), mobile, the data contract shapes, and the **orthogonal slice scrubber**
  (the injected downsampled-volume contract + the pane/slider/crosshair/linking
  pattern the G9 gate checks).
- `resources/review-ui-testing.md` — the linter (G1-G8), the CLI, validating
  without the dashboard, the CSP contract, the authoring checklist.

Working references: `microct-oa-mouse-knee`'s `resources/review-artifact.md`
(the values-table pattern), the fully-inlined fixture at
`validation/fixtures/review-site/index.html`, and the injection fixture at
`validation/fixtures/review-site-injected/` (sentinel placeholders +
`data_sources`). Mirror their structure.
