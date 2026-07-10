"use strict";
/*
 * LabRat dashboard client. Reads the disk contract through the HTTP API and
 * renders the review chain. SSE (/events) carries notifications only — every
 * state event triggers a re-read of the API, never a direct data read from the
 * stream (design §3, §13).
 *
 * index.html loads review-site.js before this file — REVIEW_SANDBOX and
 * reviewSiteSrc() below are that file's globals, not redeclared here (see
 * review-site.js for why the sandboxed-iframe contract lives there).
 */

const state = {
  tasks: [],
  currentId: null,
  view: "chain",
};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url);
  return r.ok ? r.text() : "";
}

/* ---- decision → presentation ---- */
function decisionPill(decision) {
  switch (decision) {
    case "pass": return ["pill-pass", "pass"];
    case "pass-with-concerns": return ["pill-warn", "concerns"];
    case "fail": return ["pill-fail", "fail"];
    case "fail-upstream": return ["pill-fail", "fail-upstream"];
    default: return ["pill-skip", decision];
  }
}
function statePill(s) {
  switch (s) {
    case "done": return ["pill-pass", "done"];
    case "running": return ["pill-running", "running"];
    case "paused": return ["pill-paused", "paused"];
    case "failed": return ["pill-fail", "failed"];
    default: return ["pill-skip", s];
  }
}
function dotClass(entry) {
  if (entry.gate) {
    const d = entry.gate.decision;
    if (d === "pass") return "pass";
    if (d === "pass-with-concerns") return "concerns";
    return "fail";
  }
  if (entry.status === "running") return "running";
  if (entry.status === "paused") return "paused";
  if (entry.status === "failed") return "fail";
  return "pending";
}
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function duration(a, b) {
  if (!a || !b) return "";
  const s = Math.round((new Date(b) - new Date(a)) / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/* ---- sidebar ---- */
async function loadTasks() {
  state.tasks = await getJSON("/api/tasks");
  $("task-count").textContent = `${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}`;
  const list = $("task-list");
  list.innerHTML = "";
  for (const t of state.tasks) {
    const [pc, pl] = statePill(t.state);
    const sub = t.state === "running" && t.currentPhase
      ? esc(t.currentPhase)
      : t.reason
        ? esc(t.reason)
        : `${t.phasesComplete.length} phase${t.phasesComplete.length === 1 ? "" : "s"}`;
    const el = document.createElement("div");
    el.className = "task-item" + (t.id === state.currentId ? " active" : "");
    el.innerHTML =
      `<div class="task-id">${esc(t.id)}</div>` +
      `<div class="task-protocol">${esc(t.protocol)}</div>` +
      `<div class="task-meta"><span class="pill ${pc}">${esc(pl)}</span>` +
      `<span class="task-sub">${sub}</span></div>`;
    el.onclick = () => selectTask(t.id);
    list.appendChild(el);
  }
}

function selectTask(id) {
  state.currentId = id;
  location.hash = id;
  document.querySelectorAll(".task-item").forEach((el) => {
    el.classList.toggle("active", el.querySelector(".task-id")?.textContent === id);
  });
  renderCurrent();
}

async function renderCurrent() {
  if (!state.currentId) return;
  const t = state.tasks.find((x) => x.id === state.currentId);
  $("topbar-id").textContent = state.currentId;
  $("topbar-sub").textContent = t ? `${t.input ?? ""}${t.input ? " / " : ""}${t.protocol}` : "";
  if (state.view === "chain") await renderChain();
  else if (state.view === "provenance") await renderProvenance();
  else renderReviews();
}

/* ---- review chain ---- */
async function renderChain() {
  const root = $("view-chain");
  const detail = await getJSON(`/api/tasks/${state.currentId}`);
  root.innerHTML = "";

  if (detail.task.state === "paused" || detail.task.state === "failed") {
    const b = document.createElement("div");
    b.className = "banner " + (detail.task.state === "paused" ? "banner-paused" : "banner-failed");
    b.textContent = `${detail.task.state}${detail.task.reason ? ": " + detail.task.reason : ""}`;
    root.appendChild(b);
  }

  const tl = document.createElement("div");
  tl.className = "timeline";
  detail.timeline.forEach((entry, i) => {
    const last = i === detail.timeline.length - 1;
    const row = document.createElement("div");
    row.className = "phase-row";
    row.innerHTML =
      `<div class="phase-dot-col"><div class="phase-dot ${dotClass(entry)}"></div>` +
      `${last ? "" : '<div class="phase-line"></div>'}</div>` +
      `<div class="phase-content" id="phase-${esc(entry.phase)}"></div>`;
    tl.appendChild(row);
  });
  root.appendChild(tl); // must be in the DOM before filling by id

  // Skeleton (name, time, gate) is synchronous; detail is fetched per phase.
  detail.timeline.forEach((entry) => fillPhaseSkeleton(entry));
  await renderSuggestions(root, detail.timeline.map((e) => e.phase));
  for (const entry of detail.timeline) {
    void fillPhaseDetail(entry);
  }
}

function fillPhaseSkeleton(entry) {
  const node = $(`phase-${entry.phase}`);
  if (!node) return;
  const time = entry.started
    ? `${fmtTime(entry.started)}${entry.completed ? " — " + fmtTime(entry.completed) : ""}` +
      (entry.completed ? ` (${duration(entry.started, entry.completed)})` : "")
    : entry.status;
  const attempt = entry.attempt && entry.attempt > 1
    ? `<span class="attempt">attempt ${entry.attempt}</span>` : "";
  let html =
    `<div class="phase-name">${esc(entry.phase)} ${attempt}` +
    (entry.status === "running" ? '<span class="pill pill-running">running</span>' : "") +
    (entry.status === "paused" ? '<span class="pill pill-paused">paused</span>' : "") +
    `</div><div class="phase-time">${esc(time)}</div>`;
  html += `<div class="phase-detail" id="detail-${esc(entry.phase)}"></div>`;
  node.innerHTML = html;

  if (entry.gate) {
    const [pc, pl] = decisionPill(entry.gate.decision);
    const cls = entry.gate.decision === "pass" ? "pass"
      : entry.gate.decision === "pass-with-concerns" ? "concerns" : "fail";
    const conf = entry.gate.confidence ? ` <span class="pill pill-warn">confidence ${esc(entry.gate.confidence)}</span>` : "";
    const gate = document.createElement("div");
    gate.className = `gate ${cls}`;
    gate.innerHTML =
      `<span class="pill ${pc}">${esc(pl)}</span>${conf}` +
      `<div class="gate-body">${entry.gate.feedback ? `<div class="gate-feedback">${esc(entry.gate.feedback)}</div>` : ""}</div>`;
    node.appendChild(gate);
  }

  // The review site is a first-class node in the chain: a phase whose
  // recorded outputs include artifacts/review-site/ (getTask's hasReviewSite,
  // contract-based — see api/index.ts) gets a direct jump into the Reviews view.
  if (entry.hasReviewSite) {
    node.appendChild(reviewLinkButton());
  }
}

async function fillPhaseDetail(entry) {
  const slot = $(`detail-${entry.phase}`);
  if (!slot) return;
  let detail;
  try {
    detail = await getJSON(`/api/tasks/${state.currentId}/phases/${entry.phase}`);
  } catch {
    return;
  }
  let html = "";
  if (detail.summary) {
    const firstPara = detail.summary.replace(/^#.*\n/, "").trim().split("\n\n")[0];
    html += `<p class="phase-summary">${esc(firstPara)}</p>`;
  }
  if (detail.subphases && detail.subphases.length) {
    html += '<div class="subphases">';
    for (const sp of detail.subphases) {
      const [pc, pl] = sp.mark === "pass" ? ["pill-pass", "pass"]
        : sp.mark === "human-review" ? ["pill-review", "human-review"]
        : ["pill-fail", "fail"];
      const conf = [sp.confidence, sp.notes].filter(Boolean).join(" — ");
      html += `<div class="sp"><span class="pill ${pc}">${esc(pl)}</span>` +
        `<span class="sp-name">${esc(sp.subphase)}</span>` +
        `<span class="sp-conf">${esc(conf)}</span></div>`;
    }
    html += "</div>";
  }
  html += measurementsHtml(detail.measurements);
  if (detail.evidence && detail.evidence.length) {
    html += '<div class="section-label">Evidence</div><div class="evidence-grid">';
    for (const f of detail.evidence) {
      const src = `/api/tasks/${state.currentId}/phases/${entry.phase}/evidence/${encodeURIComponent(f)}`;
      html += `<div class="evidence-thumb" data-src="${esc(src)}" data-cap="${esc(f)}">` +
        `<img src="${esc(src)}" alt="${esc(f)}" loading="lazy"><div class="cap">${esc(f)}</div></div>`;
    }
    html += "</div>";
  }
  slot.innerHTML = html;
  slot.querySelectorAll(".evidence-thumb").forEach((el) => {
    el.onclick = () => openLightbox(el.dataset.src, el.dataset.cap);
  });

  // Reviewer verification — show that the reviewer RAN code (design §10).
  if (detail.verification && detail.verification.length) {
    await appendVerification(slot, entry.phase, detail.verification);
  }
}

function measurementsHtml(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "";
  const rows = Object.entries(m)
    .filter(([, v]) => typeof v === "number" || typeof v === "string")
    .map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td></tr>`)
    .join("");
  if (!rows) return "";
  return `<div class="section-label">Measurements</div><div class="measure"><table>${rows}</table></div>`;
}

async function appendVerification(slot, phase, files) {
  const wrap = document.createElement("div");
  wrap.className = "verify";
  const links = files
    .map((f) => `<a href="/api/tasks/${state.currentId}/verification/${encodeURIComponent(phase)}/${encodeURIComponent(f)}" target="_blank">${esc(f)}</a>`)
    .join("");
  wrap.innerHTML =
    `<div class="verify-head">Reviewer verification — code + output</div>` +
    `<div class="verify-files">${links}</div>`;
  // Inline small .py/.txt so the independent check is legible without a click.
  for (const f of files) {
    if (!/\.(py|txt|md|json)$/.test(f)) continue;
    const body = await getText(`/api/tasks/${state.currentId}/verification/${encodeURIComponent(phase)}/${encodeURIComponent(f)}`);
    if (!body) continue;
    const pre = document.createElement("pre");
    pre.textContent = `# ${f}\n\n${body.trim()}`;
    wrap.appendChild(pre);
  }
  slot.appendChild(wrap);
}

/* ---- suggestions ---- */
async function renderSuggestions(root, phases) {
  const box = document.createElement("div");
  box.className = "suggestion-box";
  let existing = [];
  try { existing = await getJSON(`/api/tasks/${state.currentId}/suggestions`); } catch { /* none */ }
  const list = existing
    .map((s) => `<div class="suggestion-item">${esc(s.text)}<div class="meta">${esc(s.phase)} · ${esc(s.author)} · ${esc(s.id)}</div></div>`)
    .join("");
  const options = phases.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  box.innerHTML =
    `<h3>Suggestions for the protocol author</h3>` +
    `<div class="suggestion-list">${list || '<div class="note">No suggestions yet.</div>'}</div>` +
    `<div class="form-row"><label>Phase</label><select id="sug-phase">${options}</select></div>` +
    `<textarea id="sug-text" placeholder="e.g., add a largest-connected-component filter to the segmentation skill so femur speckle is cleaned before handoff."></textarea>` +
    `<div class="actions"><span class="note" id="sug-note"></span><button class="btn btn-primary" id="sug-submit">Submit suggestion</button></div>`;
  root.appendChild(box);
  $("sug-submit").onclick = submitSuggestion;
}

async function submitSuggestion() {
  const phase = $("sug-phase").value;
  const text = $("sug-text").value.trim();
  const note = $("sug-note");
  if (!text) { note.textContent = "Enter a suggestion first."; return; }
  $("sug-submit").disabled = true;
  try {
    const r = await fetch(`/api/tasks/${state.currentId}/suggestions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phase, text }),
    });
    if (!r.ok) throw new Error(await r.text());
    note.textContent = "Saved.";
    $("sug-text").value = "";
    await renderChain();
  } catch (e) {
    note.textContent = "Failed to save.";
    $("sug-submit").disabled = false;
  }
}

/* ---- provenance ---- */
async function renderProvenance() {
  const root = $("view-provenance");
  root.innerHTML = "";
  let manifest;
  try {
    manifest = await getJSON(`/api/tasks/${state.currentId}/manifest`);
  } catch {
    root.innerHTML = '<div class="empty">No provenance manifest on disk yet.</div>';
    return;
  }
  const title = document.createElement("div");
  title.className = "section-label";
  title.textContent = "Provenance — append-only, one entry per completed phase";
  root.appendChild(title);

  for (const e of manifest) {
    const [pc, pl] = decisionPill(e.gate_decision);
    const card = document.createElement("div");
    card.className = "prov-entry";
    const skills = e.skills_loaded
      .map((s) => `${esc(s.name)}${s.source ? ` <span class="hash">(${esc(s.source)})</span>` : ""}${s.hash ? ` <span class="hash">${esc(s.hash)}</span>` : ""}`)
      .map((x) => `<li>${x}</li>`).join("");
    const outputs = e.outputs
      .map((o) => `<li>${esc(o.path)}${o.hash ? ` <span class="hash">${esc(o.hash)}</span>` : ""}${o.fileCount != null ? ` <span class="hash">(${o.fileCount} files)</span>` : ""}</li>`)
      .join("") || "<li>—</li>";
    const inputs = e.inputs
      .map((o) => `<li>${esc(o.path)}${o.hash ? ` <span class="hash">${esc(o.hash)}</span>` : ""}</li>`)
      .join("") || "<li>—</li>";
    const subs = e.subphases
      ? Object.entries(e.subphases).map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`).join("")
      : "<li>—</li>";
    card.innerHTML =
      `<div class="prov-head">${esc(e.phase)} <span class="attempt">attempt ${e.attempt}</span>` +
      `<span class="pill ${pc}">${esc(pl)}</span></div>` +
      `<div class="prov-grid">` +
      row("when", `${esc(fmtTime(e.started))} → ${esc(fmtTime(e.completed))}`) +
      row("agent", esc(e.agent)) +
      row("skills", `<ul>${skills}</ul>`) +
      row("inputs", `<ul>${inputs}</ul>`) +
      row("outputs", `<ul>${outputs}</ul>`) +
      row("subphases", `<ul>${subs}</ul>`) +
      row("sessions", `worker ${esc(e.sessions.worker)} · gate ${esc(e.sessions.gate)}`) +
      row("verification", `${esc(e.verification.code)} → ${esc(e.verification.results)}`) +
      `</div>`;
    // Same "artifacts/review-site/" contract check as getTask's hasReviewSite
    // (src/dashboard/api/index.ts) — done client-side here because this view
    // renders the manifest's raw outputs directly, nothing pre-derived server-side.
    if (e.outputs.some((o) => o.path.startsWith("artifacts/review-site/"))) {
      card.appendChild(reviewLinkButton());
    }
    root.appendChild(card);
  }
}
function row(k, v) {
  return `<div class="pk">${k}</div><div class="pv">${v}</div>`;
}

/* ---- reviews ----
 * The review site is quarantined content (design/review-template.md §3 point
 * 3): it runs in a sandboxed iframe with NO allow-same-origin, so it is an
 * opaque origin that cannot read the dashboard's cookies/storage/DOM or call
 * /api/*. REVIEW_SANDBOX / reviewSiteSrc live in review-site.js, not here,
 * so the trust-boundary-critical constant has exactly one definition,
 * directly unit-tested (review-site.test.ts) — this function only renders it.
 */
function renderReviews() {
  const root = $("view-reviews");
  const id = state.currentId;
  root.innerHTML =
    `<div class="review-embed">` +
    `<div class="review-embed-head">` +
    `<span class="section-label">Review site</span>` +
    `<span class="quarantine-note">Sandboxed frame — isolated from the dashboard, no shared login or storage</span>` +
    `</div>` +
    `<iframe class="review-frame" src="${esc(reviewSiteSrc(id))}" ` +
    `sandbox="${esc(REVIEW_SANDBOX)}" title="Review site for ${esc(id)} (sandboxed)" loading="lazy"></iframe>` +
    `</div>`;
}

/** "Open review site" call-to-action shared by the chain + provenance views. */
function reviewLinkButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn review-link";
  btn.textContent = "Open review site";
  btn.onclick = () => setView("reviews");
  return btn;
}

/* ---- views ---- */
function setView(view) {
  state.view = view;
  $("view-chain").style.display = view === "chain" ? "" : "none";
  $("view-provenance").style.display = view === "provenance" ? "" : "none";
  $("view-reviews").style.display = view === "reviews" ? "" : "none";
  $("btn-chain").classList.toggle("active-btn", view === "chain");
  $("btn-prov").classList.toggle("active-btn", view === "provenance");
  $("btn-reviews").classList.toggle("active-btn", view === "reviews");
  // Every switch starts the new view at the top — otherwise a switch made
  // while scrolled down on one view lands mid-scroll on unrelated content.
  const main = document.querySelector(".main");
  if (main) main.scrollTop = 0;
  renderCurrent();
}

/* ---- lightbox ---- */
function openLightbox(src, cap) {
  $("lightbox-img").src = src;
  $("lightbox-cap").textContent = cap;
  $("lightbox").classList.add("open");
}
$("lightbox").onclick = () => $("lightbox").classList.remove("open");

/* ---- SSE: notification only; re-read disk on every state event ---- */
const STATE_EVENTS = ["task-started", "phase-started", "phase-complete", "gate-result", "task-done", "task-failed", "task-paused"];
function describe(ev) {
  switch (ev.type) {
    case "gate-result": return `${ev.phase}: gate ${ev.decision}`;
    case "phase-started": return `${ev.phase}: started`;
    case "phase-complete": return `${ev.phase}: complete`;
    case "task-started": return `task started (${ev.protocol})`;
    case "task-done": return "task done";
    case "task-failed": return `task failed: ${ev.reason}`;
    case "task-paused": return `task paused: ${ev.reason}`;
    default: return ev.type;
  }
}
function onStateEvent(ev) {
  $("live-event").innerHTML = `<span class="ev-type">${esc(ev.type)}</span> — ${esc(describe(ev).replace(ev.type + ": ", ""))}`;
  $("live-time").textContent = fmtTime(new Date().toISOString());
  // The stream is a notification; re-read disk via the API (design §13).
  if (ev.taskId === state.currentId) renderCurrent();
  loadTasks();
}
function onLogEvent(ev) {
  const strip = $("log-strip");
  strip.style.display = "";
  const line = document.createElement("div");
  line.className = "log-line";
  line.innerHTML = `<span class="log-t">${esc(fmtTime(new Date().toISOString()))}</span>${esc(ev.line)}`;
  const box = $("log-lines");
  box.appendChild(line);
  while (box.children.length > 40) box.removeChild(box.firstChild);
  strip.scrollTop = strip.scrollHeight;
}
function connectSSE() {
  const es = new EventSource("/events");
  es.onopen = () => $("live-dot").classList.add("on");
  es.onerror = () => $("live-dot").classList.remove("on");
  for (const type of STATE_EVENTS) {
    es.addEventListener(type, (e) => { try { onStateEvent(JSON.parse(e.data)); } catch {} });
  }
  es.addEventListener("log", (e) => { try { onLogEvent(JSON.parse(e.data)); } catch {} });
}

/* ---- boot ---- */
$("btn-chain").onclick = () => setView("chain");
$("btn-prov").onclick = () => setView("provenance");
$("btn-reviews").onclick = () => setView("reviews");

async function boot() {
  await loadTasks();
  const fromHash = location.hash.slice(1);
  const initial = state.tasks.find((t) => t.id === fromHash) ?? state.tasks[0];
  if (initial) selectTask(initial.id);
  connectSSE();
}
boot();
