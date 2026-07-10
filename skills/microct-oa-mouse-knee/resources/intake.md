# Intake — Tang mouse-knee OA (Scanco VivaCT)

## Methodology

Load the incoming DICOM series and derive scanner-aware calibration metadata.
Intake does **not** resample or emit a full intensity volume — resampling is
deferred to segmentation (`bonemorph-map` Stage 1).

**Subprocess environment** (proven on OA6-1RK):

```bash
PY=/home/jimyao/.claude-science/conda/envs/microct_analysis/bin/python
export PYTHONPATH=/home/jimyao/gitrepos/prompts/microct-analysis/src
export MPLBACKEND=Agg
```

**Primary driver:**

```python
from microct_analysis.stages.intake import run_intake

metadata = run_intake(dicom_path="input/OA6-1RK", output_dir=".")
```

**Functions the stage uses internally:**

- `microct_analysis.processing.dicom.load_dicom` — DICOM → `ScanVolume`
- `microct_analysis.processing.profiles.detect` — Scanco VivaCT profile
- `microct_analysis.processing.calibration.analyze_histogram`
- `microct_analysis.processing.calibration.analyze_segmentation_histogram`
- `microct_analysis.processing.calibration.derive_thresholds`
- `microct_analysis.processing.calibration.derive_segmentation_thresholds`

**Study-specific expectations (from `SKILL.md` + `assets/ground_truth.json`):**

- Scanner: Scanco VivaCT 40, **10.5 µm** isotropic voxels (`voxel_size_um.value`)
- Scanco thresholds are **unitless** attenuation values: **220** bone/soft-tissue,
  **320** 3D segmentation, **270** cortical/plate — not Amira HU (>2500)
- Demo fixture OA6-1RK: **877** slices, shape roughly `(877, 520, 517)` ZYX

**Worker artifacts to write for downstream phases:**

| Path | Source |
|------|--------|
| `intake/volume_metadata.json` | `IntakeArtifacts.volume_metadata` from driver |
| `intake/orientation_report.md` | human-readable load summary |
| `intake/stage_report.json` | confidence, flags, `recommended_action` |
| `spacing.json` | extract `spacing` from `volume_metadata.json` for harness handoff |

Copy `phases/intake/evidence/histogram.png` from a matplotlib histogram of the
loaded volume if the harness expects phase evidence (driver does not auto-render).

## Verification

**Correct output looks like:**

- `intake/volume_metadata.json` exists with `spacing`, `scanner`/`scanner_profile`,
  `fingerprint`, `segmentation_threshold_analysis`, and `segmentation_thresholds`
- `intake/stage_report.json` has `confidence` in `{high, medium, low}` and
  `recommended_action` in `{proceed, flag, pause}`
- `spacing.json` isotropic ≈ **0.0105 mm** per axis (10.5 µm)

**Reviewer computes:**

1. **Slice count gate** — `provenance.slice_count` or Z dimension ≥ `expects.min_slices` (100); OA6-1RK must be **877**.
2. **Voxel size gate** — all spacing axes within **10.5 µm ± 2%** (0.01029–0.01071 mm); matches `ground_truth.json` → `voxel_size_um.value`.
3. **Scanner profile** — `scanner_profile` detects Scanco (not `unknown-scanner-profile` without justification).
4. **Threshold readiness** — `segmentation_ready: true` OR documented flags in
   `threshold_flags` with a remediation plan for segmentation.
5. **Bimodality status** — read `segmentation_threshold_analysis.status`; flag
   `histogram-not-bimodal` if present (segmentation may still proceed with seeds).

**Failure modes:**

- `LoadError` from `load_dicom` — corrupt/missing DICOM, wrong modality
- `unknown-scanner-profile` — thresholds may be unreliable; escalate at segmentation
- `segmentation_threshold_analysis.status: not-bimodal` — expect `needs-seeds` path later
- Empty or single-slice stack — fail intake immediately

**Ground-truth gates applying here:** `voxel_size_um` only (mm measurement gates
apply at landmarks/measurement).
