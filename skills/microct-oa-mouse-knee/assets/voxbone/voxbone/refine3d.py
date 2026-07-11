"""3D-aware landmark assessment and refinement.

The first-pass landmarks are picked as ML-extreme voxels over a whole
epiphysis slab, independently per point. That lets the two condyle-edge
points of a WIDTH measurement land at very different anterior-posterior (AP)
depths, so the straight-line distance is measured across a diagonal rather
than the true medial-lateral width the paper defines (and, symmetrically, a
LENGTH line can drift off the proximal-distal axis).

This module adds the 3D check that a human would do by eye:

  * assess_placement(...) scores each measurement line by how well it aligns
    with the axis it is supposed to lie on (WIDTH -> medial-lateral,
    LENGTH -> proximal-distal), and flags lines whose off-axis component is
    too large.
  * refine_landmarks(...) loops: assess in 3D -> if a WIDTH line fails,
    re-pick its two endpoints constrained to a **common frontal plane**
    (a thin AP band), which is what forces the line onto the ML axis ->
    re-assess. It keeps the change only if the 3D score improves, and stops
    when everything passes or no further improvement is found.

All distances remain rotation-invariant 3D straight-line distances; the
refinement changes *which voxels* are chosen, not how they are measured.

NOTE on method provenance: the paper measures femoral width/length as direct
3D straight-line distances between *manually placed* voxels, with no
frontal-plane constraint (the max-height ortho slice is tibia-specific). The
common-frontal-plane re-pick here is a voxbone **engineering heuristic** to
make the automatic first guess lie along the medial-lateral axis; it is not the
paper's protocol, and its output is still meant to be confirmed in the review
UI against the user's manual placement.
"""
from __future__ import annotations
import numpy as np
from .geometry import _dist3_mm, _assign_ml_ap, Landmark

# how each measured line SHOULD be oriented, by the anatomy it spans
_LINE_AXIS = {
    "femur_width": "ML",
    "femur_length": "PD",     # proximal-distal
    "tibia_width": "ML",
}
# landmark pairs that define each line
_LINE_PAIR = {
    "femur_width": ("condyle_lateral", "condyle_medial"),
    "femur_length": ("intercondylar_notch", "intercondylar_groove"),
    "tibia_width": ("tibial_condyle_lateral", "tibial_condyle_medial"),
}


def _axes(mask, long_axis):
    ml_axis, ap_axis = _assign_ml_ap(mask, long_axis)
    return dict(ML=ml_axis, AP=ap_axis, PD=long_axis)


def _lm_dict(geo):
    return {lm.name: np.asarray(lm.zyx, float) for lm in geo.landmarks}


def assess_line(p, q, want_axis, axes, voxel_mm):
    """Return metrics for one line: total length, the fraction of that length
    that lies OFF the intended axis, and a pass flag."""
    d = (p - q) * voxel_mm                       # (z,y,x) mm vector
    total = float(np.linalg.norm(d))
    ax = axes[want_axis]
    on = abs(float(d[ax]))                        # component along intended axis
    off = float(np.sqrt(max(total**2 - on**2, 0.0)))
    off_frac = off / total if total > 0 else 1.0
    return dict(length_mm=round(total, 3), on_axis_mm=round(on, 3),
                off_axis_mm=round(off, 3), off_frac=round(off_frac, 3))


def assess_placement(fem, tib, fem_mask, tib_mask, long_axis, voxel_mm,
                     off_frac_tol=0.35):
    """3D acceptance check for every measurement line. Returns
    {line: {..metrics.., pass: bool}} plus an overall 'all_pass'."""
    fem_axes = _axes(fem_mask, long_axis)
    tib_axes = _axes(tib_mask, long_axis)
    L = {**_lm_dict(fem), **_lm_dict(tib)}
    out = {}
    for line, (a, b) in _LINE_PAIR.items():
        if a not in L or b not in L:
            continue
        axes = fem_axes if line.startswith("femur") else tib_axes
        m = assess_line(L[a], L[b], _LINE_AXIS[line], axes, voxel_mm)
        m["pass"] = m["off_frac"] <= off_frac_tol
        out[line] = m
    out["all_pass"] = all(v["pass"] for k, v in out.items() if isinstance(v, dict))
    return out


