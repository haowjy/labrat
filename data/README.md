# Sample data

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

### Usage

```bash
# Extract DICOMs
mkdir -p data/OA7-4L && cd data/OA7-4L && unzip ../OA7-4L.zip

# Run the protocol
npm run dev -- enqueue data/OA7-4L microct-oa-mouse-knee
```

### License

CC BY 4.0 (per the source publication).
