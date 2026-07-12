/*
 * Presentation-only pure helpers for the ReviewChainCard (the pinned hero of
 * the review layer, design §4). Same framework-free style as lib/evidence.js
 * and lib/format.js: plain data in, plain data out, no DOM, never throws on
 * the arbitrary per-protocol JSON getPhase hands back.
 *
 * The card is the trusted shell's ONE honest expression of the three-agent
 * review chain for a phase:
 *   - WORKER    — the measured value, read from phases/{phase}/measurements.json.
 *   - REVIEWER  — the gate-reviewer's INDEPENDENT recomputation, read from its
 *                 own review/verification/{phase}/*.json, plus its gate decision.
 *   - MONITOR   — the third agent's audit of the reviewer (review/monitor).
 *
 * The hero is non-deterministic (design RISK-1): a real run may catch a
 * correction OR verify the worker clean. This module derives BOTH honestly
 * from disk and NEVER fabricates a disagreement:
 *   - reviewer recomputed a DIFFERENT value  -> framing "corrected"
 *   - reviewer recomputed the SAME value, or the gate passed with no
 *     independent number to show                -> framing "verified"
 * A number only ever appears in the reviewer column when it was actually
 * found in the reviewer's own files — otherwise the column says "confirmed"
 * (gate passed) or "flagged" (gate failed), never an invented figure.
 */

import { deriveMeasurementEvidence } from "./evidence.js";

/** True for a finite JS number (rejects NaN/±Infinity/non-numbers). */
function isNum(v) {
  return typeof v === "number" && isFinite(v);
}

/** Two measured values are "the same" within the reviewer's own recompute
 * tolerance (gate feedback quotes a 1e-6 match). Relative so it holds across
 * scales; absolute floor so near-zero values don't spuriously "differ". */
