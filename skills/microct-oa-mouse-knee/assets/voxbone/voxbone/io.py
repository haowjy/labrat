"""
Loading micro-CT DICOM series into HU volumes.

Handles both a directory of ``.dcm`` slices and a ``.zip`` archive of
slices (the format exported by the Scanco / VivaCT workflow in the
source paper). Slices are ordered by ImagePositionPatient (z) when
available, else by filename. Pixel values are rescaled to Hounsfield
Units using the per-file RescaleSlope / RescaleIntercept.
"""
from __future__ import annotations

import io as _io
import os
import zipfile
from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass
class Volume:
    """A loaded micro-CT volume.

    Attributes
    ----------
    hu : (Z, Y, X) float32
        Volume in Hounsfield Units.
    voxel_mm : float
        Isotropic voxel edge length in mm.
    sample_id : str
        Identifier derived from the source path / archive name.
    meta : dict
        Selected DICOM header fields from the first slice.
    """
    hu: np.ndarray
    voxel_mm: float
    sample_id: str
    meta: dict

    @property
    def shape(self):
        return self.hu.shape


def _read_one(dcm_bytes: bytes):
    import pydicom
    return pydicom.dcmread(_io.BytesIO(dcm_bytes))


def _order_key(ds, fallback_name: str):
    ipp = getattr(ds, "ImagePositionPatient", None)
    if ipp is not None and len(ipp) == 3:
        return float(ipp[2])
    inst = getattr(ds, "InstanceNumber", None)
    if inst is not None:
        return float(inst)
    return fallback_name


def load_volume(path: str, sample_id: Optional[str] = None) -> Volume:
    """Load a DICOM series from a directory or a .zip of .dcm files."""
    import pydicom  # noqa: F401

    if sample_id is None:
        base = os.path.basename(path.rstrip("/"))
        sample_id = os.path.splitext(base)[0]

    # gather (order_key, bytes)
    entries = []
    if zipfile.is_zipfile(path):
        zf = zipfile.ZipFile(path)
        names = [n for n in zf.namelist() if n.lower().endswith(".dcm")]
        if not names:
            raise ValueError(f"no .dcm files in archive {path}")
        for n in names:
            b = zf.read(n)
            ds = _read_one(b)
            entries.append((_order_key(ds, n), b, ds))
    elif os.path.isdir(path):
        names = [f for f in os.listdir(path) if f.lower().endswith(".dcm")]
        if not names:
            raise ValueError(f"no .dcm files in directory {path}")
        for n in names:
            with open(os.path.join(path, n), "rb") as fh:
                b = fh.read()
            ds = _read_one(b)
            entries.append((_order_key(ds, n), b, ds))
    else:
        raise ValueError(f"{path} is neither a .zip nor a directory")

    entries.sort(key=lambda t: t[0])
    ds0 = entries[0][2]
    slope = float(getattr(ds0, "RescaleSlope", 1.0))
    inter = float(getattr(ds0, "RescaleIntercept", 0.0))
    rows, cols = int(ds0.Rows), int(ds0.Columns)
    z = len(entries)

    raw = np.empty((z, rows, cols), dtype=np.float32)
    for i, (_, _, ds) in enumerate(entries):
        raw[i] = ds.pixel_array.astype(np.float32)
    hu = raw * slope + inter

    voxel_mm = float(ds0.PixelSpacing[0])
    meta = {
        "manufacturer": str(getattr(ds0, "Manufacturer", "")),
        "series_description": str(getattr(ds0, "SeriesDescription", "")),
        "rescale_slope": slope,
        "rescale_intercept": inter,
        "pixel_spacing_mm": voxel_mm,
        "slice_thickness_mm": float(getattr(ds0, "SliceThickness", voxel_mm)),
        "n_slices": z,
        "shape": (z, rows, cols),
    }
    return Volume(hu=hu, voxel_mm=voxel_mm, sample_id=sample_id, meta=meta)
