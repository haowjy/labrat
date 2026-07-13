import { html, useCallback, useEffect, useState } from "../vendor/preact-htm.js";
import { getJSON, postJSON } from "../lib/api.js";
import { fmtTime } from "../lib/format.js";

/**
 * Folder-watch control panel (top-level screen, alongside Dashboard/Skills).
 * Renders the watcher daemon's heartbeat and the per-protocol drop folders,
 * and owns the two dashboard-side mutations of the watch contract (rev v2):
 *
 *   GET  /api/watcher/status  — polled every POLL_MS; the supervisor-written
 *        heartbeat (desired/state/pid/since/lastHeartbeat/pollIntervalMs/
 *        activeDrop/configError) + per-protocol watchRoot, folder counts
 *        (incoming/inProgress/done/failed), lastDrop and error. Counts and
 *        lastDrop are the SUPERVISOR's numbers relayed through the status
 *        file (contract R7) — this panel never synthesizes them client-side.
 *   POST /api/watcher         — desired ingestion state
 *        ({desired:"running"|"stopped"}) and per-protocol watch-root edits
 *        ({protocols:{<id>:{watchRoot}}}). Writes control/watcher.json only.
 *
 * Honesty about what the toggle IS (contract R4): writing desired state to a
 * file cannot start a process. The `labrat watch` daemon must already be
 * running; the toggle ENABLES/DISABLES ingestion, which the daemon applies
 * on its next tick. So desired and actual lag each other (a "requested" note
 * bridges the gap), a graceful stop passes through `stopping`, and daemon
 * health is a SEPARATE fact from desired state, derived from heartbeat
 * staleness (contract R10): a dead daemon leaves behind a status file that
 * still says "running", so a stale or absent lastHeartbeat renders as
 * "Offline", never as the file's own claim.
 *
 * Degrades, never crashes: if the routes 404 (watcher backend not built /
 * not mounted in this dashboard) or the server is unreachable, the panel
 * shows a "watcher backend unavailable" banner and keeps polling so it
 * recovers by itself once the routes appear. Polling is this panel's own
 * loop, NOT SSE: watcher status is control-plane state outside the task
 * tree, so the task-event stream never notifies about it (design §13 keeps
 * SSE notification-only for task state).
 */

const POLL_MS = 2500;

/** Heartbeat staleness threshold (contract R10): a heartbeat older than a
 * few control-loop ticks reads as "daemon offline". 4x the daemon's own
 * pollIntervalMs when the status carries it, floored generously so one slow
 * tick doesn't flap the panel to Offline. */
const HEARTBEAT_STALE_MS_MIN = 15000;

/** Daemon health: "offline" | "running" | "stopping" | "stopped". Staleness
 * first; the reported state counts only while the heartbeat proves the
 * daemon alive. */
function daemonHealth(status, now) {
  const hb = status?.lastHeartbeat ? Date.parse(status.lastHeartbeat) : NaN;
  const staleAfter = Math.max(4 * (status?.pollIntervalMs ?? 0), HEARTBEAT_STALE_MS_MIN);
  if (!Number.isFinite(hb) || now - hb > staleAfter) return "offline";
  if (status.state === "running" || status.state === "stopping") return status.state;
  return "stopped";
}

/** lastDrop.state ("in-progress" | "done" | "failed") -> pill. */
function dropPill(state) {
  switch (state) {
    case "done":
      return ["pill-pass", "done"];
    case "failed":
      return ["pill-fail", "failed"];
    case "in-progress":
      return ["pill-running", "in-progress"];
    default:
      return ["pill-skip", state];
  }
}

/** The four folder-state counters. Neutral at rest; in-progress lights up
 * accent while a drop is being worked, failed lights up alert when nonzero
 * (the one count that asks a human to go look at failed/). */
function Counts({ counts }) {
  const c = counts ?? {};
  const cells = [
    ["incoming", c.incoming ?? 0, ""],
    ["in progress", c.inProgress ?? 0, (c.inProgress ?? 0) > 0 ? "watch-count-active" : ""],
    ["done", c.done ?? 0, ""],
    ["failed", c.failed ?? 0, (c.failed ?? 0) > 0 ? "watch-count-alert" : ""],
  ];
  return html`
    <div class="watch-counts">
      ${cells.map(
        ([label, n, mod]) => html`<span class="watch-count ${mod}" key=${label}><b>${n}</b>${label}</span>`,
      )}
    </div>
  `;
}