function sameValue(a, b) {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * The classification label pair for a decisive measurement, if the worker's
 * measurements file carries one: `measurements.classifications[key] =
 * { inRange, outOfRange }` (e.g. `{ inRange: "Normal", outOfRange: "OA" }`).
 * A protocol that emits these lights up the domain wording; without them the
 * card falls back to generic cutoff language, never inventing a domain label.
 */
function labelsFor(measurements, key) {
  const c = measurements && measurements.classifications;
  const entry = c && typeof c === "object" ? c[key] : null;
  const inRange = entry && typeof entry.inRange === "string" ? entry.inRange : "within cutoff";
  const outOfRange =
    entry && typeof entry.outOfRange === "string" ? entry.outOfRange : "outside cutoff";
  return { inRange, outOfRange };
}

/** A measured value's side of the cutoff: { inRange, classification }. */
function classify(value, range, labels) {
  const inRange = value >= range.min && value <= range.max;
  return { inRange, classification: inRange ? labels.inRange : labels.outOfRange };
}

/** Containers a reviewer's verification JSON might nest its recomputed values
 * under, checked in addition to the top level. Ordered most-specific first. */
const REVIEWER_VALUE_CONTAINERS = [
  "recomputed",
  "recomputed_ratios",
  "recomputed_values",
  "ratios",
  "reviewer",
  "values",
  "measurements",
];

/**
 * The reviewer's OWN recomputed number for `key`, searched across its parsed
 * verification JSON files (top level, then the known nesting containers).
 * Returns the first finite match, or null when the reviewer left no structured
 * number for this key (common: it saved only a .py script + prose gate). Never
 * falls back to the worker's number — a null here means "no independent number
 * to show", which the card renders honestly.
 */
export function findReviewerValue(reviewerVerification, key) {
  for (const item of reviewerVerification ?? []) {
    const data = item && item.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    if (isNum(data[key])) return data[key];
    for (const c of REVIEWER_VALUE_CONTAINERS) {
      const nested = data[c];
      if (nested && typeof nested === "object" && !Array.isArray(nested) && isNum(nested[key])) {
        return nested[key];
      }
    }
  }
  return null;
}

/** The provenance links the card shows in plain language, each pointing at the
 * contract path that holds it — only the ones that actually exist on disk. */
function provenanceLinks(phaseDetail) {
  const { phase, measurements, verification, monitorVerdict } = phaseDetail;
  const links = [];
  if (measurements) {
    links.push({ label: "Worker measurement file", path: `phases/${phase}/measurements.json` });
  }
  if ((verification ?? []).length > 0) {
    links.push({ label: "Reviewer recomputation", path: `review/verification/${phase}/` });
  }
  if (monitorVerdict) {
    links.push({ label: "Audit record", path: `review/monitor/${phase}.json` });
  }
  return links;
}

/** The monitor slice: verdict + whether it PASSED the audit (only "ok" passes;
 * "rubber_stamp"/"insufficient_evidence" are the third agent catching a
 * reviewer that did not actually recompute). */
function deriveMonitor(monitorVerdict) {
  if (!monitorVerdict) return null;
  return {
    verdict: monitorVerdict.verdict,
    passed: monitorVerdict.verdict === "ok",
    reasons: monitorVerdict.reasons ?? [],
  };
}

/**
 * Derive the whole review chain for one phase's getPhase detail, or null when
 * there is nothing chain-worthy to pin (no decisive measurement, no monitor,
 * no reviewer recomputation, no correction history — the plain evidence panel
 * covers that case). See the module header for the framing contract.
 */
export function deriveReviewChain(phaseDetail) {
  if (!phaseDetail) return null;
  const {
    measurements,
    gate,
    gateHistory = [],
    reviewerVerification = [],
    monitorVerdict,
  } = phaseDetail;

  const { decisive } = deriveMeasurementEvidence(measurements);
  // Hero row: the caught one leads (first fail), else the first decisive value.
  const hero = decisive.find((r) => r.state === "fail") ?? decisive[0] ?? null;

  const monitor = deriveMonitor(monitorVerdict);
  const gateDecision = gate ? gate.decision : null;
  const history =
    gateHistory.length > 0
      ? {
          attempts: gateHistory.length,
          latestFeedback: gateHistory[gateHistory.length - 1].feedback ?? null,
        }
      : null;

  let measurement = null;
  if (hero) {
    const labels = labelsFor(measurements, hero.key);
    const worker = { value: hero.value, ...classify(hero.value, hero.range, labels) };

    const reviewerValue = findReviewerValue(reviewerVerification, hero.key);
    let reviewer;
    let framing;
    let directional = null;
    let crossedCutoff = false;

    if (reviewerValue !== null) {
      const rClass = classify(reviewerValue, hero.range, labels);
      const differs = !sameValue(reviewerValue, worker.value);
      reviewer = {
        value: reviewerValue,
        ...rClass,
        status: differs ? "recomputed-differs" : "confirmed",
      };
      framing = differs ? "corrected" : "verified";
      if (differs) {
        directional = reviewerValue > worker.value ? "higher" : "lower";
        crossedCutoff = rClass.inRange !== worker.inRange;
      }
    } else if (history) {
      // No independent number to show now, but the gate history proves the
      // reviewer caught and corrected this phase across attempts.
      reviewer = { value: null, inRange: null, classification: null, status: "flagged" };
      framing = "corrected";
    } else if (gateDecision === "pass" || gateDecision === "pass-with-concerns") {
      // Reviewer passed the phase with no separate number: an honest verify.
      reviewer = {
        value: null,
        inRange: worker.inRange,
        classification: worker.classification,
        status: "confirmed",
      };
      framing = "verified";
    } else {
      reviewer = { value: null, inRange: null, classification: null, status: "unknown" };
      framing = "pending";
    }

    measurement = {
      key: hero.key,
      cutoff: hero.range,
      worker,
      reviewer,
      framing,
      directional,
      crossedCutoff,
    };
  }

  // Nothing chain-worthy to pin.
  if (!measurement && !monitor && !history && reviewerVerification.length === 0) {
    return null;
  }

  return {
    measurement,
    monitor,
    history,
    gateDecision,
    provenance: provenanceLinks(phaseDetail),
  };
}
