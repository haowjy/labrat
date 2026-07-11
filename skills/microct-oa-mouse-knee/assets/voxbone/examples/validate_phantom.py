"""
Validate the morphometry engine against phantoms with known geometry.

Run:  python examples/validate_phantom.py
"""
import numpy as np
import voxbone as vb


def slab_phantom():
    vol = np.zeros((60, 60, 60), bool)
    vol[:, 20:40, :] = True          # 20/60 of the y-extent
    r = vb.compute_morphometry(vol, voxel_size_mm=0.01, compute_smi=False,
                               thickness_step=0.5)
    print("SLAB   BV/TV %.4f (exp 0.3333) | Tb.Th %.4f mm (exp 0.2000)"
          % (r.BV_TV, r.Tb_Th))


def sphere_phantom(rad=20, N=80):
    c = N // 2
    zz, yy, xx = np.mgrid[0:N, 0:N, 0:N]
    sph = ((zz - c) ** 2 + (yy - c) ** 2 + (xx - c) ** 2) <= rad ** 2
    r = vb.compute_morphometry(sph, voxel_size_mm=1.0, compute_smi=False,
                               thickness_step=0.25)
    exp_bv = 4 / 3 * np.pi * rad ** 3
    print("SPHERE BV %.0f (exp %.0f, %.1f%%) | BS/BV %.4f (exp %.4f) | "
          "Tb.Th %.2f (exp %d)"
          % (r.BV_mm3, exp_bv, 100 * r.BV_mm3 / exp_bv, r.BS_BV, 3 / rad,
             r.Tb_Th, 2 * rad))


if __name__ == "__main__":
    slab_phantom()
    sphere_phantom()
