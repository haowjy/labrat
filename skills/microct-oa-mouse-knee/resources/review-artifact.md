# Review artifact — package the vetted OA indices for review

## Procedure

This phase does **no science** — the `measurement` phase already vetted every index
against its evidence. Here the worker *packages* the vetted numbers into a review
site a human confirms. The method for building the site — the data contract, the
single-inlined-file rule, the trust boundary, the G1–G8 linter — is the
**`review-artifact-builder`** skill (composed for this phase). This resource adds
only what is specific to this protocol: which values become rows, and the
OA-progression read.

**The rows.** Read the vetted numbers from `measurements/results.json` (each
entry's `name`, `value`, `unit`) and the phenotype calls from
`measurements_final.json`. Show the six geometric indices and three volumes:

| `id` (results.json name) | Label | Unit |
|--------------------------|-------|------|
| `distal_femoral_length` | Distal femoral length | mm |
| `distal_femoral_width` | Distal femoral width | mm |
| `distal_femoral_ratio` | Distal femoral W/L (osteophyte index) | ratio |
| `tibial_width` | Tibial width | mm |
| `tibial_iioc_height` | Tibial IIOC height | mm |
| `tibial_iioc_ratio` | Tibial IIOC height/width | ratio |
| `patella_volume` | Patella volume | mm³ |
| `medial_meniscus_volume` | Medial peri-meniscal volume | mm³ |
| `lateral_meniscus_volume` | Lateral peri-meniscal volume | mm³ |

**Honesty flag per row** (truthful — do not launder uncertainty): `confirmed` when
the QC overlay shows the measurement on the right anatomy and the derivation
reproduces; `low-margin` when a ratio sits near its phenotype cutoff (W/L ROC
1.245 / 1.312 / 1.282; IIOC H/W 0.282, incl. the 0.28–0.30 gray zone) — the
reviewer needs to know a borderline call is borderline; `criss-cross` when
landmark lines cross between bones; `review-needed` when the stage flagged
`requires_user_confirmation`. There is no expected-value bound to be "out of" — a
wrong measurement surfaces on the overlay, not as an out-of-range flag.

**The interpretation — how far the OA has progressed.** The rows are the evidence;
the artifact's capstone is a synthesis that places this specimen on the
OA-progression spectrum, so the reviewer signs off on a *reading*, not bare
numbers. Interpretation applied after — never a gate, never a placement target.
One short progression statement, three parts:

1. **Stage, from the magnitude — not the binary cutoff.** Position the specimen on
   the paper's severity gradient: femoral W/L ≈1.19 normal → ≈1.33 (4 wk MMS,
   established) → ≈1.47 (8 wk, advanced); tibial IIOC H/W ≈0.304 normal → ≈0.25 →
   ≈0.24. A W/L of 1.30 reads as *early*; 1.45 reads as *advanced*, near the 8-week
   phenotype.
2. **Concordance across signals.** The osteophyte index (W/L, rising), the
   subchondral-collapse index (IIOC H/W, falling), and the enlargement volumes
   (patella, peri-meniscal) should tell **one** story. Three concordant signals
   support the read; a lone elevated index is weaker — when they disagree, say so
   and lower confidence.
3. **Confidence, and its basis.** State how far you trust the read and *why*: each
   ratio's distance from its per-model cutoff, whether IIOC H/W sits in the
   0.28–0.30 gray zone, the per-row honesty flags, and the single-specimen limit
   (no contralateral control here — the paper reads injured vs contralateral).
   "Given only these indices" is an honest hedge, not a hollow one.

Example, well-supported: *"Established–advanced OA. W/L 1.45 sits near the 8-week
phenotype, IIOC H/W 0.23 is well below cutoff, patella enlarged — three signals
agree, high confidence."* Example, hedged: *"Probable early OA, low confidence: W/L
1.29 is just over the 4-week ROC cutoff and IIOC H/W 0.29 is in the gray zone; the
signals only weakly agree and this is a single specimen."*

**Data contract (built by `review-artifact-builder`):** `REVIEW_MANIFEST` with
`sample_id` = the **task id from your prompt** (not the specimen label),
`produced_from.measurement = "measurements/results.json@<sha256>"` (hash the file
you actually read — G8 recomputes it), `verdict_schema`, and `data_globals`.
`REVIEW_DATA.items` = one entry per row above:
`{ id, label, value, unit, honesty_flag, honesty_detail }`. Plus
`REVIEW_DATA.interpretation = { stage, confidence, basis }` — the OA-progression
read (short strings), rendered as the capstone panel above the table.

This is the **values-table** pattern (a single-pane review). See
`review-artifact-builder` for when a protocol instead needs a multi-pane 3D layout
— this one does not.

## Verification

**Look first.** Open `artifacts/review-site/index.html` via `file://`. It should
lead with the **OA-progression read** as a headline panel (stage, confidence,
basis), then render the nine rows as a values table, each with its honesty flag and
a per-index verdict control, and fit one mobile viewport. The site exports nothing
— verdict capture is the trusted shell's job.

**Then the structural + fidelity gate.** This phase's gate is **not** scientific —
do not recompute the indices. The harness runs the deterministic `check_review_site`
linter (G1–G8) with its own authoritative inputs and writes
`review/verification/review-artifact/check_review_site.json`. Read that file; gate
`pass` only if `"ok": true` and every one of the eight findings is `"ok": true`. If
it is missing or `false`, FAIL and quote the failing findings' `detail`. The gate
detail (what each G1–G8 checks) is in the `review-artifact-builder` skill.

**Confirm the interpretation is honest — not that it's "right."** There is no
ground truth for the OA stage, so the reviewer checks only that the progression
read *follows from the shown indices*: the stage matches their magnitudes, and the
stated confidence matches how well the signals concord and what the honesty flags
say. An over-confident read on discordant or low-margin indices fails back to the
worker for the same reason laundered uncertainty would. **The final verdict comment
states this progression read** — how far the OA has progressed, or how far the
evidence supports thinking it has — so the human signs off on a reading, not a bare
table.

**Failure modes:** any gate `ok: false` — e.g. a separate-file `<script src>`
(G2), a missing `REVIEW_DATA` global (G3), a navigation/download/`on*`-handler sink
(G5), or a `produced_from` hash / `sample_id` that doesn't match this run (G8, a
stale or swapped site); or an OA-progression read whose confidence overclaims what
the concordance and honesty flags support.
