import { parse as acornParse } from "acorn";
import { full as walkFull } from "acorn-walk";

/**
 * Static parsing utilities for the review-site linter (`check.ts`).
 *
 * SECURITY INVARIANT: producer-authored review-site code is NEVER executed.
 * The worker writes `data/*.js`, `assets/*.js`, and `index.html`; the gate
 * reviewer runs the linter in ITS OWN process, so any `node:vm`/`eval` of that
 * code is arbitrary code execution inside the reviewer (it can read the
 * reviewer's env / API keys and DoS the run). Everything here is a pure
 * STATIC parse: HTML is tokenised, JS is parsed to an AST with `acorn`, and
 * values are read off literal nodes only. No producer expression is evaluated.
 */

// --- HTML -------------------------------------------------------------------

export type HtmlElement = {
  readonly tag: string;
  /** Lowercased attribute name → raw value ("" for boolean attributes). */
  readonly attrs: ReadonlyMap<string, string>;
  /** Raw text content for rawtext elements (`<script>`, `<style>`). */
  readonly rawText?: string;
};

/** Elements whose content is raw text, not markup (never re-tokenised). */
const RAWTEXT = new Set(["script", "style", "textarea", "title"]);

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/**
 * Tokenise HTML into its start elements (with attributes, incl. UNQUOTED
 * values) and the raw text of `<script>`/`<style>` blocks. Deliberately small
 * and robust rather than spec-perfect: it exists so the linter sees every
 * `src`/`href`/inline-script the browser would, closing the quoted-attr-regex
 * bypass class. Comments and doctype are skipped.
 */
