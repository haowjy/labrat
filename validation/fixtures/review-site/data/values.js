// Run data as a .js global (I3) — never fetched JSON. Loaded via <script>
// before assets/app.js runs. This is the minimal template's one data file;
// the biggest template would add per-bone geometry/mesh/landmark globals
// alongside this one.
window.REVIEW_DATA = {
  items: [
    {
      id: "distal_femoral_ratio",
      label: "Distal femoral W/L ratio",
      value: 1.42,
      unit: "ratio",
      honesty_flag: "clean",
      honesty_detail: "",
    },
    {
      id: "iioc_h_w",
      label: "Tibial IIOC height/width",
      value: 0.86,
      unit: "ratio",
      honesty_flag: "low-margin",
      honesty_detail: "Femur/tibia identity call within a 4% margin.",
    },
    {
      id: "tb_bv_tv",
      label: "Trabecular BV/TV",
      value: 0.31,
      unit: "fraction",
      honesty_flag: "clean",
      honesty_detail: "",
    },
    {
      id: "gp_thickness_mm",
      label: "Growth-plate thickness",
      value: 0.18,
      unit: "mm",
      honesty_flag: "criss-cross",
      honesty_detail:
        "Measurement lines cross between bones: a faithful sign of inter-bone rotational mismatch, not a rendering bug.",
    },
  ],
};
