# Segmentation — femur & tibia

Segmented the knee into femur (label 1) and tibia (label 2). The first pass
returned `needs-seeds` with `calibration-unverified` and
`ambiguous-bone-identity` flags; replaying the operator seeds resolved the
identity and the pass re-ran to `ready`.

Pipeline: intensity threshold to isolate mineralized bone, watershed to split
the touching femoral and tibial condyles at the joint line, then bone
assignment from the seed points.

- Labels: {femur: 1, tibia: 2}, status `ready`
- Femur: 142789 voxels
- Tibia: 128944 voxels
- Seeds replayed: yes (resolved ambiguous-bone-identity)

Outputs: `labels.nii.gz`, `masks/{femur,tibia}.nii.gz`,
`bone_assignments.json`, `meshes/{femur,tibia}.npz`.
