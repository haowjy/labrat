import { html } from "../vendor/preact-htm.js";
import { deriveReviewChain } from "../lib/review-chain.js";

/**
 * The pinned hero of the review layer (design §4): the trusted shell's honest
 * expression of the three-agent review chain for one phase — WORKER measured,
 * independent REVIEWER recomputed, third-agent MONITOR audited the reviewer.
 * Pure Process-B chrome: every value is derived from disk via getPhase
 * (`lib/review-chain.js`) and passed in as `phaseDetail`; this component never
 * fetches or writes, and never fabricates a disagreement.
 *
 * The hero is non-deterministic (RISK-1): the SAME card renders both honest
 * framings without staging one. If the reviewer recomputed a different value
 * it shows the correction (worker vs. reviewer, direction, cutoff crossed);
 * if they agree it reads "Independently verified" — no fake disagreement.
 * Sits ABOVE the EvidencePanel: the chain is the answer, the measurement
 * table + gate prose below are the depth.
 */

function fmtNum(v) {
  if (typeof v !== "number" || !isFinite(v)) return String(v);
  return String(Number.isInteger(v) ? v : +v.toPrecision(4));
}

function classPill(inRange) {
  return inRange ? "pill-pass" : "pill-fail";
}

/** The card-level headline: the measurement framing when there is a decisive
 * number, else the chain's own state (verified when the gate passed and the
 * audit held, otherwise still under review). */
function headline(chain) {
  if (chain.measurement) return chain.measurement.framing;
  const gatePass = chain.gateDecision === "pass" || chain.gateDecision === "pass-with-concerns";
  if (gatePass && (!chain.monitor || chain.monitor.passed)) return "verified";
  return "pending";
}

const HEADLINE = {
  corrected: ["pill-warn", "Caught and corrected"],
  verified: ["pill-pass", "Independently verified"],
  pending: ["pill-skip", "Under review"],
};

/** The reviewer column — a real number when the reviewer left one, else an
 * honest status word (confirmed / recomputed / pending), never an invented
 * figure. */
function ReviewerCell({ reviewer }) {
  if (reviewer.value !== null) {
    return html`
      <span class="chain-value">${fmtNum(reviewer.value)}</span>
      <span class="pill ${classPill(reviewer.inRange)}">${reviewer.classification}</span>
    `;
  }
  if (reviewer.status === "confirmed") {
    return html`
      <span class="chain-value chain-value-word">Confirmed</span>
      ${reviewer.classification
        ? html`<span class="pill ${classPill(reviewer.inRange)}">${reviewer.classification}</span>`
        : null}
    `;
  }
  if (reviewer.status === "flagged") {
    return html`<span class="chain-value chain-value-word">Recomputed · disagreed</span>`;
  }
  return html`<span class="chain-value chain-value-word chain-muted">Pending</span>`;
}

function MeasurementCompare({ measurement }) {
  const { worker, reviewer, directional, crossedCutoff, cutoff, framing } = measurement;
  const arrow = directional === "higher" ? "↑" : directional === "lower" ? "↓" : "=";
  return html`
    <div class="chain-compare">
      <div class="chain-col">
        <span class="chain-col-label">Worker measured</span>
        <span class="chain-value">${fmtNum(worker.value)}</span>
        <span class="pill ${classPill(worker.inRange)}">${worker.classification}</span>
      </div>
      <div class="chain-arrow" aria-hidden="true">${arrow}</div>
      <div class="chain-col">
        <span class="chain-col-label">Independent reviewer recomputed</span>
        <${ReviewerCell} reviewer=${reviewer} />
      </div>
    </div>
    <div class="chain-cutoff">Cutoff: values within <b>${cutoff.min}–${cutoff.max}</b> pass</div>
    ${framing === "corrected" && crossedCutoff
      ? html`<p class="chain-correction-note">
          The reviewer's recomputation crosses the cutoff
          (${worker.classification} → ${reviewer.classification ?? "flagged"}):
          a diseased reading caught before it reaches the researcher.
        </p>`
      : null}
  `;
}

