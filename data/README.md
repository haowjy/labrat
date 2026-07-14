# Sample data

## Initial protocol

LabRat's initial protocol is based on Tang et al., [“Evaluating Osteoarthritis
Severity in Mice Using μCT-Derived Geometric
Indices”](https://pubmed.ncbi.nlm.nih.gov/41677733/) (*Biology*, 2026;15(3):262).
The paper defines μCT-derived distal femoral and proximal tibial geometric
indices for assessing post-traumatic and age-related osteoarthritis in mice.
The indices were developed using severe osteoarthritis induced by medial
meniscectomy; their use in mild osteoarthritis requires further study.

## OA7-4L

Mouse knee micro-CT scan from the OA7 cohort (Tang et al., *Biology* 2026, 15,
262). 5-month-old young adult male C57BL/6, left knee (normal joint — no MMS
surgery). 830 DICOM slices at 10.5 um isotropic resolution, Scanco VivaCT 40.

### Ground truth (Supplemental Table S3)

| Index | Value | Unit | Expected state |
|---|---|---|---|
| Distal femoral length | 2.32 | mm | — |
| Distal femoral width | 2.86 | mm | — |
| Distal femoral W/L | 1.233 | ratio | normal (<1.24) |
| Tibial width | 2.89 | mm | — |
| IIOC max height | 0.924 | mm | — |
| IIOC H/W | 0.320 | ratio | normal (>0.282) |

Both decisive indices are solidly in the normal range — this is a healthy
joint. The harness should produce values close to these; deviations indicate
landmark placement error, not OA.

### Data availability and permission

The raw OA7-4L DICOM series is not distributed in this repository. The
originating laboratory authorized its use and public demonstration for this
project. A formal institutional license for redistribution of the raw series
has not yet been documented, so this repository does not assert or grant one.

The saved run under `samples/OA7-4L-run-005/` and the rendered workflow media
under `docs/assets/` are project outputs shown with the originating lab's
permission. Their inclusion documents the pipeline's behavior and does not
grant a license to the underlying DICOM series.

The work is associated with NIH/NIA Award R01 AG076731. NIH funding and the
article's publication do not, by themselves, establish a redistribution
license for unpublished source data.

### Published material

The Tang et al. article, its figures, and its published supplementary material
are available under CC BY 4.0. That license applies to the material published
with the article; it should not be read as a license for the source DICOM
series used in this demonstration.

To run the protocol, provide a DICOM directory or ZIP that you are authorized
to use:

```bash
npm run dev -- enqueue /absolute/path/to/dicom-input microct-oa-mouse-knee
```
