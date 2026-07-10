---
name: toy-stats
description: Dependency-free smoke-test protocol for LabRat itself. Use to exercise the full worker-runs-phases / independent-reviewer-gates-each-phase machine cheaply and quickly — generates fake data, fits a threshold classifier, then a linear regression, all with Python stdlib only. Not a real scientific protocol; use when validating LabRat infrastructure changes, not for actual data analysis.
---

# toy-stats — worker/reviewer gate loop smoke test

This is a minimal, self-contained demo protocol for **LabRat** (the harness),
not a real scientific analysis. It exists to exercise the whole execution
machine — worker agent runs phases and writes artifacts, an independent
reviewer agent recomputes each phase's results from scratch and gates it —
using trivial statistics so the whole run completes in seconds, on Haiku,
with zero external dependencies (pure Python 3 stdlib: `random`, `csv`,
`json`, `statistics`).

## The two phases

1. **`classify`** — the worker generates a deterministic synthetic dataset
   (fixed seed), fits a trivial threshold classifier, and reports accuracy.
   See `resources/classify.md`.
2. **`regression`** — the worker fits a closed-form OLS linear regression on
   the `classify` phase's data and reports slope/intercept/R².
   See `resources/regression.md`.

Each phase is gated: after the worker finishes, an **independent**
gate-reviewer agent re-reads the raw artifacts from disk, re-derives the
numbers with its own from-scratch code, and only passes the phase if its
independent recompute agrees with the worker's reported numbers within a
stated tolerance. The reviewer never reuses the worker's code or trusts its
JSON blindly — that boundary is the entire point of this demo.

## Why this exists

Real LabRat protocols (e.g. `microct-oa-mouse-knee`) run heavy imaging
pipelines in conda substrates and cost real compute per run. `toy-stats` lets
anyone validate a LabRat harness change — prompt assembly, phase sequencing,
the record_phase/mark_subphase/submit_gate_decision tool loop, provenance
manifest writing — end to end, cheaply and deterministically, without
touching imaging code or paying for a large model.

## Runtime

`runtime.substrate: toy-stats` with `deps: []` — a bare Python 3 interpreter,
stdlib only. No conda packages, no `PYTHONPATH` requirement, no network
access. If `python3 -c "import statistics,csv,json,random"` runs, this
protocol's runtime requirement is satisfied.

## Composition

Standalone — `parent_skills: []`. No dependency on any other registry skill.
