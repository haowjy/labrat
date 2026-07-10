# Regression — fit an OLS linear regression on the classify data

## Methodology

Use ONLY Python 3 stdlib (`csv`, `json`, `statistics`, plain arithmetic — no
`numpy`, no third-party packages). Fit an ordinary-least-squares simple linear
regression of `label` (as the numeric target y, 0.0 or 1.0) on `x1` (the
predictor), using the closed-form formulas.

**Exact steps for the worker:**

Your working directory IS the task dir already — do not `cd` into `artifacts/`
or any subdirectory first. All paths below are relative to that working
directory exactly as written, with no extra leading `artifacts/`. Do NOT run
`mkdir artifacts && cd artifacts`; if you `mkdir -p artifacts/regression`,
stay in the task dir and write to `artifacts/regression/regression.json`
(never `artifacts/artifacts/regression/regression.json`).

1. Read `artifacts/classify/data.csv` (produced by the `classify` phase).
   Parse each row's `x1` (float) and `label` (int, used as the numeric target
   `y = float(label)`).
2. Compute the closed-form OLS slope and intercept for `y = slope * x1 +
   intercept`:
   ```python
   import csv, json, statistics

   xs, ys = [], []
   with open("artifacts/classify/data.csv") as f:
       for row in csv.DictReader(f):
           xs.append(float(row["x1"]))
           ys.append(float(row["label"]))

   n = len(xs)
   x_mean = statistics.mean(xs)
   y_mean = statistics.mean(ys)

   ss_xy = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys))
   ss_xx = sum((x - x_mean) ** 2 for x in xs)

   slope = ss_xy / ss_xx
   intercept = y_mean - slope * x_mean
   ```
3. Compute R² (coefficient of determination):
   ```python
   y_pred = [slope * x + intercept for x in xs]
   ss_res = sum((y - yp) ** 2 for y, yp in zip(ys, y_pred))
   ss_tot = sum((y - y_mean) ** 2 for y in ys)
   r_squared = 1 - (ss_res / ss_tot)
   ```
4. Create `artifacts/regression/` if it does not exist (e.g.
   `mkdir -p artifacts/regression` from the task dir — do not `cd` into it)
   and write `artifacts/regression/regression.json`:
   ```json
   { "slope": 0.1234, "intercept": 0.4567, "r_squared": 0.55, "n": 200 }
   ```
5. Call the `record_phase` MCP tool with a short summary (e.g. "fit OLS
   label~x1, slope=..., r_squared=...") and a confidence level.

## Expected outputs / how to verify

**Correct output looks like:**

- `artifacts/regression/regression.json` exists with numeric `slope`,
  `intercept`, `r_squared`, and integer `n` fields.
- `n` matches the row count of `artifacts/classify/data.csv`.
- `r_squared` is between 0 and 1 (regressing a 0/1 label on a single
  correlated predictor should land well above 0, well below 1 — flag
  anything wildly outside a sane band, e.g. negative or > 1, as a bug).

**Reviewer computes (independently, own code, own process):**

Under `review/verification/regression/`, write a small stdlib-only Python
script that:

1. Re-reads `artifacts/classify/data.csv` directly from disk.
2. Independently recomputes `slope`, `intercept`, and `r_squared` from the
   closed-form OLS formulas above (own code — do not import or call the
   worker's script).
3. Compares its recomputed `slope`, `intercept`, and `r_squared` to the
   worker's `artifacts/regression/regression.json` values, each within a
   tolerance of **1e-6** (deterministic closed-form arithmetic on the same
   data should match to numerical precision — any larger discrepancy means
   the worker used different data, a different formula, or made an
   arithmetic error).

**Gate `pass` only if ALL of the following hold:**

- `artifacts/regression/regression.json` exists and parses as valid JSON
  with all four required fields.
- `n` matches `artifacts/classify/data.csv`'s row count.
- The reviewer's independently recomputed `slope`, `intercept`, and
  `r_squared` each match the worker's reported values within 1e-6.

**Failure modes to flag:**

- `regression.json` missing or malformed.
- `n` mismatch with the upstream `data.csv`.
- Recomputed slope/intercept/r_squared differ from reported values beyond
  tolerance (wrong formula, wrong column, stale/wrong input file).
- `r_squared` outside `[0, 1]` for this target/predictor pair.