export function parseHtml(html: string): readonly HtmlElement[] {
  const elements: HtmlElement[] = [];
  let i = 0;
  const n = html.length;

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    i = lt + 1;
    if (i >= n) break;

    // Comment.
    if (html.startsWith("!--", i)) {
      const end = html.indexOf("-->", i + 3);
      i = end === -1 ? n : end + 3;
      continue;
    }
    // Doctype / declaration / CDATA.
    if (html[i] === "!") {
      const end = html.indexOf(">", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    // Closing tag.
    if (html[i] === "/") {
      const end = html.indexOf(">", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    // Not a tag start (bare `<`).
    if (!/[a-zA-Z]/.test(html[i] ?? "")) continue;

    // Tag name.
    let j = i;
    while (j < n && !isSpace(html[j] ?? "") && html[j] !== ">" && html[j] !== "/") j++;
    const tag = html.slice(i, j).toLowerCase();
    i = j;

    // Attributes.
    const attrs = new Map<string, string>();
    while (i < n && html[i] !== ">") {
      if (html[i] === "/") {
        i++;
        continue;
      }
      if (isSpace(html[i] ?? "")) {
        i++;
        continue;
      }
      // Attribute name.
      let k = i;
      while (
        k < n &&
        !isSpace(html[k] ?? "") &&
        html[k] !== "=" &&
        html[k] !== ">" &&
        html[k] !== "/"
      ) {
        k++;
      }
      const name = html.slice(i, k).toLowerCase();
      i = k;
      // Optional value.
      while (i < n && isSpace(html[i] ?? "")) i++;
      let value = "";
      if (html[i] === "=") {
        i++;
        while (i < n && isSpace(html[i] ?? "")) i++;
        const q = html[i];
        if (q === '"' || q === "'") {
          i++;
          const end = html.indexOf(q, i);
          value = html.slice(i, end === -1 ? n : end);
          i = end === -1 ? n : end + 1;
        } else {
          let v = i;
          while (v < n && !isSpace(html[v] ?? "") && html[v] !== ">") v++;
          value = html.slice(i, v);
          i = v;
        }
      }
      if (name && !attrs.has(name)) attrs.set(name, value);
    }
    if (i < n && html[i] === ">") i++;

    // Rawtext content.
    if (RAWTEXT.has(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, "i").exec(html.slice(i));
      const rawEnd = close ? i + close.index : n;
      const rawText = html.slice(i, rawEnd);
      elements.push({ tag, attrs, rawText });
      i = close ? i + close.index + close[0].length : n;
    } else {
      elements.push({ tag, attrs });
    }
  }

  return elements;
}

/** `url(...)` targets and `@import "..."` targets in a CSS string. */
export function extractCssUrls(css: string): readonly string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const v = (m[2] ?? "").trim();
    if (v.length > 0) out.push(v);
  }
  for (const m of css.matchAll(/@import\s+(['"])([^'"]*)\1/gi)) {
    const v = (m[2] ?? "").trim();
    if (v.length > 0) out.push(v);
  }
  return out;
}

// --- JavaScript (static AST) ------------------------------------------------

type EsNode = { readonly type: string } & Readonly<Record<string, unknown>>;

function asNode(v: unknown): EsNode | null {
  return v !== null && typeof v === "object" && typeof (v as EsNode).type === "string"
    ? (v as EsNode)
    : null;
}

/** A `window.<name> = <expr>` assignment: its name and (if literal) value. */
export type WindowGlobal = {
  readonly name: string;
  /** True when `<expr>` is a statically-known, non-empty literal. When the RHS
   * is a non-literal expression we can't (and won't) evaluate, this is true —
   * the global IS assigned, its emptiness is just unknown. Only a literal that
   * is provably empty (``""``/`[]`/`{}`/`null`/`0`/`false`) is `false`. */
  readonly nonEmpty: boolean;
  /** The statically-evaluated literal value, or `undefined` when non-literal. */
  readonly value: unknown;
};

export type FetchCall = {
  /** The URL string when the sole argument is a string literal; else null. */
  readonly url: string | null;
};

export type JsAnalysis = {
  /** acorn parse error message, or null when the source parses. */
  readonly syntaxError: string | null;
  readonly windowGlobals: readonly WindowGlobal[];
  readonly fetchCalls: readonly FetchCall[];
  /** Runtime data-loading sinks used (XMLHttpRequest / WebSocket / EventSource). */
  readonly networkSinks: readonly string[];
  /** Count of dynamic `import(...)` expressions. */
  readonly dynamicImports: number;
  /** String-literal arguments to `document.getElementById("…")`. */
  readonly getElementByIds: readonly string[];
};

const NETWORK_CTORS = new Set(["XMLHttpRequest", "WebSocket", "EventSource"]);

/** Statically evaluate a literal AST node; `{ known: false }` for anything else. */
function evalStatic(node: EsNode | null): { known: boolean; value: unknown } {
  if (!node) return { known: false, value: undefined };
  switch (node.type) {
    case "Literal":
      return { known: true, value: node["value"] };
    case "Identifier":
      return node["name"] === "undefined"
        ? { known: true, value: undefined }
        : { known: false, value: undefined };
    case "TemplateLiteral": {
      const exprs = node["expressions"];
      const quasis = node["quasis"];
      if (Array.isArray(exprs) && exprs.length === 0 && Array.isArray(quasis)) {
        const cooked = quasis
          .map((q) => {
            const val = asNode(q)?.["value"];
            return val !== null && typeof val === "object"
              ? ((val as Record<string, unknown>)["cooked"] ?? "")
              : "";
          })
          .join("");
        return { known: true, value: cooked };
      }
      return { known: false, value: undefined };
    }
    case "UnaryExpression": {
      const arg = evalStatic(asNode(node["argument"]));
      if (!arg.known || typeof arg.value !== "number") return { known: false, value: undefined };
      if (node["operator"] === "-") return { known: true, value: -arg.value };
      if (node["operator"] === "+") return { known: true, value: arg.value };
      return { known: false, value: undefined };
    }
    case "ArrayExpression": {
      const elements = node["elements"];
      if (!Array.isArray(elements)) return { known: false, value: undefined };
      const out: unknown[] = [];
      for (const el of elements) {
        const ev = evalStatic(asNode(el));
        if (!ev.known) return { known: false, value: undefined };
        out.push(ev.value);
      }
      return { known: true, value: out };
    }
    case "ObjectExpression": {
      const props = node["properties"];
      if (!Array.isArray(props)) return { known: false, value: undefined };
      const out: Record<string, unknown> = {};
      for (const p of props) {
        const prop = asNode(p);
        if (!prop || prop.type !== "Property" || prop["computed"] === true) {
          return { known: false, value: undefined };
        }
        const keyNode = asNode(prop["key"]);
        let key: string;
        if (keyNode?.type === "Identifier") key = String(keyNode["name"]);
        else if (keyNode?.type === "Literal") key = String(keyNode["value"]);
        else return { known: false, value: undefined };
        const ev = evalStatic(asNode(prop["value"]));
        if (!ev.known) return { known: false, value: undefined };
        out[key] = ev.value;
      }
      return { known: true, value: out };
    }
    default:
      return { known: false, value: undefined };
  }
}

function nonEmptyLiteral(known: boolean, value: unknown): boolean {
  // Non-literal RHS: the global is assigned, emptiness unknown → treat as set.
  if (!known) return true;
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** `window.<name>` (or `window["name"]`) member target, else null. */
function windowMemberName(node: EsNode | null): string | null {
  if (!node || node.type !== "MemberExpression") return null;
  const obj = asNode(node["object"]);
  if (obj?.type !== "Identifier" || obj["name"] !== "window") return null;
  const prop = asNode(node["property"]);
  if (node["computed"] === true) {
    return prop?.type === "Literal" && typeof prop["value"] === "string" ? prop["value"] : null;
  }
  return prop?.type === "Identifier" ? String(prop["name"]) : null;
}

/** `document.getElementById` / bare `getElementById` callee, else identifier calls. */
function calleeName(node: EsNode | null): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return String(node["name"]);
  if (node.type === "MemberExpression" && node["computed"] !== true) {
    const prop = asNode(node["property"]);
    return prop?.type === "Identifier" ? String(prop["name"]) : null;
  }
  return null;
}

/**
 * Parse JS to an AST and read off exactly what the gates need — never executing
 * it. Parsed as a classic script (the review-site contract loads `.js` via
 * `<script src>`, not modules); a static `import`/`export` therefore surfaces
 * as a syntax error, which G4 reports.
 */
export function analyzeJs(source: string): JsAnalysis {
  let program: EsNode;
  try {
    program = acornParse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
    }) as unknown as EsNode;
  } catch (err) {
    return {
      syntaxError: err instanceof Error ? err.message : String(err),
      windowGlobals: [],
      fetchCalls: [],
      networkSinks: [],
      dynamicImports: 0,
      getElementByIds: [],
    };
  }

  const windowGlobals: WindowGlobal[] = [];
  const fetchCalls: FetchCall[] = [];
  const networkSinks: string[] = [];
  const getElementByIds: string[] = [];
  let dynamicImports = 0;

  walkFull(program as never, (raw) => {
    const node = asNode(raw);
    if (!node) return;

    if (node.type === "AssignmentExpression" && node["operator"] === "=") {
      const name = windowMemberName(asNode(node["left"]));
      if (name !== null) {
        const { known, value } = evalStatic(asNode(node["right"]));
        windowGlobals.push({ name, nonEmpty: nonEmptyLiteral(known, value), value });
      }
      return;
    }

    if (node.type === "ImportExpression") {
      dynamicImports++;
      return;
    }

    if (node.type === "NewExpression" || node.type === "CallExpression") {
      const name = calleeName(asNode(node["callee"]));
      if (name === "fetch") {
        const args = node["arguments"];
        const first = Array.isArray(args) ? asNode(args[0]) : null;
        const ev = evalStatic(first);
        fetchCalls.push({ url: ev.known && typeof ev.value === "string" ? ev.value : null });
      } else if (name !== null && NETWORK_CTORS.has(name)) {
        if (!networkSinks.includes(name)) networkSinks.push(name);
      } else if (name === "getElementById") {
        const args = node["arguments"];
        const first = Array.isArray(args) ? asNode(args[0]) : null;
        const ev = evalStatic(first);
        if (ev.known && typeof ev.value === "string") getElementByIds.push(ev.value);
      }
    }
  });

  return {
    syntaxError: null,
    windowGlobals,
    fetchCalls,
    networkSinks,
    dynamicImports,
    getElementByIds,
  };
}
