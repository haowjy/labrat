/*
 * Presentation-only pure helpers for the trusted Evidence panel
 * (components/EvidencePanel.js), in the same framework-free style as
 * lib/format.js and lib/review-bridge.js: no DOM, no Preact, every function
 * takes plain data in and returns plain data out, so the derivation is
 * eyeball-verifiable and never throws on the arbitrary per-protocol JSON the
 * read API hands back (getPhase returns `measurements` untyped —
 * dashboard/api/index.ts).
 *
 * The panel is Process-B chrome: it reads what is ALREADY on disk and never
 * invents a threshold it cannot read. The ONLY machine-readable cutoff source
 * a measurements file carries today is an `expectedRanges` map (see
 * fixtures/.../segmentation/measurements.json); a measured number without a
 * matching range is surfaced as a plain value, NOT a fabricated pass/fail.
 * Which un-ranged numbers are actually DECISIVE (e.g. femurComponents,
 * "expected 1") lives only in the gate's prose today — the data gap the skill
 * lane closes by injecting cutoffs alongside the measurements.
 */

/** True for a finite JS number (rejects NaN/±Infinity/non-numbers). */
function isNum(v) {
  return typeof v === "number" && isFinite(v);
}

/** A measurement's on-disk cutoff: a `[min, max]` pair of finite numbers,
 * else null. Tolerates any shape `expectedRanges[key]` might hold. */
export function asRange(r) {
  if (Array.isArray(r) && r.length === 2 && isNum(r[0]) && isNum(r[1])) {
    return { min: r[0], max: r[1] };
  }
  return null;
}

/**
 * Split a phase's `measurements.json` into two lists:
 *
 *   - `decisive`: a measured number that has an on-disk cutoff range, so the
 *     shell can state pass/fail itself — `{ key, value, range, state }` with
 *     `state` "pass" (in range) or "fail" (out). Sorted fail-first so an
 *     out-of-range value leads.
 *   - `context`: everything else (un-ranged numbers, arrays, objects,
 *     strings), shown as plain measured values with no invented verdict.
 *
 * `uncheckedNumbers` counts the numeric context entries — the ones that WOULD
 * be decisive if a cutoff were on disk. A non-zero count is what the panel
 * uses to render the "no machine-checkable cutoff" gap note.
 */
export function deriveMeasurementEvidence(measurements) {
  if (!measurements || typeof measurements !== "object" || Array.isArray(measurements)) {
    return { decisive: [], context: [], uncheckedNumbers: 0 };
  }
  const rangesRaw = measurements.expectedRanges;
  const ranges = rangesRaw && typeof rangesRaw === "object" && !Array.isArray(rangesRaw) ? rangesRaw : {};

  const decisive = [];
  const context = [];
  let uncheckedNumbers = 0;

  for (const [key, value] of Object.entries(measurements)) {
    if (key === "expectedRanges") continue;
    const range = asRange(ranges[key]);
    if (range && isNum(value)) {
      const state = value >= range.min && value <= range.max ? "pass" : "fail";
      decisive.push({ key, value, range, state });
    } else {
      if (isNum(value)) uncheckedNumbers += 1;
      context.push({ key, value });
    }
  }

  decisive.sort((a, b) => (a.state === b.state ? 0 : a.state === "fail" ? -1 : 1));
  return { decisive, context, uncheckedNumbers };
}

/** The subphases whose LATEST mark still asks for a human (mark
 * "human-review"): the worker's explicit "look at this" flags. The panel
 * leads with these. A subphase the worker later resolved (e.g. a replay that
 * flipped it to pass) is no longer pending, so it correctly drops out. */
export function subphasesNeedingReview(subphases) {
  return (subphases ?? []).filter((s) => s && s.mark === "human-review");
}

/** decision -> tint class shared with the phase-dot / gate-note palette
 * (pass / concerns / fail), so the evidence panel's gate band can't disagree
 * with the selector dot for the same phase. */
export function gateTint(decision) {
  if (decision === "pass") return "pass";
  if (decision === "pass-with-concerns") return "concerns";
  return "fail";
}

/** Render a measurement value compactly for a mono cell: arrays as
 * `[a, b, c]`, objects as one-line JSON, scalars as-is. */
export function fmtMeasurementValue(v) {
  if (Array.isArray(v)) return `[${v.join(", ")}]`;
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}
