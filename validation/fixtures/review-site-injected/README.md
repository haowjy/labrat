# review-site-injected fixture

A review site that uses **serve-time data injection**
(`design/review-data-injection.md`) instead of inlining all its data.

- `review-site/index.html` — the template. `REVIEW_GEOMETRY` is declared as a
  placeholder: `window.REVIEW_GEOMETRY = "__REVIEW_INJECT:REVIEW_GEOMETRY__";`,
  and the manifest's `data_sources` maps that global to the artifact
  `landmarks/geometry.json` (`transform: "identity"`). `produced_from.measurement`
  carries the artifact's `path@<sha256>`.
- `data/geometry.json` — the artifact the dashboard splices in. In a real task
  this lives under `artifacts/landmarks/geometry.json`; tests place it there.

The clean `../review-site/` fixture (fully inlined, no placeholder) still passes
every gate unchanged — this fixture exercises the injection path alongside it.
