import json, numpy as np
import nibabel as nib
from scipy import ndimage

art = "../../../artifacts"
lab = np.asanyarray(nib.load(f"{art}/labels.nii.gz").dataobj).astype(int)
FEMUR, TIBIA = 1, 2
BICONDYLAR_MIN = 0.60
MARGIN = 0.15

def centroid(m): return np.array(np.nonzero(m)).mean(axis=1)
fm, tm = (lab == FEMUR), (lab == TIBIA)
AX = int(np.argmax(np.abs(centroid(fm) - centroid(tm))))
print("split axis", AX)

def band(mask, toward, n=20):
    idx = np.nonzero(mask.any(axis=tuple(i for i in range(3) if i != AX)))[0]
    lo, hi = idx.min(), idx.max()
    return range(hi - n + 1, hi + 1) if toward > (lo + hi) / 2 else range(lo, lo + n)

def lobes(mask, k):
    sl = np.take(mask, k, axis=AX)
    lbl, n = ndimage.label(sl)
    if n == 0: return 0
    sizes = np.array([(lbl == i).sum() for i in range(1, n + 1)])
    return int((sizes >= max(10, 0.2 * sizes.max())).sum())

ct, cf = centroid(tm)[AX], centroid(fm)[AX]
fem_counts = [lobes(fm, k) for k in band(fm, ct)]
tib_counts = [lobes(tm, k) for k in band(tm, cf)]
fem_frac = sum(c >= 2 for c in fem_counts) / len(fem_counts)
tib_frac = sum(c >= 2 for c in tib_counts) / len(tib_counts)

if tib_frac > fem_frac + MARGIN:
    verdict = "FAIL"
elif fem_frac >= BICONDYLAR_MIN and fem_frac > tib_frac + MARGIN:
    verdict = "PASS"
else:
    verdict = "AMBIGUOUS"

print("fem_frac", fem_frac, "tib_frac", tib_frac, "verdict", verdict)
print("fem_counts", fem_counts)
print("tib_counts", tib_counts)

# interface localization check
def bbox(mask):
    idx = np.nonzero(mask)
    return np.array([[a.min(), a.max()] for a in idx])
bf = bbox(fm); bt = bbox(tm)
print("femur bbox", bf.tolist())
print("tibia bbox", bt.tolist())
overlap = []
for i in range(3):
    lo = max(bf[i,0], bt[i,0]); hi = min(bf[i,1], bt[i,1])
    overlap.append(max(0, hi-lo))
print("overlap per axis", overlap)
size_f = bf[:,1]-bf[:,0]
size_t = bt[:,1]-bt[:,0]
print("femur size", size_f, "tibia size", size_t)

shape = lab.shape
touches = {}
for name, lid in [("femur",1),("tibia",2)]:
    m = lab==lid
    faces = []
    if m[0,:,:].any(): faces.append("x_min")
    if m[-1,:,:].any(): faces.append("x_max")
    if m[:,0,:].any(): faces.append("y_min")
    if m[:,-1,:].any(): faces.append("y_max")
    if m[:,:,0].any(): faces.append("z_min")
    if m[:,:,-1].any(): faces.append("z_max")
    touches[name]=faces
print("touches", touches)

result = dict(split_axis=AX, fem_frac=fem_frac, tib_frac=tib_frac, verdict=verdict,
              fem_counts=fem_counts, tib_counts=tib_counts, overlap=overlap,
              femur_size=size_f.tolist(), tibia_size=size_t.tolist(), touches=touches)
json.dump(result, open("discriminator_result.json","w"), indent=2)
