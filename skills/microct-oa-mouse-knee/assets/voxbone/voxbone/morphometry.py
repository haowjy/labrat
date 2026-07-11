"""
Core trabecular bone morphometry from a segmented (binary) image stack.

All parameters follow the nomenclature standardised by Bouxsein et al.
(J Bone Miner Res 2010; 25:1468) for rodent micro-CT. Distances are
returned in the physical units implied by ``voxel_size_mm`` (mm by
default); ratios are dimensionless; densities are per mm^3.

The engine works on a boolean bone mask ``bone`` and an optional
``voi`` (volume-of-interest) mask. When ``voi`` is None the whole image
bounding box is used as the reference volume (TV).
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Optional

import numpy as np
from scipy import ndimage as ndi


# ----------------------------------------------------------------------
# Local thickness (Hildebrand & Ruegsegger 1997)
# ----------------------------------------------------------------------
def local_thickness(mask: np.ndarray, step: float = 0.5) -> np.ndarray:
    """Model-independent local thickness map (in voxel units).

    For every foreground voxel, the value is the diameter of the largest
    sphere that (a) fits entirely inside the foreground and (b) contains
    that voxel. This is the definition used for Tb.Th / Tb.Sp in
    standard micro-CT software (CTAn, Scanco, BoneJ).

    Implementation: the sphere-of-radius-r fits inside the foreground iff
    its centre lies in ``S_r = {edt >= r}``. A voxel is covered by such a
    sphere iff its distance to ``S_r`` is <= r. We sweep r from large to
    small and assign 2r to newly-covered voxels. Each sweep step costs one
    Euclidean distance transform, so the whole map is a handful of EDTs
    rather than an explicit sphere-painting loop.
    """
    mask = np.asarray(mask, dtype=bool)
    if not mask.any():
        return np.zeros(mask.shape, dtype=np.float32)

    edt = ndi.distance_transform_edt(mask)
    thickness = np.zeros(mask.shape, dtype=np.float32)
    r_max = float(edt.max())
    radii = np.arange(r_max, 0.0, -step)
    for r in radii:
        S_r = edt >= r
        if not S_r.any():
            continue
        # distance from every voxel to the nearest sphere-centre set
        dist_to_S = ndi.distance_transform_edt(~S_r)
        covered = (dist_to_S <= r) & mask & (thickness == 0)
        thickness[covered] = 2.0 * r
    # any residual foreground voxels (numerical corners) get their edt
    residual = mask & (thickness == 0)
    thickness[residual] = 2.0 * edt[residual]
    return thickness


# ----------------------------------------------------------------------
# Surface area via marching cubes
# ----------------------------------------------------------------------
def _surface_area_voxels(bone: np.ndarray) -> float:
    """Bone surface area in voxel^2 units using a marching-cubes mesh."""
    from skimage import measure

    # pad so surfaces at the image border are closed consistently
    padded = np.pad(bone.astype(np.float32), 1, mode="constant")
    try:
        verts, faces, _, _ = measure.marching_cubes(padded, level=0.5)
        return float(measure.mesh_surface_area(verts, faces))
    except (RuntimeError, ValueError):
        return float("nan")


# ----------------------------------------------------------------------
# Connectivity density (Euler-characteristic method, Odgaard & Gundersen)
# ----------------------------------------------------------------------
def _connectivity(bone: np.ndarray) -> float:
    """Connectivity = 1 - Euler number (3D, 26-connectivity)."""
    from skimage import measure

    euler = measure.euler_number(bone, connectivity=3)
    return 1.0 - float(euler)


# ----------------------------------------------------------------------
# Structure Model Index (Hildebrand & Ruegsegger 1997) -- experimental
# ----------------------------------------------------------------------
def _smi(bone: np.ndarray, dr: float = 0.5) -> float:
    """SMI = 6 * (BV * dBS/dr) / (BS^2).

    Marked experimental: SMI is sensitive to surface meshing and to
    concave regions (it can go negative). Reported for completeness.
    """
    bs = _surface_area_voxels(bone)
    if not np.isfinite(bs) or bs == 0:
        return float("nan")
    dil = ndi.binary_dilation(bone, iterations=1)
    bs_d = _surface_area_voxels(dil)
    bv = float(bone.sum())
    dbs = (bs_d - bs) / dr
    return float(6.0 * bv * dbs / (bs ** 2))


@dataclass
class Morphometry:
    """Container for one sample's morphometric parameters."""
    BV_TV: float          # bone volume fraction (BV/TV), dimensionless
    BS_BV: float          # bone surface / bone volume, 1/mm
    BS_TV: float          # bone surface density, 1/mm
    Tb_Th: float          # trabecular thickness, mm
    Tb_Sp: float          # trabecular separation, mm
    Tb_N: float           # trabecular number, 1/mm
    Conn_D: float         # connectivity density, 1/mm^3
    SMI: float            # structure model index (experimental)
    TV_mm3: float         # total (reference) volume, mm^3
    BV_mm3: float         # bone volume, mm^3
    n_voxels_bone: int
    n_voxels_tv: int

    def as_dict(self) -> dict:
        return asdict(self)


