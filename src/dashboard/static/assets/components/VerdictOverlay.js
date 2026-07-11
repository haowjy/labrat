import { html, useState } from "../vendor/preact-htm.js";
import { verdictLabel, verdictPillClass } from "../lib/review-bridge.js";
import { VerdictPanel } from "./VerdictPanel.js";

/**
 * Floats the trusted `VerdictPanel` (unchanged — see that file, its own
 * props/logic are not touched here) as a compact, collapsible corner
 * overlay on TOP of the sandboxed iframe, instead of a bar in normal flow
 * below it (goal doc: "something on top of it that does your component for
 * pass/fail"). Purely a positioning + collapse wrapper: it decides WHETHER
 * the panel is on screen and, when collapsed, renders its own tiny chip
 * using the SAME exported pure helpers VerdictPanel itself uses
 * (lib/review-bridge.js's `verdictLabel`/`verdictPillClass`) so the
 * collapsed pill can never drift from what the expanded panel shows.
 *
 * `.review-stage` (the parent, see ReviewEmbed.js) is `position:relative`;
 * this renders `position:absolute` within it (styles.css), which is what
 * makes it float ON the iframe rather than push it around in flow — the
 * iframe itself is untouched by whether this is collapsed or expanded.
 *
 * Defaults to expanded: a reviewer's first look at a phase should show Mark
 * pass/fail immediately, matching the old always-visible bar. Collapsing is
 * an opt-in to see more of the iframe underneath, not the landing state.
 */
export function VerdictOverlay({ taskId, phase, verdict, setVerdict, onFinished }) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    const label = verdictLabel(verdict);
    return html`
      <div class="verdict-overlay verdict-overlay-collapsed">
        <button type="button" class="verdict-chip" aria-expanded="false" onClick=${() => setCollapsed(false)}>
          <span class="pill ${verdictPillClass(label)}">${label}</span>
          Verdict
        </button>
      </div>
    `;
  }

  return html`
    <div class="verdict-overlay">
      <div class="verdict-overlay-bar">
        <button
          type="button"
          class="verdict-collapse-btn"
          aria-expanded="true"
          aria-label="Collapse the verdict panel"
          title="Collapse"
          onClick=${() => setCollapsed(true)}
        >
          −
        </button>
      </div>
      <${VerdictPanel}
        taskId=${taskId}
        phase=${phase}
        verdict=${verdict}
        setVerdict=${setVerdict}
        onFinished=${onFinished}
      />
    </div>
  `;
}
