import { html, useCallback, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { getJSON } from "../lib/api.js";
import { STATE_EVENTS, describeEvent, sortTasksByUrgency } from "../lib/format.js";
import { Dashboard } from "./Dashboard.js";
import { LiveStrip, LogStrip } from "./LiveStrip.js";
import { MobileDrawer } from "./MobileDrawer.js";
import { PhaseReviewView } from "./PhaseReviewView.js";
import { Sidebar } from "./Sidebar.js";
import { SkillsView } from "./SkillsView.js";

const LOG_CAP = 40;

function scrollMainToTop() {
  const main = document.querySelector(".main");
  if (main) main.scrollTop = 0;
}

/** "Where am I" trail — replaces the old mode-switch buttons entirely.
 * Two levels: Dashboard, then the sample's Phase review. Ancestor crumbs are
 * clickable shortcuts up a level (the same `goToDashboard`/`selectSample`
 * navigations the drawer offers — no third navigation path, just closer to
 * the pointer); the current level is plain text. When a phase tab has been
 * clicked, the sample crumb becomes a link that re-enters the sample's
 * landing phase (`selectSample` again). The drawer (Sidebar.js) remains the
 * full navigation surface. */
function Breadcrumb({ screen, currentId, selectedPhase, onDashboard, onSample }) {
  if (screen === "dashboard") {
    return html`<div class="breadcrumb"><span class="crumb-current">Dashboard</span></div>`;
  }
  if (screen === "skills") {
    return html`
      <div class="breadcrumb">
        <button type="button" class="crumb crumb-link" onClick=${onDashboard}>Dashboard</button
        ><span class="crumb-sep"> / </span
        ><span class="crumb-current">Skills</span>
      </div>
    `;
  }
  // Review: on landing `selectedPhase` is null (PhaseReviewView derives the
  // phase itself), so the sample is the current crumb; once a phase is
  // explicitly selected it gets its own crumb.
  if (!selectedPhase) {
    return html`
      <div class="breadcrumb">
        <button type="button" class="crumb crumb-link" onClick=${onDashboard}>Dashboard</button
        ><span class="crumb-sep"> / </span
        ><span class="crumb-current">${currentId}</span>
      </div>
    `;
  }
  return html`
    <div class="breadcrumb">
      <button type="button" class="crumb crumb-link" onClick=${onDashboard}>Dashboard</button
      ><span class="crumb-sep"> / </span
      ><button type="button" class="crumb crumb-link" onClick=${onSample}>${currentId}</button
      ><span class="crumb-sep"> / </span
      ><span class="crumb-current">${selectedPhase}</span>
    </div>
  `;
}

/**
 * Root of the Preact trusted shell. Owns navigation across both levels
 * (`screen`: "dashboard" | "review", which sample is open, which phase
 * Phase review shows, the mobile drawer), the SSE connection, and the
 * one shared `GET /api/tasks/:id` fetch every view reads from.
 *
 * Two-level shell — selecting a sample lands straight in Phase review:
 *   1. Dashboard (Dashboard.js) — a fleet board of every sample and the
 *      phase each is on. The landing view; `currentId` is null here.
 *   2. Phase review (PhaseReviewView.js -> ReviewLayer.js) — the generic
 *      trusted review layer for one phase, with the tab strip as the
 *      per-sample phase index: the decisive evidence panel leads, then the
 *      sandboxed artifact with a full-screen toggle, then the verdict
 *      controls in normal flow (no floated overlay), per-phase feedback,
 *      and sign-off. The default landing when a phase is opened is this
 *      layer, not the full-screen artifact.
 * Navigation lives in the drawer (Sidebar.js: a "Dashboard" entry plus the
 * sample list), not a topbar switcher — the topbar only shows a read-only
 * breadcrumb (above) so a reviewer always knows where they are.
 *
 * Data pattern preserved exactly from the vanilla shell (design §3, §13):
 * SSE is notification-only. Every state event re-fetches the task list and,
 * if it's about the currently-open sample, bumps `refreshTick` so whichever
 * view is mounted re-fetches its own data via new `taskDetail` props —
 * never a remount, so a reviewer's in-progress verdict (held in ReviewLayer's
 * useReviewBridge) survives an SSE tick untouched. It's only reset by an
 * actual navigation: switching phase or sample changes ReviewLayer's `key`
 * (PhaseReviewView.js), and switching to Dashboard unmounts it entirely —
 * exactly how the old three-tab shell's "Reviews" tab already behaved when
 * a reviewer navigated away and back.
 */
export function App() {
  const [tasks, setTasks] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [screen, setScreenState] = useState("dashboard");
  const [selectedPhase, setSelectedPhase] = useState(null);
  const [taskDetail, setTaskDetail] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);
  const [logLines, setLogLines] = useState([]);
  const [refreshTick, setRefreshTick] = useState(0);

  const currentIdRef = useRef(null);
  useEffect(() => {
    currentIdRef.current = currentId;
  }, [currentId]);

  const loadTasks = useCallback(async () => {
    const list = await getJSON("/api/tasks");
    setTasks(list);
    return list;
  }, []);

  /** Open a sample straight into Phase review — from a Dashboard card or
   * the drawer's sample list. `selectedPhase` resets to null so
   * PhaseReviewView's resolveActivePhase re-derives the landing phase for
   * the new sample (first phase with a review site, else the first phase)
   * instead of carrying over a stale selection. */
  const selectSample = useCallback((id) => {
    setCurrentId(id);
    setSelectedPhase(null);
    setScreenState("review");
    location.hash = id;
    setDrawerOpen(false);
    scrollMainToTop();
  }, []);

  /** Back to level 1 — the drawer's "Dashboard" entry is the only way here,
   * by design (goal doc: "that's the answer to 'how do I get back'"). */
  const goToDashboard = useCallback(() => {
    setCurrentId(null);
    setScreenState("dashboard");
    location.hash = "";
    setDrawerOpen(false);
    scrollMainToTop();
  }, []);

  /** Claude Science skill browser (import bridge) — a top-level screen off the
   * drawer, alongside Dashboard. Not tied to any sample, so currentId clears. */
  const goToSkills = useCallback(() => {
    setCurrentId(null);
    setScreenState("skills");
    location.hash = "skills";
    setDrawerOpen(false);
    scrollMainToTop();
  }, []);

  /** A Phase-review tab click — "show Phase review for this phase";
   * setting screen to "review" again when already there is a harmless
   * no-op. */
  const openPhaseReview = useCallback((phase) => {
    setSelectedPhase(phase);
    setScreenState("review");
    scrollMainToTop();
  }, []);

  // Boot: load the task list once. A recognized id in location.hash
  // deep-links straight to that sample's Phase review; otherwise stay on
  // the Dashboard (the default landing view) rather than guessing at a
  // sample to open.
  useEffect(() => {
    let cancelled = false;
    loadTasks().then((list) => {
      if (cancelled) return;
      const fromHash = location.hash.slice(1);
      const initial = list.find((t) => t.id === fromHash);
      if (initial) selectSample(initial.id);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line
  }, []);

  // The shared task-detail fetch: every sample/phase-review view reads
  // this; null (and unused) while on the Dashboard.
  useEffect(() => {
    if (!currentId) {
      setTaskDetail(null);
      return;
    }
    let cancelled = false;
    getJSON(`/api/tasks/${encodeURIComponent(currentId)}`)
      .then((d) => {
        if (!cancelled) setTaskDetail(d);
      })
      .catch(() => {
        if (!cancelled) setTaskDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentId, refreshTick]);

  // SSE: subscribed once for the app's lifetime (design §13 — notification
  // only, never a data source). Reads currentIdRef so it doesn't need to
  // resubscribe every time the reviewer switches samples.
  useEffect(() => {
    const es = new EventSource("/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    for (const type of STATE_EVENTS) {
      es.addEventListener(type, (e) => {
        let ev;
        try {
          ev = JSON.parse(e.data);
        } catch {
          return;
        }
        setLastEvent({ type: ev.type, description: describeEvent(ev), at: new Date().toISOString() });
        if (ev.taskId === currentIdRef.current) setRefreshTick((t) => t + 1);
        loadTasks();
      });
    }
    es.addEventListener("log", (e) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      setLogLines((prev) => [...prev, { line: ev.line, at: new Date().toISOString() }].slice(-LOG_CAP));
    });
    return () => es.close();
    // eslint-disable-next-line
  }, []);

  function refetchTaskDetail() {
    setRefreshTick((t) => t + 1);
  }

  // One urgency sort for both cross-sample surfaces (F1/F6): attention-needing
  // samples first on the Dashboard board AND in the Sidebar list. Done here on
  // the shared list, not inside each view, so the two can never disagree.
  const sortedTasks = sortTasksByUrgency(tasks);

  return html`
    <div class="app">
      <${MobileDrawer} open=${drawerOpen} onClose=${() => setDrawerOpen(false)}>
        <${Sidebar}
          tasks=${sortedTasks}
          currentId=${currentId}
          screen=${screen}
          onSelect=${selectSample}
          onGoDashboard=${goToDashboard}
          onGoSkills=${goToSkills}
        />
      <//>
      <main class="main">
        <div class="topbar">
          <button
            type="button"
            class="hamburger-btn"
            aria-label="Open navigation"
            onClick=${() => setDrawerOpen(true)}
          >
            <span></span><span></span><span></span>
          </button>
          <${Breadcrumb}
            screen=${screen}
            currentId=${currentId}
            selectedPhase=${selectedPhase}
            onDashboard=${goToDashboard}
            onSample=${() => selectSample(currentId)}
          />
        </div>

        <${LiveStrip} connected=${connected} lastEvent=${lastEvent} />

        <div
          class="content ${screen === "review" ? "content-review" : screen === "dashboard" ? "content-dashboard" : ""}"
        >
          ${screen === "skills"
            ? html`<${SkillsView} />`
            : screen === "dashboard"
            ? html`<${Dashboard} tasks=${sortedTasks} onSelectSample=${selectSample} />`
            : !currentId
              ? html`<div class="empty">No sample selected.</div>`
              : html`<${PhaseReviewView}
                  taskId=${currentId}
                  taskDetail=${taskDetail}
                  selectedPhase=${selectedPhase}
                  onSelectPhase=${openPhaseReview}
                  onVerdictFinished=${refetchTaskDetail}
                />`}
        </div>

        <${LogStrip} lines=${logLines} />
      </main>
    </div>
  `;
}
