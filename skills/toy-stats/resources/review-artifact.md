# Review artifact — package the vetted numbers into a review site

## Methodology

This phase does **no science**. The `classify` and `regression` phases were
already gated against ground truth; here the worker *packages* those vetted
numbers into a contract-conformant **review site** — a small, self-contained,
offline HTML folder a human can open on a phone to confirm/correct/reject each
value (design `review-template.md` §1, invariants I1-I7).

The producer is protocol-specific (toy-stats emits a values table); the
CONTRACT and the gate linter are generic. Emit exactly ONE inlined file under
`artifacts/review-site/`:

```
review-site/
  index.html   entry point (I1): a <style> block, then inline <script> data
               blocks (window.REVIEW_MANIFEST, window.REVIEW_DATA — data
               globals FIRST), then the inline app <script> (renders the
               table, holds verdict state in memory, exports JSON)
```

**Single document — no separate files.** An opaque-origin sandboxed iframe
(how the dashboard embeds the site) refuses every external subresource: a
`<script src>` or `<link href>` to a separate file is silently dropped and the
page renders blank (probe R4). So inline everything into `index.html` — CSS in
`<style>`, data and app logic in `<script>` blocks. The served CSP therefore
carries `script-src 'self' 'unsafe-inline'` so the inline blocks execute.

`validation/fixtures/review-site/index.html` in the repo is a hand-written,
contract-clean reference for this exact single-file structure — mirror it.

**Exact steps for the worker** (cwd IS the task dir; paths are literal):

1. `mkdir -p artifacts/review-site`.
2. Read the vetted numbers from `artifacts/regression/regression.json` (slope,
   intercept, r_squared, n) and `artifacts/classify/classification.json`
   (n, threshold, accuracy). These are the rows to review.
3. Compute the fidelity hash of the source measurement so the site names the
   run it was built from (contract I3 / gate G8):
   ```
   sha256sum artifacts/regression/regression.json
   ```
   Take the 64-hex digest as `<HASH>`.
4. In `index.html`, add an inline `<script>` (BEFORE the app script) assigning
   `window.REVIEW_MANIFEST`. Set `sample_id` to the **task id from your prompt**
   (e.g. `task-2026-07-09-001`) — the gate verifies it against the harness's
   authoritative run id (G8/H1b), so it must be the task id, not a free-form
   label:
   ```js
   window.REVIEW_MANIFEST = {
     sample_id: "<the task id from your prompt>",
     produced_from: { measurement: "regression/regression.json@<HASH>" },
     verdict_schema: "review-verdict/1",
     data_globals: ["REVIEW_MANIFEST", "REVIEW_DATA"],
   };
   ```
   Assign every `window.*` global with a **static object/array literal** — the
   gate reads the manifest by parsing it statically and NEVER executes it, so
   computed/dynamic assignments are invisible to G3/G8.
5. In a second inline `<script>` (still before the app script) assign
   `window.REVIEW_DATA = { items: [...] }` — one item per vetted number, each
   `{ id, label, value, unit, honesty_flag, honesty_detail }` (see the
   fixture).
6. Build the rest of `index.html` (I1): a `<meta viewport>`, an inline
   `<style>` block (self-contained — no external fonts/CDN), a values table,
   and an **Export verdict** button. No `<script src>`, no `<link href>`, no
   external origins (this phase's `cdn_allowlist` is `[]`) — everything inlined.
7. In the final inline `<script>` (the app), read
   `window.REVIEW_MANIFEST`/`window.REVIEW_DATA` (never `fetch` local JSON —
   I3/G5), render the rows, hold per-row verdict state in memory, and Export a
   `verdict.json` via a **synchronous `data:`-URL download** in the button's
   click handler carrying `schema`, `sample_id`, `produced_from`, `overall`,
   `items[]`, `exported_at` (I5). Do NOT navigate the frame
   (`window.location`/`location.assign`/`window.open`) or add inline `on*`
   handlers or a `<meta refresh>` — the linter fails those (G5), and under
   `'unsafe-inline'` they are the exfil channels the CSP can't block. Mirror
   the fixture's app script.
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
exists; it is self-contained (everything inlined) and passes the review-site
linter G1-G8 clean.

**Reviewer READS the harness-run linter result (does NOT run it or rebuild the site):**

The gate for this phase is **structural + fidelity**, not scientific — do NOT
recompute slope/accuracy here (that was gated upstream), and do NOT hand-run a
linter or hand-type the policy. The **harness** runs the deterministic
`check_review_site` linter (G1-G8) with its own authoritative inputs — the phase
`cdn_allowlist`, the run's `artifacts/` measurement root, and the task id as the
expected `sample_id` — and writes the report to:

```
review/verification/review-artifact/check_review_site.json
```

Read that file. It is `{ "ok": bool, "fidelity": "verified"|"unverified",
"findings": [{ "gate": "G1".."G8", "ok": bool, "detail": "…" }] }`.

The linter checks: **G1** `index.html` resolves and is non-empty; **G2**
single inlined document, self-contained — no separate-file `<script src>`/`<link
href>` (they blank in the sandbox), and every `href`/`src`/CSS `url()` a
relative in-folder file, no `..`, absolute, `file://`, `data:`/`blob:`/
`javascript:` exec source, or dangling ref; **G3** an inline `<script>` assigns
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
the on-disk measurement (the site describes THIS run, not a stale one).

**Gate `pass` only if** `check_review_site.json` has `"ok": true` and every one
of the eight findings is `"ok": true`. If the file is missing or `"ok": false`,
FAIL and quote the failing findings' `detail` in your `submit_gate_decision`
feedback. (Note: the harness also enforces this as a deterministic floor — a
non-`ok` report fails the gate regardless — so passing a non-`ok` report is a
rubber stamp the monitor will catch.)

**The boundary is two layers — the linter is not redundant with the CSP.** The
linter is best-effort **structural + self-containment** analysis (single
inlined document, no external loads, faithful provenance). The enforcing boundary
is THREE cooperating parts. They divide the work: the **sandbox + CSP** (Lane A)
contain external subresource loads and network connections (`connect-src
'none'`); the **linter** contains the DIRECT navigation and inline-handler forms
(G5) — because the site needs `script-src 'unsafe-inline'` to render at all
(R4), and under `'unsafe-inline'` the CSP no longer blocks inline handlers, and
`connect-src` never blocked navigation (`window.location = evil`; no
`navigate-to` directive); and the **trusted-but-verified producer** (worker
authors, gate reviewer re-checks) carries the residual. No layer alone is the
boundary. The linter's JS exfil detection (G5) is explicitly BEST-EFFORT, not a
proof — static analysis closes the direct literal forms of the known exfil
classes, not every obfuscation (aliasing, computed non-literal dispatch).

**Failure modes to flag:** any gate `ok: false` — e.g. `index.html` missing
(G1), a separate-file `<script src>`/absolute/`..` path (G2), a missing data
global (G3), a `getElementById` with no matching element (G4), a `fetch`/
navigation sink/inline `on*` handler/`<meta refresh>` (G5), an external origin
not in `cdn_allowlist` (G6), no export/`schema` surface (G7), or a
`produced_from` hash that does not match the run's measurements (G8, a
stale/mismatched site).
