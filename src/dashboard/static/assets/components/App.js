import { html, useCallback, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { getJSON } from "../lib/api.js";
import { STATE_EVENTS, describeEvent } from "../lib/format.js";
import { Dashboard } from "./Dashboard.js";
import { LiveStrip, LogStrip } from "./LiveStrip.js";
import { MobileDrawer } from "./MobileDrawer.js";
import { PhaseOverview } from "./PhaseOverview.js";
import { PhaseReviewView } from "./PhaseReviewView.js";
import { Sidebar } from "./Sidebar.js";

const LOG_CAP = 40;

function scrollMainToTop() {
  const main = document.querySelector(".main");
  if (main) main.scrollTop = 0;
}

/** Read-only "where am I" trail (goal doc: "Dashboard / <sample> /
 * <sample> · <phase>") — replaces the old mode-switch buttons entirely;
 * navigation now lives only in the drawer (Sidebar.js). Plain text, no
 * links: getting back a level is the drawer's job (its "Dashboard" entry,
 * or re-selecting the active sample), not this trail's. */
function Breadcrumb({ screen, currentId, selectedPhase }) {
  if (screen === "dashboard") {
    return html`<div class="breadcrumb"><span class="crumb-current">Dashboard</span></div>`;
  }
  if (screen === "sample") {
    return html`
      <div class="breadcrumb">
        <span class="crumb">Dashboard</span><span class="crumb-sep"> / </span
        ><span class="crumb-current">${currentId}</span>
      </div>
    `;
  }
  return html`
    <div class="breadcrumb">
      <span class="crumb">Dashboard</span><span class="crumb-sep"> / </span
      ><span class="crumb">${currentId}</span><span class="crumb-sep"> / </span
      ><span class="crumb-current">${currentId} · ${selectedPhase}</span>
    </div>
  `;
}

/**
 * Root of the Preact trusted shell. Owns navigation across all three levels
 * (`screen`: "dashboard" | "sample" | "review", which sample is open, which
 * phase Phase review shows, the mobile drawer), the SSE connection, and the
 * one shared `GET /api/tasks/:id` fetch every view reads from.
 *
 * Three-level shell:
 *   1. Dashboard (Dashboard.js) — a fleet board of every sample and the
 *      phase each is on. The landing view; `currentId` is null here.
 *   2. Sample (PhaseOverview.js) — one sample's compact phase index.
 *   3. Phase review (PhaseReviewView.js -> ReviewEmbed.js ->
 *      VerdictOverlay.js) — one phase's sandboxed review site with the
 *      trusted VerdictPanel floated on top.
 * Navigation lives in the drawer (Sidebar.js: a "Dashboard" entry plus the
 * sample list), not a topbar switcher — the topbar only shows a read-only
 * breadcrumb (above) so a reviewer always knows where they are.
 *
 * Data pattern preserved exactly from the vanilla shell (design §3, §13):
 * SSE is notification-only. Every state event re-fetches the task list and,
 * if it's about the currently-open sample, bumps `refreshTick` so whichever
 * view is mounted re-fetches its own data via new `taskDetail` props —
 * never a remount, so a reviewer's in-progress verdict (held in
 * ReviewEmbed's useReviewBridge) survives an SSE tick untouched. It's only
 * reset by an actual navigation: switching phase or sample changes
 * ReviewEmbed's `key` (PhaseReviewView.js), and switching to Dashboard or
 * back to a sample's own phase index unmounts it entirely — exactly how the
 * old three-tab shell's "Reviews" tab already behaved when a reviewer
 * navigated away and back.
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

  /** Open a sample's phase index (level 2) — from a Dashboard card or the
   * drawer's sample list. Re-selecting the ALREADY-open sample still resets
   * `screen` to "sample", which is how a reviewer gets back to level 2 from
   * deep inside Phase review without a dedicated "back" control: the
   * drawer's sample list stays visible with that sample highlighted the
   * whole time (Sidebar.js). */
  const selectSample = useCallback((id) => {
    setCurrentId(id);
    setScreenState("sample");
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

  /** A Sample-index row click or a Phase-review tab click both mean the
   * same thing — "show Phase review for this phase" — so one callback
   * covers both entry points; setting screen to "review" again when
   * already there is a harmless no-op. */
  const openPhaseReview = useCallback((phase) => {
    setSelectedPhase(phase);
    setScreenState("review");
    scrollMainToTop();
  }, []);

  // Boot: load the task list once. A recognized id in location.hash
  // deep-links straight to that sample's phase index (level 2); otherwise
  // stay on the Dashboard (level 1, the default landing view) rather than
  // guessing at a sample to open.
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

  return html`
    <div class="app">
      <${MobileDrawer} open=${drawerOpen} onClose=${() => setDrawerOpen(false)}>
        <${Sidebar}
          tasks=${tasks}
          currentId=${currentId}
          screen=${screen}
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
          <${Breadcrumb} screen=${screen} currentId=${currentId} selectedPhase=${selectedPhase} />
        </div>

        <${LiveStrip} connected=${connected} lastEvent=${lastEvent} />

        <div
          class="content ${screen === "review" ? "content-review" : screen === "dashboard" ? "content-dashboard" : ""}"
        >
          ${screen === "dashboard"
            ? html`<${Dashboard} tasks=${tasks} onSelectSample=${selectSample} />`
            : !currentId
              ? html`<div class="empty">No sample selected.</div>`
              : screen === "sample"
                ? html`<${PhaseOverview} taskId=${currentId} taskDetail=${taskDetail} onSelectPhase=${openPhaseReview} />`
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
