import json, numpy as np
import nibabel as nib
from scipy import ndimage

art = "../../../artifacts"

# 1. Load labels and check CC for femur/tibia
lab_img = nib.load(f"{art}/labels.nii.gz")
lab = np.asanyarray(lab_img.dataobj)
print("labels shape", lab.shape, "zooms", lab_img.header.get_zooms())

assigns = json.load(open(f"{art}/segmentation/structure_assignments.json"))["assignments"]
print("assignments", assigns)

results = {}
for name in ("femur","tibia"):
    lid = assigns[name]
    _, n = ndimage.label(lab == int(lid))
    results[f"{name}_cc"] = int(n)
    print(name, "cc=", n)

# others - report cc counts too
for name, lid in assigns.items():
    if name in ("femur","tibia"): continue
    _, n = ndimage.label(lab == int(lid))
    print(name, "cc=", n)

json.dump(results, open("cc_results.json","w"), indent=2)
