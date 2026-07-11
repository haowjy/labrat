import { html, useCallback, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { getJSON } from "../lib/api.js";
import { STATE_EVENTS, describeEvent, sortTasksByUrgency } from "../lib/format.js";
import { Dashboard } from "./Dashboard.js";
import { LiveStrip, LogStrip } from "./LiveStrip.js";
import { MobileDrawer } from "./MobileDrawer.js";
import { PhaseReviewView, resolveActivePhase } from "./PhaseReviewView.js";
import { Sidebar } from "./Sidebar.js";

const LOG_CAP = 40;

function scrollMainToTop() {
  const main = document.querySelector(".main");
  if (main) main.scrollTop = 0;
}

/** "Where am I" trail ("Dashboard / <sample> / <phase>") — replaces the old
 * mode-switch buttons entirely. Ancestor crumbs are clickable shortcuts up
 * a level (the same `goToDashboard`/`selectSample` navigations the drawer
 * offers — no third navigation path, just closer to the pointer); the
 * current level is plain text. The middle crumb re-selects the open sample,
 * which re-lands Phase review on that sample's default phase (App.js's
 * `selectSample` resets the phase selection). While the task detail is
 * still loading there's no resolved phase yet, so the sample id is the
 * deepest crumb. The drawer (Sidebar.js) remains the full navigation
 * surface. */
function Breadcrumb({ currentId, activePhase, onDashboard, onSample }) {
  if (!currentId) {
    return html`<div class="breadcrumb"><span class="crumb-current">Dashboard</span></div>`;
  }
  if (!activePhase) {
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
      ><span class="crumb-current">${activePhase}</span>
    </div>
  `;
}

/**
 * Root of the Preact trusted shell. Owns navigation (which sample is open,
 * which phase Phase review shows, the mobile drawer), the SSE connection,
 * and the one shared `GET /api/tasks/:id` fetch every view reads from.
 *
 * Two-level shell:
 *   1. Dashboard (Dashboard.js) — a fleet board of every sample and the
 *      phase each is on. The landing view; `currentId` is null here.
 *   2. Phase review (PhaseReviewView.js -> ReviewEmbed.js ->
 *      VerdictOverlay.js) — one phase's sandboxed review site with the
 *      trusted VerdictPanel floated on top, plus the PhaseSelector tab
 *      strip across all of the sample's phases. Selecting a sample lands
 *      HERE: the intermediate per-sample phase index (PhaseOverview.js)
 *      duplicated exactly the navigation the tab strip already carries, so
 *      it was collapsed into this level and deleted.
 * With only two levels there is no separate `screen` state to keep in sync:
 * which level is showing IS whether `currentId` is null. Navigation lives
 * in the drawer (Sidebar.js: a "Dashboard" entry plus the sample list), not
 * a topbar switcher — the topbar only shows a read-only breadcrumb (above)
 * so a reviewer always knows where they are.
 *
 * Data pattern preserved exactly from the vanilla shell (design §3, §13):
 * SSE is notification-only. Every state event re-fetches the task list and,
 * if it's about the currently-open sample, bumps `refreshTick` so whichever
 * view is mounted re-fetches its own data via new `taskDetail` props —
 * never a remount, so a reviewer's in-progress verdict (held in
 * ReviewEmbed's useReviewBridge) survives an SSE tick untouched. It's only
 * reset by an actual navigation: switching phase or sample changes
 * ReviewEmbed's `key` (PhaseReviewView.js), and switching to the Dashboard
 * unmounts it entirely — exactly how the old three-tab shell's "Reviews"
 * tab already behaved when a reviewer navigated away and back.
 */
export function App() {
  const [tasks, setTasks] = useState([]);
  const [currentId, setCurrentId] = useState(null);
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

  /** Open a sample DIRECTLY in Phase review — from a Dashboard card, the
   * drawer's sample list, or the breadcrumb's middle crumb. `selectedPhase`
   * resets to null so resolveActivePhase picks this sample's landing phase
   * fresh (explicit selection -> phase with a review site -> first phase) —
   * which also makes re-selecting the ALREADY-open sample meaningful: it
   * re-lands on that default phase. */
  const selectSample = useCallback((id) => {
    setCurrentId(id);
    setSelectedPhase(null);
    location.hash = id;
    setDrawerOpen(false);
    scrollMainToTop();
  }, []);

  /** Back to level 1 — the drawer's "Dashboard" entry is the only way here,
   * by design (goal doc: "that's the answer to 'how do I get back'"). */
  const goToDashboard = useCallback(() => {
    setCurrentId(null);
    location.hash = "";
    setDrawerOpen(false);
    scrollMainToTop();
  }, []);

  /** A PhaseSelector tab click — Phase review is already on screen, so this
   * only changes which of the open sample's phases it shows. */
  const selectPhase = useCallback((phase) => {
    setSelectedPhase(phase);
    scrollMainToTop();
  }, []);

  // Boot: load the task list once. A recognized id in location.hash
  // deep-links straight into that sample's Phase review; otherwise stay on
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

  // The shared task-detail fetch: Phase review reads this; null (and
  // unused) while on the Dashboard.
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

  // Resolved ONCE here (from the same shared taskDetail Phase review reads)
  // so the breadcrumb and the view always show the same phase; null while
  // the detail is loading or on the Dashboard.
  const activePhase = currentId && taskDetail ? resolveActivePhase(taskDetail.timeline, selectedPhase) : null;

  return html`
    <div class="app">
      <${MobileDrawer} open=${drawerOpen} onClose=${() => setDrawerOpen(false)}>
        <${Sidebar}
          tasks=${sortedTasks}
          currentId=${currentId}
          onSelect=${selectSample}
          onGoDashboard=${goToDashboard}
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
            currentId=${currentId}
            activePhase=${activePhase}
            onDashboard=${goToDashboard}
            onSample=${() => selectSample(currentId)}
          />
        </div>

        <${LiveStrip} connected=${connected} lastEvent=${lastEvent} />

        <div class="content ${currentId ? "content-review" : "content-dashboard"}">
          ${!currentId
            ? html`<${Dashboard} tasks=${sortedTasks} onSelectSample=${selectSample} />`
            : html`<${PhaseReviewView}
                taskId=${currentId}
                taskDetail=${taskDetail}
                activePhase=${activePhase}
                onSelectPhase=${selectPhase}
                onVerdictFinished=${refetchTaskDetail}
              />`}
        </div>

        <${LogStrip} lines=${logLines} />
      </main>
    </div>
  `;
}