function MonitorLine({ monitor }) {
  if (!monitor) {
    return html`<div class="chain-monitor chain-monitor-none">
      Third-agent audit: not recorded for this phase
    </div>`;
  }
  return html`
    <div class="chain-monitor ${monitor.passed ? "chain-monitor-pass" : "chain-monitor-fail"}">
      <span class="chain-monitor-head">
        Reviewer audit
        <span class="pill ${monitor.passed ? "pill-pass" : "pill-fail"}">
          ${monitor.passed ? "passed" : "failed"}
        </span>
      </span>
      ${monitor.reasons.length > 0
        ? html`<span class="chain-monitor-reason">${monitor.reasons[0]}</span>`
        : null}
    </div>
  `;
}

function HistoryLine({ history }) {
  if (!history) return null;
  return html`
    <details class="chain-history">
      <summary>
        ${`Caught and corrected over ${history.attempts} review ${
          history.attempts === 1 ? "attempt" : "attempts"
        }`}
      </summary>
      ${history.latestFeedback
        ? html`<p class="chain-history-feedback">${history.latestFeedback}</p>`
        : html`<p class="chain-history-feedback chain-muted">No feedback text recorded.</p>`}
    </details>
  `;
}

function Provenance({ links, entry }) {
  if (links.length === 0 && !entry) return null;
  const verified = !!entry;
  return html`
    <div class="chain-provenance">
      <span class="section-label">Provenance</span>
      <ul class="chain-prov-list">
        ${links.map(
          (l) => html`
            <li class="chain-prov-item" key=${l.path}>
              <span class="chain-prov-label">${l.label}</span>
              <code class="chain-prov-path">${l.path}</code>
              ${verified ? html`<span class="chain-prov-verified">integrity verified</span>` : null}
            </li>
          `,
        )}
      </ul>
      <details class="chain-tech">
        <summary>Technical details (hashes, sessions, timing)</summary>
        ${entry
          ? html`
              <dl class="chain-tech-grid">
                <div><dt>Agent</dt><dd>${entry.agent}</dd></div>
                <div><dt>Attempt</dt><dd>${entry.attempt}</dd></div>
                <div><dt>Worker session</dt><dd><code>${entry.sessions.worker}</code></dd></div>
                <div><dt>Gate session</dt><dd><code>${entry.sessions.gate}</code></dd></div>
                <div><dt>Started</dt><dd>${entry.started}</dd></div>
                <div><dt>Completed</dt><dd>${entry.completed}</dd></div>
              </dl>
              <span class="section-label">Recorded artifacts</span>
              <ul class="chain-hash-list">
                ${entry.outputs.map(
                  (o) => html`
                    <li key=${o.path}>
                      <code class="chain-hash-path">${o.path}</code>
                      ${o.hash ? html`<code class="chain-hash">${o.hash}</code>` : null}
                    </li>
                  `,
                )}
              </ul>
            `
          : html`<p class="chain-muted">No provenance manifest entry recorded yet.</p>`}
      </details>
    </div>
  `;
}

export function ReviewChainCard({ phaseDetail }) {
  const chain = deriveReviewChain(phaseDetail);
  if (!chain) return null;

  const [pillClass, pillText] = HEADLINE[headline(chain)];

  return html`
    <div class="review-chain-card">
      <div class="chain-head">
        <span class="section-label">Review chain · worker → reviewer → audit</span>
        <span class="pill ${pillClass}">${pillText}</span>
      </div>
      ${chain.measurement
        ? html`<${MeasurementCompare} measurement=${chain.measurement} />`
        : html`<p class="chain-no-measure">
            No cutoff-checkable measurement for this phase. The chain below records the
            reviewer's independent check and the audit.
          </p>`}
      <${HistoryLine} history=${chain.history} />
      <${MonitorLine} monitor=${chain.monitor} />
      <${Provenance} links=${chain.provenance} entry=${phaseDetail.provenance} />
    </div>
  `;
}
