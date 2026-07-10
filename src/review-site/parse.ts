import { parse as acornParse } from "acorn";
import { full as walkFull } from "acorn-walk";
import { parse as parse5, defaultTreeAdapter } from "parse5";

/**
 * Static parsing utilities for the review-site linter (`check.ts`).
 *
 * SECURITY INVARIANT: producer-authored review-site code is NEVER executed.
 * The worker writes `index.html` (with inline `<script>`/`<style>` blocks); the
 * gate reviewer runs the linter in ITS OWN process, so any `node:vm`/`eval` of
 * that code is arbitrary code execution inside the reviewer (it can read the
 * reviewer's env / API keys and DoS the run). Everything here is a pure STATIC
 * parse: HTML is parsed to a DOM tree with `parse5` (spec-compliant — entity
 * decoding, comment/rawtext termination, and URL-bearing attributes are handled
 * as the browser would), JS is parsed to an AST with `acorn`, and values are
 * read off literal nodes only. No producer expression is evaluated.
 */

// --- HTML -------------------------------------------------------------------

export type HtmlElement = {
  readonly tag: string;
  /** Lowercased attribute name → decoded value ("" for boolean attributes). */
  readonly attrs: ReadonlyMap<string, string>;
  /** Raw text content for rawtext elements (`<script>`, `<style>`). */
  readonly rawText?: string;
};

/** Elements whose single text child is their raw content (not markup). */
const RAWTEXT = new Set(["script", "style", "textarea", "title"]);

/**
 * Parse HTML into a flat list of its elements (tag + decoded attributes) and
 * the raw text of `<script>`/`<style>` blocks, in document order. Backed by
 * `parse5`, so the linter sees exactly what the browser's parser would: entity
 * references in attribute values are decoded (`&#x68;ttps://` → `https://`),
 * `--!>`/`</style bar>` terminate the constructs they should, and URL-bearing
 * attributes on any element are visible. Nesting is flattened — the gates care
 * about which elements exist and their attributes, not the tree shape.
 */
export function parseHtml(html: string): readonly HtmlElement[] {
  const doc = parse5(html);
  const elements: HtmlElement[] = [];

  const visit = (node: unknown): void => {
    if (!defaultTreeAdapter.isElementNode(node as never)) {
      const children = (node as { childNodes?: unknown[] }).childNodes;
      if (Array.isArray(children)) for (const child of children) visit(child);
      return;
    }
    const el = node as {
      tagName: string;
      attrs: { name: string; value: string }[];
      childNodes: { nodeName: string; value?: string }[];
    };
    const tag = el.tagName.toLowerCase();
    const attrs = new Map<string, string>();
    for (const a of el.attrs) {
      const name = a.name.toLowerCase();
      if (!attrs.has(name)) attrs.set(name, a.value);
    }
    if (RAWTEXT.has(tag)) {
      const text = el.childNodes.find((c) => c.nodeName === "#text")?.value ?? "";
      elements.push({ tag, attrs, rawText: text });
    } else {
      elements.push({ tag, attrs });
    }
    for (const child of el.childNodes) visit(child);
  };

  visit(doc);
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
  /** Data-exfil/loading sinks: XMLHttpRequest / WebSocket / EventSource /
   * navigator.sendBeacon. */
  readonly networkSinks: readonly string[];
  /** Navigation sinks (F1): assignment to `window.location`/`location.href`,
   * `location.assign`/`.replace`, `window.open` — CSP `connect-src` does NOT
   * block navigation, so ONLY the linter catches this exfil channel. */
  readonly navigationSinks: readonly string[];
  /** Dynamic code-exec sinks: `eval`, `new Function`, `setTimeout`/`setInterval`
   * with a string body (live if `'unsafe-eval'` is ever added for Plotly). */
  readonly execSinks: readonly string[];
  /** Count of dynamic `import(...)` expressions. */
  readonly dynamicImports: number;
  /** String-literal arguments to `document.getElementById("…")`. */
  readonly getElementByIds: readonly string[];
};

const NETWORK_CTORS = new Set(["XMLHttpRequest", "WebSocket", "EventSource"]);
/** Identifiers that resolve to the global (window) object. */
const WINDOW_ALIASES = new Set(["window", "self", "top", "parent", "globalThis", "frames"]);

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

/**
 * Flatten a member/identifier chain to a dotted path (`window.location.href`),
 * resolving computed members with a string-literal property (`window["fetch"]`
 * → `window.fetch`) so aliased/computed sinks can't hide from a name match.
 * Returns null if any segment is dynamic (a computed non-literal, a call, etc.).
 */
