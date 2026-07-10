import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { dotClass } from "../lib/format.js";

/**
 * Jump-nav for the review-chain view (design/review-architecture-decision.md
 * mockup vocabulary: "phase 1-6 tabs"). Deliberately NOT a mutually-exclusive
 * panel switcher — the 4-pane/per-phase-panel layout is explicitly out of
 * this slice's scope (goal doc "Scope OUT"). Instead each tab scrolls the
 * chain's existing single-column timeline to that phase's row and
 * highlights it; the whole chain (every phase's detail, evidence,
 * measurements) stays visible and intact, exactly as it renders today —
 * tabs are pure orientation, added on top.
 *
 * The active tab tracks scroll position (a lightweight scroll-spy: whichever
 * phase row's top has scrolled past a small offset from the top of `.main`
 * is "current"), so it also works for a reviewer who scrolls manually
 * instead of clicking a tab.
 */
const ACTIVATION_OFFSET_PX = 90;

function useScrollSpy(phaseIds) {
  const [active, setActive] = useState(phaseIds[0] ?? null);

  useEffect(() => {
    const mainEl = document.querySelector(".main");
    if (!mainEl || phaseIds.length === 0) return;

    function computeActive() {
      const mainTop = mainEl.getBoundingClientRect().top;
      let current = phaseIds[0];
      for (const id of phaseIds) {
        const el = document.getElementById(`phase-${id}`);
        if (!el) continue;
        if (el.getBoundingClientRect().top - mainTop <= ACTIVATION_OFFSET_PX) current = id;
      }
      setActive(current);
    }

    computeActive();
    mainEl.addEventListener("scroll", computeActive, { passive: true });
    return () => mainEl.removeEventListener("scroll", computeActive);
    // phaseIds is a small array of phase name strings; join() keeps the
    // effect from re-subscribing every render while still reacting to a
    // genuinely different task/timeline.
    // eslint-disable-next-line
  }, [phaseIds.join("|")]);

  return [active, setActive];
}

function scrollToPhase(phase) {
  const el = document.getElementById(`phase-${phase}`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function PhaseTabs({ timeline }) {
  const phaseIds = (timeline ?? []).map((e) => e.phase);
  const [active, setActive] = useScrollSpy(phaseIds);

  if (phaseIds.length === 0) return null;

  return html`
    <div class="phase-tabs" role="tablist" aria-label="Phases">
      ${timeline.map(
        (entry) => html`
          <button
            key=${entry.phase}
            type="button"
            role="tab"
            aria-selected=${entry.phase === active}
            class="phase-tab ${entry.phase === active ? "phase-tab-active" : ""}"
            onClick=${() => {
              setActive(entry.phase);
              scrollToPhase(entry.phase);
            }}
          >
            <span class="phase-tab-dot ${dotClass(entry)}"></span>
            ${entry.phase}
            ${entry.hasReviewSite ? html`<span class="phase-tab-review-mark" title="has a review site">◆</span>` : null}
          </button>
        `,
      )}
    </div>
  `;
}
