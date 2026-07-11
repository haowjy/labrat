"""
Segmentation of a knee-joint micro-CT volume into bone, then into the
two articulating bones (distal femur + proximal tibia).

This automates the manual Amira workflow from the source paper:
    median denoise -> threshold -> clean -> marker-based watershed to
    split the fused femur/tibia at the joint line.

The paper placed watershed seeds by hand; here the seeds are generated
automatically from the two ends of the bone's long axis.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
from scipy import ndimage as ndi


@dataclass
class Segmentation:
    bone: np.ndarray          # bool, cleaned whole-bone mask (at seg resolution)
    femur: np.ndarray         # bool
    tibia: np.ndarray         # bool
    long_axis: int            # axis index of the proximal-distal direction
    femur_end: str            # 'low' or 'high' along long_axis
    threshold_hu: float
    voxel_mm: float           # voxel size of the masks (seg resolution)
    notes: dict
    downsample: int = 1       # factor applied to the source volume


def denoise(hu: np.ndarray, size: int = 3) -> np.ndarray:
    """3D median filter (paper: 'a 3D median filter to denoise')."""
    return ndi.median_filter(hu, size=size)


def threshold_bone(hu: np.ndarray, threshold_hu: float = 2500.0) -> np.ndarray:
    """Binary bone mask (paper: interactive threshold > 2500 HU)."""
    return hu > threshold_hu


def clean_mask(bone: np.ndarray, min_size: int = 5000,
               closing_iter: int = 1) -> np.ndarray:
    """Morphological cleanup: close small gaps, drop specks, keep the
    single largest connected component (the articulating bone mass)."""
    m = ndi.binary_closing(bone, iterations=closing_iter)
    lab, n = ndi.label(m)
    if n == 0:
        return m
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    keep = sizes.argmax()
    main = lab == keep
    # fill interior cavities slice-wise along the long axis later; here
    # just return the largest component
    return main


def _pick_long_axis(mask: np.ndarray, voxel_mm: float) -> int:
    coords = np.array(np.where(mask))
    extents = coords.max(1) - coords.min(1)
    return int(np.argmax(extents))


def split_femur_tibia(
    bone: np.ndarray,
    voxel_mm: float,
    long_axis: Optional[int] = None,
    seed_frac: float = 0.08,
    thick_pct: float = 60.0,
    femur_end: str = "auto",
) -> Segmentation:
    """Split the fused bone mass into femur and tibia by seeded watershed.

    Seeds are placed in the thick (diaphyseal) part of each end of the
    long axis; watershed on the inverted distance transform then flows
    the boundary to the thin joint constriction — the automatic analogue
    of the paper's hand-placed watershed markers.

    Parameters
    ----------
    femur_end : {'auto','low','high'}
        Which end of the long axis is the femur. 'auto' uses a bilobed-
        epiphysis heuristic (the distal femur has two condyles separated
        by the intercondylar notch). Override per-batch after checking the
        QC image if the heuristic is wrong for your mounting orientation.
    """
    from skimage.segmentation import watershed

    if long_axis is None:
        long_axis = _pick_long_axis(bone, voxel_mm)

    # move long axis to front for convenience
    b = np.moveaxis(bone, long_axis, 0)
    zs = np.where(b.any((1, 2)))[0]
    z0, z1 = int(zs[0]), int(zs[-1])
    span = z1 - z0

    edt = ndi.distance_transform_edt(b)
    thick = edt > np.percentile(edt[b], thick_pct)

    markers = np.zeros(b.shape, dtype=np.int32)
    lo_slab = slice(z0, z0 + max(1, int(seed_frac * span)))
    hi_slab = slice(z1 - max(1, int(seed_frac * span)), z1 + 1)
    markers[lo_slab][thick[lo_slab]] = 1  # low end
    markers[hi_slab][thick[hi_slab]] = 2  # high end

    ws = watershed(-edt, markers=markers, mask=b)
    low_mask = ws == 1
    high_mask = ws == 2

    # decide which end is femur
    conf = None
    if femur_end == "auto":
        femur_end, conf = _femur_end_by_condyles(low_mask, high_mask)
    if femur_end == "low":
        femur = low_mask
        tibia = high_mask
    else:
        femur = high_mask
        tibia = low_mask

    # move axis back
    femur = np.moveaxis(femur, 0, long_axis)
    tibia = np.moveaxis(tibia, 0, long_axis)

    notes = {
        "z_range": (z0, z1),
        "low_voxels": int(low_mask.sum()),
        "high_voxels": int(high_mask.sum()),
        "femur_end": femur_end,
        "femur_end_confidence": conf,   # None if user-specified; else dict
    }
    return Segmentation(
        bone=bone, femur=femur, tibia=tibia, long_axis=long_axis,
        femur_end=femur_end, threshold_hu=np.nan, voxel_mm=voxel_mm, notes=notes,
    )


def _femur_end_by_condyles(low_mask: np.ndarray, high_mask: np.ndarray):
    """Decide which split piece is the femur from condyle morphology.

    Near the joint, the distal femur separates into two condyles (the
    intercondylar notch splits each perpendicular cross-section into ~2
    connected components), whereas the tibial plateau is a single block.
    We score each piece by the mean number of cross-sectional components
    in the slab of slices nearest the joint; the higher-scoring piece is
    the femur.

    Both masks are oriented with the long axis at index 0. The joint side
    is the HIGH-z end of ``low_mask`` and the LOW-z end of ``high_mask``.

    Returns
    -------
    (femur_end, confidence) where femur_end in {'low','high'} and
    confidence is a dict {low_score, high_score, margin, method} so the
    caller can flag low-confidence assignments for QC.
    """
    def condyle_score(mask, joint_at_high):
        zc = np.where(mask.any((1, 2)))[0]
        if len(zc) < 6:
            return 1.0
        tip = zc[-max(3, len(zc)//12):] if joint_at_high else zc[:max(3, len(zc)//12)]
        counts = []
        min_area = max(20, int(0.02 * mask[tip].sum() / max(1, len(tip))))
        for z in tip:
            sl = mask[z]
            if sl.sum() < min_area:
                continue
            # drop specks before counting lobes
            _, nc = ndi.label(ndi.binary_opening(sl, iterations=1))
            counts.append(nc)
        return float(np.mean(counts)) if counts else 1.0

    s_low = condyle_score(low_mask, joint_at_high=True)
    s_high = condyle_score(high_mask, joint_at_high=False)
    femur_end = "low" if s_low >= s_high else "high"
    denom = max(s_low, s_high, 1e-6)
    conf = {
        "low_score": round(s_low, 3),
        "high_score": round(s_high, 3),
        "margin": round(abs(s_low - s_high) / denom, 3),
        "method": "condyle_count",
    }
    return femur_end, conf


def cut_quality(seg: "Segmentation") -> dict:
    """Quantify how clean the femur/tibia separation is.

    A clean cut at the joint constriction should:
      * assign essentially all bone to exactly one of the two labels
        (small unassigned remainder), and
      * meet along a thin, roughly planar interface near the joint — so
        the per-long-slice boundary between femur and tibia should be
        localized to a short band of the long axis, not smeared over the
        whole overlap region.

    Returns a dict with:
      unassigned_frac : bone voxels in neither femur nor tibia / total bone
      overlap_frac    : voxels labelled both (should be 0 by construction)
      interface_band_mm : long-axis spread (5-95 pct) of the set of long
        slices that contain the femur/tibia contact surface. Small = clean.
      contact_voxels  : number of femur voxels 26-adjacent to tibia.
    """
    femur, tibia, la, v = seg.femur, seg.tibia, seg.long_axis, seg.voxel_mm
    bone = seg.bone
    total = float(bone.sum())
    assigned = femur | tibia
    unassigned_frac = float((bone & ~assigned).sum()) / total if total else np.nan
    overlap_frac = float((femur & tibia).sum()) / total if total else np.nan

    # contact surface: tibia voxels touching a dilated femur
    fd = ndi.binary_dilation(femur, iterations=1)
    contact = tibia & fd
    cvox = int(contact.sum())
    if cvox:
        contact_long = np.moveaxis(contact, la, 0)
        zc = np.where(contact_long.any((1, 2)))[0]
        # per-slice contact counts -> weighted 5-95 pct spread
        counts = contact_long.reshape(contact_long.shape[0], -1).sum(1).astype(float)
        cdf = np.cumsum(counts) / counts.sum()
        z5 = np.searchsorted(cdf, 0.05)
        z95 = np.searchsorted(cdf, 0.95)
        band_mm = (z95 - z5) * v
    else:
        band_mm = np.nan
    return {
        "unassigned_frac": unassigned_frac,
        "overlap_frac": overlap_frac,
        "contact_voxels": cvox,
        "interface_band_mm": float(band_mm),
    }


def segment_knee(
    hu: np.ndarray,
    voxel_mm: float,
    threshold_hu: float = 2500.0,
    do_denoise: bool = True,
    median_size: int = 3,
    long_axis: Optional[int] = None,
    femur_end: str = "auto",
    downsample: int = 2,
) -> Segmentation:
    """Full segmentation: (downsample) -> denoise -> threshold -> clean ->
    femur/tibia split.

    ``downsample`` decimates the source volume by an integer factor before
    segmentation. The geometric landmarks are mm-scale, so 2x (≈21 µm for a
    10.5 µm scan) leaves them unchanged while cutting runtime ~8x. Set
    ``downsample=1`` for full-resolution masks. The returned masks are at
    the decimated resolution; ``seg.voxel_mm`` and ``seg.downsample`` record
    the scale so downstream code maps back to physical units correctly.
    """
    f = int(downsample)
    src = hu[::f, ::f, ::f] if f > 1 else hu
    seg_voxel = voxel_mm * f

    work = denoise(src, size=median_size) if do_denoise else src
    bone = threshold_bone(work, threshold_hu)
    bone = clean_mask(bone)
    seg = split_femur_tibia(bone, seg_voxel, long_axis=long_axis, femur_end=femur_end)
    seg.threshold_hu = float(threshold_hu)
    seg.downsample = f
    return seg