function memberPath(node: EsNode | null): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return String(node["name"]);
  if (node.type !== "MemberExpression") return null;
  const objPath = memberPath(asNode(node["object"]));
  if (objPath === null) return null;
  const prop = asNode(node["property"]);
  let key: string | null;
  if (node["computed"] === true) {
    key = prop?.type === "Literal" && typeof prop["value"] === "string" ? prop["value"] : null;
  } else {
    key = prop?.type === "Identifier" ? String(prop["name"]) : null;
  }
  return key === null ? null : `${objPath}.${key}`;
}

/** A window-alias base is `undefined` (bare) or a known window alias. */
function baseIsGlobal(base: string | undefined): boolean {
  return base === undefined || WINDOW_ALIASES.has(base) || base === "document";
}

/** Does assigning to this path navigate the frame (`window.location` / `.href`)? */
function isNavigationTarget(path: string): boolean {
  const segs = path.split(".");
  const last = segs[segs.length - 1];
  if (last === "location") return baseIsGlobal(segs[segs.length - 2]);
  if (last === "href" && segs[segs.length - 2] === "location") {
    return baseIsGlobal(segs[segs.length - 3]);
  }
  return false;
}

/**
 * Parse JS to an AST and read off exactly what the gates need — never executing
 * it. Parsed as a classic script (the review-site contract inlines `.js` in
 * `<script>` blocks, not modules); a static `import`/`export` therefore
 * surfaces as a syntax error, which G4 reports.
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
      navigationSinks: [],
      execSinks: [],
      dynamicImports: 0,
      getElementByIds: [],
    };
  }

  const windowGlobals: WindowGlobal[] = [];
  const fetchCalls: FetchCall[] = [];
  const networkSinks: string[] = [];
  const navigationSinks: string[] = [];
  const execSinks: string[] = [];
  const getElementByIds: string[] = [];
  let dynamicImports = 0;

  const addSink = (list: string[], value: string): void => {
    if (!list.includes(value)) list.push(value);
  };
  const firstArgIsString = (node: EsNode): boolean => {
    const args = node["arguments"];
    const first = Array.isArray(args) ? asNode(args[0]) : null;
    const ev = evalStatic(first);
    return ev.known && typeof ev.value === "string";
  };

  walkFull(program as never, (raw) => {
    const node = asNode(raw);
    if (!node) return;

    if (node.type === "AssignmentExpression" && node["operator"] === "=") {
      const left = asNode(node["left"]);
      const name = windowMemberName(left);
      if (name !== null) {
        const { known, value } = evalStatic(asNode(node["right"]));
        windowGlobals.push({ name, nonEmpty: nonEmptyLiteral(known, value), value });
      }
      const path = memberPath(left);
      if (path !== null && isNavigationTarget(path)) addSink(navigationSinks, `${path} = …`);
      return;
    }

    if (node.type === "ImportExpression") {
      dynamicImports++;
      return;
    }

    if (node.type === "NewExpression" || node.type === "CallExpression") {
      const callee = asNode(node["callee"]);
      const path = memberPath(callee);
      const segs = path === null ? [] : path.split(".");
      const last = segs[segs.length - 1] ?? "";
      const base = segs[segs.length - 2];

      // Runtime code-exec constructor: new Function(...) / Function(...).
      if (last === "Function" && baseIsGlobal(base)) {
        addSink(execSinks, "Function(…)");
        return;
      }
      if (node.type === "NewExpression") {
        if (last !== "" && NETWORK_CTORS.has(last)) addSink(networkSinks, last);
        return;
      }

      // CallExpression from here.
      if (last === "fetch" && baseIsGlobal(base)) {
        const args = node["arguments"];
        const first = Array.isArray(args) ? asNode(args[0]) : null;
        const ev = evalStatic(first);
        fetchCalls.push({ url: ev.known && typeof ev.value === "string" ? ev.value : null });
      } else if (last === "sendBeacon") {
        addSink(networkSinks, "navigator.sendBeacon");
      } else if ((last === "assign" || last === "replace") && base === "location") {
        addSink(navigationSinks, `${path}(…)`);
      } else if (last === "open" && baseIsGlobal(base)) {
        addSink(navigationSinks, "window.open(…)");
      } else if (last === "eval" && baseIsGlobal(base)) {
        addSink(execSinks, "eval(…)");
      } else if ((last === "setTimeout" || last === "setInterval") && firstArgIsString(node)) {
        addSink(execSinks, `${last}("<string body>")`);
      } else if (last === "getElementById") {
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
    navigationSinks,
    execSinks,
    dynamicImports,
    getElementByIds,
  };
}
