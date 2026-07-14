import json, math
import numpy as np

base = "artifacts"
results = json.load(open(f"{base}/measurements/results.json"))
spacing = json.load(open(f"{base}/spacing.json"))
orient = json.load(open(f"{base}/landmarks/orientation_frame.json"))
positions = json.load(open(f"{base}/landmarks/positions.json"))

vox = spacing["spacing_mm"][0]
print("voxel size mm:", vox, "matches results:", results["voxel_size_mm"])

idx = results["indices"]

# 1. W/L reproduction
w = idx["distal_femoral_width"]["value_mm"]
l = idx["distal_femoral_length"]["value_mm"]
wl_reported = idx["distal_femoral_ratio"]["value"]
wl_recomp = w / l
print("W/L recompute:", wl_recomp, "reported:", wl_reported, "match1%:", abs(wl_recomp-wl_reported)/wl_reported < 0.01)

# recompute length and width from native points directly
def euclid(p1, p2, vox):
    p1 = np.array(p1); p2 = np.array(p2)
    return np.linalg.norm(p1-p2) * vox

len_pts = idx["distal_femoral_length"]["points"]
length_recomp = euclid(len_pts["intercondylar_groove_midpoint"], len_pts["intercondylar_notch"], vox)
print("length recompute (3d euclid):", length_recomp, "reported:", l)

width_pts = idx["distal_femoral_width"]["points"]
width_recomp_3d = euclid(width_pts["lateral_condylar_edge"], width_pts["medial_condylar_edge"], vox)
print("width recompute (3d euclid, NOT frontal-projected):", width_recomp_3d, "reported:", w, "cross_check_3d:", idx["distal_femoral_width"].get("cross_check_3d_mm"))

# 2. IIOC height recompute via transform, from native points (not reading upstream reported value)
tr = orient["tibial_reorientation"]
R = np.array(tr["rotation_matrix"])
pivot = np.array(tr["pivot_zyx"])
grid_center = np.array(tr["grid_center_zyx"])

def forward(native_zyx):
    native = np.array(native_zyx, dtype=float)
    return R @ (native - pivot) + grid_center

art_native = idx["tibial_iioc_height"]["native_points"]["articular_surface_proximal"]
gp_native = idx["tibial_iioc_height"]["native_points"]["growth_plate_proximal"]

art_r = forward(art_native)
gp_r = forward(gp_native)
print("reoriented articular rz:", art_r[0], "reported reoriented_rz.articular:", idx["tibial_iioc_height"]["reoriented_rz"]["articular"])
print("reoriented growth_plate rz:", gp_r[0], "reported reoriented_rz.growth_plate:", idx["tibial_iioc_height"]["reoriented_rz"]["growth_plate"])

height_vox_recomp = abs(art_r[0] - gp_r[0])
height_mm_recomp = height_vox_recomp * vox
print("height recompute (vox):", height_vox_recomp, "mm:", height_mm_recomp)
print("reported height vox:", idx["tibial_iioc_height"]["value_vox"], "mm:", idx["tibial_iioc_height"]["value_mm"])
print("within 1 slice (vox):", abs(height_vox_recomp - idx["tibial_iioc_height"]["value_vox"]) <= 1)

# cross check against orientation_frame.json's own persisted values
print("orientation_frame iioc_height_vox:", tr["iioc_height_vox"], "iioc_height_mm:", tr["iioc_height_mm"])

# 3. H/W ratio reproduction
tw = idx["tibial_width"]["value_mm"]
h = idx["tibial_iioc_height"]["value_mm"]
hw_reported = idx["tibial_iioc_ratio"]["value"]
hw_recomp = h / tw
print("H/W recompute:", hw_recomp, "reported:", hw_reported, "match1%:", abs(hw_recomp-hw_reported)/hw_reported < 0.01)

tw_pts = idx["tibial_width"]["points"]
tw_recomp_3d = euclid(tw_pts["medial_tibial_condyle_edge"], tw_pts["lateral_tibial_condyle_edge"], vox)
print("tibial width recompute (3d euclid native points):", tw_recomp_3d, "reported:", tw)
print("orientation_frame tibial_width_mm (reoriented slab):", tr["tibial_width_mm"])

# 4. check positions.json matches results points
print()
print("positions.json landmark voxels vs results points:")
for name in ["intercondylar_groove_midpoint","intercondylar_notch","lateral_condylar_edge","medial_condylar_edge",
             "articular_surface_proximal","growth_plate_proximal","lateral_tibial_condyle_edge","medial_tibial_condyle_edge"]:
    p = positions["landmarks"][name]["voxel"] if "landmarks" in positions else None

