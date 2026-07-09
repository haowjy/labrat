# Independent gate verification for the intake phase.
# Re-derives slice count and voxel spacing straight from the DICOM headers,
# rather than trusting the worker's summary.
import glob
import numpy as np
import pydicom

files = sorted(glob.glob("input/OA6-1RK/*.dcm"))
print(f"DICOM files on disk: {len(files)}")

slices = [pydicom.dcmread(f, stop_before_pixels=True) for f in files]
z = sorted(float(s.ImagePositionPatient[2]) for s in slices)
dz = np.diff(z)
px, py = map(float, slices[0].PixelSpacing)
print(f"In-plane spacing: [{px:.3f}, {py:.3f}] mm")
print(f"Slice spacing: {np.median(dz):.3f} mm (min {dz.min():.3f}, max {dz.max():.3f})")
print(f"Max gap between adjacent slices: {dz.max():.4f} mm")
