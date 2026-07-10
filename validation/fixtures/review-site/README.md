# review-site fixture (Lane 0)

The minimal, contract-clean, single-document `review-site/` folder. Not a
`build_review_site()` emit — hand-written to prove the review-site contract
(`../design/review-template.md` §1, invariants I1-I7) is real, small, and
buildable with no framework. This is the "minimal" column of that doc's
minimal-vs-biggest table: one page, one data file, a values table with
honesty flags, pick-a-verdict-per-row, Export JSON. Sibling of
`validation/fixtures/toy-stats-task/`.

## Layout

```
review-site/
  index.html        entry point (I1)
  assets/app.css
  assets/app.js      renders the table, holds verdict state in memory, exports JSON
  data/manifest.js   window.REVIEW_MANIFEST — sample_id, produced_from, verdict_schema, data_globals
  data/values.js     window.REVIEW_DATA — the example rows
```

Every `href`/`src` here is relative and resolves inside this folder; no `..`,
no absolute paths, no external origins (I2/I4 — this fixture's `cdn_allowlist`
is `[]`).

## URL shape (pins Lanes A and B to one contract)

The dashboard will serve any task's review site at:

```
GET /api/tasks/:id/review-site/*path
```

`*path` resolves under `artifacts/review-site/` inside that task's dir (the
same `resolveTaskFile`-guarded pattern already used for
`/api/tasks/:id/phases/:phase/evidence/:file` and
`/api/tasks/:id/verification/:phase/:file` in `src/dashboard/server.ts`).
`GET .../review-site/` (no path) resolves to `index.html`. This fixture is
what a request to that route would return today if `artifacts/review-site/`
held it — Lane A codes the route against this folder without a live protocol
run.

## Who consumes it

- **Lane A (route + CSP)** serves this folder's bytes through the route above
  and stamps the CSP header (`cdn_allowlist: []` for this fixture means
  `script-src 'self'`, no additions).
- **Lane B (sandboxed iframe)** embeds `index.html` via `<iframe
  sandbox="allow-scripts allow-downloads" src="...">` (no `allow-same-origin`
  — opaque origin, load-bearing) and drives the Export button to confirm the
  verdict download works under the real sandbox, including iOS Safari
  (C1-C3).
- **Lane C (linter/gate)** runs `check_review_site` (G1-G8) against this
  folder as the "must pass clean" fixture, then against mutated copies (drop
  `index.html`, an absolute path, a missing `window.*` global, an external
  origin, a `sample_id` mismatch) to confirm each mutation fails the gate it's
  meant to catch.

## Validating this fixture

Bare **`file://`** (open `index.html` directly, no server) is the right check
**only** for authoring: does the table render, does a per-row verdict stick,
does Export download a valid `verdict.json`. It is functionally meaningful
here because this fixture is unsandboxed at that point.

It is **not** a stand-in for the real embedding. A **sandboxed** `file://`
frame renders blank for reasons unrelated to this contract (opaque origin +
`file://` blocks external subresource loads and same-frame navigation — see
`../design/review-template.md` "R2 RESOLVED" / R4). The real check is
**sandboxed, served over HTTP** by Lane A's route into Lane B's iframe; that
verification belongs to Lanes A/B, not here.
