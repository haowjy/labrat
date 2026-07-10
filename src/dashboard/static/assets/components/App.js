import { html, useCallback, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { getJSON } from "../lib/api.js";
import { STATE_EVENTS, describeEvent } from "../lib/format.js";
import { LiveStrip, LogStrip } from "./LiveStrip.js";
import { MobileDrawer } from "./MobileDrawer.js";
import { ProvenanceView } from "./ProvenanceView.js";
import { ReviewChainView } from "./ReviewChainView.js";
import { ReviewsView } from "./ReviewsView.js";
import { Sidebar } from "./Sidebar.js";

const LOG_CAP = 40;
const VIEWS = [
  { id: "chain", label: "Review chain" },
  { id: "provenance", label: "Provenance" },
  { id: "reviews", label: "Reviews" },
];

function scrollMainToTop() {
  const main = document.querySelector(".main");
  if (main) main.scrollTop = 0;
}

/**
 * Root of the Preact trusted shell. Owns navigation (task selection, view
 * switch, mobile drawer), the SSE connection, and the one shared
 * `GET /api/tasks/:id` fetch every view but Reviews reads from (Reviews
 * derives its review-phase name from it but does not remount on its
 * refreshes — see ReviewsView/VerdictPanel: an SSE tick must never blow
 * away a reviewer's in-progress verdict).
 *
 * Data pattern preserved exactly from the vanilla shell (design §3, §13):
 * SSE is notification-only. Every state event re-fetches the task list and,
 * if it's about the currently-open task, bumps `refreshTick` so whichever
 * view is mounted re-fetches its own data — the same "always fresh on
 * entry/event" behavior renderCurrent() had, just via props instead of a
 * full innerHTML rebuild.
 */
export function App() {
  const [tasks, setTasks] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [view, setViewState] = useState("chain");
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

  const selectTask = useCallback((id) => {
    setCurrentId(id);
    location.hash = id;
    setDrawerOpen(false);
  }, []);

  const setView = useCallback((v) => {
    setViewState(v);
    scrollMainToTop();
  }, []);

  // Boot: load the task list once, then select the id from location.hash
  // (deep-linkable) or fall back to the first task.
  useEffect(() => {
    let cancelled = false;
    loadTasks().then((list) => {
      if (cancelled) return;
      const fromHash = location.hash.slice(1);
      const initial = list.find((t) => t.id === fromHash) ?? list[0];
      if (initial) selectTask(initial.id);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line
  }, []);

  // The shared task-detail fetch: every view but Reviews reads this
  // (Reviews only needs it to learn the review phase's name).
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
  // resubscribe every time the reviewer switches tasks.
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

  const current = tasks.find((t) => t.id === currentId) ?? null;
  // t.input is read optimistically for parity with the vanilla shell's own
  // renderCurrent(); GET /api/tasks (TaskSummary) does not currently
  // serialize it, so this is a silent no-op today in both versions, not a
  // Lane B regression — see the Lane B report.
  const subtitle = current ? `${current.input ?? ""}${current.input ? " / " : ""}${current.protocol}` : "";

  function refetchTaskDetail() {
    setRefreshTick((t) => t + 1);
  }

  return html`
    <div class="app">
      <${MobileDrawer} open=${drawerOpen} onClose=${() => setDrawerOpen(false)}>
        <${Sidebar} tasks=${tasks} currentId=${currentId} onSelect=${selectTask} />
      <//>
      <main class="main">
        <div class="topbar">
          <button
            type="button"
            class="hamburger-btn"
            aria-label="Open task list"
            onClick=${() => setDrawerOpen(true)}
          >
            <span></span><span></span><span></span>
          </button>
          <div class="topbar-titles">
            <div class="title">${currentId ?? "—"}</div>
            <div class="subtitle">${subtitle}</div>
          </div>
          <div class="spacer"></div>
          ${VIEWS.map(
            (v) => html`
              <button
                key=${v.id}
                type="button"
                class=${view === v.id ? "active-btn" : ""}
                onClick=${() => setView(v.id)}
              >
                ${v.label}
              </button>
            `,
          )}
        </div>

        <${LiveStrip} connected=${connected} lastEvent=${lastEvent} />

        <div class="content ${view === "reviews" ? "content-reviews" : ""}">
          ${!currentId
            ? html`<div class="empty">No tasks yet.</div>`
            : view === "chain"
              ? html`<${ReviewChainView}
                  taskId=${currentId}
                  taskDetail=${taskDetail}
                  refreshTick=${refreshTick}
                  onOpenReviews=${() => setView("reviews")}
                />`
              : view === "provenance"
                ? html`<${ProvenanceView}
                    taskId=${currentId}
                    refreshTick=${refreshTick}
                    onOpenReviews=${() => setView("reviews")}
                  />`
                : html`<${ReviewsView}
                    taskId=${currentId}
                    taskDetail=${taskDetail}
                    onVerdictFinished=${refetchTaskDetail}
                  />`}
        </div>

        <${LogStrip} lines=${logLines} />
      </main>
    </div>
  `;
}
