# Regression Phase Summary

## Overview
Fitted an ordinary-least-squares (OLS) linear regression model on the classify phase data to predict labels from the x1 feature.

## Methodology
- **Input data**: `artifacts/classify/data.csv` (200 samples from the classify phase)
- **Target variable**: `label` (0 or 1)
- **Predictor variable**: `x1` (continuous)
- **Method**: Closed-form OLS linear regression using Python 3 stdlib (csv, json, statistics)

## Regression Formula
```
label = 0.209133 × x1 + 0.289142
```

## Results
- **Slope**: 0.20913284747291624
- **Intercept**: 0.28914235599393573
- **R² (coefficient of determination)**: 0.3117845834485421
- **Sample size**: 200

## Interpretation
- The model explains approximately **31.2%** of the variance in labels using x1 alone
- For each unit increase in x1, the predicted label increases by ~0.209
- The intercept of ~0.289 represents the predicted label when x1 = 0
- The moderate R² is expected: the original label was generated from x1 + x2 > 1.0, so predicting from x1 alone leaves the x2 contribution unexplained

## Output Artifacts
- `artifacts/regression/regression.json`: Regression coefficients and metadata (slope, intercept, r_squared, n)
