# review-site fixture (Lane 0)

The minimal, contract-clean, **single-document** `review-site/` folder. Not a
`build_review_site()` emit — hand-written to prove the review-site contract
(`../design/review-template.md` §1, invariants I1-I7) is real, small, and
buildable with no framework. This is the "minimal" column of that doc's
minimal-vs-biggest table: one page, one inline data block, a values table with
honesty flags, pick-a-verdict-per-row, Export JSON.
Sibling of `validation/fixtures/toy-stats-task/`.

## Layout — one file, everything inlined

```
review-site/
  index.html   entry point (I1): <style> block + inline <script> data blocks
               (window.REVIEW_MANIFEST, window.REVIEW_DATA) + inline app script
```

Why one file: an opaque-origin sandboxed iframe (Lane B embeds this with
`sandbox="allow-scripts allow-downloads"`, no `allow-same-origin`) **refuses
every external subresource load** — a `<script src>` or `<link href>` to a
separate file is silently dropped, pre-network, and the page renders blank
(probe R4, confirmed over real HTTP). So the whole site ships as a single
inlined `index.html`: CSS in a `<style>`, run data and app logic in inline
`<script>` blocks (data globals first, app last). There are no relative
subresource refs, no `..`, no absolute paths, no external origins (I2/I4 —
this fixture's `cdn_allowlist` is `[]`).

## URL shape (pins Lanes A and B to one contract)

The dashboard serves any task's review site at:

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
  and stamps the CSP header. `cdn_allowlist: []` for this fixture means
  `script-src 'self' 'unsafe-inline'` — `'unsafe-inline'` is load-bearing:
  without it the inline `<style>`/`<script>` blocks are refused and the page
  is blank (R4).
- **Lane B (sandboxed iframe)** embeds `index.html` via `<iframe
  sandbox="allow-scripts allow-downloads" src="...">` (no `allow-same-origin`
  — opaque origin, load-bearing) and drives the Export button to confirm the
  verdict download works under the real sandbox, including iOS Safari
  (C1-C3).
- **Lane C (linter/gate)** runs `check_review_site` (G1-G8) against this
  folder as the "must pass clean" fixture, then against mutated copies (a
  separate `<script src>`, a `window.location` exfil, an `onerror=` handler, a
  `<meta refresh>`, an `<object data=external>`, a `sample_id` mismatch) to
  confirm each mutation fails the gate it's meant to catch.

## The two-layer boundary (why the linter still matters under `'unsafe-inline'`)

`'unsafe-inline'` is required for the site to render at all, but it also
permits inline event handlers (`onerror=`) and inline `<script>`, and
`connect-src 'none'` does **not** block navigation (`window.location = evil`;
there is no `navigate-to` directive). So the sandbox + CSP contain external
loads/connections, but the **linter** is the layer that catches navigation and
inline-handler exfil. Both layers are load-bearing — see `check.ts`.

## Validating this fixture

Bare **`file://`** (open `index.html` directly, no server) is the right check
**only** for authoring: does the table render, does a per-row verdict stick,
does Export download a valid `verdict.json`. It is functionally meaningful
here because this fixture is unsandboxed at that point.

It is **not** a stand-in for the real embedding. The real check is
**sandboxed, served over HTTP** by Lane A's route into Lane B's iframe under
the real `reviewSiteCsp()`; that verification belongs to Lanes A/B.
