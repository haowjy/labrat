"""
Automated geometric indices of the distal femur and proximal tibia.

These reproduce the manual Amira ruler measurements from the source
paper, whose OA-severity index is the distal-femur width/length ratio
(width reflects osteophyte formation; length is largely OA-invariant).

Operational landmark definitions
--------------------------------
The paper places ruler endpoints by hand on a 3D model. Here we derive
the same quantities from the segmented femur / tibia masks using explicit
geometric rules, and emit the landmark coordinates so every measurement
can be checked on a QC overlay.

Axes: ``long`` = proximal-distal (from segmentation); the remaining two
image axes are assigned to mediolateral (ML) and anteroposterior (AP) by
epiphyseal spread — the femoral condyles are widest along ML.

  * Distal-femur WIDTH  = maximum ML extent across the condylar region
      (distal 20 % of the femur), i.e. lateral-condyle edge to
      medial-condyle edge. Increases with osteophytes.
  * Distal-femur LENGTH = proximal-distal distance from the midline
      intercondylar groove (proximal border of the intercondylar space)
      to the intercondylar notch (distal-most midline bone). Measured at
      the ML midline.
  * WL_RATIO = width / length  (the OA index).
  * Tibia WIDTH = maximum ML extent of the proximal tibia plateau.
  * Tibia medial/lateral compartment HEIGHT = proximal-distal distance
      from the plateau surface to the epiphyseal (growth-plate) line in
      each ML half.

All distances are returned in mm.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional

import numpy as np


@dataclass
class Landmark:
    name: str
    zyx: tuple           # voxel coordinate (in original image axes)

    def as_dict(self):
        return {"name": self.name, "z": int(self.zyx[0]),
                "y": int(self.zyx[1]), "x": int(self.zyx[2])}


@dataclass
class FemurGeometry:
    femur_length_mm: float
    femur_width_mm: float
    wl_ratio: float
    landmarks: list = field(default_factory=list)

    def as_dict(self):
        d = {"femur_length_mm": self.femur_length_mm,
             "femur_width_mm": self.femur_width_mm,
             "wl_ratio": self.wl_ratio}
        return d


@dataclass
class TibiaGeometry:
    tibia_width_mm: float
    med_compartment_height_mm: float
    lat_compartment_height_mm: float
    landmarks: list = field(default_factory=list)

    def as_dict(self):
        return {"tibia_width_mm": self.tibia_width_mm,
                "med_compartment_height_mm": self.med_compartment_height_mm,
                "lat_compartment_height_mm": self.lat_compartment_height_mm}


def _assign_ml_ap(mask: np.ndarray, long_axis: int):
    """Return (ml_axis, ap_axis): the epiphysis is widest along ML."""
    others = [a for a in range(3) if a != long_axis]
    # measure extent of the distal-epiphysis slab along each candidate axis
    b = np.moveaxis(mask, long_axis, 0)
    zs = np.where(b.any((1, 2)))[0]
    # use both ends' epiphyses (widest 15% near each joint end) — take global
    slab = b[zs[len(zs)//2:]]  # distal half (arbitrary but consistent)
    extents = {}
    for ax_pos, orig_ax in zip((1, 2), others):
        prof = slab.any(axis=(0, 3 - ax_pos)) if False else None
    # simpler: max ML extent = axis with larger 95th-pct spread in epiphysis
    coords = np.array(np.where(slab))  # 3 x N in (long, o1, o2)
    spreads = []
    for i in (1, 2):
        c = coords[i]
        spreads.append(np.percentile(c, 97.5) - np.percentile(c, 2.5))
    if spreads[0] >= spreads[1]:
        ml_axis, ap_axis = others[0], others[1]
    else:
        ml_axis, ap_axis = others[1], others[0]
    return ml_axis, ap_axis


def _dist3_mm(p, q, voxel_mm: float) -> float:
    """Straight-line 3D Euclidean distance between two (z,y,x) voxel points.

    This is the paper's landmark definition ("straight-line distance
    between ...") and is rotation-invariant, so widths/lengths are the same
    whether measured in raw scanner axes or an anatomically aligned frame.
    """
    p = np.asarray(p, float); q = np.asarray(q, float)
    return float(np.linalg.norm(p - q)) * voxel_mm


def _joint_end(mask: np.ndarray, companion: np.ndarray, long_axis: int) -> str:
    """Which long-axis end of ``mask`` faces the ``companion`` bone.

    Robust joint localization: the articular (joint) end of a bone is the
    end nearest the other bone. Returns 'high' or 'low' (position along the
    long axis of the mask's own extent).
    """
    b = np.moveaxis(mask, long_axis, 0)
    c = np.moveaxis(companion, long_axis, 0)
    zs = np.where(b.any((1, 2)))[0]
    cz = np.where(c.any((1, 2)))[0]
    if len(cz) == 0:
        return "high"
    comp_center = 0.5 * (cz[0] + cz[-1])
    # end whose z is closer to the companion centre
    return "high" if abs(zs[-1] - comp_center) < abs(zs[0] - comp_center) else "low"


def measure_femur(femur: np.ndarray, long_axis: int, voxel_mm: float,
                  femur_end: str, companion: Optional[np.ndarray] = None,
                  distal_frac: float = 0.25) -> FemurGeometry:
    """Distal-femur width, length and W/L ratio.

    Joint (distal) end is located from the companion tibia when provided
    (robust); otherwise falls back to the wider-epiphysis end.

    Definitions (Tang et al.):
      * WIDTH  = max mediolateral extent across the condylar slab
                 (lateral↔medial condyle edges; grows with osteophytes).
      * LENGTH = proximal-distal midline distance from the intercondylar
                 groove (proximal border of the intercondylar fossa, where
                 the condyles merge) to the intercondylar notch (distal-most
                 midline bone). A *local* distal-femur dimension.
    """
    ml_axis, ap_axis = _assign_ml_ap(femur, long_axis)
    b = np.moveaxis(femur, long_axis, 0)
    remaining = [a for a in range(3) if a != long_axis]
    ml_pos = 1 if remaining[0] == ml_axis else 2
    ap_pos = 3 - ml_pos

    zs = np.where(b.any((1, 2)))[0]
    z_lo, z_hi = int(zs[0]), int(zs[-1])
    span = z_hi - z_lo
    n = max(3, int(distal_frac * span))

    # locate joint (distal) end
    if companion is not None:
        end = _joint_end(femur, companion, long_axis)
    else:
        def ml_spread(sl):
            cc = np.array(np.where(b[sl]))
            return 0.0 if cc.shape[1] == 0 else (
                np.percentile(cc[ml_pos], 97.5) - np.percentile(cc[ml_pos], 2.5))
        end = "high" if ml_spread(slice(z_hi - n, z_hi + 1)) >= \
            ml_spread(slice(z_lo, z_lo + n)) else "low"
    joint_at_high = (end == "high")
    epi = slice(z_hi - n, z_hi + 1) if joint_at_high else slice(z_lo, z_lo + n)

    def to_orig(local_long, o1, o2, slab_start=0):
        orig = np.zeros(3, dtype=int)
        orig[long_axis] = slab_start + local_long
        orig[remaining[0]] = o1
        orig[remaining[1]] = o2
        return tuple(int(v) for v in orig)

    # ---- WIDTH: condyle-to-condyle ML extent in the distal slab ----
    cc = np.array(np.where(b[epi]))
    ml_vals = cc[ml_pos]
    lo_i, hi_i = ml_vals.argmin(), ml_vals.argmax()
    lm_lat = to_orig(cc[0][lo_i], cc[1][lo_i], cc[2][lo_i], epi.start)
    lm_med = to_orig(cc[0][hi_i], cc[1][hi_i], cc[2][hi_i], epi.start)
    # WIDTH = straight-line 3D distance between the condyle-edge landmarks
    # (paper definition; rotation-invariant), not a single-axis extent.
    femur_width_mm = _dist3_mm(lm_lat, lm_med, voxel_mm)
    ml_mid = int(round(0.5 * (ml_vals.max() + ml_vals.min())))

    # ---- LENGTH: intercondylar groove -> notch along the midline ----
    # At the joint surface the two condyles are separated by the open
    # intercondylar fossa, so the AP-depth of bone in the midline ML band is
    # near zero; proceeding proximally the condyles merge (the trochlear /
    # intercondylar groove) and the midline AP-depth jumps to the full
    # epiphyseal depth. We detect that transition:
    #   notch_z  = distal-most midline bone voxel (joint surface)
    #   groove_z = the level (moving proximally from the joint) where midline
    #              AP-depth first crosses 50 % of its distal-region maximum.
    # femur_length = |groove_z - notch_z|.
    half = max(2, span // 120)
    if joint_at_high:
        distal_region = slice(max(z_lo, z_hi - 2 * n), z_hi + 1)
        march = range(distal_region.stop - 1, distal_region.start - 1, -1)  # distal->proximal
    else:
        distal_region = slice(z_lo, min(z_hi, z_lo + 2 * n) + 1)
        march = range(distal_region.start, distal_region.stop)

    ap_depth = {}
    ml_band = slice(max(0, ml_mid - half), ml_mid + half + 1)
    for z in range(distal_region.start, distal_region.stop):
        idx2 = [slice(None)] * 3
        idx2[0] = z
        idx2[ml_pos] = ml_band
        sl = b[tuple(idx2)]              # 2D: (ap-ish, ...) but ml collapsed to band
        pts = np.where(sl)
        if len(pts[0]) == 0:
            ap_depth[z] = 0.0
            continue
        ap2d = ap_pos - 1               # ap index within the 2D slice
        ap_depth[z] = float(pts[ap2d].max() - pts[ap2d].min())

    # notch = distal-most midline bone (deepest point of intercondylar notch)
    notch_z = next((z for z in march if ap_depth.get(z, 0.0) > 0
                    or b.take(z, axis=0)[ml_band].any()),
                   z_hi if joint_at_high else z_lo)
    # plateau (merged-condyle / trochlear) depth = 90th pct of midline depths;
    # robust to the shallow notch region and to isolated deep shaft voxels.
    all_depths = np.array([ap_depth.get(z, 0.0)
                           for z in range(distal_region.start, distal_region.stop)])
    plateau = np.percentile(all_depths[all_depths > 0], 90) if (all_depths > 0).any() else 0.0
    # groove = marching proximally FROM the notch, the first level where the
    # midline AP-depth first reaches 50 % of the plateau (the step where the
    # two condyles merge into the trochlear groove).
    thr = 0.5 * plateau
    march_from_notch = (range(notch_z - 1, distal_region.start - 1, -1)
                        if joint_at_high else range(notch_z + 1, distal_region.stop))
    groove_z = notch_z
    for z in march_from_notch:
        if plateau > 0 and ap_depth.get(z, 0.0) >= thr:
            groove_z = z
            break

    def midline_point(z_move):
        idx2 = [slice(None)] * 3
        idx2[0] = z_move
        idx2[ml_pos] = ml_band
        sl = b[tuple(idx2)]
        pts = np.where(sl)
        if len(pts[0]) == 0:
            return to_orig(z_move, ml_mid, 0)
        o = [0, 0]
        # reconstruct remaining-axis centroid (ml fixed at ml_mid)
        ap2d = ap_pos - 1
        ap_center = int(round(pts[ap2d].mean())) + (ml_band.start if ap_pos < ml_pos else 0)
        # simpler: put point at ml_mid and AP centroid
        ap_full = int(round(pts[ap2d].mean()))
        if ml_pos == 1:
            return to_orig(z_move, ml_mid, ap_full)
        else:
            return to_orig(z_move, ap_full, ml_mid)
    lm_notch = midline_point(notch_z)
    lm_groove = midline_point(groove_z)
    # LENGTH = straight-line 3D distance between groove and notch landmarks
    # (paper definition; rotation-invariant).
    femur_length_mm = _dist3_mm(lm_notch, lm_groove, voxel_mm)

    wl = femur_width_mm / femur_length_mm if femur_length_mm > 0 else float("nan")
    lms = [Landmark("condyle_lateral", lm_lat), Landmark("condyle_medial", lm_med),
           Landmark("intercondylar_notch", lm_notch),
           Landmark("intercondylar_groove", lm_groove)]
    return FemurGeometry(femur_length_mm=femur_length_mm,
                         femur_width_mm=femur_width_mm, wl_ratio=wl, landmarks=lms)


def measure_tibia(tibia: np.ndarray, long_axis: int, voxel_mm: float,
                  companion: Optional[np.ndarray] = None,
                  proximal_frac: float = 0.35) -> TibiaGeometry:
    """Proximal-tibia width and medial/lateral compartment heights.

    Plateau (proximal) end is located from the companion femur when
    provided (robust); otherwise falls back to the wider-epiphysis end.
    """
    ml_axis, ap_axis = _assign_ml_ap(tibia, long_axis)
    b = np.moveaxis(tibia, long_axis, 0)
    remaining = [a for a in range(3) if a != long_axis]
    ml_pos = 1 if remaining[0] == ml_axis else 2

    zs = np.where(b.any((1, 2)))[0]
    z_lo, z_hi = int(zs[0]), int(zs[-1])
    span = z_hi - z_lo
    n = max(3, int(proximal_frac * span))

    if companion is not None:
        plateau_at_low = (_joint_end(tibia, companion, long_axis) == "low")
    else:
        def ml_spread(zslab):
            cc = np.array(np.where(b[zslab]))
            return 0.0 if cc.shape[1] == 0 else (
                np.percentile(cc[ml_pos], 97.5) - np.percentile(cc[ml_pos], 2.5))
        plateau_at_low = ml_spread(slice(z_lo, z_lo + n)) >= \
            ml_spread(slice(z_hi - n, z_hi + 1))
    epi = slice(z_lo, z_lo + n) if plateau_at_low else slice(z_hi - n, z_hi + 1)

    cc = np.array(np.where(b[epi]))
    ml_vals = cc[ml_pos]
    lo_i, hi_i = ml_vals.argmin(), ml_vals.argmax()

    def _to_orig(local_long, o1, o2, slab_start):
        orig = np.zeros(3, dtype=int)
        orig[long_axis] = slab_start + local_long
        rem = [a for a in range(3) if a != long_axis]
        orig[rem[0]] = o1
        orig[rem[1]] = o2
        return tuple(int(v) for v in orig)

    tib_lat = _to_orig(cc[0][lo_i], cc[1][lo_i], cc[2][lo_i], epi.start)
    tib_med = _to_orig(cc[0][hi_i], cc[1][hi_i], cc[2][hi_i], epi.start)
    # WIDTH = straight-line 3D distance between medial/lateral tibial condyle
    # border landmarks (paper definition; rotation-invariant).
    tibia_width_mm = _dist3_mm(tib_lat, tib_med, voxel_mm)
    ml_mid = int(round((ml_vals.max() + ml_vals.min()) / 2))

    # Compartment height (paper: "distance between midpoint of tibial
    # plateau and epiphyseal line"). Restricted to the proximal-epiphysis
    # slab `epi`; measured per ML half as the proximal-distal run of bone
    # from the plateau (articular) surface down to the epiphyseal line
    # (first substantial growth-plate gap). The plateau surface side of the
    # epiphysis is the low-z end when plateau_at_low, else the high-z end.
    epi_start, epi_stop = epi.start, epi.stop
    ap_pos = 3 - ml_pos  # the remaining in-plane axis

    def half_height(ml_lo, ml_hi):
        idx = [slice(None)] * 3
        idx[0] = slice(epi_start, epi_stop)         # <-- restrict to epiphysis
        idx[ml_pos] = slice(ml_lo, ml_hi)
        sub = b[tuple(idx)]                          # (long_epi, a, a)
        # occupancy profile along the long (proximal-distal) axis
        occ = sub.any(axis=tuple(a for a in range(3) if a != 0))
        zc = np.where(occ)[0]
        if len(zc) == 0:
            return 0.0
        # walk inward from the plateau surface until the first growth-plate
        # gap (a run of empty long-axis slices), giving surface->epiphyseal-
        # line distance rather than the whole epiphysis span.
        order = range(len(occ)) if plateau_at_low else range(len(occ) - 1, -1, -1)
        started = False
        gap = 0
        count = 0
        gap_tol = max(2, int(0.04 * (epi_stop - epi_start)))
        for k in order:
            if occ[k]:
                started = True
                count += 1 + gap
                gap = 0
            elif started:
                gap += 1
                if gap >= gap_tol:
                    break
        return count * voxel_mm
    # medial vs lateral split at midline; which side is medial depends on
    # mounting — reported as (med, lat) but user can swap after QC.
    h_low = half_height(ml_vals.min(), ml_mid)
    h_high = half_height(ml_mid, ml_vals.max() + 1)

    g = TibiaGeometry(tibia_width_mm=tibia_width_mm,
                      med_compartment_height_mm=h_low,
                      lat_compartment_height_mm=h_high,
                      landmarks=[Landmark("tibial_condyle_lateral", tib_lat),
                                 Landmark("tibial_condyle_medial", tib_med)])
    return g
