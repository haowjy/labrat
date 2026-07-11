"""Anatomical alignment for slice-based review.

The paper reorients the *whole dataset* to a coordinate plane before measuring
on ortho slices. voxbone's geometric indices are straight-line 3D distances
between landmark points and are therefore **rotation-invariant** -- alignment
does NOT change the numeric results. This module exists only to produce
anatomically upright ortho slices for the review UI.

Because a mouse knee is scanned flexed, the femur and tibia lean in opposite
directions; no single rotation makes both frontal at once. We therefore align
each bone independently (an engineering choice of this pipeline, not the paper's
single-rotation protocol). The long axis is fit on the *diaphysis only*
(excluding the flared epiphysis), which drives residual tilt to ~2-3 deg.
"""
from __future__ import annotations
import numpy as np
from scipy import ndimage as ndi

_ZAXIS = np.array([1.0, 0.0, 0.0])


def _rotation_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Rotation matrix sending unit vector a onto unit vector b."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(a @ b)
    if np.linalg.norm(v) < 1e-8:
        return np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1.0 / (1.0 + c))


def shaft_long_axis(mask: np.ndarray, plateau_high: bool,
                    shaft_frac=(0.45, 0.95)) -> np.ndarray:
    """Long-axis unit vector (z,y,x) from a line fit through per-slice centroids
    of the diaphyseal region only.

    `plateau_high` marks which long-axis end carries the epiphysis/plateau; the
    shaft fraction is measured as distance from that end so the flared
    epiphysis is excluded from the fit.
    """
    zs = np.where(mask.any((1, 2)))[0]
    z0, z1 = int(zs[0]), int(zs[-1])
    span = max(1, z1 - z0)
    zc, yc, xc = [], [], []
    for z in range(z0, z1 + 1):
        sl = mask[z]
        if sl.sum() < 20:
            continue
        frac = (z1 - z) / span if plateau_high else (z - z0) / span
        if shaft_frac[0] <= frac <= shaft_frac[1]:
            p = np.where(sl)
            zc.append(z); yc.append(p[0].mean()); xc.append(p[1].mean())
    if len(zc) < 3:  # fallback: use whole bone
        zc, yc, xc = [], [], []
        for z in range(z0, z1 + 1):
            sl = mask[z]
            if sl.sum() < 20:
                continue
            p = np.where(sl)
            zc.append(z); yc.append(p[0].mean()); xc.append(p[1].mean())
    zc = np.asarray(zc, float)
    dy = np.polyfit(zc, np.asarray(yc), 1)[0]
    dx = np.polyfit(zc, np.asarray(xc), 1)[0]
    v = np.array([1.0, dy, dx])
    return v / np.linalg.norm(v)


def residual_tilt_deg(mask: np.ndarray, plateau_high: bool) -> float:
    """Angle (deg) between the shaft long axis and the +Z axis."""
    lv = shaft_long_axis(mask, plateau_high)
    return float(np.degrees(np.arccos(np.clip(abs(lv @ _ZAXIS), 0, 1))))


def align_bone(mask: np.ndarray, hu: np.ndarray, plateau_high: bool,
               shaft_frac=(0.45, 0.95)):
    """Rotate one bone into an upright anatomical frame.

    Returns
    -------
    R : (3,3) rotation matrix (aligned = R @ (raw - offset))
    hu_aligned, mask_aligned : arrays in the aligned frame (same shape as input)
    ctr : centroid of the mask (raw voxel coords) used as the rotation pivot
    tilt_before, tilt_after : residual shaft tilt in degrees

    The output volume is centred on the bone's own centroid, so no voxels are
    clipped (100% retained).
    """
    lv = shaft_long_axis(mask, plateau_high, shaft_frac)
    R1 = _rotation_between(lv, _ZAXIS)
    pts = np.array(np.where(mask)).T.astype(float)
    ctr = pts.mean(0)
    rp = (pts - ctr) @ R1.T
    zt = rp[:, 0]
    sel = zt > np.percentile(zt, 75) if plateau_high else zt < np.percentile(zt, 25)
    yx = rp[sel][:, 1:]
    ev, evec = np.linalg.eigh(np.cov(yx.T))
    ml = evec[:, int(np.argmax(ev))]
    ang = np.arctan2(ml[0], ml[1])
    cz, sz = np.cos(-ang), np.sin(-ang)
    R2 = np.array([[1, 0, 0], [0, cz, -sz], [0, sz, cz]])
    R = R2 @ R1
    out_shape = mask.shape
    newc = np.array(out_shape) / 2.0
    offset = ctr - R.T @ newc
    hu_al = ndi.affine_transform(hu.astype(np.float32), R.T, offset=offset,
                                 output_shape=out_shape, order=1)
    m_al = ndi.affine_transform(mask.astype(np.float32), R.T, offset=offset,
                                output_shape=out_shape, order=0) > 0.5
    return R, hu_al, m_al, ctr, residual_tilt_deg(mask, plateau_high), \
        residual_tilt_deg(m_al, plateau_high)


def aligned_coord(p_raw, R: np.ndarray, ctr: np.ndarray, shape) -> np.ndarray:
    """Map a raw (z,y,x) point into the aligned frame produced by align_bone."""
    newc = np.array(shape) / 2.0
    offset = ctr - R.T @ newc
    return R @ (np.asarray(p_raw, float) - offset)
