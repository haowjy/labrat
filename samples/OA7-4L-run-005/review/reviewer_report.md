# Gate review — intake

- Decision: **pass**
- Reviewer session: fd310922-477e-4e88-8c59-4a26e5ba3f50
- Defaulted (no submit_gate_decision after 2 attempts): no
- Trust boundary: VIOLATION — see below

## Trust boundary violations

- [phases] added: intake/sessions/gate-reviewer.jsonl

_Verification code + output: `review/verification/intake/`_

---

# Gate review — segmentation

- Decision: **pass**
- Reviewer session: 4ac0c4df-f339-46f4-ac6f-09dc6c8e0df5
- Defaulted (no submit_gate_decision after 2 attempts): no
- Trust boundary: VIOLATION — see below

## Subphase assessments

- threshold: Confirmed: filtered.nii.gz present, isotropic 0.0105mm zooms verified from labels.nii.gz header; manual threshold path (histogram not bimodal) is disclosed, medium confidence is appropriate.
- watershed: Confirmed: first-pass needs-seeds (driver.log) with ambiguous-bone-identity, curated seeds re-run to ready. Independently recomputed femur/tibia CC==1 and z-bbox overlap ~12.8% of smaller bbox (worker: 12.6%, consistent) — no unexpected face contact beyond FOV crop.
- structure-assignment: Confirmed: bicondylar discriminator independently reimplemented from scratch and reproduces fem_frac=0.85/tib_frac=0.50/PASS exactly; sesamoid/osteophyte-lateral-to-condyle count recomputes to 0; all 6 assigned structures' voxel/volume figures match exactly; patella/menisci correctly absent and explicitly escalated rather than invented; geometry.json well-formed once at segmentation/geometry.json.

## Trust boundary violations

- [phases] added: segmentation/sessions/gate-reviewer.jsonl

_Verification code + output: `review/verification/segmentation/`_

---

# Gate review — segmentation

- Decision: **pass-with-concerns**
- Reviewer session: 9fa6cf75-afe2-4218-8b2e-024d1bb07cdd
- Defaulted (no submit_gate_decision after 2 attempts): no
- Trust boundary: VIOLATION — see below

## Subphase assessments

- threshold: Verified filtered.nii.gz present, correct spacing; manual Amira-scale thresholds recorded and finite; medium confidence appropriate given non-bimodal histogram.
- watershed: Independently recomputed femur cc=1, tibia cc=1, interface overlap ~12.6% of smaller bbox, no unexpected face contact. needs-seeds -> curated -> ready path confirmed in driver.log, not a shortcut.
- structure-assignment: Bicondylar discriminator reimplemented from scratch and reproduces exactly (fem_frac=0.85, tib_frac=0.5, PASS, margin 0.35 vs required 0.15). Sesamoid/osteophyte-in-condyle-slab check recomputed as 0. Patella/menisci genuinely absent, honestly flagged in review_flags rather than fabricated.

## Trust boundary violations

- [phases] modified: segmentation/sessions/gate-reviewer.jsonl

_Verification code + output: `review/verification/segmentation/`_

---

# Gate review — seed-review

- Decision: **pass**
- Reviewer session: a8d7930c-a9ef-4e24-8cbc-77c76a39a591
- Defaulted (no submit_gate_decision after 2 attempts): no
- Trust boundary: VIOLATION — see below

## Trust boundary violations

- [phases] added: seed-review/sessions/gate-reviewer.jsonl

_Verification code + output: `review/verification/seed-review/`_

---

# Gate review — landmarks

- Decision: **pass-with-concerns**
- Reviewer session: e25fc132-b644-4bb7-ac65-d137e730dedb
- Defaulted (no submit_gate_decision after 2 attempts): no
- Trust boundary: VIOLATION — see below

## Trust boundary violations

- [phases] added: landmarks/sessions/gate-reviewer.jsonl

_Verification code + output: `review/verification/landmarks/`_

---

# Gate review — measurement

- Decision: **pass**
- Reviewer session: 3048aefb-17c2-417b-8424-f0ddc5240b40
- Defaulted (no submit_gate_decision after 2 attempts): no
- Trust boundary: VIOLATION — see below

## Trust boundary violations

- [phases] added: measurement/sessions/gate-reviewer.jsonl

_Verification code + output: `review/verification/measurement/`_

---

# Gate review — review-artifact

- Decision: **pass**
- Reviewer session: 712ebba8-fed5-4b52-9b98-906bfa73c362
- Defaulted (no submit_gate_decision after 2 attempts): no
- Trust boundary: VIOLATION — see below

## Trust boundary violations

- [phases] modified: review-artifact/evidence/review_site_3d.png
- [phases] modified: review-artifact/measurements.json
- [phases] modified: review-artifact/sessions/worker.jsonl
- [phases] added: review-artifact/sessions/gate-reviewer.jsonl

_Verification code + output: `review/verification/review-artifact/`_