/**
 * One protocol's row: id, the editable watch-root folder, counts, lastDrop,
 * and the supervisor's per-protocol config error when set (contract R10).
 * The draft is row-local state: it survives the poll re-renders (the row is
 * keyed by protocol id, so it re-renders rather than remounts) and is only
 * dropped once the polled status actually reflects the saved value — the
 * status file is written by the supervisor, which may lag the POST by a
 * tick (or be offline), so clearing the draft on POST success would snap
 * the field back to the stale root.
 */
function ProtocolRow({ id, proto, onSaveRoot }) {
  const [draft, setDraft] = useState(null); // null = mirror proto.watchRoot
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const currentRoot = proto.watchRoot ?? "";
  useEffect(() => {
    if (draft !== null && draft === currentRoot) {
      setDraft(null);
      setSaved(false);
    }
  }, [draft, currentRoot]);

  const value = draft ?? currentRoot;
  const dirty = draft !== null && draft !== currentRoot;

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await onSaveRoot(id, draft.trim());
      setSaved(true);
    } catch (e) {
      setError(e.message || "Could not save the watch root.");
    } finally {
      setSaving(false);
    }
  }

  const drop = proto.lastDrop;
  const [dc, dl] = drop ? dropPill(drop.state) : [null, null];

  return html`
    <div class="watch-proto">
      <div class="watch-proto-head">
        <span class="watch-proto-id">${id}</span>
        <${Counts} counts=${proto.counts} />
      </div>
      <label class="watch-root-label" for="watch-root-${id}">Watch root</label>
      <div class="watch-root-row">
        <input
          id="watch-root-${id}"
          class="watch-root-input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="/absolute/path/to/dropbox"
          value=${value}
          disabled=${saving}
          onInput=${(e) => {
            setDraft(e.currentTarget.value);
            setSaved(false);
            setError(null);
          }}
          onKeyDown=${(e) => {
            if (e.key === "Enter") save();
          }}
        />
        <button type="button" class="btn" disabled=${!dirty || saving} onClick=${save}>
          ${saving ? "Saving…" : "Save folder"}
        </button>
      </div>
      ${error ? html`<div class="watch-error">${error}</div>` : null}
      ${!error && saved && dirty
        ? html`<div class="watch-saved">Saved. Waiting for the watcher to pick it up.</div>`
        : null}
      ${proto.error ? html`<div class="watch-error">Protocol config error: ${proto.error}</div>` : null}
      ${drop
        ? html`
            <div class="watch-lastdrop">
              <span class="watch-lastdrop-label">Last drop</span>
              <span class="watch-lastdrop-name">${drop.name}</span>
              <span class="pill ${dc}">${dl}</span>
              <span class="watch-lastdrop-meta">
                ${fmtTime(drop.at)}${drop.taskId ? ` · ${drop.taskId}` : ""}
              </span>
            </div>
          `
        : null}
    </div>
  `;
}

/**
 * "Add a watch folder" form: bind a runnable protocol (picker fed from
 * GET /api/claude-science/skills, minus protocols already bound in the
 * heartbeat) to an absolute drop folder. POSTs {protocols:{[id]:{watchRoot}}}
 * — the server rejects non-runnable ids, so the picker and the write path
 * enforce the same allowlist. The new binding only shows up in the rows
 * above after the daemon's next heartbeat; while the daemon is offline the
 * form still saves (disk is the contract) but says so plainly — a file
 * cannot start a process, so the binding stays inert until `labrat watch`
 * runs.
 */
