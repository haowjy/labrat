/*
 * F1 postMessage bridge — trust-critical, ported unchanged in behavior from
 * the vanilla app.js (design/review-architecture-decision.md "what lives
 * where": verdict state is assembled ONLY in the trusted shell, never inside
 * the untrusted iframe). Every constant, predicate, and validator below is
 * the SAME check the vanilla shell ran — same key sets, same enums, same
 * finite-number requirement, same id regex, same caps. Nothing here got
 * looser when it became Preact.
 *
 * Deliberately framework-free and pure (no DOM, no Preact): every exported
 * function takes state in and returns new state, never mutates its
 * arguments, and never touches `window`/`document`/`Date.now()` directly
 * (callers pass `now` in) — so this file is directly unit-testable with
 * plain Node assertions (review-bridge.test.ts), and the untestable part
 * (the real `window.addEventListener("message", ...)` wiring, the iframe
 * `contentWindow` identity check, the load-counter) lives in the one place
 * that actually needs the DOM: components/useReviewBridge.js.
 *
 * TRUST BOUNDARY (unchanged): an `interaction` is untrusted EVIDENCE. It may
 * auto-tint the verdict "corrected" for the reviewer's attention, but
 * `applyReviewMessage` never sets `verdict.status` — that stays reserved for
 * an explicit reviewer action (`withStatus`, called only from a button
 * click), so the eventual write can never be driven by a raw iframe message.
 */

// The trusted receiver's protocol contract (F1). Only these message types,
// actions, and keys are accepted; everything else is dropped.
export const REVIEW_MSG_TYPES = { ready: 1, interaction: 1, "metrics-updated": 1 };
export const REVIEW_INTERACTION_ACTIONS = { "landmark-moved": 1 };
export const REVIEW_ID_RE = /^[A-Za-z0-9_-]{1,128}$/; // a bounded, safe landmark id
export const REVIEW_LOG_CAP = 200; // max log lines kept
export const REVIEW_EVIDENCE_CAP = 500; // max validated-interaction payloads retained
export const REVIEW_LOG_RATE_WINDOW_MS = 1000;
export const REVIEW_LOG_RATE_MAX = 20; // beyond this per window, coalesce/drop
export const REVIEW_METRICS_MAX_KEYS = 16;

const REVIEW_INTERACTION_KEYS = { type: 1, action: 1, id: 1, position: 1 };
const REVIEW_POSITION_KEYS = { x: 1, y: 1, z: 1 };
const REVIEW_METRICS_KEYS = { type: 1, metrics: 1 };
const REVIEW_READY_KEYS = { type: 1 };

export function newReviewVerdict() {
  return {
    status: null,
    corrected: false,
    evidence: [],
    log: [],
    logWindowStart: 0,
    logWindowCount: 0,
    logSuppressed: 0,
  };
}

/** True for a finite JS number (rejects NaN/±Infinity/non-numbers). */
export function isFiniteNumber(n) {
  return typeof n === "number" && isFinite(n);
}

/** True when `obj`'s own enumerable keys are all within `allowed` (no extras). */
export function hasOnlyKeys(obj, allowed) {
  for (const k of Object.keys(obj)) if (!allowed[k]) return false;
  return true;
}

/** A bounded, safe landmark id (non-empty, <=128 chars, `[A-Za-z0-9_-]`). */
export function isReviewId(id) {
  return typeof id === "string" && REVIEW_ID_RE.test(id);
}

/**
 * Validate an `interaction`: strict keys, known action, safe id, finite x/y/z.
 * Returns the sanitized payload, or null to reject.
 */
export function validateInteraction(d) {
  if (!hasOnlyKeys(d, REVIEW_INTERACTION_KEYS)) return null;
  if (!REVIEW_INTERACTION_ACTIONS[d.action]) return null;
  if (!isReviewId(d.id)) return null;
  const p = d.position;
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (!hasOnlyKeys(p, REVIEW_POSITION_KEYS)) return null;
  if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z)) return null;
  return { action: d.action, id: d.id, position: { x: p.x, y: p.y, z: p.z } };
}

/**
 * Validate a `metrics-updated`: strict keys, safe id, only finite-number
 * metric values (no arbitrary objects/arrays). Returns sanitized metrics or
 * null.
 */
export function validateMetrics(d) {
  if (!hasOnlyKeys(d, REVIEW_METRICS_KEYS)) return null;
  const m = d.metrics;
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const keys = Object.keys(m);
  if (keys.length === 0 || keys.length > REVIEW_METRICS_MAX_KEYS) return null;
  if (!isReviewId(m.id)) return null;
  const out = { id: m.id };
  for (const k of keys) {
    if (k === "id") continue;
    if (!isFiniteNumber(m[k])) return null;
    out[k] = m[k];
  }
  return out;
}

/**
 * Append one line to `verdict.log`, rate-limited exactly as the vanilla
 * shell rate-limited its DOM log strip: at most REVIEW_LOG_RATE_MAX lines
 * per REVIEW_LOG_RATE_WINDOW_MS window; events beyond that are counted and
 * coalesced into a single "N suppressed" line surfaced at the start of the
 * next window. `now` is injected (defaults to Date.now()) so callers/tests
 * can drive the rate limiter deterministically instead of sleeping.
 *
 * Adaptation note: the vanilla shell kept the "N suppressed" notice
 * DOM-only (never pushed into the in-memory `state.reviewVerdict.log`
 * array, which nothing read — a write-only artifact of imperative DOM
 * rendering). Preact has no separate imperative channel; `verdict.log` IS
 * what renders, so the suppressed notice is folded into it here. Same text,
 * same order, same cap, same rate-limit semantics — only the "where does
 * the string live before it's on screen" plumbing changed.
 */
