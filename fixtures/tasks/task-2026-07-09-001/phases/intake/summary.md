# Intake — OA6-1RK

Loaded 877 DICOM slices from `input/OA6-1RK/` and assembled a coherent 3D
volume. Voxel spacing is isotropic at [0.012, 0.012, 0.012] mm, matching the
scanner metadata. Intensity values are consistent with a calibrated micro-CT
acquisition (air near 0, cortical bone in the high band).

Handed off `intensity.nii.gz`, `spacing.json`, and `transforms.json` to the
segmentation phase.

- Slices: 877 (no gaps or duplicates)
- Volume: 512 x 512 x 877 voxels
- Spacing: 0.012 mm isotropic
- Modality: micro-CT (calibrated)
