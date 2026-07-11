"""Build the interactive HTML review site for one sample.

Emits a self-contained folder (index.html + femur.html + tibia.html +
shared.css + shared.js + data/*.js) that opens from ``file://`` on desktop or
mobile with nothing installed. See REVIEW_UI_SPEC.md for the UI contract.

    build_review_site(seg, fem, tib, out_dir, gp_mask=None, measurements=None)

Data ships as ``data/*.js`` files assigning to ``window`` globals (loaded via
``<script>`` tags) rather than JSON fetched at runtime, because browsers block
``fetch()`` of local files under the ``file://`` CORS policy.
"""
from __future__ import annotations
import os
import io
import json
import base64
import shutil
import numpy as np
from scipy import ndimage as ndi

from .align import align_bone, aligned_coord

_ASSETS = os.path.join(os.path.dirname(__file__), "review_assets")


def _need_pillow():
    try:
        from PIL import Image  # noqa: F401
    except Exception as e:  # noqa: BLE001
        raise ImportError("review site needs Pillow (pip install pillow)") from e


def _jpg(gray, q=90):
    from PIL import Image
    buf = io.BytesIO(); Image.fromarray(gray, "L").save(buf, "JPEG", quality=q)
    return base64.b64encode(buf.getvalue()).decode()


def _png(rgba):
    from PIL import Image
    buf = io.BytesIO(); Image.fromarray(rgba).save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def _crop_bounds(mask, pad=5):
    zs = np.where(mask.any((1, 2)))[0]; ys = np.where(mask.any((0, 2)))[0]; xs = np.where(mask.any((0, 1)))[0]
    return (max(0, zs[0] - pad), min(mask.shape[0], zs[-1] + pad),
            max(0, ys[0] - pad), min(mask.shape[1], ys[-1] + pad),
            max(0, xs[0] - pad), min(mask.shape[2], xs[-1] + pad))


def _mpr(hu_al, m_al, col, step=1, q=90, window_hu=3500.0):
    """Build coronal/sagittal/axial slice stacks (base64) for one aligned bone."""
    den = ndi.median_filter(hu_al, size=2)          # cleaned display volume
    z0, z1, y0, y1, x0, x1 = _crop_bounds(m_al)
    hc = den[z0:z1, y0:y1, x0:x1][::step, ::step, ::step]
    mc = m_al[z0:z1, y0:y1, x0:x1][::step, ::step, ::step]
    Z, Y, X = hc.shape

    def norm(sl):
        return (np.clip(sl / window_hu, 0, 1) * 255).astype(np.uint8)

    def stack(ax):
        gs, ov = [], []
        for i in range(hc.shape[ax]):
            sl = np.take(hc, i, ax); ms = np.take(mc, i, ax)
            gs.append(_jpg(norm(sl), q))
            o = np.zeros((*ms.shape, 4), np.uint8); o[ms] = list(col) + [90]
            ov.append(_png(o))
        return dict(gray=gs, over=ov, n=int(hc.shape[ax]),
                    shape=[int(s) for s in np.take(hc, 0, ax).shape])
    return dict(coronal=stack(1), sagittal=stack(2), axial=stack(0),
                shape=[Z, Y, X], crop_origin=[int(z0), int(y0), int(x0)], step=step)


def _mesh(mask, step, sc, smooth=1.0, level=0.5):
    from skimage import measure
    m = mask.astype(np.float32)
    if smooth:
        m = ndi.gaussian_filter(m, smooth)
    m = m[::step, ::step, ::step]
    if m.max() < level:
        return dict(x=[], y=[], z=[], i=[], j=[], k=[])
    vv, ff, _, _ = measure.marching_cubes(m, level=level)
    vv = (vv * step).astype(np.float32)
    return dict(x=(vv[:, 2] * sc).round(3).tolist(), y=(vv[:, 1] * sc).round(3).tolist(),
                z=(vv[:, 0] * sc).round(3).tolist(),
                i=ff[:, 0].tolist(), j=ff[:, 1].tolist(), k=ff[:, 2].tolist())


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_clean(v) for v in o]
    return o.item() if hasattr(o, "item") else o


