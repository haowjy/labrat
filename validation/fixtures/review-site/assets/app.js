// Minimal review-site fixture (review-template.md §1, the "minimal" column).
// Reads window.REVIEW_MANIFEST / window.REVIEW_DATA (assigned by data/*.js,
// loaded via <script> before this file — I3: never fetched JSON). Verdict
// state lives in memory only for this document's lifetime (Top risk / R2:
// an opaque-origin sandboxed frame hard-throws on localStorage/sessionStorage,
// and in-memory state does not survive cross-page navigation anyway, hence
// single-document). Export is the only record.
(function () {
  "use strict";

  var manifest = window.REVIEW_MANIFEST;
  var data = window.REVIEW_DATA;
  var items = (data && data.items) || [];

  var VERDICTS = ["confirm", "correct", "reject"];
  var VERDICT_LABEL = { confirm: "Confirm", correct: "Correct", reject: "Reject" };

  // verdicts: item id -> "confirm" | "correct" | "reject". Absent = unset.
  var state = { verdicts: Object.create(null) };

  var els = {
    title: document.getElementById("sample-title"),
    source: document.getElementById("sample-source"),
    tbody: document.getElementById("rows-body"),
    progress: document.getElementById("progress"),
    exportBtn: document.getElementById("export-btn"),
  };

  // --- small DOM helper (avoids repeating createElement/className/textContent) ---
  function el(tag, opts) {
    var node = document.createElement(tag);
    opts = opts || {};
    if (opts.className) node.className = opts.className;
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.attrs) {
      Object.keys(opts.attrs).forEach(function (key) {
        node.setAttribute(key, opts.attrs[key]);
      });
    }
    return node;
  }

  // --- pure: derive overall from per-item verdicts (reject > correct > confirm) ---
  function computeOverall(rowVerdicts) {
    if (rowVerdicts.indexOf("reject") !== -1) return "reject";
    if (rowVerdicts.indexOf("correct") !== -1) return "correct";
    return "confirm";
  }

  function reviewedCount() {
    return items.reduce(function (count, item) {
      return count + (state.verdicts[item.id] ? 1 : 0);
    }, 0);
  }

  function updateProgress() {
    var total = items.length;
    var done = reviewedCount();
    var ready = total > 0 && done === total;

    if (total === 0) {
      els.progress.textContent = "No indices to review.";
    } else if (ready) {
      els.progress.textContent = done + " of " + total + " reviewed. Ready to export.";
    } else {
      els.progress.textContent = done + " of " + total + " reviewed.";
    }
    els.progress.dataset.ready = String(ready);
    els.exportBtn.disabled = !ready;
  }

  function syncRowButtons(tr, itemId) {
    var picked = state.verdicts[itemId];
    VERDICTS.forEach(function (verdict) {
      var btn = tr.querySelector('[data-verdict="' + verdict + '"]');
      btn.setAttribute("aria-pressed", String(picked === verdict));
    });
  }

  function onVerdictClick(tr, item, verdict) {
    var next = state.verdicts[item.id] === verdict ? null : verdict;
    if (next) {
      state.verdicts[item.id] = next;
    } else {
      delete state.verdicts[item.id];
    }
    syncRowButtons(tr, item.id);
    updateProgress();
  }

  function buildRow(item) {
    var tr = document.createElement("tr");
    tr.dataset.itemId = item.id;

    var indexCell = el("td", { attrs: { "data-label": "Index" } });
    indexCell.appendChild(el("span", { className: "row-label", text: item.label }));
    indexCell.appendChild(el("code", { className: "row-id", text: item.id }));
    tr.appendChild(indexCell);

    var valueCell = el("td", { attrs: { "data-label": "Value" } });
    valueCell.appendChild(el("span", { className: "row-value-num", text: String(item.value) }));
    if (item.unit) {
      valueCell.appendChild(el("span", { className: "row-value-unit", text: item.unit }));
    }
    tr.appendChild(valueCell);

    var flagCell = el("td", { attrs: { "data-label": "Honesty flag" } });
    flagCell.appendChild(
      el("span", {
        className: "flag-chip",
        text: item.honesty_flag,
        attrs: { "data-flag": item.honesty_flag },
      }),
    );
    if (item.honesty_detail) {
      flagCell.appendChild(el("p", { className: "flag-detail", text: item.honesty_detail }));
    }
    tr.appendChild(flagCell);

    var verdictCell = el("td", { attrs: { "data-label": "Verdict" } });
    var group = el("div", {
      className: "verdict-group",
      attrs: { role: "group", "aria-label": "Verdict for " + item.label },
    });
    VERDICTS.forEach(function (verdict) {
      var btn = el("button", {
        className: "verdict-btn verdict-" + verdict,
        text: VERDICT_LABEL[verdict],
        attrs: { type: "button", "data-verdict": verdict, "aria-pressed": "false" },
      });
      btn.addEventListener("click", function () {
        onVerdictClick(tr, item, verdict);
      });
      group.appendChild(btn);
    });
    verdictCell.appendChild(group);
    tr.appendChild(verdictCell);

    return tr;
  }

  // --- pure: the review-verdict/1 payload from current state ---
  function buildVerdictPayload() {
    return {
      schema: manifest.verdict_schema,
      sample_id: manifest.sample_id,
      produced_from: manifest.produced_from,
      overall: computeOverall(
        items.map(function (item) {
          return state.verdicts[item.id];
        }),
      ),
      items: items.map(function (item) {
        return {
          id: item.id,
          verdict: state.verdicts[item.id],
          corrected_value: null,
          note: "",
        };
      }),
      exported_at: new Date().toISOString(),
    };
  }

  function render() {
    els.title.textContent = "Review " + manifest.sample_id;
    els.source.textContent = "from " + manifest.produced_from.measurement;

    items.forEach(function (item) {
      els.tbody.appendChild(buildRow(item));
    });

    updateProgress();
  }

  // C2: the whole handler runs synchronously, start to finish, inside the
  // click event, so a real tap/touch triggers the download directly (iOS
  // Safari drops a download-anchor click deferred past an await/microtask).
  // C3: data: URL, not blob: (Safari refuses blob: URLs created inside an
  // opaque-origin sandboxed frame; a data: URL needs no origin at all).
  els.exportBtn.addEventListener("click", function () {
    if (els.exportBtn.disabled) return;

    var json = JSON.stringify(buildVerdictPayload(), null, 2);
    var dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(json);

    var link = document.createElement("a");
    link.href = dataUrl;
    link.download = "verdict.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });

  render();
})();