def compute_morphometry(
    bone: np.ndarray,
    voi: Optional[np.ndarray] = None,
    voxel_size_mm: float = 1.0,
    compute_smi: bool = True,
    thickness_step: float = 0.5,
) -> Morphometry:
    """Compute the standard trabecular parameters for one segmented stack.

    Parameters
    ----------
    bone : 3D array
        Segmented bone (non-zero = bone).
    voi : 3D bool array, optional
        Volume of interest. Defaults to the full image volume. TV and all
        densities are referenced to the VOI; bone outside the VOI is
        ignored.
    voxel_size_mm : float
        Isotropic voxel edge length in mm.
    compute_smi : bool
        Whether to compute the (experimental) structure model index.
    thickness_step : float
        Radius sweep step for local thickness (voxels). Smaller = more
        accurate, slower.
    """
    bone = np.asarray(bone) > 0
    if bone.ndim != 3:
        raise ValueError(f"expected a 3D stack, got shape {bone.shape}")

    if voi is None:
        voi = np.ones(bone.shape, dtype=bool)
    else:
        voi = np.asarray(voi) > 0
        bone = bone & voi

    v = float(voxel_size_mm)
    voxel_vol = v ** 3

    n_tv = int(voi.sum())
    n_bv = int(bone.sum())
    if n_tv == 0:
        raise ValueError("VOI is empty")

    tv_mm3 = n_tv * voxel_vol
    bv_mm3 = n_bv * voxel_vol
    bv_tv = n_bv / n_tv

    # surface area (voxel^2 -> mm^2)
    bs_mm2 = _surface_area_voxels(bone) * (v ** 2)
    bs_bv = (bs_mm2 / bv_mm3) if bv_mm3 > 0 else float("nan")
    bs_tv = bs_mm2 / tv_mm3

    # thickness of bone phase (Tb.Th)
    th_map = local_thickness(bone, step=thickness_step)
    tb_th = float(th_map[bone].mean()) * v if n_bv > 0 else float("nan")

    # thickness of marrow phase within VOI (Tb.Sp)
    marrow = voi & (~bone)
    if marrow.any():
        sp_map = local_thickness(marrow, step=thickness_step)
        tb_sp = float(sp_map[marrow].mean()) * v
    else:
        tb_sp = float("nan")

    # trabecular number (plate-model, Bouxsein 2010): Tb.N = (BV/TV)/Tb.Th
    tb_n = (bv_tv / tb_th) if (tb_th and np.isfinite(tb_th) and tb_th > 0) else float("nan")

    conn_d = _connectivity(bone) / tv_mm3

    smi = _smi(bone) if compute_smi else float("nan")

    return Morphometry(
        BV_TV=bv_tv,
        BS_BV=bs_bv,
        BS_TV=bs_tv,
        Tb_Th=tb_th,
        Tb_Sp=tb_sp,
        Tb_N=tb_n,
        Conn_D=conn_d,
        SMI=smi,
        TV_mm3=tv_mm3,
        BV_mm3=bv_mm3,
        n_voxels_bone=n_bv,
        n_voxels_tv=n_tv,
    )
