// Contract-level data file (review-template.md §1, invariant I3).
// The gate (G8) reads this file to confirm the site describes THIS run:
// sample_id + produced_from must match the measurements the site was built
// from. Everything else under data/ is producer-specific.
window.REVIEW_MANIFEST = {
  sample_id: "oa-knee-0007",
  produced_from: {
    measurement:
      "measurements/results.json@3f179308d75117c096ff1ec771b54779a522b9da8d067c539a551a0ee355ad9d",
  },
  verdict_schema: "review-verdict/1",
  // Every window.* global this site's data/ folder assigns (I3). The gate
  // checks each name here resolves to a non-empty global.
  data_globals: ["REVIEW_MANIFEST", "REVIEW_DATA"],
};
