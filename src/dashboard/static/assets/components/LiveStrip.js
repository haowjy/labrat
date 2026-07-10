import { html } from "../vendor/preact-htm.js";
import { fmtTime } from "../lib/format.js";

/** The SSE connection ticker: notification-only (design §13) — shows the
 * last event type/description, never a data source for the views. */
export function LiveStrip({ connected, lastEvent }) {
  return html`
    <div class="live-strip">
      <span class="live-dot ${connected ? "on" : ""}"></span>
      <span class="live-label">Live</span>
      <span class="live-event">
        ${lastEvent
          ? html`<span class="ev-type">${lastEvent.type}</span> — ${lastEvent.description}`
          : "waiting for events…"}
      </span>
      <span class="live-time">${lastEvent ? fmtTime(lastEvent.at) : ""}</span>
    </div>
  `;
}

/** Ephemeral log strip — explicitly NOT part of the record (design §13):
 * capped, most-recent-40, purely a live tail of harness log lines. */
export function LogStrip({ lines }) {
  if (lines.length === 0) return null;
  return html`
    <div class="log-strip">
      <div class="log-head">ephemeral log — not part of the record</div>
      <div>
        ${lines.map(
          (l, i) => html`
            <div class="log-line" key=${i}>
              <span class="log-t">${fmtTime(l.at)}</span>${l.line}
            </div>
          `,
        )}
      </div>
    </div>
  `;
}
