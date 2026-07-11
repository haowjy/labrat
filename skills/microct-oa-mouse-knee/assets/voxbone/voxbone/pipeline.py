"""
Top-level orchestration: single-sample and batch pipelines, plus the
group statistics + plotting entry point.

    run_sample(path) -> SampleResult      (one knee)
    run_batch(paths, metadata) -> DataFrame  (a study; writes QC + table)
    analyze(df, group_col) -> stats + plots
"""
from __future__ import annotations

import os
import json
from dataclasses import dataclass, field, asdict
from typing import Optional, Sequence, Union

import numpy as np
import pandas as pd

from .io import load_volume
from .segment import segment_knee, cut_quality
from .geometry import measure_femur, measure_tibia
from .voi import tibial_subchondral_voi
from .morphometry import compute_morphometry
from .qc import qc_overlay
from .refine3d import assess_placement, refine_landmarks


@dataclass
class SampleResult:
    sample_id: str
    metrics: dict                       # flat dict of all measured values
    qc_path: Optional[str] = None
    warnings: list = field(default_factory=list)

    def to_row(self) -> dict:
        row = {"sample_id": self.sample_id}
        row.update(self.metrics)
        row["qc_path"] = self.qc_path
        row["warnings"] = ";".join(self.warnings) if self.warnings else ""
        return row


def run_sample(
    path: str,
    sample_id: Optional[str] = None,
    voxel_mm: Optional[float] = None,
    threshold_hu: float = 2500.0,
    downsample: int = 2,
    femur_end: str = "auto",
    long_axis: Optional[int] = None,
    do_morphometry: bool = True,
    voi_depth_mm: float = 1.0,
    qc_dir: Optional[str] = "qc",
    thickness_step: float = 1.0,
    refine_3d: bool = True,
    off_frac_tol: float = 0.35,
) -> SampleResult:
    """Run the full pipeline on one knee-joint DICOM series (dir or .zip)."""
    vol = load_volume(path, sample_id=sample_id)
    sid = vol.sample_id
    vmm = voxel_mm if voxel_mm is not None else vol.voxel_mm
    warnings = []

    seg = segment_knee(vol.hu, vmm, threshold_hu=threshold_hu,
                       downsample=downsample, femur_end=femur_end,
                       long_axis=long_axis)
    q = cut_quality(seg)
    if q["unassigned_frac"] > 0.05:
        warnings.append("unassigned_frac=%.2f (>5%%): check split" % q["unassigned_frac"])
    if q["interface_band_mm"] == q["interface_band_mm"] and q["interface_band_mm"] > 3.0:
        warnings.append("interface_band=%.1fmm (>3mm): diffuse cut" % q["interface_band_mm"])
    conf = seg.notes.get("femur_end_confidence") or {}
    if conf.get("margin", 1.0) < 0.15:
        warnings.append("low-confidence femur/tibia call (margin=%.2f): verify QC/override femur_end"
                        % conf.get("margin", float("nan")))

    fem = measure_femur(seg.femur, seg.long_axis, seg.voxel_mm, seg.femur_end,
                        companion=seg.tibia)
    tib = measure_tibia(seg.tibia, seg.long_axis, seg.voxel_mm, companion=seg.femur)

    # 3D acceptance check on the landmark geometry (not just 2D extents): each
    # measurement line must lie on the axis it is meant to (WIDTH -> ML,
    # LENGTH -> proximal-distal). If a WIDTH line is off-axis, re-pick its
    # endpoints on a common frontal plane and keep the change only if the 3D
    # score improves.
    assess = assess_placement(fem, tib, seg.femur, seg.tibia, seg.long_axis,
                              seg.voxel_mm, off_frac_tol=off_frac_tol)
    if refine_3d and not assess["all_pass"]:
        fem, tib, log = refine_landmarks(seg, fem, tib, seg.voxel_mm,
                                         off_frac_tol=off_frac_tol)
        assess = log[-1]
    for line in ("femur_width", "femur_length", "tibia_width"):
        if line in assess and not assess[line]["pass"]:
            warnings.append("3D check: %s line off-axis (off_frac=%.2f) — confirm in review UI"
                            % (line, assess[line]["off_frac"]))

    metrics = {}
    metrics.update(fem.as_dict())
    metrics.update(tib.as_dict())
    for line in ("femur_width", "femur_length", "tibia_width"):
        if line in assess:
            metrics["off_axis_" + line] = assess[line]["off_frac"]
    metrics["cut_interface_band_mm"] = q["interface_band_mm"]
    metrics["femur_end"] = seg.femur_end
    metrics["femur_end_margin"] = conf.get("margin", float("nan"))

    if do_morphometry:
        try:
            voir = tibial_subchondral_voi(
                vol.hu, seg.tibia, seg.long_axis, seg.downsample, vmm,
                threshold_hu=threshold_hu, depth_mm=voi_depth_mm)
            morph = compute_morphometry(
                voir.bone, voi=voir.voi, voxel_size_mm=vmm,
                compute_smi=False, thickness_step=thickness_step)
            md = morph.as_dict()
            # Conn_D / SMI are unreliable on a thin cropped slab (Euler number
            # and surface-derivative are boundary-sensitive) -> excluded from
            # defaults; the raw Morphometry object still carries them.
            for k in ("BV_TV", "Tb_Th", "Tb_Sp", "Tb_N", "BS_BV"):
                metrics["tib_" + k] = md[k]
        except Exception as e:  # noqa: BLE001
            warnings.append("morphometry failed: %s" % e)

    qc_path = None
    if qc_dir is not None:
        os.makedirs(qc_dir, exist_ok=True)
        qc_path = os.path.join(qc_dir, f"{sid}_qc.png")
        try:
            qc_overlay(seg, fem, tib, qc_path, title="voxbone — %s" % sid)
        except Exception as e:  # noqa: BLE001
            warnings.append("qc render failed: %s" % e)
            qc_path = None

    return SampleResult(sample_id=sid, metrics=metrics, qc_path=qc_path,
                        warnings=warnings)


