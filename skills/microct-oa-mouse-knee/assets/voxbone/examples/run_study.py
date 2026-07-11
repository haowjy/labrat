"""
End-to-end example: run voxbone over a study directory and produce the
group statistics + plots.

Layout expected:
    samples_dir/
        Sham_1.zip   (or a folder of .dcm slices named Sham_1/)
        Sham_2.zip
        PTOA_1.zip
        ...
    groups.csv   with columns: sample_id,group[,timepoint,...]

Run:  python examples/run_study.py samples_dir groups.csv
"""
import sys
import voxbone as vb


def main(samples_dir, metadata_csv, group_col="group"):
    # 1) batch over every sample -> tidy table + per-sample QC overlays
    df = vb.run_batch(
        samples_dir,
        metadata=metadata_csv,
        out_csv="voxbone_results.csv",
        qc_dir="qc",
        downsample=2,          # segmentation/geometry resolution
        voi_depth_mm=1.0,      # tibial subchondral slab thickness
        thickness_step=1.0,    # local-thickness sweep step (voxels)
    )
    print("\nResults table: voxbone_results.csv")
    print("QC overlays:   qc/<sample>_qc.png   <-- REVIEW THESE")

    # flag any low-confidence orientation calls for manual check
    if "warnings" in df:
        flagged = df[df["warnings"].astype(str).str.len() > 0]
        if len(flagged):
            print("\n%d sample(s) with warnings — check their QC overlays:" % len(flagged))
            for _, r in flagged.iterrows():
                print("  -", r["sample_id"], "::", r["warnings"])

    # 2) group statistics + plots
    stats = vb.analyze(df, group_col=group_col, out_dir="analysis")
    print("\nStats: analysis/stats_summary.csv | Plots: analysis/group_plots.png")
    print(stats[["param", "test", "p_fdr", "effect", "sig"]].round(4).to_string(index=False))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