export function appendVerdictLog(verdict, text, now = Date.now()) {
  let v = verdict;
  const lines = [];
  if (now - v.logWindowStart > REVIEW_LOG_RATE_WINDOW_MS) {
    if (v.logSuppressed > 0) {
      lines.push(`… ${v.logSuppressed} event(s) suppressed (rate limit).`);
    }
    v = { ...v, logWindowStart: now, logWindowCount: 0, logSuppressed: 0 };
  }
  v = { ...v, logWindowCount: v.logWindowCount + 1 };
  if (v.logWindowCount > REVIEW_LOG_RATE_MAX) {
    return { ...v, logSuppressed: v.logSuppressed + 1 };
  }
  lines.push(text);
  let log = v.log;
  for (const line of lines) {
    log = [...log, { text: line, at: new Date(now).toISOString() }];
  }
  if (log.length > REVIEW_LOG_CAP) log = log.slice(log.length - REVIEW_LOG_CAP);
  return { ...v, log };
}

/**
 * Pure reducer for one postMessage event's `data`, called ONLY after the
 * caller has confirmed `event.source` is the exact mounted iframe window
 * (that identity check needs a live WindowProxy reference, which is DOM
 * state this module deliberately does not hold — see useReviewBridge.js).
 * Unknown/invalid messages return the SAME verdict reference (no-op), so a
 * caller can skip a re-render with `next === prev`.
 *
 * TRUST BOUNDARY: `interaction` only ever flips `corrected` — it can never
 * set `status`. `status` is set exclusively by `withStatus`, called only
 * from an explicit reviewer action.
 */
export function applyReviewMessage(verdict, data, now = Date.now()) {
  if (!data || typeof data !== "object" || !REVIEW_MSG_TYPES[data.type]) return verdict;

  if (data.type === "ready") {
    if (!hasOnlyKeys(data, REVIEW_READY_KEYS)) return verdict;
    return appendVerdictLog(verdict, "Review site loaded and interactive.", now);
  }

  if (data.type === "interaction") {
    const ok = validateInteraction(data);
    if (!ok) return verdict;
    let evidence = [...verdict.evidence, ok];
    if (evidence.length > REVIEW_EVIDENCE_CAP) {
      evidence = evidence.slice(evidence.length - REVIEW_EVIDENCE_CAP);
    }
    const next = { ...verdict, evidence, corrected: true };
    return appendVerdictLog(
      next,
      `Adjusted ${ok.id} — flagged "corrected" (needs an explicit reviewer verdict).`,
      now,
    );
  }

  if (data.type === "metrics-updated") {
    const m = validateMetrics(data);
    if (!m) return verdict;
    const bits = Object.keys(m)
      .filter((k) => k !== "id")
      .map((k) => `${k}=${m[k]}`)
      .join(", ");
    return appendVerdictLog(verdict, `Metrics for ${m.id}: ${bits}`, now);
  }

  return verdict;
}

/**
 * Revoke the bridge's untrusted state: called when an iframe the shell
 * mounted reloads/navigates on its own (the WindowProxy survives that, so
 * `event.source` alone can't distinguish a self-navigated document — F1).
 * Clears `corrected` and `evidence`; PRESERVES `status` (the reviewer's own
 * explicit verdict is not iframe-sourced, so it survives). The caller is
 * responsible for also dropping its live iframe-window reference so future
 * messages fail the identity check.
 */
export function revokeEvidence(verdict, reason, now = Date.now()) {
  const next = { ...verdict, corrected: false, evidence: [] };
  return appendVerdictLog(
    next,
    `Bridge revoked — ${reason}. Re-open the review to re-establish it.`,
    now,
  );
}

/**
 * The ONLY setter for the reviewer's explicit, committable verdict. Never
 * called from message handling — only from a user action (a Pass/Fail
 * click in VerdictPanel).
 */
export function withStatus(verdict, status) {
  return { ...verdict, status };
}

/** Pill shown for the current verdict: an explicit status wins; otherwise
 * the untrusted "corrected" evidence flag tints it; otherwise pending. */
export function verdictLabel(verdict) {
  return verdict.status || (verdict.corrected ? "corrected" : "pending");
}

export function verdictPillClass(label) {
  if (label === "pass") return "pill-pass";
  if (label === "fail") return "pill-fail";
  if (label === "corrected") return "pill-warn";
  return "pill-skip";
}

/**
 * Latest validated position per landmark id, in first-seen order — the
 * shell's best-effort `adjustments` list for the Finish-review write. Each
 * entry's `proposed` is `null`: the review-site's `interaction` message
 * carries only the POST-drag position (see index.html's endDrag()), never
 * the pre-drag one, and `metrics-updated` carries only a scalar
 * `drift_from_original_mm`, not a vector — so the shell has no honest value
 * to put there today. Sending a fabricated `proposed` (e.g. copying
 * `corrected`) would be worse than `null`: it would silently claim no
 * drift happened. See the Lane B report for the follow-up this implies.
 */
export function adjustmentsFromEvidence(evidence) {
  const byId = new Map();
  for (const e of evidence) {
    byId.set(e.id, { id: e.id, proposed: null, corrected: e.position });
  }
  return [...byId.values()];
}
