import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  analyzeJs,
  extractCssUrls,
  parseHtml,
  type HtmlElement,
  type JsAnalysis,
} from "./parse.js";
import { cspConfirmsNoConnect } from "./csp.js";

/**
 * `check_review_site` — the deterministic review-site linter (design
 * review-template.md §2, gates G1-G9).
 *
 * It depends ONLY on the review-site CONTRACT (§1, invariants I1-I7): a single
 * inlined entry point, self-contained (no external subresources), `.js`-global
 * run data, and a manifest that names the run the site was built from and the
 * `verdict_schema` the trusted shell will emit under (G7). The site itself
 * exports NOTHING — a self-download/export sink is a G5 hard-fail (F2/F3);
 * export lives in the shell. It knows nothing about 3D / Plotly, so
 * it gates any protocol's review site identically.
 *
 * THE BOUNDARY IS NOT THE LINTER ALONE (read this — it is NOT redundant with the CSP).
 * The site is served into an opaque-origin sandboxed iframe under a strict CSP
 * (Lane A, `reviewSiteCsp()`). Because that sandbox refuses every external
 * subresource, the site ships as ONE inlined `index.html` and the CSP must
 * carry `script-src 'unsafe-inline'` for it to render at all (R4). That has a
 * cost the CSP/sandbox alone cannot pay:
 *   - `'unsafe-inline'` permits inline event handlers (`onerror=`) and inline
 *     scripts, so the CSP no longer blocks inline-handler exfil; and
 *   - `connect-src 'none'` blocks fetch/XHR/beacon but NOT navigation
 *     (`window.location = evil`; there is no `navigate-to` directive).
 * So the enforcing boundary is THREE cooperating parts, not the linter alone:
 *   1. the opaque-origin sandbox + CSP — external subresource loads and network
 *      connections (`connect-src 'none'`: fetch/XHR/beacon/WebSocket);
 *   2. THIS linter — the DIRECT navigation (G5) and inline-handler (G5) forms
 *      the CSP structurally cannot block under `script-src 'unsafe-inline'`; and
 *   3. the trusted-but-verified producer — the worker authors the site under
 *      review, and the gate reviewer re-checks it.
 * The linter's JS exfil detection (G5) is explicitly BEST-EFFORT, not a proof:
 * it closes the DIRECT literal forms of the known exfil classes statically,
 * before serve — separate-file subresources (blank in the sandbox), external
 * origins, runtime data loading, navigation sinks, inline handlers,
 * arbitrary-exec sources — but a static pass cannot enumerate every obfuscation
 * (aliasing, computed non-literal dispatch, F7). A determined producer with
 * `'unsafe-inline'` can still author JS a static pass cannot fully reason about;
 * that residual is why the sandbox/CSP and the trusted producer carry the rest.
 *
 * SECURITY: producer code is parsed, NEVER executed. All markup/JS analysis is
 * a static parse (see `parse.ts`) — the reviewer runs this in its own process,
 * so executing the site's JS here would be arbitrary code execution inside the
 * reviewer. Pure over its inputs (a folder on disk + the phase's
 * `cdn_allowlist` + the run's measurements); returns a findings report, never
 * throws on a contract violation (only on genuinely unreadable input).
 */

export type GateId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8" | "G9";

export type Finding = {
  readonly gate: GateId;
  readonly ok: boolean;
  /** One line per problem; empty on a clean gate. */
  readonly detail: string;
  /** Non-blocking notes that do NOT set `ok=false` — the `connect-src`-owned
   * network sinks the served CSP is confirmed to block (G5/F5). Present only
   * when a gate distinguishes warnings from hard-fails. */
  readonly warnings?: string;
};

export type ReviewSiteReport = {
  readonly ok: boolean;
  readonly siteDir: string;
  /** Whether G8 could authoritatively verify the site against the run. */
  readonly fidelity: "verified" | "unverified";
  readonly findings: readonly Finding[];
};

export type CheckReviewSiteOptions = {
  /** Absolute path to the review-site folder (contains `index.html`). */
  readonly siteDir: string;
  /** External origins the phase permits (protocol.yaml `cdn_allowlist`, G6). */
  readonly cdnAllowlist: readonly string[];
  /**
   * Absolute path to the run's measurement file for the G8 hash check. When
   * omitted, the harness gate instead supplies `measurementsRoot` and the
   * linter resolves the manifest's declared `produced_from` path under it.
   */
  readonly resultsPath?: string;
  /**
   * Absolute root the manifest's `produced_from.measurement` path resolves
   * against (the harness passes `<taskDir>/artifacts`). Lets G8 hash the real
   * on-disk measurement the site names, with a traversal guard.
   */
  readonly measurementsRoot?: string;
  /**
   * Harness-known run id. The manifest `sample_id` MUST equal it (H1b) — this
   * is the authoritative anti-swap check, since a toy measurement file carries
   * no `sample_id` of its own.
   */
  readonly expectedSampleId?: string;
  /**
   * When true (the harness gate sets it), fidelity MUST be verifiable: a
   * missing/unreadable measurement FAILS G8 rather than degrading to a
   * structural-only pass (H1). The standalone Lane 0 fixture leaves it false.
   */
  readonly requireFidelity?: boolean;
  /**
   * The EFFECTIVE served CSP (F4) — the exact policy the dashboard route will
   * emit for this site, built by the canonical `buildReviewSiteCsp`. G5 uses it
   * to decide the F5 downgrade: a `connect-src`-owned network sink is a warning
   * (not a hard-fail) ONLY when this policy is confirmed exactly
   * `connect-src 'none'` (`cspConfirmsNoConnect`). Missing/malformed/weaker →
   * FAIL CLOSED: the network sinks stay hard-fails. The harness gate always
   * supplies it; the standalone CLI/fixture omits it (network sinks hard-fail).
   */
  readonly contentSecurityPolicy?: string;
};

