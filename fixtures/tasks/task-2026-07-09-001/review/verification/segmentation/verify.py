# Independent gate verification for the segmentation phase.
# Written and run by the gate reviewer in its own scratch space.
# Reads worker output read-only; cannot modify artifacts/ or phases/.
import nibabel as nib
import numpy as np
from scipy import ndimage

BONE_NAMES = {1: "femur", 2: "tibia"}

labels = nib.load("artifacts/labels.nii.gz").get_fdata().astype(int)
present = np.unique(labels[labels > 0])
print(f"Unique labels: {present.tolist()}   # expect [1, 2] = femur, tibia")

for value in present:
    mask = labels == value
    voxels = int(mask.sum())
    components, n = ndimage.label(mask)
    sizes = np.bincount(components.ravel())[1:]
    sizes_desc = sorted(sizes.tolist(), reverse=True)
    largest_frac = sizes_desc[0] / voxels if voxels else 0.0
    name = BONE_NAMES.get(int(value), str(value))
    print(f"Label {value} ({name}): {voxels} voxels, {n} connected components")
    print(f"  component sizes: {sizes_desc}")
    print(f"  largest fraction: {largest_frac:.4f}")
    if n != 1:
        print(f"  CONCERN: expected 1 component for {name}, found {n}")