function AddWatchFolder({ boundIds, health, onAdd }) {
  const [skills, setSkills] = useState(null); // null = loading/unavailable
  const [picked, setPicked] = useState("");
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [savedId, setSavedId] = useState(null);

  useEffect(() => {
    let alive = true;
    getJSON("/api/claude-science/skills")
      .then((list) => {
        if (alive) setSkills(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (alive) setSkills([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const options = (skills ?? [])
    .filter((s) => s.runnable === true && !boundIds.includes(s.name))
    .map((s) => s.name);

  // A saved binding graduates to a ProtocolRow once the heartbeat carries
  // it; drop the "saved" note at that point.
  useEffect(() => {
    if (savedId && boundIds.includes(savedId)) setSavedId(null);
  }, [savedId, boundIds]);

  const ready = picked !== "" && root.trim() !== "" && !busy;

  async function add() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    setSavedId(null);
    try {
      await onAdd(picked, root.trim());
      setSavedId(picked);
      setPicked("");
      setRoot("");
    } catch (e) {
      setError(e.message || "Could not add the watch folder.");
    } finally {
      setBusy(false);
    }
  }

  if (skills === null) return null; // still loading the protocol list

  return html`
    <div class="watch-add">
      <div class="watch-add-title">Add a watch folder</div>
      ${options.length === 0
        ? html`<div class="watch-add-empty">
            ${(skills ?? []).some((s) => s.runnable === true)
              ? "All runnable protocols already have a watch folder."
              : "No runnable protocols found in the Claude Science registry."}
          </div>`
        : html`
            <div class="watch-add-row">
              <select
                class="watch-add-select"
                value=${picked}
                disabled=${busy}
                onChange=${(e) => {
                  setPicked(e.currentTarget.value);
                  setError(null);
                }}
              >
                <option value="">Choose a protocol…</option>
                ${options.map((name) => html`<option value=${name} key=${name}>${name}</option>`)}
              </select>
              <input
                class="watch-root-input"
                type="text"
                spellcheck="false"
                autocomplete="off"
                placeholder="/absolute/path/to/dropbox"
                value=${root}
                disabled=${busy}
                onInput=${(e) => {
                  setRoot(e.currentTarget.value);
                  setError(null);
                }}
                onKeyDown=${(e) => {
                  if (e.key === "Enter") add();
                }}
              />
              <button type="button" class="btn btn-primary" disabled=${!ready} onClick=${add}>
                ${busy ? "Adding…" : "Add"}
              </button>
            </div>
          `}
      ${error ? html`<div class="watch-error">${error}</div>` : null}
      ${!error && savedId
        ? html`<div class="watch-saved">
            Saved ${savedId}. It appears above after the watcher's next heartbeat.
          </div>`
        : null}
      ${health === "offline"
        ? html`<div class="watch-add-offline">
            The watcher daemon is offline. Bindings added here are saved to disk but stay
            inert until <code>labrat watch</code> is running — the dashboard can't start it.
          </div>`
        : null}
    </div>
  `;
}

/** Health -> [dot class, label, meta line]. Meta never repeats a stale
 * file's pid/since claims when the heartbeat says offline. */
function healthPresentation(health, status, ingestionOn) {
  switch (health) {
    case "running":
      return [
        "running",
        "Running",
        `pid ${status.pid ?? "?"}${status.since ? ` · since ${fmtTime(status.since)}` : ""}${
          status.activeDrop?.name ? ` · working on ${status.activeDrop.name}` : ""
        }`,
      ];
    case "stopping":
      return [
        "stopping",
        "Stopping",
        `Finishing the active run${
          status.activeDrop?.name ? ` (${status.activeDrop.name})` : ""
        }; no new drops will be claimed.`,
      ];
    case "stopped":
      // Says only what `state` proves (daemon alive, not claiming). Whether
      // ingestion is enabled is the toggle's story — during the lag window
      // (desired flipped, heartbeat not yet caught up) the two differ.
      return ["", "Stopped", "Daemon connected; not claiming drops."];
    default:
      return [
        "offline",
        "Offline",
        `No heartbeat${
          status.lastHeartbeat ? ` since ${fmtTime(status.lastHeartbeat)}` : ""
        }. Ingestion is ${ingestionOn ? "enabled" : "disabled"}; start the daemon with: labrat watch`,
      ];
  }
}

export function WatchPanel() {
  const [status, setStatus] = useState(null); // last good GET /api/watcher/status
  const [unavailable, setUnavailable] = useState(false);
  const [pendingDesired, setPendingDesired] = useState(null); // POSTed, heartbeat not caught up yet
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getJSON("/api/watcher/status");
      setStatus(s);
      setUnavailable(false);
    } catch {
      // Route absent (404) or server unreachable: degrade to the banner and
      // keep the last good status visible. The poll keeps running, so the
      // panel recovers on its own when the backend appears.
      setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // The daemon's heartbeat echoes desired back (contract R4); once it
  // matches what we asked for, drop the "requested" note. Older status
  // shapes without `desired` confirm via the run state instead.
  useEffect(() => {
    if (!pendingDesired || !status) return;
    const confirmed =
      status.desired != null
        ? status.desired === pendingDesired
        : pendingDesired === "running"
          ? status.state === "running"
          : status.state === "stopped";
    if (confirmed) setPendingDesired(null);
  }, [status, pendingDesired]);

  const saveRoot = useCallback(
    async (id, watchRoot) => {
      await postJSON("/api/watcher", { protocols: { [id]: { watchRoot } } });
      refresh();
    },
    [refresh],
  );

  const health = status === null ? "offline" : daemonHealth(status, Date.now());
  const effectiveDesired =
    pendingDesired ??
    status?.desired ??
    (status?.state === "running" || status?.state === "stopping" ? "running" : "stopped");
  const ingestionOn = effectiveDesired === "running";

  async function toggle() {
    const target = ingestionOn ? "stopped" : "running";
    setToggleBusy(true);
    setToggleError(null);
    try {
      const resp = await postJSON("/api/watcher", { desired: target });
      // Reflect the desired state the server confirmed (POST returns the
      // merged control file); fall back to what we asked for.
      setPendingDesired((resp && resp.desired) || target);
      refresh();
    } catch (e) {
      setToggleError(e.message || "Could not update ingestion.");
    } finally {
      setToggleBusy(false);
    }
  }

  const protocols = Object.entries(status?.protocols ?? {});
  const [dotClass, healthLabel, healthMeta] =
    status === null ? [] : healthPresentation(health, status, ingestionOn);

  return html`
    <div class="watch-view">
      <div class="watch-head">
        <h2>Watch folders</h2>
        <p class="note">
          To ingest a DICOM series or .zip: copy it NEXT TO the protocol's
          incoming/ folder first (e.g. under a staging name), then rename the
          finished copy into incoming/ — the atomic rename marks it complete.
          (Alternatively, write an empty &lt;name&gt;.complete file beside it
          after copying directly into incoming/.) The watcher daemon (labrat
          watch) claims settled drops, runs the protocol, and moves them to
          done/ or failed/. The toggle below enables or disables ingestion;
          it does not launch the daemon.
        </p>
      </div>

      ${unavailable
        ? html`<div class="banner banner-unavailable">
            Watcher backend unavailable. /api/watcher did not respond; retrying every few seconds.
          </div>`
        : null}

      ${status === null && !unavailable
        ? html`<div class="empty">Loading watcher status…</div>`
        : null}
      ${status !== null
        ? html`
            <div class="watch-status-card">
              <span class="watch-state-dot ${dotClass}" aria-hidden="true"></span>
              <div class="watch-state-text">
                <span class="watch-state-label">${healthLabel}</span>
                <span class="watch-state-meta">${healthMeta}</span>
              </div>
              <button
                type="button"
                class="btn ${ingestionOn ? "" : "btn-primary"} watch-toggle"
                disabled=${toggleBusy || unavailable}
                onClick=${toggle}
              >
                ${ingestionOn ? "Disable ingestion" : "Enable ingestion"}
              </button>
              ${toggleError ? html`<div class="watch-error">${toggleError}</div>` : null}
              ${!toggleError && pendingDesired && health !== "offline"
                ? html`<div class="watch-status-note">
                    Ingestion ${pendingDesired === "running" ? "enable" : "disable"} requested;
                    waiting for the watcher's next heartbeat.
                  </div>`
                : null}
              ${status.configError
                ? html`<div class="watch-error">Config error: ${status.configError}</div>`
                : null}
            </div>

            ${protocols.length === 0
              ? html`<div class="empty">
                  No watch folders configured. Protocols get a watch root from the harness config;
                  once one is set, its folder and drop counts appear here.
                </div>`
              : html`<div class="watch-proto-list">
                  ${protocols.map(
                    ([id, proto]) => html`
                      <${ProtocolRow} key=${id} id=${id} proto=${proto} onSaveRoot=${saveRoot} />
                    `,
                  )}
                </div>`}

            <${AddWatchFolder}
              boundIds=${protocols.map(([id]) => id)}
              health=${health}
              onAdd=${saveRoot}
            />
          `
        : null}
    </div>
  `;
}