const HEX64 = /^[0-9a-f]{64}$/;

type HtmlFile = {
  readonly relPath: string;
  readonly absPath: string;
  readonly elements: readonly HtmlElement[];
  readonly ids: ReadonlySet<string>;
  readonly refs: readonly HtmlRef[];
  /** Inline `<script>` (no `src`) bodies, statically analysed. */
  readonly inlineScripts: readonly JsAnalysis[];
  /** Relative `.js` `<script src>` targets, for G4 id resolution. */
  readonly scriptSrcRefs: readonly string[];
};

type JsFile = {
  readonly relPath: string;
  readonly absPath: string;
  readonly analysis: JsAnalysis;
};

/** A statically-analysed JS unit (an inline block or a `.js` file) + its label. */
type JsSource = { readonly label: string; readonly analysis: JsAnalysis };

/** Where a URL reference appears — governs which schemes are legal (G2). */
type RefContext = "exec" | "resource" | "css" | "nav";
type HtmlRef = { readonly value: string; readonly context: RefContext };

/** `src` on these loads executable/framed content; a `data:`/`blob:` there is code. */
const EXEC_SRC_TAGS = new Set(["script", "iframe", "embed", "frame"]);

async function existsAt(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root: string, ext: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(ext)) continue;
    const abs = join(root, name);
    const info = await stat(abs).catch(() => undefined);
    if (info?.isFile()) out.push(abs);
  }
  return out.sort();
}

