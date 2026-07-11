"""
Group statistics and publication plots for a voxbone results table.

For each numeric parameter, ``analyze`` picks a test based on the number
of groups and a normality check, corrects across parameters with
Benjamini-Hochberg FDR, computes an effect size, and draws grouped plots
with significance annotations.
"""
from __future__ import annotations

import os
from typing import Optional, Sequence

import numpy as np
import pandas as pd
from scipy import stats as ss


DEFAULT_PARAMS = [
    "wl_ratio", "femur_width_mm", "femur_length_mm",
    "tibia_width_mm", "med_compartment_height_mm", "lat_compartment_height_mm",
    "tib_BV_TV", "tib_Tb_Th", "tib_Tb_Sp", "tib_Tb_N",
]


def _cohens_d(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    na, nb = len(a), len(b)
    if na < 2 or nb < 2:
        return np.nan
    sp = np.sqrt(((na-1)*a.std(ddof=1)**2 + (nb-1)*b.std(ddof=1)**2) / (na+nb-2))
    return (a.mean() - b.mean()) / sp if sp > 0 else np.nan


def _eta_squared_kw(groups):
    # epsilon-squared effect size for Kruskal-Wallis
    H = ss.kruskal(*groups).statistic
    n = sum(len(g) for g in groups)
    k = len(groups)
    return (H - k + 1) / (n - k) if n > k else np.nan


def analyze(
    df: "pd.DataFrame",
    group_col: str,
    params: Optional[Sequence[str]] = None,
    alpha: float = 0.05,
    out_dir: str = "analysis",
    min_n: int = 3,
) -> "pd.DataFrame":
    """Run per-parameter group statistics and write plots + a summary table.

    Returns a DataFrame of test results (one row per parameter).
    """
    os.makedirs(out_dir, exist_ok=True)
    if group_col not in df.columns:
        raise ValueError("group_col %r not in results columns" % group_col)
    params = [p for p in (params or DEFAULT_PARAMS) if p in df.columns]
    groups = [g for g, _ in df.groupby(group_col)]
    n_groups = len(groups)

    rows = []
    for p in params:
        sub = df[[group_col, p]].dropna()
        gvals = [sub.loc[sub[group_col] == g, p].values for g in groups]
        gvals = [v for v in gvals if len(v) >= min_n]
        if len(gvals) < 2:
            rows.append({"param": p, "test": "skipped (n<%d)" % min_n,
                         "stat": np.nan, "p_raw": np.nan, "effect": np.nan})
            continue
        # normality (Shapiro on pooled residuals)
        pooled = np.concatenate([v - v.mean() for v in gvals])
        normal = (len(pooled) >= 3 and ss.shapiro(pooled).pvalue > 0.05)

        if len(gvals) == 2:
            if normal:
                stat, praw = ss.ttest_ind(*gvals, equal_var=False)
                test = "welch_t"
            else:
                stat, praw = ss.mannwhitneyu(*gvals, alternative="two-sided")
                test = "mannwhitney"
            effect = _cohens_d(*gvals)
        else:
            if normal:
                stat, praw = ss.f_oneway(*gvals)
                test = "anova"
            else:
                stat, praw = ss.kruskal(*gvals)
                test = "kruskal"
            try:
                effect = _eta_squared_kw(gvals)
            except Exception:
                effect = np.nan
        rows.append({"param": p, "test": test, "stat": float(stat),
                     "p_raw": float(praw), "effect": float(effect),
                     "n_groups": len(gvals)})

    res = pd.DataFrame(rows)
    # BH-FDR across parameters that produced a p-value
    mask = res["p_raw"].notna()
    if mask.any():
        praw = res.loc[mask, "p_raw"].values
        order = np.argsort(praw)
        m = len(praw)
        adj = np.empty(m)
        prev = 1.0
        for rank in range(m-1, -1, -1):
            i = order[rank]
            val = praw[i] * m / (rank + 1)
            prev = min(prev, val)
            adj[i] = prev
        res.loc[mask, "p_fdr"] = np.clip(adj, 0, 1)
    else:
        res["p_fdr"] = np.nan
    res["sig"] = res["p_fdr"] < alpha

    res.to_csv(os.path.join(out_dir, "stats_summary.csv"), index=False)
    _plot_all(df, group_col, res, out_dir)
    return res


def _stars(p):
    if p != p:
        return "ns"
    return "***" if p < 1e-3 else "**" if p < 1e-2 else "*" if p < 0.05 else "ns"


def _plot_all(df, group_col, res, out_dir):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    params = res["param"].tolist()
    groups = list(df.groupby(group_col).groups.keys())
    ncol = min(4, len(params)) or 1
    nrow = int(np.ceil(len(params) / ncol))
    fig, axes = plt.subplots(nrow, ncol, figsize=(3.4*ncol, 3.2*nrow),
                             squeeze=False)
    palette = plt.cm.tab10(np.linspace(0, 1, len(groups)))
    for i, p in enumerate(params):
        ax = axes[i // ncol][i % ncol]
        rrow = res[res["param"] == p].iloc[0]
        for j, g in enumerate(groups):
            vals = df.loc[df[group_col] == g, p].dropna().values
            if len(vals) == 0:
                continue
            x = np.full(len(vals), j) + np.random.uniform(-0.08, 0.08, len(vals))
            ax.scatter(x, vals, s=22, color=palette[j], alpha=0.8, edgecolor="k",
                       linewidth=0.4, zorder=3)
            if len(vals) > 0:
                ax.hlines(vals.mean(), j-0.22, j+0.22, color="k", lw=2, zorder=4)
                if len(vals) > 1:
                    se = vals.std(ddof=1)/np.sqrt(len(vals))
                    ax.errorbar(j, vals.mean(), yerr=se, color="k", capsize=4, zorder=4)
        ax.set_xticks(range(len(groups)))
        ax.set_xticklabels([str(g) for g in groups], rotation=20, ha="right", fontsize=8)
        ax.set_title("%s  (%s)" % (p, _stars(rrow.get("p_fdr", np.nan))), fontsize=9)
        ax.spines[["top", "right"]].set_visible(False)
    for k in range(len(params), nrow*ncol):
        axes[k // ncol][k % ncol].axis("off")
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, "group_plots.png"), dpi=120)
    import matplotlib.pyplot as _plt
    _plt.close(fig)
