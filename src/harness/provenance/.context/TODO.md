# TODO — harness/provenance

Deferred work colocated with the provenance manifest. Full triage: work-dir `gaps-backlog.md`.

- [ ] **Dedup manifest entries** (#12) — gate re-runs append duplicate entries for the
  same phase (observed: two intake + two segmentation entries with different gate
  session ids). `appendManifestEntry` should dedup by phase+attempt, or version
  re-runs distinctly.
