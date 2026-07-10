import { createHash } from "node:crypto";
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
 * review-template.md §2, gates G1-G8).
 *
 * It depends ONLY on the review-site CONTRACT (§1, invariants I1-I7): a single
 * inlined entry point, self-contained (no external subresources), `.js`-global
 * run data, and a manifest that names the run the site was built from and the
 * `verdict_schema` the trusted shell will emit under (G7). The site itself
 * exports NOTHING — a self-download/export sink is a G5 hard-fail (F2/F3);
 * export lives in the shell. It knows nothing about bonemorph / 3D / Plotly, so
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

export type GateId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8";

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
};

function checkG3(jsSources: readonly JsSource[]): {
  readonly finding: Finding;
  readonly manifest: ManifestInfo | null;
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
    };
  }
  if (manifestValue === undefined || typeof manifestValue !== "object" || manifestValue === null) {
    // Assigned but not a static object literal — the contract requires a
    // literal manifest the gate can read (I3/G8).
    return {
      finding: finding("G3", [...problems, "window.REVIEW_MANIFEST is not a static object literal"]),
      manifest: null,
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
  const manifest: ManifestInfo = {
    sampleId: mf["sample_id"],
    producedFrom: mf["produced_from"],
    verdictSchema: mf["verdict_schema"],
    dataGlobals: declared,
  };
  return { finding: finding("G3", problems), manifest };
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
/** Resolve the manifest's declared measurement path under `root`, guarded. */
function resolveMeasurement(root: string, declaredPath: string): string | null {
  if (declaredPath.length === 0 || isAbsolute(declaredPath)) return null;
  const abs = resolve(root, declaredPath);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`)) return null;
  return abs;
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

  return { finding: finding("G8", problems), fidelity };
}

/** Run G1-G8 against a review-site folder. */
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
  const { finding: g3, manifest } = checkG3(jsSources);
  const g4 = checkG4(htmls, allJs);
  const g5 = checkG5(jsSources, htmls, opts);
  const g6 = checkG6(htmls, opts.cdnAllowlist);
  const g7 = checkG7(manifest);
  const { finding: g8, fidelity } = await checkG8(manifest, opts);

  const findings = [g1, g2, g3, g4, g5, g6, g7, g8];
  return { ok: findings.every((f) => f.ok), siteDir, fidelity, findings };
}
