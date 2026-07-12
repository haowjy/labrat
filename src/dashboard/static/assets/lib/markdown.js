/**
 * Minimal markdown-to-HTML renderer for gate feedback and structured prose.
 * Handles the subset the gate reviewer produces: headings, bold, italic,
 * inline code, bullet/numbered lists, paragraphs. No HTML passthrough —
 * all `<` and `>` are escaped (the gate output is untrusted agent text).
 *
 * Returns an HTML string suitable for `dangerouslySetInnerHTML` / `.innerHTML`.
 */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ESC[c]);
}

/** Inline formatting: **bold**, *italic*, `code`. Applied after escaping. */
function inlineFmt(line) {
  return line
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

/**
 * Convert a markdown string to an HTML string.
 *
 * Supported:
 * - `## heading` (h3) and `### heading` (h4) — h2 reserved for page-level
 * - `**bold**`, `*italic*`, `` `code` ``
 * - `- item` and `* item` (unordered list)
 * - `1. item` (ordered list)
 * - Blank-line-separated paragraphs
 * - Lines starting with `> ` (blockquote)
 */
export function renderMarkdown(src) {
  if (!src) return "";
  const lines = src.split("\n");
  const out = [];
  let inUl = false;
  let inOl = false;
  let inBq = false;
  let para = [];

  function flushPara() {
    if (para.length > 0) {
      out.push(`<p>${para.join(" ")}</p>`);
      para = [];
    }
  }
  function closeList() {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  }
  function closeBq() {
    if (inBq) { out.push("</blockquote>"); inBq = false; }
  }

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Blank line
    if (line.trim() === "") {
      flushPara();
      closeList();
      closeBq();
      continue;
    }

    // Heading
    const hm = line.match(/^(#{2,4})\s+(.+)/);
    if (hm) {
      flushPara();
      closeList();
      closeBq();
      const level = Math.min(hm[1].length + 1, 5); // ## -> h3, ### -> h4
      out.push(`<h${level}>${inlineFmt(esc(hm[2]))}</h${level}>`);
      continue;
    }

    // Unordered list
    const ulm = line.match(/^\s*[-*]\s+(.+)/);
    if (ulm) {
      flushPara();
      closeBq();
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${inlineFmt(esc(ulm[1]))}</li>`);
      continue;
    }

    // Ordered list
    const olm = line.match(/^\s*\d+\.\s+(.+)/);
    if (olm) {
      flushPara();
      closeBq();
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push(`<li>${inlineFmt(esc(olm[1]))}</li>`);
      continue;
    }

    // Blockquote
    const bqm = line.match(/^>\s?(.*)/);
    if (bqm) {
      flushPara();
      closeList();
      if (!inBq) { out.push("<blockquote>"); inBq = true; }
      out.push(inlineFmt(esc(bqm[1])));
      continue;
    }

    // Regular text — accumulate into paragraph
    closeList();
    closeBq();
    para.push(inlineFmt(esc(line)));
  }

  flushPara();
  closeList();
  closeBq();
  return out.join("\n");
}
