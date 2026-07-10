# Classify — generate fake data, fit a trivial threshold classifier

## Methodology

This phase has no real input requirement: `input/` may be empty. The worker
**generates** a deterministic synthetic dataset itself, then fits and scores a
trivial classifier against it. Use ONLY Python 3 stdlib — `random`, `csv`,
`json`, `statistics`. No third-party packages, no network access.

**Exact steps for the worker:**

Your working directory IS the task dir. All paths below are relative to it
exactly as written — do not `cd` into a subdirectory first.

1. Create the output directory `artifacts/classify/` if it does not exist
   (`mkdir -p artifacts/classify`).
2. Generate data with a **fixed seed** so the run is fully reproducible:
   ```python
   import random, csv, json

   random.seed(42)
   N = 200
   THRESHOLD = 1.0

   rows = []
   for _ in range(N):
       x1 = random.uniform(-2, 2)
       x2 = random.uniform(-2, 2)
       label = 1 if (x1 + x2) > THRESHOLD else 0
       rows.append((x1, x2, label))
   ```
3. Write `artifacts/classify/data.csv` with a header row `x1,x2,label` followed
   by the 200 data rows (float x1/x2, integer label), in the same order they
   were generated.
4. Fit the classifier: it is simply the known generating rule,
   `predict = 1 if (x1 + x2) > THRESHOLD else 0`. Apply it to every row in
   `data.csv` (read the file back in, do not reuse in-memory `rows`) and
   compute accuracy = (# correct predictions) / N using `statistics`/plain
   arithmetic.
5. Write `artifacts/classify/classification.json`:
   ```json
   { "n": 200, "threshold": 1.0, "accuracy": 1.0 }
   ```
   (accuracy should be exactly 1.0 here since the classifier IS the
   generating rule — that is expected and correct, not a bug.)
6. Call the `record_phase` MCP tool with a short summary (e.g. "generated 200
   synthetic rows, fit threshold classifier, accuracy=1.0") and a confidence
   level.

## Expected outputs / how to verify

**Correct output looks like:**

- `artifacts/classify/data.csv` exists, has a `x1,x2,label` header plus
  exactly 200 rows, `label` is 0 or 1.
- `artifacts/classify/classification.json` exists with numeric `n`,
  `threshold`, and `accuracy` fields; `n` equals the row count in `data.csv`.

**Reviewer computes (independently, own code, own process):**

The reviewer does NOT trust the worker's reported numbers. Under
`review/verification/classify/`, write a small stdlib-only Python script that:

1. Re-reads `artifacts/classify/data.csv` directly from disk.
2. Re-implements the SAME threshold rule stated above
   (`predict = 1 if x1 + x2 > threshold else 0`, using the `threshold` value
   reported in `classification.json`) and recomputes accuracy from the raw
   CSV rows — not from the worker's JSON.
3. Compares the recomputed accuracy to `classification.json`'s `accuracy`
   within a tolerance of **0.01** (allows for floating-point rounding, not
   for a wrong rule or wrong data).

**Gate `pass` only if ALL of the following hold:**

- Both output files exist and parse as valid CSV / JSON.
- `data.csv` has exactly `n` rows matching `classification.json`'s `n`.
- The reviewer's independently recomputed accuracy matches the reported
  `accuracy` within 0.01.

**Failure modes to flag:**

- `data.csv` missing, empty, or malformed (wrong columns, non-numeric values).
- Row count mismatch between `data.csv` and `classification.json.n`.
- Recomputed accuracy differs from reported accuracy by more than 0.01
  (indicates the worker used a different rule, different data, or
  miscomputed).
