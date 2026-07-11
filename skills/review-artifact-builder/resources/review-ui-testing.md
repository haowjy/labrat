# Review UI — Testing & Validation

Load when writing or validating a review-artifact phase. This resource
covers how to use the LabRat tooling to check that a review artifact
meets the contract.

## The review-site linter

The harness runs deterministic static checks (G1–G9) on every review artifact
before the gate reviewer sees it. G1–G8 apply to every artifact; **G9 applies
only to spatial reviews** (those that declare `review_layout:
"spatial-multipane"`). The linter never executes the artifact's JavaScript — it
parses and validates statically.

### CLI for hand-testing

```bash
tsx src/review-site/cli.ts check-review-site <site-dir> \
  [--results <path>]           # measurement file path for the G8 hash check (alternative to --measurements-root)
  [--measurements-root <dir>]  # dir containing measurement files for G8 hash check
  [--cdn-allowlist a,b]        # allowed external origins for G6
  [--sample-id <id>]           # expected task id for G8 provenance check
```

(There is no `labrat` bin wired yet — invoke the CLI via `tsx` as above.
`labrat check-review-site` is the intended alias once packaged.)

Exits 0 (all gates pass), 1 (at least one gate failed), or 2 (linter
error). Prints the JSON findings report to stdout.

**Use this while authoring the review artifact.** Run it after every
change to catch structural violations before the harness runs.

### The 9 gates

| Gate | What it checks | Common failure |
|------|---------------|----------------|
| G1 | `index.html` exists and is non-empty | Missing file |
| G2 | Self-contained: no `<script src>` or `<link href>` to external files, no absolute/`..`/`file://` refs | Forgot to inline a script |
| G3 | `window.REVIEW_MANIFEST` assigned as a static object literal; every `data_globals` entry exists non-empty. When `data_sources` is present, each source must appear in `data_globals` and each sentinel placeholder must have a matching `data_sources` entry, with a `produced_from` hash for its artifact | Manifest computed dynamically instead of statically; `data_sources` entry missing from `data_globals`; sentinel placeholder with no `data_sources` entry |
| G4 | All JS parses; every `getElementById(id)` target exists in the page | Typo in element ID |
| G5 | No exfil sinks: navigation, download, WebRTC, dynamic code (`eval`, `Function`, `import()`), inline `on*` handlers. Network sinks (fetch/XHR/WebSocket) downgrade to warning only if CSP confirms `connect-src 'none'` | Plotly's bundle uses `eval` internally |
| G6 | Every external origin ⊆ `cdn_allowlist` from `protocol.yaml` | Referencing a CDN not in the allowlist |
| G7 | `verdict_schema` field present in manifest | Missing schema declaration |
| G8 | Provenance: `sample_id` matches harness task id; every `produced_from` entry's hash matches actual file on disk (iterates all keys, not just `measurement`) | Stale hash after regeneration; `data_sources` artifact with no `produced_from` hash |
| G9 | *(spatial reviews only, when `review_layout: "spatial-multipane"`)* required views present: every `required_views` entry has a `[data-review-view]` element; each `slice-*` view has a `[data-review-slice-canvas]` + `<input type="range" data-review-slice-slider>`; a slice-data global (`REVIEW_VOLUME`/`REVIEW_SLICES`) is declared with a `produced_from` hash; `linked_views: true` with landmark data present | Shipped the 3D mesh but no linked orthogonal slice scrubber; a slice pane with no slider; slice-data global not declared |

**G5 is the strictest.** It hard-fails on `eval`, `Function()`,
`new Function()`, `import()`, and inline `on*` handlers. This rules
out libraries that use `eval` internally (Plotly). If you get a G5
failure, the library cannot be used — switch to one that doesn't
eval (three.js passes clean).

**G8 is the provenance check.** It ensures the review artifact was built
from the actual data, not from stale or swapped data. Every
`produced_from` entry must be `"<path>@<sha256>"` format, and each hash
must match the file on disk. With serve-time injection, G8 is strictly
stronger: the server also verifies the hash at splice time, so
provenance is guaranteed by construction rather than by the worker's
transcription accuracy.

**G9 is the spatial-layout check.** It fires only when the manifest declares
`review_layout: "spatial-multipane"` — a `values-table` review omits that field
and G9 is N/A (auto-pass), so single-pane protocols are unaffected. When it fires,
it statically asserts the *ingredients* of the linked slice scrubber (it can't
execute the wiring, so it checks the structural markers the pattern prescribes in
`review-ui-threejs-and-layout.md`):

- every `required_views` entry has a matching `[data-review-view="<id>"]` element;
- each `slice-<axis>` view has an `<input type="range" data-review-slice-slider="<axis>">`
  and a `[data-review-slice-canvas="<axis>"]` (axis ∈ axial/coronal/sagittal);
- a slice-data global (`REVIEW_VOLUME` or `REVIEW_SLICES`) is in `data_globals`
  with a `data_sources` entry + `produced_from` hash (or a non-empty static literal);
- `linked_views: true` and landmark data is present (in `REVIEW_VOLUME.landmarks`
  or the geometry global).

