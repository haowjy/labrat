import { html } from "../vendor/preact-htm.js";
import { decisionPill } from "../lib/format.js";
import {
  deriveMeasurementEvidence,
  fmtMeasurementValue,
  gateTint,
  subphasesNeedingReview,
} from "../lib/evidence.js";

/**
 * The trusted Evidence panel — the lead of the generic review layer (design/
 * review-architecture-decision.md: the decisive evidence a reviewer reads
 * lives in the shell, OUTSIDE the untrusted artifact). Pure Process-B chrome:
 * everything here is read from disk via getPhase (measurements, latest
 * subphase marks, the gate) and passed in as `phaseDetail` — this component
 * never fetches or writes.
 *
 * Order carries the hierarchy (goal doc "surface the decisive numbers
 * first"):
 *   1. Subphases the worker flagged `human-review` — its explicit "a human
 *      must look at this" — lead, since they're why the phase is in front of
 *      a person at all.
 *   2. Decisive measurements: each measured number that has an on-disk cutoff
 *      range, with the pass/fail the shell can compute itself and the exact
 *      cutoff it compared against.
 *   3. Other measured values (no machine-checkable cutoff on disk) with the
 *      clearly-marked gap note — the shell shows the number but won't invent
 *      a threshold; the gate's reasoning below carries the qualitative call.
 *   4. The automated gate's decision + narrative (+ per-subphase assessments),
 *      which articulates the cutoff comparison in prose.
 */
function NeedsReview({ subphases }) {
  const flagged = subphasesNeedingReview(subphases);
  if (flagged.length === 0) return null;
  return html`
    <div class="evidence-flags">
      <span class="section-label section-label-alert">Flagged for human review (${flagged.length})</span>
      ${flagged.map(
        (s) => html`
          <div class="evidence-flag" key=${s.subphase}>
            <div class="evidence-flag-head">
              <code class="chip">${s.subphase}</code>
              ${s.confidence ? html`<span class="evidence-conf">confidence: ${s.confidence}</span>` : null}
            </div>
            ${s.notes ? html`<p class="evidence-flag-note">${s.notes}</p>` : null}
          </div>
        `,
      )}
    </div>
  `;
}

function DecisiveRow({ row }) {
  const [pc, pl] = decisionPill(row.state === "pass" ? "pass" : "fail");
  return html`
    <div class="measure-row measure-row-${row.state}">
      <span class="measure-key">${row.key}</span>
      <span class="measure-val">${fmtMeasurementValue(row.value)}</span>
      <span class="measure-cutoff">in ${row.range.min}–${row.range.max}</span>
      <span class="pill ${pc}">${pl}</span>
    </div>
  `;
}

function ContextRow({ row }) {
  return html`
    <div class="measure-row measure-row-context">
      <span class="measure-key">${row.key}</span>
      <span class="measure-val">${fmtMeasurementValue(row.value)}</span>
      <span class="measure-cutoff measure-cutoff-none">no cutoff on disk</span>
    </div>
  `;
}

function GateBand({ gate }) {
  if (!gate) return null;
  const [pc, pl] = decisionPill(gate.decision);
  const assessments = gate.subphase_assessments
    ? Object.entries(gate.subphase_assessments).filter(([, v]) => typeof v === "string")
    : [];
  return html`
    <div class="gate-note gate-note-${gateTint(gate.decision)}">
      <div class="gate-note-head">
        <span class="section-label">Automated gate</span>
        <span class="pill ${pc}">${pl}</span>
      </div>
      ${gate.feedback
        ? html`<p class="gate-note-body">${gate.feedback}</p>`
        : html`<p class="gate-note-body gate-note-empty">No feedback recorded.</p>`}
      ${assessments.length > 0
        ? html`
            <dl class="gate-subphases">
              ${assessments.map(
                ([name, text]) => html`
                  <div class="gate-subphase" key=${name}>
                    <dt><code class="chip">${name}</code></dt>
                    <dd>${text}</dd>
                  </div>
                `,
              )}
            </dl>`
        : null}
    </div>
  `;
}

export function EvidencePanel({ phaseDetail }) {
  if (!phaseDetail) return null;
  const { measurements, subphases, gate } = phaseDetail;
  const { decisive, context, uncheckedNumbers } = deriveMeasurementEvidence(measurements);
  const hasMeasurements = decisive.length > 0 || context.length > 0;

  return html`
    <div class="evidence-panel">
      <span class="section-label">Decisive evidence</span>
      <${NeedsReview} subphases=${subphases} />
      ${hasMeasurements
        ? html`
            <div class="measure-table">
              ${decisive.map((row) => html`<${DecisiveRow} key=${row.key} row=${row} />`)}
              ${context.map((row) => html`<${ContextRow} key=${row.key} row=${row} />`)}
            </div>
            ${uncheckedNumbers > 0
              ? html`<p class="evidence-gap">
                  ${uncheckedNumbers} measured value(s) carry no machine-checkable cutoff on disk. The gate's
                  reasoning below carries the qualitative call; the skill lane exposes the numeric cutoffs.
                </p>`
              : null}`
        : html`<p class="evidence-empty">No measurements recorded for this phase — the decisive numbers live inside the review artifact.</p>`}
      <${GateBand} gate=${gate} />
    </div>
  `;
}
