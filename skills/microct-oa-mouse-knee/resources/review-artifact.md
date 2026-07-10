# Review artifact — package the vetted OA indices into a review site

## Methodology

This phase does **no science**. The `measurement` phase already gated every
geometric index against `assets/ground_truth.json`; here the worker *packages*
those vetted numbers into a contract-conformant **review site** — a small,
self-contained, offline HTML page a human can open on a phone to
confirm/correct/reject each index (design `review-template.md` §1, invariants
I1-I7).

The CONTRACT and the gate linter are **generic** (identical for every
protocol's review site); only the rows are microct — the Tang OA geometric
indices (femoral W/L, tibial IIOC H/W, the distances they derive from). This is
the reusable **inlined values-review-site** pattern: a values table with an
honesty flag per index, a per-index verdict control, and a synchronous export.

Emit exactly ONE inlined file:

```
review-site/
  index.html   entry point (I1): a <style> block, then inline <script> data
               blocks (window.REVIEW_MANIFEST, window.REVIEW_DATA — data
               globals FIRST), then the inline app <script> (renders the
               table, holds verdict state in memory, exports JSON)
```

**Single document — no separate files.** An opaque-origin sandboxed iframe (how
the dashboard embeds the site) refuses every external subresource: a `<script
src>` or `<link href>` to a separate file is silently dropped and the page
renders blank (probe R4). So inline everything into `index.html` — CSS in
`<style>`, data and app logic in `<script>` blocks. The served CSP therefore
carries `script-src 'self' 'unsafe-inline'` so the inline blocks execute.

`validation/fixtures/review-site/index.html` in the repo is a hand-written,
contract-clean reference for this exact single-file structure — **mirror it**
(its `<style>`, its data-blocks-then-app-script order, its synchronous
`data:`-URL export). The fixture already renders the OA indices; you are
rebuilding it from THIS run's real numbers.

**Exact steps for the worker** (cwd IS the task dir; paths are literal):

1. `mkdir -p artifacts/review-site`.
2. Read the vetted numbers from `artifacts/measurements/results.json` (each
   entry's `name`, `value`, `unit`) and the phenotype calls / gate outcomes
   from `artifacts/measurements_final.json` (`fields.<name>.ground_truth_gate`,
   `phenotype_calls`). These are the rows to review. The core indices to show:
   `distal_femoral_length`, `distal_femoral_width`, `distal_femoral_ratio`
   (femoral W/L — the OA phenotype driver), `tibial_width`,
   `tibial_iioc_height`, `tibial_iioc_ratio` (tibial IIOC H/W).
3. Compute the fidelity hash of the source measurement so the site names the
   run it was built from (contract I3 / gate G8):
   ```
   sha256sum artifacts/measurements/results.json
   ```
   Take the 64-hex digest as `<HASH>`.
4. In `index.html`, add an inline `<script>` (BEFORE the app script) assigning
   `window.REVIEW_MANIFEST`. Set `sample_id` to the **task id from your prompt**
   (e.g. `task-2026-07-10-008`) — the gate verifies it against the harness's
   authoritative run id (G8/H1b), so it must be the task id, not the
   specimen label (`measurements_final.json`'s `sample_id`, e.g. `OA6-1RK`):
   ```js
   window.REVIEW_MANIFEST = {
     sample_id: "<the task id from your prompt>",
     produced_from: { measurement: "measurements/results.json@<HASH>" },
     verdict_schema: "review-verdict/1",
     data_globals: ["REVIEW_MANIFEST", "REVIEW_DATA"],
   };
   ```
   Assign every `window.*` global with a **static object/array literal** — the
   gate reads the manifest by parsing it statically and NEVER executes it, so
   computed/dynamic assignments are invisible to G3/G8. Point `produced_from`
   at `measurements/results.json` (the numbers' source), NOT
   `measurements_final.json` — the linter hashes exactly that file (G8).
5. In a second inline `<script>` (still before the app script) assign
   `window.REVIEW_DATA = { items: [...] }` — one item per index, each
   `{ id, label, value, unit, honesty_flag, honesty_detail }`:
   - `id`: the results.json `name` (e.g. `distal_femoral_ratio`).
   - `label`: a human name (e.g. "Distal femoral W/L ratio", "Tibial IIOC
     height/width").
   - `value`: the numeric `value` (round to a sensible precision, e.g. 3-4 sig
     figs); `unit`: the results.json `unit` (`mm`, or `ratio`/`dimensionless`).
   - `honesty_flag` + `honesty_detail`: a short, TRUTHFUL confidence note the
     reviewer needs — do not launder uncertainty. Set `clean` only when the
     index passed its ground-truth gate comfortably; otherwise flag it (e.g.
     `low-margin` when a ratio sits near the OA/normal threshold — femoral W/L
     normal `< 1.28` vs OA `> 1.30`, tibial IIOC H/W cutoff `0.28`; `out-of-gate`
     when `ground_truth_gate.pass` is false; `criss-cross` when landmark lines
     cross between bones). See the fixture's items for the shape.
6. Build the rest of `index.html` (I1): a `<meta viewport>`, an inline `<style>`
   block (self-contained — no external fonts/CDN), the values table, and an
   **Export verdict** button. No `<script src>`, no `<link href>`, no external
   origins (this phase's `cdn_allowlist` is `[]`) — everything inlined. Mobile:
   touch targets ≥44px, the whole review fits one viewport (I6).
7. In the final inline `<script>` (the app), read
   `window.REVIEW_MANIFEST`/`window.REVIEW_DATA` (never `fetch` local JSON —
   I3/G5), render the rows, hold per-row verdict state in memory, and Export a
   `verdict.json` via a **synchronous `data:`-URL download** in the button's
   click handler carrying `schema`, `sample_id`, `produced_from`, `overall`,
   `items[]`, `exported_at` (I5). Do NOT navigate the frame
   (`window.location`/`location.assign`/`window.open`), add inline `on*`
   handlers, or a `<meta refresh>` — the linter fails those (G5), and under
   `'unsafe-inline'` they are the exfil channels the CSP can't block. Mirror the
   fixture's app script.
8. **Match the fixture and re-read your file.** The gate is run by the harness,
   not by you: after you `record_phase`, the harness runs the deterministic
   `check_review_site` linter (G1-G8) with its own authoritative inputs and the
   reviewer gates on the result. If a gate fails, the gate feedback names the
   failing `Gx` and its detail — fix exactly that and the phase re-runs. Keep
   the site a **single inlined `index.html`** (no separate `<script src>`/`<link
   href>`, no `..`/absolute/`data:`/`blob:`/`javascript:` sources, no external
   origins beyond `cdn_allowlist`), ship data as inline `.js` globals (never
   `fetch`), no navigation/`on*`-handler/`<meta refresh>`, and keep the export
   button + `schema` string.
9. Call `record_phase` with phase `review-artifact` and a short summary.

## Expected outputs / how to verify

**Correct output looks like:** a single `artifacts/review-site/index.html`
exists; it is self-contained (everything inlined), renders the run's OA indices
as a values table with per-index honesty flags and verdict controls, and passes
the review-site linter G1-G8 clean.

**Reviewer READS the harness-run linter result (does NOT run it or rebuild the site):**

The gate for this phase is **structural + fidelity**, not scientific — do NOT
recompute the OA indices here (that was gated upstream against
`ground_truth.json`), and do NOT hand-run a linter or hand-type the policy. The
**harness** runs the deterministic `check_review_site` linter (G1-G8) with its
own authoritative inputs — the phase `cdn_allowlist`, the run's `artifacts/`
measurement root, and the task id as the expected `sample_id` — and writes the
report to:

```
review/verification/review-artifact/check_review_site.json
```

Read that file. It is `{ "ok": bool, "fidelity": "verified"|"unverified",
"findings": [{ "gate": "G1".."G8", "ok": bool, "detail": "…" }] }`.

The linter checks: **G1** `index.html` resolves and is non-empty; **G2** single
inlined document, self-contained — no separate-file `<script src>`/`<link href>`
(they blank in the sandbox), and every `href`/`src`/CSS `url()` a relative
in-folder file, no `..`, absolute, `file://`, `data:`/`blob:`/`javascript:` exec
source, or dangling ref; **G3** an inline `<script>` assigns
`window.REVIEW_MANIFEST` and every declared `window.*` data global is present
and non-empty (parsed **statically**, never executed); **G4** every inline
`<script>` is syntactically valid and each `getElementById` targets an id that
exists in the page; **G5** no exfil beyond the contract — no runtime data
loading (`fetch`/`XMLHttpRequest`/`sendBeacon`/`import()`), no navigation sink
(`window.location`/`location.assign`/`window.open` — CSP-unblockable), no inline
`on*` handler or `<meta refresh>`, no dynamic `eval`/`Function`; **G6** every
external origin is in this phase's `cdn_allowlist`; **G7** a verdict export
control exists and the verdict `schema` string is referenced; **G8** the
manifest's `sample_id` equals the run id and its `produced_from` hash matches
`measurements/results.json` on disk (the site describes THIS run, not a stale
one).

**Gate `pass` only if** `check_review_site.json` has `"ok": true` and every one
of the eight findings is `"ok": true`. If the file is missing or `"ok": false`,
FAIL and quote the failing findings' `detail` in your `submit_gate_decision`
feedback. (Note: the harness also enforces this as a deterministic floor — a
non-`ok` report fails the gate regardless — so passing a non-`ok` report is a
rubber stamp the harness's review-site floor catches directly, before the
monitor runs.)

**The boundary is not the linter alone — the linter is not redundant with the
CSP.** The linter is best-effort **structural + self-containment** analysis
(single inlined document, no external loads, faithful provenance). The enforcing
boundary is THREE cooperating parts. They divide the work: the **sandbox + CSP**
(Lane A) contain external subresource loads and network connections
(`connect-src 'none'`); the **linter** contains the DIRECT navigation and
inline-handler forms (G5) — because the site needs `script-src 'unsafe-inline'`
to render at all (R4), and under `'unsafe-inline'` the CSP no longer blocks
inline handlers, and `connect-src` never blocked navigation (`window.location =
evil`; no `navigate-to` directive); and the **trusted-but-verified producer**
(worker authors, gate reviewer re-checks) carries the residual. No layer alone
is the boundary. The linter's JS exfil detection (G5) is explicitly BEST-EFFORT,
not a proof — static analysis closes the direct literal forms of the known exfil
classes, not every obfuscation (aliasing, computed non-literal dispatch).

**Failure modes to flag:** any gate `ok: false` — e.g. `index.html` missing
(G1), a separate-file `<script src>`/absolute/`..` path (G2), a missing data
global (G3), a `getElementById` with no matching element (G4), a `fetch`/
navigation sink/inline `on*` handler/`<meta refresh>` (G5), an external origin
not in `cdn_allowlist` (G6), no export/`schema` surface (G7), or a
`produced_from` hash / `sample_id` that does not match the run (G8, a
stale/mismatched or swapped site).
