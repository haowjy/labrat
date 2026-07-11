"""
Volume-of-interest extraction for trabecular morphometry.

The source paper analyses tibial subchondral trabecular bone: the region
from the proximal tibial articular surface down to the growth plate. This
module crops that VOI at FULL resolution (so Tb.Th etc. are not limited by
the coarse segmentation grid) using the low-resolution tibia mask to
locate the plateau, then re-thresholding the full-resolution HU.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np
from scipy import ndimage as ndi


@dataclass
class VOIResult:
    bone: np.ndarray          # full-res binary trabecular bone in the VOI
    voi: np.ndarray           # full-res VOI mask (reference volume for TV)
    voxel_mm: float
    bbox: tuple               # (zlo,zhi,ylo,yhi,xlo,xhi) in full-res coords
    notes: dict


def tibial_subchondral_voi(
    hu_full: np.ndarray,
    tibia_lowres: np.ndarray,
    long_axis: int,
    downsample: int,
    voxel_mm_full: float,
    threshold_hu: float = 2500.0,
    depth_mm: float = 1.0,
    surface_offset_mm: float = 0.1,
    ml_inset_frac: float = 0.10,
) -> VOIResult:
    """Crop the proximal-tibial subchondral trabecular VOI at full res.

    Parameters
    ----------
    hu_full : full-resolution HU volume
    tibia_lowres : tibia mask at ``downsample`` resolution
    depth_mm : axial thickness of the analysed slab below the articular
        surface (paper: articular surface -> growth plate; a fixed slab is
        used here as a reproducible proxy — adjust per study).
    surface_offset_mm : skip this much just below the very surface (the
        subchondral plate) before starting the trabecular slab.
    ml_inset_frac : trim this fraction off each mediolateral edge so the
        VOI is cancellous-centred and excludes the cortical rim.
    """
    f = int(downsample)
    # upsample tibia mask bbox to full-res
    tl = np.moveaxis(tibia_lowres, long_axis, 0)
    zs = np.where(tl.any((1, 2)))[0]
    # plateau end: determined by caller orientation; assume plateau is the end
    # closest to the femur was already used to orient — here take the end whose
    # cross-section is widest (plateau).
    def ml_extent(z):
        s = tl[z]
        pts = np.where(s)
        return 0 if len(pts[0]) == 0 else np.ptp(pts[0]) + np.ptp(pts[1])
    z_lo, z_hi = int(zs[0]), int(zs[-1])
    plateau_low = ml_extent(z_lo + 2) >= ml_extent(z_hi - 2)
    plateau_z = z_lo if plateau_low else z_hi

    # full-res long-axis coordinate of the plateau surface
    depth_vox = int(round(depth_mm / voxel_mm_full))
    off_vox = int(round(surface_offset_mm / voxel_mm_full))
    p_full = plateau_z * f

    hu_m = np.moveaxis(hu_full, long_axis, 0)
    Z = hu_m.shape[0]
    if plateau_low:
        z0 = min(Z - 1, p_full + off_vox)
        z1 = min(Z, z0 + depth_vox)
        sl = slice(z0, z1)
    else:
        z1 = max(0, p_full - off_vox)
        z0 = max(0, z1 - depth_vox)
        sl = slice(z0, z1)

    # ML/AP crop from the tibia footprint in this slab (upsampled bbox)
    tl_slab = tl[max(0, (sl.start)//f):(sl.stop)//f + 1]
    if tl_slab.any():
        pts = np.where(tl_slab.any(0))
        y0, y1 = pts[0].min()*f, pts[0].max()*f
        x0, x1 = pts[1].min()*f, pts[1].max()*f
    else:
        y0 = x0 = 0; y1, x1 = hu_m.shape[1], hu_m.shape[2]
    # inset ML edges
    yin = int(ml_inset_frac * (y1 - y0)); xin = int(ml_inset_frac * (x1 - x0))
    y0 += yin; y1 -= yin; x0 += xin; x1 -= xin

    sub = hu_m[sl, y0:y1, x0:x1]
    bone = sub > threshold_hu
    voi = np.ones(sub.shape, dtype=bool)

    # move axes back to original ordering for the cropped block
    bone = np.moveaxis(bone, 0, long_axis)
    voi = np.moveaxis(voi, 0, long_axis)

    notes = {
        "plateau_low": bool(plateau_low),
        "depth_mm": depth_mm,
        "slab_voxels": int(np.prod(sub.shape)),
        "bone_fraction": float(bone.mean()),
    }
    return VOIResult(bone=bone, voi=voi, voxel_mm=voxel_mm_full,
                     bbox=(sl.start, sl.stop, y0, y1, x0, x1), notes=notes)