def build_review_site(seg, fem, tib, out_dir="review_site", gp_mask=None,
                       measurements=None, sample_id=None, slice_step=1,
                       mesh_step=3):
    """Generate the review folder. Returns the output directory path.

    seg  : Segmentation (has .femur, .tibia, .voxel_mm, .femur_end, .notes,
           .downsample, .long_axis)
    fem  : FemurGeometry, tib : TibiaGeometry (carry .landmarks, .as_dict())
    gp_mask : optional growth-plate mask in the seg grid (for the 3D scene)
    measurements : optional dict to override/augment fem+tib .as_dict()
    """
    _need_pillow()
    sid = sample_id or getattr(seg, "sample_id", "sample")
    v = seg.voxel_mm
    fem_hi = (seg.femur_end == "high")

    # per-bone anatomical alignment (display only; measurements are unchanged).
    # align_bone needs an HU display volume; the caller passes masks, so
    # synthesize a bone-valued display volume (threshold surrogate).
    def disp(mask):
        return (mask.astype(np.float32) * 3500.0)
    Rf, fem_hu_al, fem_al, ctr_f, tf0, tf1 = align_bone(seg.femur, disp(seg.femur), fem_hi)
    Rt, tib_hu_al, tib_al, ctr_t, tt0, tt1 = align_bone(seg.tibia, disp(seg.tibia), False)

    fem_col, tib_col = [192, 57, 43], [36, 113, 163]
    fem_mpr = _mpr(fem_hu_al, fem_al, fem_col, step=slice_step)
    tib_mpr = _mpr(tib_hu_al, tib_al, tib_col, step=slice_step)

    shape = seg.femur.shape

    def off_of(R, ctr):
        return ctr - R.T @ (np.array(shape) / 2.0)
    off_f, off_t = off_of(Rf, ctr_f), off_of(Rt, ctr_t)

    def rec(lm, bone, R, off):
        z, y, x = [int(c) for c in lm.zyx]
        az, ay, ax = aligned_coord((z, y, x), R, off, shape)
        return dict(name=lm.name, bone=bone,
                    mx=round(x * v, 3), my=round(y * v, 3), mz=round(z * v, 3),
                    az=float(round(az, 2)), ay=float(round(ay, 2)), ax=float(round(ax, 2)))
    LM_fem = [rec(l, "femur", Rf, off_f) for l in fem.landmarks]
    LM_tib = [rec(l, "tibia", Rt, off_t) for l in tib.landmarks]

    meas = {}
    meas.update(fem.as_dict()); meas.update(tib.as_dict())
    if measurements:
        meas.update(measurements)
    meas = {k: (round(x, 4) if isinstance(x, float) else x) for k, x in meas.items()}

    conf = (seg.notes or {}).get("femur_end_confidence", {}) or {}
    xf = dict(femur=dict(Rt=Rf.T.tolist(), off=off_f.tolist(),
                         crop=fem_mpr["crop_origin"], step=fem_mpr["step"]),
              tibia=dict(Rt=Rt.T.tolist(), off=off_t.tolist(),
                         crop=tib_mpr["crop_origin"], step=tib_mpr["step"]),
              voxel_mm=v)
    meta = dict(sample_id=sid, voxel_mm=v, xf=xf, landmarks=LM_fem + LM_tib,
                measurements=meas,
                seg_notes=dict(femur_end=seg.femur_end,
                               femur_end_margin=round(conf.get("margin", float("nan")), 3)),
                align=dict(femur_tilt=round(tf1, 1), tibia_tilt=round(tt1, 1)))

    # meshes
    f = getattr(seg, "downsample", 1)
    meshes = dict(femur=_mesh(seg.femur, mesh_step, v),
                  tibia=_mesh(seg.tibia, mesh_step, v))
    if gp_mask is not None:
        meshes["growth_plate"] = _mesh(gp_mask.astype(bool), max(1, mesh_step - 1), v, smooth=0.6, level=0.6)
        gs = np.where(gp_mask.any((1, 2)))[0]
        if len(gs):
            meta["gp_stats"] = dict(thickness_mm=None)  # caller may fill via measurements
    else:
        meshes["growth_plate"] = dict(x=[], y=[], z=[], i=[], j=[], k=[])
    meta.setdefault("gp_stats", dict(thickness_mm=None,
                                     z_lo_mm_from_plateau=None, z_hi_mm_from_plateau=None))

    # write folder
    os.makedirs(os.path.join(out_dir, "data"), exist_ok=True)
    for name in ("shared.css", "shared.js", "index.html", "femur.html", "tibia.html"):
        shutil.copyfile(os.path.join(_ASSETS, name), os.path.join(out_dir, name))

    def dump_js(var, obj, fn):
        with open(os.path.join(out_dir, "data", fn), "w") as fh:
            fh.write("window.%s=" % var)
            json.dump(_clean(obj), fh, separators=(",", ":"))
            fh.write(";")
    dump_js("BM_META", meta, "meta.js")
    dump_js("BM_MESHES", meshes, "meshes.js")
    dump_js("BM_femur", dict(mpr=fem_mpr, landmarks=LM_fem), "femur.js")
    dump_js("BM_tibia", dict(mpr=tib_mpr, landmarks=LM_tib), "tibia.js")
    return out_dir
