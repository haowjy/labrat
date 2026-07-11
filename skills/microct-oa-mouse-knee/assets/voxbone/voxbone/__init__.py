"""
voxbone — a reusable pipeline for murine knee-joint micro-CT analysis.

Automates the hand-run Amira + Scanco workflow from Tang et al. into a
scriptable pipeline: DICOM -> segmentation -> femur/tibia split ->
geometric OA indices (distal-femur width/length ratio, tibial
compartment heights) + trabecular morphometry -> group stats + plots.

Typical use
-----------
    import voxbone as vb
    res = vb.run_sample("OA6-10RK.zip", voxel_mm=None)   # single sample
    df  = vb.run_batch("samples/", metadata="groups.csv")  # a study
    vb.analyze(df, group_col="group")                     # stats + plots
"""
from .io import load_volume, Volume
from .segment import segment_knee, cut_quality, Segmentation
from .geometry import measure_femur, measure_tibia
from .voi import tibial_subchondral_voi
from .morphometry import compute_morphometry, local_thickness, Morphometry
from .qc import qc_overlay
from .align import align_bone, shaft_long_axis, residual_tilt_deg
from .growth_plate import segment_growth_plate
from .refine3d import assess_placement, refine_landmarks
from .review import build_review_site
from .pipeline import run_sample, run_batch, SampleResult
from .stats import analyze

__all__ = [
    "load_volume", "Volume",
    "segment_knee", "cut_quality", "Segmentation",
    "measure_femur", "measure_tibia",
    "tibial_subchondral_voi",
    "compute_morphometry", "local_thickness", "Morphometry",
    "qc_overlay",
    "align_bone", "shaft_long_axis", "residual_tilt_deg",
    "segment_growth_plate",
    "assess_placement", "refine_landmarks",
    "build_review_site",
    "run_sample", "run_batch", "SampleResult",
    "analyze",
]

__version__ = "0.1.0"