def run_batch(
    samples: Union[str, Sequence[str]],
    metadata: Optional[Union[str, "pd.DataFrame"]] = None,
    id_col: str = "sample_id",
    out_csv: str = "voxbone_results.csv",
    qc_dir: str = "qc",
    **run_kwargs,
) -> "pd.DataFrame":
    """Run the pipeline over many samples and consolidate into one table.

    Parameters
    ----------
    samples : a directory containing per-sample subfolders/zips, or an
        explicit list of paths.
    metadata : path to a CSV (or a DataFrame) mapping ``id_col`` -> group /
        covariates; merged onto the results by sample_id.
    """
    if isinstance(samples, str) and os.path.isdir(samples):
        entries = sorted(
            os.path.join(samples, e) for e in os.listdir(samples)
            if e.lower().endswith(".zip") or os.path.isdir(os.path.join(samples, e)))
    else:
        entries = list(samples)

    rows = []
    for p in entries:
        try:
            res = run_sample(p, qc_dir=qc_dir, **run_kwargs)
            rows.append(res.to_row())
            print("[ok] %s" % res.sample_id, "| warnings:", len(res.warnings))
        except Exception as e:  # noqa: BLE001
            print("[FAIL] %s: %s" % (p, e))
            rows.append({"sample_id": os.path.basename(p), "warnings": "FAILED: %s" % e})

    df = pd.DataFrame(rows)
    if metadata is not None:
        meta = pd.read_csv(metadata) if isinstance(metadata, str) else metadata
        df = df.merge(meta, on=id_col, how="left")
    df.to_csv(out_csv, index=False)
    print("wrote", out_csv, "(%d samples)" % len(df))
    return df
