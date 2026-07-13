import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { getJSON, postJSON } from "../lib/api.js";

/**
 * Manual "Submit a sample" panel (top-level screen, alongside Watch folders
 * and Skills). The third ingest surface next to the CLI (`labrat enqueue`)
 * and the folder watcher: pick an input path + protocol, press Start, and
 * the dashboard launches a real run.
 *
 *   POST /api/enqueue {input, protocol} — the server validates (path exists
 *   inside the project root, protocol known to the registry) and spawns the
 *   existing CLI enqueue as a detached child. It answers 202 "started"
 *   WITHOUT a task id — the id is allocated inside the child process.
 *
 * So the panel discovers the new id itself: it snapshots the task-list ids
 * before POSTing, then polls GET /api/tasks until an id appears that wasn't
 * in the snapshot, and links straight into that sample. If the run dies
 * before allocating a task, the poll times out with a pointer at the
 * server-side launch log instead of spinning forever.
 */

const PROTOCOLS = ["microct-oa-mouse-knee", "toy-stats"];
const DEFAULT_INPUT = "data/OA7-4L.zip";
const POLL_MS = 2000;
const POLL_TIMEOUT_MS = 120000;

export function SubmitPanel({ onOpenSample }) {
  const [input, setInput] = useState(DEFAULT_INPUT);
  const [protocol, setProtocol] = useState(PROTOCOLS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [started, setStarted] = useState(null); // 202 body from POST /api/enqueue
  const [newTaskId, setNewTaskId] = useState(null);
  const [timedOut, setTimedOut] = useState(false);
  const pollRef = useRef(null);

  // Never leak the poll past unmount (navigating away cancels the watch;
  // the run itself is server-side and unaffected).
  useEffect(() => () => clearInterval(pollRef.current), []);

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStarted(null);
    setNewTaskId(null);
    setTimedOut(false);
    clearInterval(pollRef.current);
    try {
      // Snapshot BEFORE the POST so the new task can't slip into the baseline.
      const before = new Set((await getJSON("/api/tasks")).map((t) => t.id));
      const resp = await postJSON("/api/enqueue", {
        input: input.trim(),
        protocol,
      });
      setStarted(resp);

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      pollRef.current = setInterval(async () => {
        try {
          const tasks = await getJSON("/api/tasks");
          const fresh = tasks.find((t) => !before.has(t.id));
          if (fresh) {
            clearInterval(pollRef.current);
            setNewTaskId(fresh.id);
            return;
          }
        } catch {
          // transient fetch failure — keep polling until the deadline
        }
        if (Date.now() > deadline) {
          clearInterval(pollRef.current);
          setTimedOut(true);
        }
      }, POLL_MS);
    } catch (e) {
      setError(e.message || "Could not start the run.");
    } finally {
      setBusy(false);
    }
  }

  return html`
    <div class="watch-view">
      <div class="watch-head">
        <h2>Submit a sample</h2>
        <p class="note">
          Start a run directly: give a path to a DICOM series or .zip (relative
          to the project root) and pick a protocol. The dashboard launches the
          same run a terminal <code>labrat enqueue</code> would — the new
          sample appears in the sidebar as its first phase starts.
        </p>
      </div>

      <div class="watch-proto">
        <label class="watch-root-label" for="submit-input">Input path</label>
        <div class="watch-root-row">
          <input
            id="submit-input"
            class="watch-root-input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="data/sample.zip"
            value=${input}
            disabled=${busy}
            onInput=${(e) => {
              setInput(e.currentTarget.value);
              setError(null);
            }}
            onKeyDown=${(e) => {
              if (e.key === "Enter") start();
            }}
          />
        </div>
        <label class="watch-root-label" for="submit-protocol">Protocol</label>
        <div class="watch-root-row">
          <select
            id="submit-protocol"
            class="watch-root-input"
            disabled=${busy}
            onChange=${(e) => setProtocol(e.currentTarget.value)}
          >
            ${PROTOCOLS.map(
              (p) => html`<option key=${p} value=${p} selected=${p === protocol}>${p}</option>`,
            )}
          </select>
          <button
            type="button"
            class="btn btn-primary"
            disabled=${busy || input.trim() === ""}
            onClick=${start}
          >
            ${busy ? "Starting…" : "Start"}
          </button>
        </div>

        ${error ? html`<div class="watch-error">${error}</div>` : null}
        ${started && !newTaskId && !timedOut
          ? html`<div class="watch-saved">
              Run started (${started.protocol}). Waiting for the task to appear…
            </div>`
          : null}
        ${newTaskId
          ? html`<div class="watch-saved">
              Started <b>${newTaskId}</b>${" "}
              <button type="button" class="btn" onClick=${() => onOpenSample(newTaskId)}>
                Open sample
              </button>
            </div>`
          : null}
        ${timedOut
          ? html`<div class="watch-error">
              No new task appeared yet. The run may have failed to start — check
              the launch log on the server${started?.log ? ` (${started.log})` : ""}.
            </div>`
          : null}
      </div>
    </div>
  `;
}
