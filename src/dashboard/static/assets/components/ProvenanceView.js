import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { getJSON } from "../lib/api.js";
import { decisionPill, fmtTime } from "../lib/format.js";

function ProvEntry({ entry, onOpenReviews }) {
  const [pc, pl] = decisionPill(entry.gate_decision);
  // Same "artifacts/review-site/" contract check as getTask's hasReviewSite
  // (src/dashboard/api/index.ts) — done client-side here because this view
  // renders the manifest's raw outputs directly, nothing pre-derived
  // server-side.
  const hasReviewSite = entry.outputs.some((o) => o.path.startsWith("artifacts/review-site/"));

  return html`
    <div class="prov-entry">
      <div class="prov-head">
        ${entry.phase} <span class="attempt">attempt ${entry.attempt}</span>
        <span class="pill ${pc}">${pl}</span>
      </div>
      <div class="prov-grid">
        <div class="pk">when</div>
        <div class="pv">${fmtTime(entry.started)} → ${fmtTime(entry.completed)}</div>

        <div class="pk">agent</div>
        <div class="pv">${entry.agent}</div>

        <div class="pk">skills</div>
        <div class="pv">
          <ul>
            ${entry.skills_loaded.map(
              (s) => html`
                <li key=${s.name}>
                  ${s.name}
                  ${s.source ? html`<span class="hash">(${s.source})</span>` : null}
                  ${s.hash ? html`<span class="hash">${s.hash}</span>` : null}
                </li>
              `,
            )}
          </ul>
        </div>

        <div class="pk">inputs</div>
        <div class="pv">
          <ul>
            ${entry.inputs.length === 0
              ? html`<li>—</li>`
              : entry.inputs.map(
                  (o) => html`
                    <li key=${o.path}>
                      ${o.path}
                      ${o.hash ? html`<span class="hash">${o.hash}</span>` : null}
                    </li>
                  `,
                )}
          </ul>
        </div>

        <div class="pk">outputs</div>
        <div class="pv">
          <ul>
            ${entry.outputs.length === 0
              ? html`<li>—</li>`
              : entry.outputs.map(
                  (o) => html`
                    <li key=${o.path}>
                      ${o.path}
                      ${o.hash ? html`<span class="hash">${o.hash}</span>` : null}
                      ${o.fileCount != null ? html`<span class="hash">(${o.fileCount} files)</span>` : null}
                    </li>
                  `,
                )}
          </ul>
        </div>

        <div class="pk">subphases</div>
        <div class="pv">
          <ul>
            ${entry.subphases
              ? Object.entries(entry.subphases).map(([k, v]) => html`<li key=${k}>${k}: ${v}</li>`)
              : html`<li>—</li>`}
          </ul>
        </div>

        <div class="pk">sessions</div>
        <div class="pv">worker ${entry.sessions.worker} · gate ${entry.sessions.gate}</div>

        <div class="pk">verification</div>
        <div class="pv">${entry.verification.code} → ${entry.verification.results}</div>
      </div>
      ${hasReviewSite
        ? html`<button type="button" class="btn review-link" onClick=${onOpenReviews}>
            Open review site
          </button>`
        : null}
    </div>
  `;
}

/** The provenance view: append-only per-phase manifest cards, ported from
 * app.js's renderProvenance. */
export function ProvenanceView({ taskId, refreshTick, onOpenReviews }) {
  const [manifest, setManifest] = useState(undefined); // undefined = loading, null = 404

  useEffect(() => {
    let cancelled = false;
    setManifest(undefined);
    getJSON(`/api/tasks/${encodeURIComponent(taskId)}/manifest`)
      .then((m) => {
        if (!cancelled) setManifest(m);
      })
      .catch(() => {
        if (!cancelled) setManifest(null);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshTick]);

  if (manifest === undefined) return html`<div class="empty">Loading…</div>`;
  if (manifest === null) {
    return html`<div class="empty">No provenance manifest on disk yet.</div>`;
  }

  return html`
    <div>
      <div class="section-label">Provenance — append-only, one entry per completed phase</div>
      ${manifest.map(
        (e) => html`<${ProvEntry} key=${e.phase + e.attempt} entry=${e} onOpenReviews=${onOpenReviews} />`,
      )}
    </div>
  `;
}
