"""
Per-sample QC overlays. Every sample gets one so the automatic landmark
placement and femur/tibia split can be visually confirmed or corrected.
"""
from __future__ import annotations

import numpy as np


def _mip_rgb(femur, tibia, collapse_axis):
    r = femur.max(collapse_axis).astype(float)
    g = tibia.max(collapse_axis).astype(float)
    return np.stack([r, g, np.zeros_like(r)], -1)


def qc_overlay(seg, fem_geo, tib_geo, out_path, title=""):
    """Render a two-panel (coronal + sagittal) QC overlay with landmarks.

    Long axis is assumed at index ``seg.long_axis``; masks are at seg
    resolution. Femur landmarks are in original (full-res) image coords and
    are scaled by ``seg.downsample`` for display.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    la = seg.long_axis
    femur = np.moveaxis(seg.femur, la, 0)
    tibia = np.moveaxis(seg.tibia, la, 0)

    def L(name):
        # Landmark coords are in the SAME (segmentation-resolution) grid as
        # the masks, so no rescaling — just reorder to (long, o1, o2).
        for lm in fem_geo.landmarks:
            if lm.name == name:
                zyx = np.array(lm.zyx, float)
                moved = [zyx[la]] + [zyx[a] for a in range(3) if a != la]
                return moved
        return None

    cor = _mip_rgb(femur, tibia, 1)   # collapse o1 -> (long, o2)
    sag = _mip_rgb(femur, tibia, 2)   # collapse o2 -> (long, o1)

    fig, ax = plt.subplots(1, 2, figsize=(11, 7))
    ax[0].imshow(cor, aspect="auto"); ax[0].set_title("Coronal  red=femur  green=tibia")
    ax[1].imshow(sag, aspect="auto"); ax[1].set_title("Sagittal")
    ax[0].set_xlabel("o2"); ax[0].set_ylabel("long (proximal→distal)")
    ax[1].set_xlabel("o1")

    colors = {"condyle_lateral": "cyan", "condyle_medial": "yellow",
              "intercondylar_notch": "magenta", "intercondylar_groove": "white"}
    for name, c in colors.items():
        p = L(name)
        if p is None:
            continue
        long_, o1, o2 = p
        ax[0].plot(o2, long_, "o", ms=9, mfc="none", mec=c, mew=2)
        ax[1].plot(o1, long_, "o", ms=9, mfc="none", mec=c, mew=2)

    lat, med = L("condyle_lateral"), L("condyle_medial")
    notch, groove = L("intercondylar_notch"), L("intercondylar_groove")
    if lat and med:
        ax[0].plot([lat[2], med[2]], [lat[0], med[0]], "-", color="cyan", lw=1.8,
                   label="width %.2f mm" % fem_geo.femur_width_mm)
    if notch and groove:
        ax[1].plot([notch[1], groove[1]], [notch[0], groove[0]], "-", color="white",
                   lw=1.8, label="length %.2f mm" % fem_geo.femur_length_mm)
    ax[0].legend(loc="lower left", fontsize=8); ax[1].legend(loc="lower left", fontsize=8)

    conf = seg.notes.get("femur_end_confidence") or {}
    margin = conf.get("margin", float("nan"))
    flag = "  ⚠ LOW-CONFIDENCE femur/tibia call" if (margin == margin and margin < 0.15) else ""
    fig.suptitle("%s   W/L=%.2f  (femur_end margin %.2f)%s" %
                 (title, fem_geo.wl_ratio, margin, flag), fontsize=12)
    fig.tight_layout()
    fig.savefig(out_path, dpi=100)
    import matplotlib.pyplot as _plt
    _plt.close(fig)
    return out_path