Pass = all present. Fail = a declared view with no element, a slice view missing
its slider or canvas, or no slice-data source — the detail names the missing piece.
G9 proves the scrubber *exists and is wired to real data*; that the linking
*behaves* correctly is the worker's `file://` self-check and the human reviewer's
job, not the static linter's.

### What the report looks like

```json
{
  "ok": true,
  "siteDir": "artifacts/review-site",
  "fidelity": "verified",
  "findings": [
    { "gate": "G1", "ok": true, "detail": "" },
    { "gate": "G2", "ok": true, "detail": "" },
    ...
  ]
}
```

Passing gates always return `"detail": ""`. A failing gate's detail
carries the problem text, e.g.
`{ "gate": "G1", "ok": false, "detail": "index.html missing at <dir>" }`.

## Testing without the dashboard

The dashboard serves review artifacts at
`GET /api/tasks/:id/review-site/*path` with the full CSP headers and
sandboxed iframe. But the development sandbox SIGTERMs port binds, so
you can't run the dashboard locally.

**What you can do:**

1. **Run the CLI linter** — catches G1-G8 violations statically. This
   is the primary validation tool during authoring.

2. **Open `index.html` via `file://`** — for visual spot-checking only.
   This is unsandboxed (no CSP, no iframe isolation), so it doesn't
   test the trust boundary. Use it to verify that the 3D scene renders,
   the layout works, and interactions function.

   **Sentinel templates and `file://`:** a template that uses injection
   placeholders (`window.<NAME> = "__REVIEW_INJECT:<NAME>__";`) will
   assign sentinel *strings* to its data globals when opened via
   `file://`. The render will be broken (the app code tries to read
   objects/arrays, not strings). This is expected. The authoring
   workflow:
   - While iterating on render and layout, temporarily inline real data
     as static literals so `file://` shows a working render.
   - Before final submission, swap the data literals to sentinel
     placeholders and add the corresponding `data_sources` entries.
   - Compute `produced_from` hashes with a shell command (e.g.
     `sha256sum <file>`) -- never hand-copy data bytes or hashes.
   - Run the CLI linter on the final sentinel template. The linter
     validates the structural contract; the server handles the fill.

3. **Check the canonical fixtures:**
   - `validation/fixtures/review-site/index.html` — fully inlined
     (no injection), passes all 8 gates clean.
   - `validation/fixtures/review-site-injected/` — sentinel
     placeholders + `data_sources`, passes all 8 gates clean.
   Compare your artifact against their structure.

4. **Check the three.js reference** — the file at
   `tasks/task-2026-07-10-008/artifacts/review-site/index.html` is a
   real task artifact with full three.js 3D landmark review (2759L,
   real femur/tibia geometry, 8 landmarks, raycasting, postMessage
   bridge). Use it as the reference for 3D review artifacts.

## What the harness does automatically

In a real run, you don't call the linter manually. The harness
(`review-artifact-check.ts`) triggers `checkReviewSite` automatically
for any phase whose `outputs` include `review-site` or `review-site/*`.
It runs with authoritative inputs:

- `expectedSampleId: taskId` (from the running task)
- `requireFidelity: true` (G8 hash check is mandatory)
- The phase's `cdn_allowlist` from `protocol.yaml`
- The exact served CSP from `csp.ts`

The report is written to
`review/verification/<phase>/check_review_site.json` for the gate
reviewer to read. The gate reviewer gates on the report — it does not
re-run the linter.

## The CSP contract

The CSP is defined in one place (`src/review-site/csp.ts`) and used by
both the dashboard route and the G5 gate — they cannot drift. The built
policy:

```
default-src 'self';
script-src 'self' 'unsafe-inline' [+cdn_allowlist];
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
connect-src 'none';
webrtc 'block';
frame-ancestors 'self';
base-uri 'none';
form-action 'none';
object-src 'none'
```

`connect-src 'none'` blocks all network requests from the iframe
(fetch, XHR, WebSocket, EventSource, beacon). Combined with the
opaque-origin sandbox (`allow-scripts` only, no `allow-same-origin`),
the iframe structurally cannot exfiltrate data or write verdicts.

## Checklist for review artifact authors

Before submitting a review-artifact phase resource:

- [ ] Run `tsx src/review-site/cli.ts check-review-site <site-dir>` — all 8 gates pass
- [ ] Open via `file://` — 3D scene renders, interactions work (inline
      real data temporarily for this check; sentinel templates show
      broken renders via `file://`, which is expected)
- [ ] Check mobile layout — touch targets >=44px, tabs at thumb reach
- [ ] `window.REVIEW_MANIFEST` is a static literal (not computed)
- [ ] Every `produced_from` hash matches the actual file (use
      `sha256sum`, never hand-copy)
- [ ] No `eval`, `Function()`, `import()`, or inline `on*` handlers
- [ ] All data is either inlined as `<script>` globals or declared via
      `data_sources` + sentinel placeholders — never fetched at runtime
- [ ] If using injection: each `data_sources` entry names an artifact
      that exists, appears in `data_globals`, and has a matching
      `produced_from` hash
- [ ] Total document size under 5MB (accounts for all data, including
      what the server will inject)
