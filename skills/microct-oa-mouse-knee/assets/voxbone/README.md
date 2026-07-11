# voxbone

A reusable pipeline for **murine knee-joint micro-CT** analysis. It automates
the hand-run Amira + Scanco workflow from Tang et al. ("Geometric indices
derived from CT images as sensitive and reliable parameters for evaluating
disease severity and therapeutic response of osteoarthritis in mice") into a
scriptable, batch-capable Python package.

```
DICOM series ─▶ segment ─▶ femur/tibia split ─▶ geometric OA indices
                                              └▶ trabecular morphometry
   many samples ─────────────────────────────▶ tidy table ─▶ stats + plots
```

## What it replaces (the by-hand steps)

| Manual step (Amira / Scanco)                              | voxbone |
|-----------------------------------------------------------|-----------|
| Import DICOM, 3D median denoise                           | `load_volume` + `segment_knee(do_denoise=True)` |
| Interactive threshold (>2500 HU) → bone mask              | `segment_knee(threshold_hu=2500)` |
| Hand-place watershed seeds → separate femur & tibia       | automatic seeded watershed (`split_femur_tibia`) |
| Ruler landmarks → distal-femur **width / length / W:L**   | `measure_femur` |
| Ruler landmarks → tibia width, compartment heights        | `measure_tibia` |
| Scanco contour ROI → BV/TV, Tb.Th, Tb.N, Tb.Sp            | `tibial_subchondral_voi` + `compute_morphometry` |
| Consolidate into Prism/Excel, run stats, make plots       | `run_batch` + `analyze` |

## Install

```bash
pip install -e .            # from the package root
# deps: numpy scipy scikit-image pydicom pandas matplotlib  (+ statsmodels/seaborn for [stats])
```

## Quick start

```python
import voxbone as vb

# ---- one knee (a directory of .dcm, or a .zip of slices) ----
res = vb.run_sample("OA6-10RK.zip", downsample=2)
print(res.metrics)          # dict of all indices
print(res.qc_path)          # qc/<sample>_qc.png  -- ALWAYS review this

# ---- a whole study ----
df = vb.run_batch("samples_dir/", metadata="groups.csv")   # groups.csv: sample_id,group,...
stats = vb.analyze(df, group_col="group")                  # writes analysis/group_plots.png + stats_summary.csv
```

`groups.csv` maps each `sample_id` to its experimental group (and any
covariates); it is merged onto the results table by `sample_id`.

## Measured parameters

**Geometric (distal femur / proximal tibia)**
- `femur_width_mm` — lateral↔medial condyle extent (grows with osteophytes)
- `femur_length_mm` — intercondylar groove→notch midline distance
- `wl_ratio` — **width / length: the paper's headline OA-severity index**
- `tibia_width_mm`, `med_/lat_compartment_height_mm`

**Trabecular (tibial subchondral VOI)**
- `tib_BV_TV`, `tib_Tb_Th`, `tib_Tb_Sp`, `tib_Tb_N`, `tib_BS_BV`
  (Bouxsein et al. 2010 nomenclature)

## Validation status (read this)

- **Trabecular morphometry — validated against analytical phantoms.**
  A solid slab returns exact BV/TV and Tb.Th; a sphere returns bone volume
  to 0.3 %, local thickness to 0.1 %, and BS/BV within ~9 % (the known
  marching-cubes surface bias). See `examples/validate_phantom.py`.
- **Femur/tibia split — quantitatively verified per sample.** `cut_quality`
  reports 0 % unassigned, 0 % overlap, and a thin interface band
  (1.4 mm on the bundled real sample). A warning fires if the split looks
  diffuse.
- **Geometric landmarks — auto-proposed, QC-confirmed.** The distal-femur
  length (intercondylar groove→notch) is a small anatomical landmark pair
  that cannot be fully trusted from a single unlabeled scan without manual
  ground truth. The pipeline therefore *proposes* landmarks and **always
  writes a QC overlay** you confirm or correct — the realistic analogue of
  the paper's manual ruler step. The femur/tibia orientation call carries a
  confidence margin; margins < 0.15 raise a `low-confidence` warning
  (the bundled sample is one such case — the call is correct on visual QC,
  but you should confirm it on the overlay rather than take it on trust).

### Overriding the automatic calls

If a QC overlay shows the femur/tibia labels swapped, pin the orientation:

```python
res = vb.run_sample("sample.zip", femur_end="high")   # or "low"
# also available: long_axis=0|1|2, threshold_hu=…, voi_depth_mm=…, downsample=…
```

## Notes & limits

- `downsample=2` (≈21 µm for a 10.5 µm scan) is the default for segmentation
  and geometry — mm-scale landmarks are unaffected and runtime drops ~8×.
  Trabecular morphometry is always computed at **full resolution** on the
  cropped tibial VOI.
- Tb.Th depends on the VOI: a fixed-depth subchondral slab (`voi_depth_mm`)
  includes some subchondral plate, biasing Tb.Th upward. Tune `voi_depth_mm`
  / `surface_offset_mm` and confirm against a couple of manual Scanco ROIs
  for your study.
- Connectivity density and SMI are computed but **excluded from the default
  table** — both are unreliable on a thin cropped slab.
