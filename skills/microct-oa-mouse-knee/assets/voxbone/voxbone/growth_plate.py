"""Segment the proximal-tibial growth plate (physis).

The growth plate is an unmineralized cartilage disc, so in micro-CT it appears
as a low-density transverse gap between the epiphyseal ossification centre and
the metaphyseal spongiosa. We locate, per column, the non-mineralized gap that
separates those two dense zones, fit a smoothed height-map surface through the
gap centres, and take a thin sheet around that surface (restricted to non-bone).

Validated on OA6-10RK_1: 0.21 mm thick, 1.75-2.73 mm below the plateau
(mouse physis is ~0.15-0.25 mm), versus 1.13 mm for a naive column-gap method
that swallowed marrow.
"""
from __future__ import annotations
import numpy as np
from scipy import ndimage as ndi


def segment_growth_plate(tibia_hu: np.ndarray, tibia_mask: np.ndarray,
                         long_axis: int, voxel_mm: float,
                         threshold_hu: float = 2500.0,
                         plateau_at_low: bool = False,
                         search_mm=(1.6, 2.9), sheet_half_mm: float = 0.10):
    """Return a boolean mask of the growth-plate sheet, in the input array frame.

    Parameters
    ----------
    tibia_hu, tibia_mask : full-res HU and bone mask of the tibia (same shape)
    long_axis : proximal-distal axis index
    voxel_mm : full-res isotropic voxel size
    plateau_at_low : True if the plateau (articular surface) is at the low-index
        end of `long_axis`; the search window is measured from the plateau.
    search_mm : (lo, hi) distance-from-plateau window to search for the gap.
    sheet_half_mm : half-thickness of the retained sheet around the gap surface.

    Returns
    -------
    gp_mask : bool array (input frame)
    stats : dict(thickness_mm, z_lo_mm_from_plateau, z_hi_mm_from_plateau, voxels)
    """
    bone = tibia_hu > threshold_hu
    # work in a frame where index 0 is the plateau
    b = np.moveaxis(bone, long_axis, 0)
    if not plateau_at_low:
        b = b[::-1]
    nz, ny, nx = b.shape
    lo = max(0, int(search_mm[0] / voxel_mm))
    hi = min(nz, int(search_mm[1] / voxel_mm))
    has_epi = b[:lo].any(0)
    has_meta = b[hi:].any(0)
    valid = has_epi & has_meta
    ys, xs = np.where(valid)
    Hmap = np.full((ny, nx), np.nan)
    for y, x in zip(ys, xs):
        empty = ~b[lo:hi, y, x]
        if not empty.any():
            continue
        idx = np.where(empty)[0]
        runs = np.split(idx, np.where(np.diff(idx) > 1)[0] + 1)
        longest = max(runs, key=len)
        Hmap[y, x] = lo + 0.5 * (longest[0] + longest[-1])
    if not np.isfinite(Hmap).any():
        return np.zeros_like(bone), dict(thickness_mm=0.0, voxels=0,
                                         z_lo_mm_from_plateau=float("nan"),
                                         z_hi_mm_from_plateau=float("nan"))
    fill = np.nanmedian(Hmap)
    Hs = ndi.gaussian_filter(ndi.median_filter(np.where(valid, Hmap, fill), 7), 2)
    half = max(1, int(round(sheet_half_mm / voxel_mm)))
    zz = np.arange(nz)[:, None, None]
    sheet = (np.abs(zz - Hs[None]) <= half) & (~b) & valid[None]
    lab, n = ndi.label(sheet)
    if n:
        sizes = ndi.sum(np.ones_like(lab), lab, range(1, n + 1))
        sheet = lab == (int(np.argmax(sizes)) + 1)
    # stats (in plateau frame)
    zc = np.where(sheet.any((1, 2)))[0]
    if len(zc):
        z_lo, z_hi = zc[0] * voxel_mm, zc[-1] * voxel_mm
        # mean per-column thickness
        th = sheet.sum(0)
        thickness = float(th[th > 0].mean()) * voxel_mm if (th > 0).any() else 0.0
    else:
        z_lo = z_hi = float("nan"); thickness = 0.0
    # back to input frame
    if not plateau_at_low:
        sheet = sheet[::-1]
    gp_mask = np.moveaxis(sheet, 0, long_axis)
    return gp_mask, dict(thickness_mm=round(thickness, 3),
                         z_lo_mm_from_plateau=round(float(z_lo), 3),
                         z_hi_mm_from_plateau=round(float(z_hi), 3),
                         voxels=int(gp_mask.sum()))