/** The `url=` target of a `<meta http-equiv=refresh>` (`""` for a self-refresh). */
function metaRefreshUrl(el: HtmlElement): string | null {
  if (el.tag !== "meta") return null;
  const equiv = el.attrs.get("http-equiv");
  if (equiv === undefined || equiv.trim().toLowerCase() !== "refresh") return null;
  const content = el.attrs.get("content") ?? "";
  const m = /;\s*url\s*=\s*(.+)$/i.exec(content);
  return m ? (m[1] ?? "").trim().replace(/^['"]|['"]$/g, "") : "";
}

/** First URL of each candidate in a `srcset` (`"a.png 1x, b.png 2x"`). */
function parseSrcset(srcset: string): string[] {
  return srcset
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter((u) => u.length > 0);
}

/** Every URL-bearing reference on a page (attributes + CSS), with its context. */
function collectRefs(elements: readonly HtmlElement[]): HtmlRef[] {
  const refs: HtmlRef[] = [];
  const push = (value: string, context: RefContext): void => {
    refs.push({ value: value.trim(), context });
  };
  for (const el of elements) {
    const src = el.attrs.get("src");
    if (src !== undefined) push(src, EXEC_SRC_TAGS.has(el.tag) ? "exec" : "resource");
    if (el.tag === "object") {
      const data = el.attrs.get("data");
      if (data !== undefined) push(data, "exec"); // <object data> embeds executable content
    }
    const href = el.attrs.get("href");
    if (href !== undefined) {
      const nav = el.tag === "a" || el.tag === "area" || el.tag === "base";
      push(href, nav ? "nav" : "exec");
    }
    const srcset = el.attrs.get("srcset");
    if (srcset !== undefined) for (const u of parseSrcset(srcset)) push(u, "resource");
    const poster = el.attrs.get("poster");
    if (poster !== undefined) push(poster, "resource");
    const ping = el.attrs.get("ping");
    if (ping !== undefined) for (const u of ping.trim().split(/\s+/)) if (u) push(u, "nav");
    const formaction = el.attrs.get("formaction");
    if (formaction !== undefined) push(formaction, "nav");
    if (el.tag === "form") {
      const action = el.attrs.get("action");
      if (action !== undefined) push(action, "nav");
    }
    const metaUrl = metaRefreshUrl(el);
    if (metaUrl !== null && metaUrl.length > 0) push(metaUrl, "nav");
    const style = el.attrs.get("style");
    if (style !== undefined) for (const u of extractCssUrls(style)) push(u, "css");
    if (el.tag === "style" && el.rawText) for (const u of extractCssUrls(el.rawText)) push(u, "css");
  }
  return refs;
}

type RefKind =
  | "fragment"
  | "data"
  | "blob"
  | "external"
  | "file-scheme"
  | "script-scheme"
  | "benign-scheme"
  | "opaque-scheme"
  | "absolute"
  | "parent-traversal"
  | "relative";

function classifyRef(value: string): RefKind {
  if (value === "" || value.startsWith("#")) return "fragment";
  if (/^data:/i.test(value)) return "data";
  if (/^blob:/i.test(value)) return "blob";
  if (/^https?:\/\//i.test(value)) return "external";
  if (/^file:\/\//i.test(value)) return "file-scheme";
  if (/^(?:javascript|vbscript):/i.test(value)) return "script-scheme";
  if (/^(?:mailto|tel|sms):/i.test(value)) return "benign-scheme";
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return "opaque-scheme";
  if (value.startsWith("/")) return "absolute";
  if (value.split(/[/\\]/).includes("..")) return "parent-traversal";
  return "relative";
}

/** Resolve a relative ref against the page that declared it; must stay inside `siteDir`. */
function resolvesInside(siteDir: string, pageAbs: string, ref: string): string | null {
  const noQuery = ref.split(/[?#]/)[0] ?? ref;
  const abs = resolve(dirname(pageAbs), noQuery);
  const rel = relative(siteDir, abs);
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || resolve(siteDir, rel) !== abs) {
    return null;
  }
  return abs;
}

function finding(gate: GateId, problems: readonly string[]): Finding {
  return { gate, ok: problems.length === 0, detail: problems.join("; ") };
}

// --- G1: entry resolves -----------------------------------------------------
async function checkG1(siteDir: string): Promise<Finding> {
  const indexPath = join(siteDir, "index.html");
  if (!(await existsAt(indexPath))) {
    return finding("G1", [`index.html missing at ${siteDir}`]);
  }
  const info = await stat(indexPath);
  if (info.size === 0) return finding("G1", ["index.html is empty"]);
  return finding("G1", []);
}

// --- G2: self-contained single document (inlined; no exec/external source) ---
async function checkG2(siteDir: string, htmls: readonly HtmlFile[]): Promise<Finding> {
  const problems: string[] = [];
  for (const page of htmls) {
    // Single-document delta (R4): any separate-file subresource silently blanks
    // in the opaque-origin sandbox — inline it into index.html instead.
    for (const el of page.elements) {
      if (el.tag === "script" && el.attrs.get("src") !== undefined) {
        problems.push(
          `${page.relPath}: <script src="${el.attrs.get("src")}"> loads a separate file — the site must be a single inlined index.html (an opaque-origin sandbox refuses external subresources)`,
        );
      }
      if (el.tag === "link" && el.attrs.get("href") !== undefined) {
        problems.push(
          `${page.relPath}: <link href="${el.attrs.get("href")}"> loads a separate subresource — inline it into index.html (an opaque-origin sandbox refuses external subresources)`,
        );
      }
    }
    for (const { value: ref, context } of page.refs) {
      const kind = classifyRef(ref);
      switch (kind) {
        case "fragment":
        case "benign-scheme":
        case "external": // G6 owns external-origin policy.
          break;
        case "absolute":
          problems.push(`${page.relPath}: absolute path "${ref}"`);
          break;
        case "parent-traversal":
          problems.push(`${page.relPath}: "${ref}" escapes the folder ("..")`);
          break;
        case "file-scheme":
          problems.push(`${page.relPath}: file:// ref "${ref}"`);
          break;
        case "script-scheme":
          problems.push(`${page.relPath}: script-URL ref "${ref}" (arbitrary code source)`);
          break;
        case "opaque-scheme":
          problems.push(`${page.relPath}: non-relative ref "${ref}" resolves to no in-folder file`);
          break;
        case "data":
        case "blob":
          // Inline data on an <img> etc. is self-contained; on a script/link/
          // iframe/object or in CSS it is an arbitrary exec/style source.
          if (context === "exec" || context === "css") {
            problems.push(`${page.relPath}: ${kind}: ref in a ${context} position (arbitrary exec/style source)`);
          }
          break;
        case "relative": {
          const abs = resolvesInside(siteDir, page.absPath, ref);
          if (abs === null) {
            problems.push(`${page.relPath}: relative ref "${ref}" does not resolve inside the folder`);
          } else if (!(await existsAt(abs))) {
            problems.push(`${page.relPath}: relative ref "${ref}" points to a missing file (${relative(siteDir, abs)})`);
          }
          break;
        }
      }
    }
  }
  return finding("G2", problems);
}

// --- G3: data globals present (statically, from inline <script>) ------------
type ManifestInfo = {
  readonly sampleId: unknown;
  readonly producedFrom: unknown;
  readonly verdictSchema: unknown;
  readonly dataGlobals: readonly string[];
  readonly dataSources: unknown;
  /** G9 (spatial reviews): absent on single-pane manifests → G9 is N/A. */
  readonly reviewLayout: unknown;
  readonly requiredViews: readonly string[];
  readonly linkedViews: unknown;
};

/**
 * The path portions the manifest's `produced_from` entries hash
 * (`"<path>@<sha256>"` → `"<path>"`) — the same path-portion lookup the server
 * performs at splice time and G8 hash-verifies. Shared by G3 (every
 * `data_sources` artifact must be hashed) and G9 (the slice-data artifact
 * specifically); hash FORMAT and file-hash verification stay G8's job.
 */
function producedFromPaths(pf: unknown): ReadonlySet<string> {
  const paths = new Set<string>();
  if (pf !== null && typeof pf === "object") {
    for (const ref of Object.values(pf as Record<string, unknown>)) {
      if (typeof ref !== "string") continue;
      const at = ref.lastIndexOf("@");
      if (at !== -1) paths.add(ref.slice(0, at));
    }
  }
  return paths;
}

/** A `window.<NAME> = "__REVIEW_INJECT:<NAME>__"` serve-time placeholder value. */
const INJECT_SENTINEL = /^__REVIEW_INJECT:(.+)__$/;

function checkG3(jsSources: readonly JsSource[]): {
  readonly finding: Finding;
  readonly manifest: ManifestInfo | null;
  /** Statically-parsed `window.*` literal values (G9 reads the slice-data one). */
  readonly globalValues: ReadonlyMap<string, unknown>;
} {
  const problems: string[] = [];

  // Aggregate every window.* global assigned across all inline <script> blocks
  // (and any stray .js file), read statically — never executed.
  const globals = new Map<string, boolean>(); // name -> non-empty
  const globalValues = new Map<string, unknown>();
  for (const { label, analysis } of jsSources) {
    if (analysis.syntaxError) {
      problems.push(`${label}: could not parse (${analysis.syntaxError})`);
      continue;
    }
    for (const g of analysis.windowGlobals) {
      globals.set(g.name, (globals.get(g.name) ?? false) || g.nonEmpty);
      if (g.value !== undefined) globalValues.set(g.name, g.value);
    }
  }

  const manifestValue = globalValues.get("REVIEW_MANIFEST");
  if (!globals.get("REVIEW_MANIFEST")) {
    return {
      finding: finding("G3", [...problems, "no inline <script> assigns window.REVIEW_MANIFEST"]),
      manifest: null,
      globalValues,
    };
  }
  if (manifestValue === undefined || typeof manifestValue !== "object" || manifestValue === null) {
    // Assigned but not a static object literal — the contract requires a
    // literal manifest the gate can read (I3/G8).
    return {
      finding: finding("G3", [...problems, "window.REVIEW_MANIFEST is not a static object literal"]),
      manifest: null,
      globalValues,
    };
  }

  const mf = manifestValue as Record<string, unknown>;
  const declared = Array.isArray(mf["data_globals"])
    ? mf["data_globals"].filter((x): x is string => typeof x === "string")
    : [];
  for (const name of declared) {
    if (!globals.get(name)) {
      problems.push(`declared data global window.${name} is missing or empty`);
    }
  }

  // Serve-time injection hardening (review-data-injection.md): when the manifest
  // declares data_sources, the template's placeholders and the manifest's
  // sources must agree, else the server would splice into a document the linter
  // never validated as consistent. Additive — a fully-inlined manifest (no
  // data_sources) skips this entirely and G3 is unchanged.
  const ds = mf["data_sources"];
  const dataSourceGlobals =
    ds !== null && typeof ds === "object"
      ? Object.keys(ds as Record<string, unknown>)
      : [];
  if (ds !== null && typeof ds === "object") {
    const declaredSet = new Set(declared);
    for (const key of dataSourceGlobals) {
      if (!declaredSet.has(key)) {
        problems.push(`data_sources.${key} is not listed in data_globals`);
      }
    }
    // Every placeholder-assigned global (static sentinel value) must be declared
    // as a source, or the server has no artifact to fill it with.
    const sourceSet = new Set(dataSourceGlobals);
    for (const [name, value] of globalValues) {
      if (typeof value === "string" && INJECT_SENTINEL.test(value) && !sourceSet.has(name)) {
        problems.push(`window.${name} is an injection placeholder with no data_sources entry`);
      }
    }
    // Every source's artifact path must carry a produced_from hash — the same
    // path-portion lookup the server performs at splice time. Catching the
    // mismatch here means the template fails the GATE, not the serve.
    const hashedPaths = producedFromPaths(mf["produced_from"]);
    for (const [key, raw] of Object.entries(ds as Record<string, unknown>)) {
      const artifact =
        raw !== null && typeof raw === "object"
          ? (raw as Record<string, unknown>)["artifact"]
          : undefined;
      if (typeof artifact === "string" && artifact.length > 0 && !hashedPaths.has(artifact)) {
        problems.push(
          `data_sources.${key} artifact "${artifact}" has no matching produced_from entry (the server cannot verify its hash)`,
        );
      }
    }
  }

  const manifest: ManifestInfo = {
    sampleId: mf["sample_id"],
    producedFrom: mf["produced_from"],
    verdictSchema: mf["verdict_schema"],
    dataGlobals: declared,
    dataSources: ds,
    reviewLayout: mf["review_layout"],
    requiredViews: Array.isArray(mf["required_views"])
      ? mf["required_views"].filter((x): x is string => typeof x === "string")
      : [],
    linkedViews: mf["linked_views"],
  };
  return { finding: finding("G3", problems), manifest, globalValues };
}

// --- G4: JS statically valid + referenced element IDs exist ----------------
function checkG4(htmls: readonly HtmlFile[], allJs: readonly JsFile[]): Finding {
  const problems: string[] = [];
  const byAbs = new Map(allJs.map((j) => [j.absPath, j] as const));
  for (const f of allJs) {
    if (f.analysis.syntaxError) {
      problems.push(`${f.relPath}: invalid JS (${f.analysis.syntaxError})`);
    }
  }
  for (const page of htmls) {
    const analyses: JsAnalysis[] = [...page.inlineScripts];
    page.inlineScripts.forEach((a, idx) => {
      if (a.syntaxError) problems.push(`${page.relPath}: inline <script> #${idx + 1} invalid JS (${a.syntaxError})`);
    });
    for (const ref of page.scriptSrcRefs) {
      const abs = resolve(dirname(page.absPath), ref.split(/[?#]/)[0] ?? ref);
      const match = byAbs.get(abs);
      if (match) analyses.push(match.analysis);
    }
    for (const a of analyses) {
      for (const id of a.getElementByIds) {
        if (!page.ids.has(id)) {
          problems.push(`${page.relPath}: getElementById("${id}") has no matching element id in the page`);
        }
      }
    }
  }
  return finding("G4", problems);
}

// --- G5: no exfil beyond the contract ---------------------------------------
// The layer the CSP/sandbox CANNOT cover (see header). Two severities (F5):
//   - HARD-FAIL: navigation (F1), downloads/self-export + image + WebRTC sinks
//     (F3), inline event handlers + <meta refresh> (F5/F6), dynamic code-exec.
//     None of these is owned by `connect-src`.
//   - WARNING ONLY: the `connect-src`-owned network class — fetch / XHR /
//     sendBeacon / WebSocket / EventSource — but ONLY when the effective served
//     CSP is confirmed exactly `connect-src 'none'` (F4/`cspConfirmsNoConnect`).
//     Missing/malformed/weaker policy → FAIL CLOSED (these become hard-fails).
function checkG5(
  jsSources: readonly JsSource[],
  htmls: readonly HtmlFile[],
  opts: CheckReviewSiteOptions,
): Finding {
  const problems: string[] = [];
  const warnings: string[] = [];
  // The `connect-src`-owned class is downgraded to a warning only under a
  // confirmed exact `connect-src 'none'`; otherwise it stays a hard-fail.
  const connectSrcBlocked = cspConfirmsNoConnect(opts.contentSecurityPolicy);

  for (const { label, analysis } of jsSources) {
    // connect-src-owned network sinks (fetch + XHR/WebSocket/EventSource/beacon).
    const networkHits: string[] = [];
    for (const call of analysis.fetchCalls) {
      const shown = call.url === null ? "fetch(<dynamic>)" : `fetch("${call.url}")`;
      networkHits.push(`${label}: ${shown} — the site must ship data as .js globals, never fetch at runtime (I3)`);
    }
    for (const sink of analysis.networkSinks) {
      networkHits.push(`${label}: uses ${sink} (I3: no runtime data loading/exfil)`);
    }
    for (const hit of networkHits) {
      if (connectSrcBlocked) {
        warnings.push(`${hit} [warning: neutralized by served connect-src 'none']`);
      } else {
        problems.push(`${hit} — and the served CSP does not confirm connect-src 'none' (fail-closed, F4)`);
      }
    }

    // Everything below is a hard-fail regardless of the CSP.
    for (const sink of analysis.navigationSinks) {
      problems.push(`${label}: navigation sink ${sink} — navigation is an exfil channel the CSP cannot block (F1)`);
    }
    for (const sink of analysis.downloadSinks) {
      problems.push(`${label}: download/self-export sink ${sink} — the review site must never download; the trusted shell owns export (F2/F3)`);
    }
    for (const sink of analysis.imageSinks) {
      problems.push(`${label}: dynamic image sink ${sink} — an image src is a GET governed by img-src, not connect-src (F3)`);
    }
    for (const sink of analysis.webrtcSinks) {
      problems.push(`${label}: WebRTC sink ${sink} — a data channel connect-src does not own (F3; also webrtc 'block')`);
    }
    for (const sink of analysis.execSinks) {
      problems.push(`${label}: dynamic code-exec ${sink} — the contract needs no runtime eval`);
    }
    if (analysis.dynamicImports > 0) {
      problems.push(`${label}: dynamic import() loads code at runtime (I3: inline via <script> only)`);
    }
  }
  // HTML-level exec/nav surfaces that 'unsafe-inline' now permits.
  for (const page of htmls) {
    for (const el of page.elements) {
      for (const attr of el.attrs.keys()) {
        if (/^on[a-z]+$/.test(attr)) {
          problems.push(`${page.relPath}: inline <${el.tag} ${attr}=…> event handler — arbitrary JS that 'unsafe-inline' executes; the contract needs none (F5)`);
        }
      }
      const metaUrl = metaRefreshUrl(el);
      if (metaUrl !== null) {
        problems.push(`${page.relPath}: <meta http-equiv=refresh${metaUrl ? ` url=${metaUrl}` : ""}> auto-navigates — an exfil channel the CSP cannot block (F6)`);
      }
    }
  }
  const base = finding("G5", problems);
  return warnings.length > 0 ? { ...base, warnings: warnings.join("; ") } : base;
}

// --- G6: external origins ⊆ cdn_allowlist ----------------------------------
function normalizeOrigin(entry: string): string {
  try {
    return new URL(entry).origin;
  } catch {
    return entry.replace(/\/+$/, "");
  }
}

function checkG6(htmls: readonly HtmlFile[], cdnAllowlist: readonly string[]): Finding {
  const allowed = new Set(cdnAllowlist.map(normalizeOrigin));
  const problems: string[] = [];
  for (const page of htmls) {
    for (const { value: ref } of page.refs) {
      if (classifyRef(ref) !== "external") continue;
      let origin: string;
      try {
        origin = new URL(ref).origin;
      } catch {
        problems.push(`${page.relPath}: unparseable external ref "${ref}"`);
        continue;
      }
      if (!allowed.has(origin)) {
        problems.push(`${page.relPath}: external origin ${origin} not in cdn_allowlist [${[...allowed].join(", ")}]`);
      }
    }
  }
  return finding("G6", problems);
}

// --- G7: manifest declares the verdict schema (NOT an iframe export) ---------
// Redefined by F2. The OLD G7 REQUIRED the review site to own a download/export
// surface — a capability the new architecture deliberately removed: verdict
// export/write lives in the TRUSTED SHELL, and any iframe-side download/self-
// export is now a G5 hard-fail (F3). What survives is the provenance fact the
// shell needs: the manifest must name the `verdict_schema` the shell will emit
// the verdict under (I5). The site itself must NOT export anything.
function checkG7(manifest: ManifestInfo | null): Finding {
  const problems: string[] = [];
  const schema = manifest?.verdictSchema;
  if (!(typeof schema === "string" && schema.length > 0)) {
    problems.push(
      "manifest verdict_schema missing (I5: the trusted shell needs the schema name it will emit the verdict under)",
    );
  }
  return finding("G7", problems);
}

// --- G8: provenance fidelity ------------------------------------------------
/**
 * Resolve the manifest's declared measurement path under `root`, guarded the
 * same way `resolveTaskFile` (dashboard) guards serves: the lexical check
 * rejects `..`/absolute paths, but only `realpathSync` + containment on the
 * REAL path catches a symlink in the (worker-authored) artifacts tree pointing
 * outside it — otherwise G8 would hash a file outside the task tree and
 * "verify" fidelity against the wrong bytes. Fail closed: a missing target or
 * any realpath error returns null.
 */
function resolveMeasurement(root: string, declaredPath: string): string | null {
  if (declaredPath.length === 0 || isAbsolute(declaredPath)) return null;
  const candidate = resolve(root, declaredPath);
  try {
    const resolved = realpathSync(candidate);
    const realRoot = realpathSync(root);
    if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) return null;
    return resolved;
  } catch {
    return null;
  }
}

async function checkG8(
  manifest: ManifestInfo | null,
  opts: CheckReviewSiteOptions,
): Promise<{ finding: Finding; fidelity: "verified" | "unverified" }> {
  if (manifest === null) {
    return { finding: finding("G8", ["manifest unavailable (see G3)"]), fidelity: "unverified" };
  }
  const problems: string[] = [];
  const sampleId = typeof manifest.sampleId === "string" ? manifest.sampleId : "";
  if (sampleId.length === 0) problems.push("manifest sample_id missing");

  // The manifest sample_id must equal the harness-known run id (H1b): a toy
  // measurement carries no sample_id of its own, so this is the anti-swap check.
  if (opts.expectedSampleId && sampleId && opts.expectedSampleId !== sampleId) {
    problems.push(`manifest sample_id "${sampleId}" ≠ run id "${opts.expectedSampleId}"`);
  }

  const pf = manifest.producedFrom;
  const measurement =
    pf !== null && typeof pf === "object" && typeof (pf as Record<string, unknown>)["measurement"] === "string"
      ? ((pf as Record<string, unknown>)["measurement"] as string)
      : "";
  const at = measurement.lastIndexOf("@");
  const declaredPath = at === -1 ? "" : measurement.slice(0, at);
  const declaredHash = at === -1 ? "" : measurement.slice(at + 1);
  if (at === -1 || !HEX64.test(declaredHash)) {
    problems.push(`manifest produced_from.measurement is not "path@<sha256>" (got "${measurement}")`);
  }

  // Locate the real on-disk measurement: an explicit resultsPath (CLI) or the
  // declared path resolved under the harness-supplied measurementsRoot.
  const measurementFile =
    opts.resultsPath ??
    (opts.measurementsRoot && declaredPath
      ? resolveMeasurement(opts.measurementsRoot, declaredPath)
      : null);

  let fidelity: "verified" | "unverified" = "unverified";
  if (measurementFile && (await existsAt(measurementFile))) {
    fidelity = "verified";
    const bytes = await readFile(measurementFile);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (declaredHash && declaredHash !== actualHash) {
      problems.push(
        `manifest produced_from hash ${declaredHash.slice(0, 12)}… ≠ measurement ${actualHash.slice(0, 12)}… (stale/mismatched site)`,
      );
    }
    // If the measurement itself names a sample_id, it must match too.
    try {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (parsed !== null && typeof parsed === "object") {
        const runSampleId = (parsed as Record<string, unknown>)["sample_id"];
        if (typeof runSampleId === "string" && sampleId && runSampleId !== sampleId) {
          problems.push(`manifest sample_id "${sampleId}" ≠ measurement sample_id "${runSampleId}"`);
        }
      }
    } catch {
      /* non-JSON measurement — hash check still applies. */
    }
  } else if (opts.requireFidelity) {
    // The harness gate requires an authoritative check; a missing measurement
    // must FAIL, not silently degrade to a structural-only pass (H1).
    problems.push(
      `fidelity required but the measurement is unavailable (${measurementFile ?? "no path supplied"})`,
    );
  }

  // Multi-source provenance (review-data-injection.md): a template may inject
  // more than one artifact, each declared under its own produced_from key
  // ("path@<sha256>"). Verify every ADDITIONAL entry the same way — hash the
  // on-disk file under measurementsRoot. `measurement` stays the primary
  // (handled above with the sample_id cross-check); the single-measurement case
  // adds no extra entries, so it is unchanged.
  if (pf !== null && typeof pf === "object") {
    for (const [key, ref] of Object.entries(pf as Record<string, unknown>)) {
      if (key === "measurement") continue;
      if (typeof ref !== "string") {
        problems.push(`manifest produced_from.${key} is not a "path@<sha256>" string`);
        continue;
      }
      const kat = ref.lastIndexOf("@");
      const kPath = kat === -1 ? "" : ref.slice(0, kat);
      const kHash = kat === -1 ? "" : ref.slice(kat + 1);
      if (kat === -1 || !HEX64.test(kHash)) {
        problems.push(`manifest produced_from.${key} is not "path@<sha256>" (got "${ref}")`);
        continue;
      }
      const kFile = opts.measurementsRoot ? resolveMeasurement(opts.measurementsRoot, kPath) : null;
      if (kFile && (await existsAt(kFile))) {
        const kActual = createHash("sha256").update(await readFile(kFile)).digest("hex");
        if (kHash !== kActual) {
          problems.push(
            `manifest produced_from.${key} hash ${kHash.slice(0, 12)}… ≠ file ${kActual.slice(0, 12)}… (stale/mismatched site)`,
          );
        }
      } else if (opts.requireFidelity) {
        problems.push(`fidelity required but produced_from.${key} is unavailable (${kFile ?? "no path supplied"})`);
      }
    }
  }

  return { finding: finding("G8", problems), fidelity };
}

// --- G9: spatial 3D review (real Three.js scene; slices optional) -----------
// Fires ONLY when the manifest declares `review_layout: "spatial-multipane"`
// (design demo-readiness §2 "3D-first layout"); a values-table review omits the
// field and G9 is N/A → auto-pass, so single-pane protocols are unaffected.
//
// The PRIMARY, required view is a REAL 3D scene: a `[data-review-view="scene3d"]`
// element with a `<canvas>`, driven by an inlined three.js WebGL scene with
// OrbitControls (drag rotates the camera). A static painted 2D canvas is NOT a
// 3D review and fails here — p80 found exactly that shipped ("orbit does
// nothing"). The linter can't execute the scene, so it statically requires the
// distinctive three.js scene primitives (WebGLRenderer + OrbitControls + a
// camera) in the inlined script; that the orbit BEHAVES is the worker's file://
// drag-check and the human reviewer's job.
//
// Orthogonal slices are OPTIONAL drill-down evidence: an artifact with no
// slice-* views (and no REVIEW_VOLUME/REVIEW_SLICES) still passes. But when a
// slice-* view IS declared it must carry its per-axis slider + canvas, be wired
// to a slice-data global, and set `linked_views: true` — an incomplete scrubber
// is worse than none. Landmark data (REVIEW_EVIDENCE.landmarks) is always
// required: the named landmark markers render from it.
const SLICE_VIEW = /^slice-(axial|coronal|sagittal)$/;
const SLICE_DATA_GLOBALS = ["REVIEW_VOLUME", "REVIEW_SLICES"] as const;
// Distinctive three.js scene primitives a static painted 2D canvas lacks.
// Word-boundary matched against the inlined script text (never executed);
// presence is the static bar — the p80 painted canvas has none of them.
const THREE_SCENE_TOKENS: readonly { readonly re: RegExp; readonly need: string }[] = [
  { re: /\bWebGLRenderer\b/, need: "a WebGLRenderer (real GPU 3D rendering, not a 2D canvas paint)" },
  { re: /\bOrbitControls\b/, need: "OrbitControls (drag must rotate the camera — the exact thing a painted canvas cannot do)" },
  { re: /\b(?:Perspective|Orthographic)Camera\b/, need: "a camera (PerspectiveCamera/OrthographicCamera)" },
];
const SCENE3D_VIEW = "scene3d";

function checkG9(
  manifest: ManifestInfo | null,
  htmls: readonly HtmlFile[],
  globalValues: ReadonlyMap<string, unknown>,
): Finding {
  // N/A auto-pass. A null manifest is G3's failure to report, and without a
  // readable manifest no `review_layout: "spatial-multipane"` was declared.
  if (manifest === null || manifest.reviewLayout !== "spatial-multipane") {
    return finding("G9", []);
  }
  const problems: string[] = [];

  // Static DOM markers + inline JS text, aggregated across pages (the single-
  // document contract means index.html in practice) — the same parsed elements
  // every gate uses. The inline <script> text is scanned (not executed) for the
  // three.js scene primitives.
  const views = new Set<string>();
  const sliders = new Set<string>();
  const canvases = new Set<string>();
  let canvasCount = 0;
  const jsChunks: string[] = [];
  for (const page of htmls) {
    for (const el of page.elements) {
      const view = el.attrs.get("data-review-view");
      if (view !== undefined) views.add(view);
      const canvas = el.attrs.get("data-review-slice-canvas");
      if (canvas !== undefined) canvases.add(canvas);
      const slider = el.attrs.get("data-review-slice-slider");
      const isRange = el.tag === "input" && (el.attrs.get("type") ?? "").trim().toLowerCase() === "range";
      if (slider !== undefined && isRange) sliders.add(slider);
      if (el.tag === "canvas") canvasCount++;
      if (el.tag === "script" && el.attrs.get("src") === undefined && el.rawText) jsChunks.push(el.rawText);
    }
  }
  const jsText = jsChunks.join("\n");

  // 1. The 3D scene is the primary, required view: declared and present, with a
  // canvas to render into.
  if (!manifest.requiredViews.includes(SCENE3D_VIEW)) {
    problems.push(`spatial-multipane manifest must declare "${SCENE3D_VIEW}" in required_views (the 3D scene is the primary review view)`);
  }
  if (!views.has(SCENE3D_VIEW)) {
    problems.push(`no [data-review-view="${SCENE3D_VIEW}"] element (the 3D scene is the primary review view)`);
  } else if (canvasCount === 0) {
    problems.push(`the ${SCENE3D_VIEW} view has no <canvas> to render the 3D scene into`);
  }

  // 2. A REAL three.js scene with OrbitControls — reject a static painted canvas.
  for (const { re, need } of THREE_SCENE_TOKENS) {
    if (!re.test(jsText)) {
      problems.push(`no ${need} in the inlined script — a static painted 2D canvas is not a 3D review`);
    }
  }

  // 3. Landmark markers render from REVIEW_EVIDENCE.landmarks (always required).
  const EVIDENCE_GLOBAL = "REVIEW_EVIDENCE";
  if (!manifest.dataGlobals.includes(EVIDENCE_GLOBAL)) {
    problems.push(`no ${EVIDENCE_GLOBAL} global in data_globals (landmark/evidence data)`);
  } else {
    const evidence = globalValues.get(EVIDENCE_GLOBAL);
    const landmarks =
      evidence !== null && typeof evidence === "object"
        ? (evidence as Record<string, unknown>)["landmarks"]
        : undefined;
    if (!Array.isArray(landmarks) || landmarks.length === 0) {
      problems.push(`${EVIDENCE_GLOBAL}.landmarks is missing or empty (the 3D scene needs named landmark markers)`);
    }
  }

  // 4. Slices are OPTIONAL drill-down evidence. Validate ONLY the slice-* views
  // that are actually declared; an artifact with none still passes (REVIEW_VOLUME
  // optional). When a slice view IS declared, its slider + canvas markers are
  // required (the scrubber the G9 gate statically asserts).
  const sliceViews = manifest.requiredViews.filter((v) => SLICE_VIEW.test(v));
  for (const view of sliceViews) {
    if (!views.has(view)) {
      problems.push(`declared slice view "${view}" has no [data-review-view="${view}"] element`);
    }
    const axis = SLICE_VIEW.exec(view)?.[1];
    if (axis !== undefined) {
      if (!sliders.has(axis)) {
        problems.push(`slice view "${view}" has no <input type="range" data-review-slice-slider="${axis}">`);
      }
      if (!canvases.has(axis)) {
        problems.push(`slice view "${view}" has no [data-review-slice-canvas="${axis}"] element`);
      }
    }
  }

  // 5. When slices ARE shown, they must be wired to real slice data (a slice-data
  // global backed by a produced_from hash or a non-empty inlined literal) and
  // linked to the 3D scene. Skipped entirely when no slice view is declared.
  if (sliceViews.length > 0) {
    const sliceGlobal = SLICE_DATA_GLOBALS.find((g) => manifest.dataGlobals.includes(g));
    if (sliceGlobal === undefined) {
      problems.push("slice views are declared but no slice-data global (REVIEW_VOLUME or REVIEW_SLICES) is in data_globals");
    } else {
      const ds = manifest.dataSources;
      const entry =
        ds !== null && typeof ds === "object"
          ? (ds as Record<string, unknown>)[sliceGlobal]
          : undefined;
      const artifact =
        entry !== null && typeof entry === "object"
          ? (entry as Record<string, unknown>)["artifact"]
          : undefined;
      if (typeof artifact === "string" && artifact.length > 0) {
        if (!producedFromPaths(manifest.producedFrom).has(artifact)) {
          problems.push(`slice-data global ${sliceGlobal} artifact "${artifact}" has no produced_from "path@<sha256>" entry`);
        }
      } else {
        const value = globalValues.get(sliceGlobal);
        const inlined =
          value !== undefined &&
          !(typeof value === "string" && (value.length === 0 || INJECT_SENTINEL.test(value)));
        if (!inlined) {
          problems.push(`slice-data global ${sliceGlobal} has no data_sources entry with a produced_from hash and is not a non-empty static literal`);
        }
      }
    }
    if (manifest.linkedViews !== true) {
      problems.push("slice views are declared but linked_views is not true (the 3D scene and slices must share one position)");
    }
  }

  return finding("G9", problems);
}

/** Run G1-G9 against a review-site folder. */
export async function checkReviewSite(opts: CheckReviewSiteOptions): Promise<ReviewSiteReport> {
  const siteDir = resolve(opts.siteDir);

  const htmlPaths = await listFiles(siteDir, ".html");
  const jsPaths = await listFiles(siteDir, ".js");

  const allJs: JsFile[] = await Promise.all(
    jsPaths.map(async (absPath) => {
      const text = await readFile(absPath, "utf8");
      return { absPath, relPath: relative(siteDir, absPath), analysis: analyzeJs(text) };
    }),
  );

  const htmls: HtmlFile[] = await Promise.all(
    htmlPaths.map(async (absPath) => {
      const text = await readFile(absPath, "utf8");
      const elements = parseHtml(text);
      const ids = new Set<string>();
      const inlineScripts: JsAnalysis[] = [];
      const scriptSrcRefs: string[] = [];
      for (const el of elements) {
        const id = el.attrs.get("id");
        if (id !== undefined && id.length > 0) ids.add(id);
        if (el.tag === "script") {
          const src = el.attrs.get("src");
          if (src === undefined) {
            if (el.rawText && el.rawText.trim().length > 0) {
              inlineScripts.push(analyzeJs(el.rawText));
            }
          } else if (classifyRef(src.trim()) === "relative" && src.trim().endsWith(".js")) {
            scriptSrcRefs.push(src.trim());
          }
        }
      }
      return {
        absPath,
        relPath: relative(siteDir, absPath),
        elements,
        ids,
        refs: collectRefs(elements),
        inlineScripts,
        scriptSrcRefs,
      };
    }),
  );

  // Every statically-analysed JS unit, inline blocks and stray .js files alike,
  // feeds the global/sink gates. In the single-document contract the app lives
  // entirely in inline <script> blocks.
  const jsSources: JsSource[] = [
    ...allJs.map((f) => ({ label: f.relPath, analysis: f.analysis })),
    ...htmls.flatMap((page) =>
      page.inlineScripts.map((analysis, idx) => ({
        label: `${page.relPath} inline <script> #${idx + 1}`,
        analysis,
      })),
    ),
  ];

  const g1 = await checkG1(siteDir);
  const g2 = await checkG2(siteDir, htmls);
  const { finding: g3, manifest, globalValues } = checkG3(jsSources);
  const g4 = checkG4(htmls, allJs);
  const g5 = checkG5(jsSources, htmls, opts);
  const g6 = checkG6(htmls, opts.cdnAllowlist);
  const g7 = checkG7(manifest);
  const { finding: g8, fidelity } = await checkG8(manifest, opts);
  const g9 = checkG9(manifest, htmls, globalValues);

  const findings = [g1, g2, g3, g4, g5, g6, g7, g8, g9];
  return { ok: findings.every((f) => f.ok), siteDir, fidelity, findings };
}
