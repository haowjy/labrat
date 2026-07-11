import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { getJSON } from "../lib/api.js";
import { useReviewBridge } from "./useReviewBridge.js";
import { EvidencePanel } from "./EvidencePanel.js";
import { ReviewEmbed } from "./ReviewEmbed.js";
import { VerdictPanel } from "./VerdictPanel.js";

/**
 * Per-phase suggestion to the protocol author, scoped to the phase under
 * review (no phase picker — the phase IS the context). Posts under the active
 * phase and lists only that phase's suggestions. Mounted inside ReviewLayer,
 * which is keyed `taskId:phase`, so a half-typed draft can't survive a phase
 * switch and get filed against the wrong phase.
 */
function SuggestionBox({ taskId, phase }) {
  const [suggestions, setSuggestions] = useState([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getJSON(`/api/tasks/${encodeURIComponent(taskId)}/suggestions`)
      .then((s) => {
        if (!cancelled) setSuggestions(s);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed) {
      setNote("Enter a suggestion first.");
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/suggestions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase, text: trimmed }),
      });
      if (!r.ok) throw new Error(await r.text());
      const entry = await r.json();
      setSuggestions((prev) => [...prev, entry]);
      setText("");
      setNote("Saved.");
    } catch {
      setNote("Failed to save.");
    } finally {
      setSubmitting(false);
    }
  }

  const visible = suggestions.filter((s) => s.phase === phase);

  return html`
    <div class="suggestion-box">
      <h3>Suggestions for the protocol author · ${phase}</h3>
      <div class="suggestion-list">
        ${visible.length === 0
          ? html`<div class="note">No suggestions for this phase yet.</div>`
          : visible.map(
              (s) => html`
                <div class="suggestion-item" key=${s.id}>
                  ${s.text}
                  <div class="meta">${s.author} · ${s.id}</div>
                </div>
              `,
            )}
      </div>
      <textarea
        placeholder="e.g., add a largest-connected-component filter to the segmentation skill so femur speckle is cleaned before handoff."
        value=${text}
        onInput=${(e) => setText(e.currentTarget.value)}
      ></textarea>
      <div class="actions">
        <span class="note">${note}</span>
        <button class="btn btn-primary" disabled=${submitting} onClick=${submit}>
          Submit suggestion
        </button>
      </div>
    </div>
  `;
}

/**
 * Sign-off actions: download the review chain and copy the task's folder
 * path. Export is a plain download anchor — the endpoint sets
 * Content-Disposition, so the browser saves the bundle with no JS. Copy
 * folder path writes the server-provided absolute `taskDir` (from the shared
 * task detail) to the clipboard so a scientist can paste the tree into Claude
 * Science to improve the protocol — the demo's closing beat.
 */
function SignOffActions({ taskId, taskDir }) {
  const [copied, setCopied] = useState(false);

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(taskDir);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return html`
    <div class="signoff-actions">
      <a class="btn" href=${`/api/tasks/${encodeURIComponent(taskId)}/export`} download>
        Export review chain
      </a>
      <button type="button" class="btn" title=${taskDir ?? ""} onClick=${copyPath}>
        ${copied ? "Copied path" : "Copy folder path"}
      </button>
    </div>
  `;
}

/**
 * The generic review layer for ONE phase — the default landing when a phase
 * is opened (design/review-architecture-decision.md: a trusted shell that
 * holds everything the reviewer reads and records, OUTSIDE the untrusted
 * artifact). It OWNS the postMessage bridge (useReviewBridge) because it owns
 * both the artifact iframe (through `bindIframe`) AND the trusted
 * VerdictPanel — so landmark corrections a reviewer makes full-screen live in
 * this component's state and are still there for the verdict controls after
 * they exit.
 *
 * Mounted by PhaseReviewView under `key=${taskId}:${phase}`, so switching
 * phase gives a genuinely fresh bridge + fresh full-screen state + a fresh
 * getPhase fetch — matching the old ReviewEmbed remount — while a data-only
 * SSE refresh (which never changes that key) leaves an in-progress verdict
 * untouched.
 *
 * Layout (top to bottom): the decisive Evidence panel leads; then the
 * sandboxed artifact with its full-screen toggle (full-screen is a CSS-only
 * promotion of the SAME iframe element, so the bridge survives enter/exit);
 * then the trusted verdict controls in normal flow (never floated on the
 * iframe); then per-phase feedback and the task-level sign-off actions.
 */
export function ReviewLayer({ taskId, phase, entry, taskDir, onVerdictFinished }) {
  const { verdict, bindIframe, setVerdict } = useReviewBridge();
  const [fullScreen, setFullScreen] = useState(false);
  const [phaseDetail, setPhaseDetail] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getJSON(`/api/tasks/${encodeURIComponent(taskId)}/phases/${encodeURIComponent(phase)}`)
      .then((d) => {
        if (!cancelled) setPhaseDetail(d);
      })
      .catch(() => {
        if (!cancelled) setPhaseDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, phase]);

  const hasReviewSite = !!(entry && entry.hasReviewSite);

  return html`
    <div class="review-layer">
      <${EvidencePanel} phaseDetail=${phaseDetail} />

      ${hasReviewSite
        ? html`<${ReviewEmbed}
            taskId=${taskId}
            phase=${phase}
            bindIframe=${bindIframe}
            fullScreen=${fullScreen}
            onToggleFullScreen=${setFullScreen}
          />`
        : html`
            <div class="review-stage review-stage-empty">
              <div class="empty">No interactive review artifact for this phase.</div>
            </div>
          `}

      <${VerdictPanel}
        taskId=${taskId}
        phase=${phase}
        verdict=${verdict}
        setVerdict=${setVerdict}
        onFinished=${onVerdictFinished}
      />

      <${SuggestionBox} taskId=${taskId} phase=${phase} />
      <${SignOffActions} taskId=${taskId} taskDir=${taskDir} />
    </div>
  `;
}
