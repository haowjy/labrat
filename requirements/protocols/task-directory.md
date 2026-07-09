# Task Directory Structure

Each task gets its own directory. The agent writes into it. The dashboard
reads from it. The provenance manifest ties everything together.

```
tasks/{task-id}/
├── input/
│   └── OA6-1RK/                    # DICOM series (symlinked or copied)
│       ├── oa6-1rk_1_00001.dcm
│       └── ...
│
├── phases/
│   ├── intake/
│   │   ├── summary.md              # scan loaded, 877 slices, Scanco VivaCT
│   │   ├── decisions.md            # scanner profile auto-detected
│   │   ├── measurements.json       # spacing, voxel count, histogram
│   │   ├── confidence.json         # { level: "high", flags: [] }
│   │   ├── evidence/
│   │   │   └── histogram.png
│   │   └── code/
│   │       └── load_dicom.py
│   │
│   ├── segmentation/
│   │   ├── summary.md
│   │   ├── decisions.md            # threshold choice, watershed params
│   │   ├── measurements.json       # bone volumes, component counts
│   │   ├── confidence.json         # { level: "medium", flags: ["low-margin-bone-identity"] }
│   │   ├── evidence/
│   │   │   ├── bone_mask_axial.png
│   │   │   ├── bone_mask_coronal.png
│   │   │   ├── bone_mask_sagittal.png
│   │   │   ├── watershed_split.png
│   │   │   └── cut_quality.png
│   │   └── code/
│   │       └── segment.py
│   │
│   ├── landmarks/
│   │   ├── summary.md
│   │   ├── decisions.md            # placement rationale per landmark
│   │   ├── measurements.json       # landmark positions, distances
│   │   ├── confidence.json         # per-landmark confidence
│   │   ├── evidence/
│   │   │   ├── landmarks_3d_front.png
│   │   │   ├── landmarks_3d_oblique.png
│   │   │   ├── landmarks_3d_side.png
│   │   │   ├── groove_profile.png
│   │   │   ├── condyle_edges.png
│   │   │   └── growth_plate.png
│   │   └── code/
│   │       └── place_landmarks.py
│   │
│   ├── roi/
│   │   ├── summary.md
│   │   ├── decisions.md
│   │   ├── measurements.json
│   │   ├── confidence.json
│   │   ├── evidence/
│   │   │   └── voi_overlay.png
│   │   └── code/
│   │       └── define_roi.py
│   │
│   └── measurement/
│       ├── summary.md
│       ├── decisions.md
│       ├── measurements.json       # final values + gate results
│       ├── confidence.json
│       ├── evidence/
│       │   ├── measurement_lines_3d.png
│       │   └── gate_results.png
│       └── code/
│           └── compute.py
│
├── provenance/
│   └── manifest.yaml               # ties all phases together
│
├── review/
│   ├── reviewer_report.md          # reviewer agent's findings
│   ├── reviewer_evidence/          # any additional evidence reviewer generated
│   └── verdict.json                # { status, flags, gated_measurements }
│
└── suggestions/
    └── suggestions.json            # scientist's feedback per phase
```

## What the dashboard reads

The dashboard walks `phases/` in order, reads each phase's files, and
renders them:

- `summary.md` → prose description of the phase
- `decisions.md` → expandable decisions section
- `evidence/*.png` → image gallery
- `measurements.json` → measurement table with gate status
- `confidence.json` → confidence badge + flags

The `review/` directory holds the reviewer agent's independent assessment.
The `suggestions/` directory holds the scientist's feedback.

## What the provenance manifest records

The manifest in `provenance/manifest.yaml` follows the prov-model:
analysis_run, phases (with technique, status, confidence, artifacts),
and any deviations from the protocol.

A result number that cannot be traced through
artifact → phase → technique/protocol → decision is incomplete provenance.
