#!/usr/bin/env python3
"""
Independent regression verification.
Recomputes OLS regression from scratch on the classify data.csv.
Compares to worker's reported values.
"""

import csv
import json
import statistics
import sys

# Tolerance for numerical comparison
TOLERANCE = 1e-6

def load_data(csv_path):
    """Load x1 and label columns from CSV."""
    xs = []
    ys = []
    with open(csv_path) as f:
        for row in csv.DictReader(f):
            xs.append(float(row["x1"]))
            ys.append(float(row["label"]))
    return xs, ys

def compute_ols(xs, ys):
    """Compute OLS regression: y = slope * x + intercept."""
    n = len(xs)
    x_mean = statistics.mean(xs)
    y_mean = statistics.mean(ys)

    ss_xy = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys))
    ss_xx = sum((x - x_mean) ** 2 for x in xs)

    slope = ss_xy / ss_xx
    intercept = y_mean - slope * x_mean

    return slope, intercept

def compute_r_squared(xs, ys, slope, intercept):
    """Compute R^2 (coefficient of determination)."""
    y_mean = statistics.mean(ys)
    y_pred = [slope * x + intercept for x in xs]

    ss_res = sum((y - yp) ** 2 for y, yp in zip(ys, y_pred))
    ss_tot = sum((y - y_mean) ** 2 for y in ys)

    r_squared = 1 - (ss_res / ss_tot)
    return r_squared

def main():
    # Load data
    data_path = "artifacts/classify/data.csv"
    xs, ys = load_data(data_path)
    n = len(xs)

    # Compute OLS
    slope, intercept = compute_ols(xs, ys)
    r_squared = compute_r_squared(xs, ys, slope, intercept)

    # Load worker's results
    worker_path = "artifacts/regression/regression.json"
    with open(worker_path) as f:
        worker_data = json.load(f)

    worker_slope = worker_data["slope"]
    worker_intercept = worker_data["intercept"]
    worker_r_squared = worker_data["r_squared"]
    worker_n = worker_data["n"]

    # Print results
    print("=" * 70)
    print("INDEPENDENT REGRESSION VERIFICATION")
    print("=" * 70)
    print()
    print("Data loaded from: artifacts/classify/data.csv")
    print(f"Number of data points: {n}")
    print()
    print("INDEPENDENTLY RECOMPUTED VALUES:")
    print(f"  Slope:        {slope:.17f}")
    print(f"  Intercept:    {intercept:.17f}")
    print(f"  R²:           {r_squared:.17f}")
    print()
    print("WORKER'S REPORTED VALUES:")
    print(f"  Slope:        {worker_slope:.17f}")
    print(f"  Intercept:    {worker_intercept:.17f}")
    print(f"  R²:           {worker_r_squared:.17f}")
    print(f"  n:            {worker_n}")
    print()

    # Verify checks
    checks = []

    # Check 1: n matches
    check1 = n == worker_n
    checks.append(("n matches data.csv row count", check1, f"computed n={n}, worker n={worker_n}"))

    # Check 2: slope matches within tolerance
    slope_diff = abs(slope - worker_slope)
    check2 = slope_diff <= TOLERANCE
    checks.append(("slope matches within tolerance", check2, f"diff={slope_diff:.2e}, tolerance={TOLERANCE}"))

    # Check 3: intercept matches within tolerance
    intercept_diff = abs(intercept - worker_intercept)
    check3 = intercept_diff <= TOLERANCE
    checks.append(("intercept matches within tolerance", check3, f"diff={intercept_diff:.2e}, tolerance={TOLERANCE}"))

    # Check 4: r_squared matches within tolerance
    r2_diff = abs(r_squared - worker_r_squared)
    check4 = r2_diff <= TOLERANCE
    checks.append(("r_squared matches within tolerance", check4, f"diff={r2_diff:.2e}, tolerance={TOLERANCE}"))

    # Check 5: r_squared in valid range
    check5 = 0 <= r_squared <= 1
    checks.append(("r_squared in [0, 1]", check5, f"r_squared={r_squared:.17f}"))

    print("VERIFICATION CHECKS:")
    print("-" * 70)
    all_passed = True
    for description, passed, detail in checks:
        status = "✓ PASS" if passed else "✗ FAIL"
        print(f"{status}: {description}")
        print(f"       {detail}")
        if not passed:
            all_passed = False
    print()

    if all_passed:
        print("RESULT: All checks passed ✓")
        return 0
    else:
        print("RESULT: Some checks failed ✗")
        return 1

if __name__ == "__main__":
    sys.exit(main())
