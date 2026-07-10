# Review artifact — package the vetted numbers into a review site

## Methodology

This phase does **no science**. The `classify` and `regression` phases were
already gated against ground truth; here the worker *packages* those vetted
numbers into a contract-conformant **review site** — a small, self-contained,
offline HTML folder a human can open on a phone to confirm/correct/reject each
value (design `review-template.md` §1, invariants I1-I7).

The producer is protocol-specific (toy-stats emits a values table); the
CONTRACT and the gate linter are generic. Emit exactly this folder under
`artifacts/review-site/`:

```
review-site/
  index.html          entry point (I1); loads the data globals then app.js
  assets/app.js       renders the table, holds verdict state in memory, exports JSON
  assets/app.css      self-contained styling, no external fonts/CDN
  data/manifest.js    window.REVIEW_MANIFEST — sample_id, produced_from, verdict_schema, data_globals
  data/values.js      window.REVIEW_DATA — the rows to review
```

`validation/fixtures/review-site/` in the repo is a hand-written, contract-clean
reference for this exact structure — mirror it.

**Exact steps for the worker** (cwd IS the task dir; paths are literal):

1. `mkdir -p artifacts/review-site/assets artifacts/review-site/data`.
2. Read the vetted numbers from `artifacts/regression/regression.json` (slope,
   intercept, r_squared, n) and `artifacts/classify/classification.json`
   (n, threshold, accuracy). These are the rows to review.
3. Compute the fidelity hash of the source measurement so the site names the
   run it was built from (contract I3 / gate G8):
   ```
   sha256sum artifacts/regression/regression.json
   ```
   Take the 64-hex digest as `<HASH>`.
4. Write `data/manifest.js` assigning `window.REVIEW_MANIFEST`:
   ```js
   window.REVIEW_MANIFEST = {
     sample_id: "toy-stats-run",
     produced_from: { measurement: "regression/regression.json@<HASH>" },
     verdict_schema: "review-verdict/1",
     data_globals: ["REVIEW_MANIFEST", "REVIEW_DATA"],
   };
   ```
5. Write `data/values.js` assigning `window.REVIEW_DATA = { items: [...] }` —
   one item per vetted number, each `{ id, label, value, unit, honesty_flag,
   honesty_detail }` (see the fixture's `data/values.js`).
6. Write `index.html` (I1): a `<meta viewport>`, load `data/manifest.js` then
   `data/values.js` then `assets/app.js` via **relative** `<script src>`; a
   values table and an **Export verdict** button. Every `href`/`src` relative,
   inside the folder, no `..`, no absolute paths, no external origins (this
   phase's `cdn_allowlist` is `[]`).
7. Write `assets/app.js`: read `window.REVIEW_MANIFEST`/`window.REVIEW_DATA`
   (never `fetch` local JSON — I3/G5), render the rows, hold per-row verdict
   state in memory, and Export a `verdict.json` via a **synchronous `data:`-URL
   download** in the button's click handler carrying `schema`, `sample_id`,
   `produced_from`, `overall`, `items[]`, `exported_at` (I5). Mirror the
   fixture's `assets/app.js`.
8. **Self-check before recording** — run the same linter the gate runs, and
   iterate until every gate is clean:
   ```
   "$LABRAT_HOME/node_modules/.bin/tsx" "$LABRAT_HOME/src/review-site/cli.ts" \
     check-review-site artifacts/review-site \
     --results artifacts/regression/regression.json \
     --cdn-allowlist ""
   ```
   Exit 0 with `"ok": true` means all of G1-G8 pass.
9. Call `record_phase` with phase `review-artifact` and a short summary.

## Expected outputs / how to verify

**Correct output looks like:** `artifacts/review-site/index.html` and
`artifacts/review-site/data/manifest.js` exist; the folder is self-contained
and passes the review-site linter G1-G8 clean.

**Reviewer runs the linter (its own process, does NOT rebuild the site):**

The gate for this phase is **structural + fidelity**, not scientific — do NOT
recompute slope/accuracy here (that was gated upstream). Run the generic
`check_review_site` linter and read its findings:

```
"$LABRAT_HOME/node_modules/.bin/tsx" "$LABRAT_HOME/src/review-site/cli.ts" \
  check-review-site artifacts/review-site \
  --results artifacts/regression/regression.json \
  --cdn-allowlist "<the phase cdn_allowlist, comma-joined; empty here>"
```

It prints `{ "ok": bool, "findings": [{ "gate": "G1".."G8", "ok": bool,
"detail": "…" }] }` and exits 0 when clean, 1 when any gate fails.

The linter checks: **G1** `index.html` resolves and is non-empty; **G2**
every `href`/`src` is relative, inside the folder, no `..`/absolute/`file://`;
**G3** `data/manifest.js` exists and every declared `window.*` data global is
present and non-empty; **G4** every JS file is syntactically valid and each
`getElementById` targets an id that exists in its page; **G5** no `fetch`/
`XMLHttpRequest` of a local or `.json` path; **G6** every external origin is
in this phase's `cdn_allowlist`; **G7** a verdict export control exists and the
verdict `schema` string is referenced; **G8** the manifest's `produced_from`
hash matches `artifacts/regression/regression.json` on disk (the site describes
THIS run, not a stale one).

**Gate `pass` only if** the linter exits 0 with `"ok": true` and every one of
the eight findings is `"ok": true`. Quote the failing findings' `detail` in
your `submit_gate_decision` feedback on a fail.

**Failure modes to flag:** any gate `ok: false` — e.g. `index.html` missing
(G1), an absolute/`..` path (G2), a missing data global (G3), a `getElementById`
with no matching element (G4), a local `fetch` (G5), an external origin not in
`cdn_allowlist` (G6), no export/`schema` surface (G7), or a `produced_from`
hash that does not match the run's measurements (G8, a stale/mismatched site).
