import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { getJSON, getText } from "../lib/api.js";
import { decisionPill, dotClass, duration, fmtTime } from "../lib/format.js";

const INLINE_VERIFICATION_RE = /\.(py|txt|md|json)$/;

function Measurements({ measurements }) {
  if (!measurements || typeof measurements !== "object" || Array.isArray(measurements)) {
    return null;
  }
  const rows = Object.entries(measurements).filter(
    ([, v]) => typeof v === "number" || typeof v === "string",
  );
  if (rows.length === 0) return null;
  return html`
    <div class="section-label">Measurements</div>
    <div class="measure">
      <table>
        <tbody>
          ${rows.map(
            ([k, v]) => html`
              <tr key=${k}>
                <td class="k">${k}</td>
                <td class="v">${v}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

function Subphases({ subphases }) {
  if (!subphases || subphases.length === 0) return null;
  return html`
    <div class="subphases">
      ${subphases.map((sp) => {
        const [pc, pl] =
          sp.mark === "pass"
            ? ["pill-pass", "pass"]
            : sp.mark === "human-review"
              ? ["pill-review", "human-review"]
              : ["pill-fail", "fail"];
        const conf = [sp.confidence, sp.notes].filter(Boolean).join(" — ");
        return html`
          <div class="sp" key=${sp.subphase}>
            <span class="pill ${pc}">${pl}</span>
            <span class="sp-name">${sp.subphase}</span>
            <span class="sp-conf">${conf}</span>
          </div>
        `;
      })}
    </div>
  `;
}

function EvidenceGrid({ taskId, phase, files, onOpen }) {
  if (!files || files.length === 0) return null;
  return html`
    <div class="section-label">Evidence</div>
    <div class="evidence-grid">
      ${files.map((f) => {
        const src = `/api/tasks/${encodeURIComponent(taskId)}/phases/${encodeURIComponent(phase)}/evidence/${encodeURIComponent(f)}`;
        return html`
          <div class="evidence-thumb" key=${f} onClick=${() => onOpen(src, f)}>
            <img src=${src} alt=${f} loading="lazy" />
            <div class="cap">${f}</div>
          </div>
        `;
      })}
    </div>
  `;
}

/** Reviewer verification — proof the reviewer RAN code (design §10). Inlines
 * the small text files (.py/.txt/.md/.json) so the independent check is
 * legible without a click; other filetypes are still linked. */
function VerificationBlock({ taskId, phase, files }) {
  const [bodies, setBodies] = useState({});

  useEffect(() => {
    let cancelled = false;
    const targets = files.filter((f) => INLINE_VERIFICATION_RE.test(f));
    Promise.all(
      targets.map((f) =>
        getText(
          `/api/tasks/${encodeURIComponent(taskId)}/verification/${encodeURIComponent(phase)}/${encodeURIComponent(f)}`,
        ).then((body) => [f, body]),
      ),
    ).then((pairs) => {
      if (cancelled) return;
      const next = {};
      for (const [f, body] of pairs) if (body) next[f] = body;
      setBodies(next);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId, phase, files.join("|")]);

  if (!files || files.length === 0) return null;
  return html`
    <div class="verify">
      <div class="verify-head">Reviewer verification — code + output</div>
      <div class="verify-files">
        ${files.map(
          (f) => html`
            <a
              key=${f}
              href="/api/tasks/${encodeURIComponent(taskId)}/verification/${encodeURIComponent(phase)}/${encodeURIComponent(f)}"
              target="_blank"
              rel="noreferrer"
              >${f}</a
            >
          `,
        )}
      </div>
      ${Object.entries(bodies).map(
        ([f, body]) => html`<pre key=${f}># ${f}\n\n${body.trim()}</pre>`,
      )}
    </div>
  `;
}

function GateBlock({ gate }) {
  if (!gate) return null;
  const [pc, pl] = decisionPill(gate.decision);
  const cls =
    gate.decision === "pass" ? "pass" : gate.decision === "pass-with-concerns" ? "concerns" : "fail";
  return html`
    <div class="gate ${cls}">
      <span class="pill ${pc}">${pl}</span>
      ${gate.confidence ? html`<span class="pill pill-warn">confidence ${gate.confidence}</span>` : null}
      <div class="gate-body">
        ${gate.feedback ? html`<div class="gate-feedback">${gate.feedback}</div>` : null}
      </div>
    </div>
  `;
}

/** The human review verdict, read back from the persisted task-tree write
 * (goal doc: "the chain view reads the persisted verdict back... shows the
 * completed chain (agent confidence + human verdict)"). ASSUMPTION (flagged
 * in the Lane B report): Lane A's read route is expected to surface this as
 * a `humanReview` field on the GET /api/tasks/:id response, shaped after the
 * pinned POST /review/finish body plus a `reviewed_at` stamp. Read
 * defensively — if the field is named differently or absent (Lane A not yet
 * merged, or this phase was never finished), nothing renders here; the rest
 * of the chain is unaffected. */
function HumanVerdict({ humanReview }) {
  if (!humanReview) return null;
  const pass = humanReview.human_verdict === "pass";
  return html`
    <div class="human-verdict">
      <span class="pill ${pass ? "pill-pass" : "pill-fail"}"
        >human: ${humanReview.human_verdict}</span
      >
      ${humanReview.corrected ? html`<span class="pill pill-warn">corrected</span>` : null}
      ${humanReview.reviewed_at
        ? html`<span class="human-verdict-time">reviewed ${fmtTime(humanReview.reviewed_at)}</span>`
        : null}
      ${humanReview.notes
        ? html`<div class="human-verdict-notes">${humanReview.notes}</div>`
        : null}
    </div>
  `;
}

export function PhaseRow({ taskId, entry, last, refreshTick, humanReview, onOpenLightbox, onOpenReviews }) {
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getJSON(`/api/tasks/${encodeURIComponent(taskId)}/phases/${encodeURIComponent(entry.phase)}`)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        /* phase detail not ready yet / not found — leave the skeleton up */
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, entry.phase, refreshTick]);

  const time = entry.started
    ? `${fmtTime(entry.started)}${entry.completed ? " — " + fmtTime(entry.completed) : ""}` +
      (entry.completed ? ` (${duration(entry.started, entry.completed)})` : "")
    : entry.status;

  const firstPara =
    detail && detail.summary
      ? detail.summary.replace(/^#.*\n/, "").trim().split("\n\n")[0]
      : null;

  return html`
    <div class="phase-row">
      <div class="phase-dot-col">
        <div class="phase-dot ${dotClass(entry)}"></div>
        ${last ? null : html`<div class="phase-line"></div>`}
      </div>
      <div class="phase-content" id="phase-${entry.phase}">
        <div class="phase-name">
          ${entry.phase}
          ${entry.attempt && entry.attempt > 1
            ? html`<span class="attempt">attempt ${entry.attempt}</span>`
            : null}
          ${entry.status === "running" ? html`<span class="pill pill-running">running</span>` : null}
          ${entry.status === "paused" ? html`<span class="pill pill-paused">paused</span>` : null}
        </div>
        <div class="phase-time">${time}</div>

        <${GateBlock} gate=${entry.gate} />

        <${HumanVerdict} humanReview=${humanReview} />

        ${entry.hasReviewSite
          ? html`<button type="button" class="btn review-link" onClick=${onOpenReviews}>
              Open review site
            </button>`
          : null}

        <div class="phase-detail">
          ${firstPara ? html`<p class="phase-summary">${firstPara}</p>` : null}
          <${Subphases} subphases=${detail && detail.subphases} />
          <${Measurements} measurements=${detail && detail.measurements} />
          <${EvidenceGrid}
            taskId=${taskId}
            phase=${entry.phase}
            files=${detail && detail.evidence}
            onOpen=${onOpenLightbox}
          />
          ${detail && detail.verification && detail.verification.length
            ? html`<${VerificationBlock}
                taskId=${taskId}
                phase=${entry.phase}
                files=${detail.verification}
              />`
            : null}
        </div>
      </div>
    </div>
  `;
}