def _repick_width_common_plane(mask, long_axis, joint_at_low, axes,
                               ap_band_frac=0.12, slab_frac=0.30):
    """Re-pick the two ML-extreme condyle-edge points within a COMMON frontal
    plane. The plane is the AP position where the epiphysis is widest in ML
    (the true condylar width plane); points are taken from a thin AP band
    around it, so the connecting line lies on the ML axis.

    Returns (lat_pt, med_pt) as original-frame (z,y,x) int tuples.
    """
    b = np.moveaxis(mask, long_axis, 0)
    rem = [a for a in range(3) if a != long_axis]
    ml_pos = 1 if rem[0] == axes["ML"] else 2
    ap_pos = 3 - ml_pos
    zs = np.where(b.any((1, 2)))[0]
    z_lo, z_hi = int(zs[0]), int(zs[-1]); span = z_hi - z_lo
    n = max(3, int(slab_frac * span))
    epi = slice(z_lo, z_lo + n) if joint_at_low else slice(z_hi - n, z_hi + 1)
    sub = b[epi]                                   # (long, r1, r2)
    coords = np.array(np.where(sub))               # 3 x N
    if coords.shape[1] == 0:
        return None, None
    ml_local = coords[ml_pos]
    ap_local = coords[ap_pos]
    # choose the AP plane where ML spread is greatest (condylar width plane)
    ap_vals = np.unique(ap_local)
    best_ap, best_spread = ap_vals[len(ap_vals) // 2], -1
    for apv in ap_vals:
        sel = ap_local == apv
        if sel.sum() < 5:
            continue
        spread = ml_local[sel].max() - ml_local[sel].min()
        if spread > best_spread:
            best_spread, best_ap = spread, apv
    band = max(1, int(ap_band_frac * (ap_local.max() - ap_local.min() + 1)))
    inband = np.abs(ap_local - best_ap) <= band
    if inband.sum() < 2:
        inband = np.ones_like(ap_local, bool)
    mlb = ml_local[inband]
    lo_i = np.where(inband)[0][mlb.argmin()]
    hi_i = np.where(inband)[0][mlb.argmax()]

    def to_orig(i):
        o = np.zeros(3, int); o[long_axis] = epi.start + coords[0][i]
        o[rem[0]] = coords[1][i]; o[rem[1]] = coords[2][i]
        return tuple(int(x) for x in o)
    return to_orig(lo_i), to_orig(hi_i)


def refine_landmarks(seg, fem, tib, voxel_mm, off_frac_tol=0.35, max_iter=3,
                     verbose=False):
    """Iterate: assess in 3D -> re-pick failing WIDTH lines on a common frontal
    plane -> re-measure -> keep the change only if the 3D off-axis score
    improves. Returns (fem, tib, log) where log lists the per-iteration
    assessment. fem/tib are mutated copies with refined landmarks + widths.
    """
    from copy import deepcopy
    from .geometry import _joint_end
    fem = deepcopy(fem); tib = deepcopy(tib)
    long_axis = seg.long_axis
    log = []
    for it in range(max_iter):
        a = assess_placement(fem, tib, seg.femur, seg.tibia, long_axis, voxel_mm,
                             off_frac_tol)
        log.append(a)
        if verbose:
            print("iter", it, {k: v.get("off_frac") for k, v in a.items() if isinstance(v, dict)})
        if a["all_pass"]:
            break
        improved = False
        # only WIDTH lines are re-pickable on a plane; LENGTH is handled by
        # the AP-depth method in geometry and is left as-is here.
        for line in ("femur_width", "tibia_width"):
            if line not in a or a[line]["pass"]:
                continue
            geo = fem if line == "femur_width" else tib
            mask = seg.femur if line == "femur_width" else seg.tibia
            comp = seg.tibia if line == "femur_width" else seg.femur
            axes = _axes(mask, long_axis)
            joint_at_low = (_joint_end(mask, comp, long_axis) == "low")
            lat, med = _repick_width_common_plane(mask, long_axis, joint_at_low, axes)
            if lat is None:
                continue
            names = _LINE_PAIR[line]
            old = {lm.name: lm.zyx for lm in geo.landmarks}
            new_lm = []
            for lm in geo.landmarks:
                if lm.name == names[0]:
                    new_lm.append(Landmark(lm.name, lat))
                elif lm.name == names[1]:
                    new_lm.append(Landmark(lm.name, med))
                else:
                    new_lm.append(lm)
            new_width = _dist3_mm(lat, med, voxel_mm)
            # accept only if off-axis fraction actually drops
            trial_axes = axes
            m_new = assess_line(np.asarray(lat, float), np.asarray(med, float),
                                _LINE_AXIS[line], trial_axes, voxel_mm)
            if m_new["off_frac"] < a[line]["off_frac"] - 1e-3:
                geo.landmarks = new_lm
                if line == "femur_width":
                    geo.femur_width_mm = new_width
                else:
                    geo.tibia_width_mm = new_width
                improved = True
        if not improved:
            break
    final = assess_placement(fem, tib, seg.femur, seg.tibia, long_axis, voxel_mm,
                            off_frac_tol)
    log.append(final)
    return fem, tib, log
