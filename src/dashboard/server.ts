import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import express, { type Express } from "express";
import { loadConfig, type DashboardConfig } from "./config.js";
import { buildReviewSiteCsp } from "../review-site/csp.js";
import { extractManifest } from "../review-site/parse.js";
import {
  getManifest,
  getPhase,
  getSuggestions,
  getTask,
  listTasks,
  resolveTaskFile,
} from "./api/index.js";
import type { SseEvent } from "../schema/index.js";
import { handleSse, publishEvent } from "./sse/index.js";
import { startDevReplay } from "./sse/replay.js";
import { finishReview } from "./review/index.js";
import { appendSuggestion } from "./suggestions/index.js";
import { STATIC_ROOT } from "./static/index.js";

/**
 * CDN origins the review page's <script> tags may load from. Empty by default
 * (design review-template §2/I4: `cdn_allowlist: []`, vendored) so the demo
 * emits `script-src 'self' 'unsafe-inline'` and the served CSP never exceeds
 * what the G6 gate verified (`origins ⊆ cdn_allowlist`), beyond the fixed
 * `'unsafe-inline'` the inlined single-document site requires (R4). The
 * design's per-phase `cdn_allowlist`
 * field is forward-compat (Lane F): pass the phase's value to `reviewSiteCsp()`
 * at the call site instead of relying on this default.
 */
const REVIEW_SITE_CDN_ALLOWLIST = "";

/**
 * The Content-Security-Policy for the review-site route (design C5/R2). Thin
 * adapter over the CANONICAL builder in `review-site/csp.ts` — the single
 * source of truth the G5 gate also confirms (F4), so the served policy and the
 * gated policy cannot drift. Takes a space-separated allowlist string (the
 * route's config shape) and forwards the tokens.
 *
 * Decision point (C4): if/when a route serves a Plotly template, add
 * `'unsafe-eval'` to script-src in the canonical builder — Plotly's bundle
 * evals. `'unsafe-inline'` on script-src is LOAD-BEARING (R4): the inlined
 * single-document site renders blank in an opaque-origin sandbox without it.
 * The cost — inline handlers become live and `connect-src 'none'` never blocked
 * navigation — is carried by the deterministic linter (`review-site/check.ts`
 * G5), not here. The sandbox + CSP contain external loads/connections; the
 * linter contains navigation + inline-handler exfil. The two layers together
 * are the boundary.
 */
export function reviewSiteCsp(cdnAllowlist: string = REVIEW_SITE_CDN_ALLOWLIST): string {
  return buildReviewSiteCsp(cdnAllowlist.split(/\s+/).filter((t) => t !== ""));
}

/**
 * Resolve a request path under a task's artifacts/review-site/ to an absolute
 * file, or null if any segment escapes the tree. Delegates traversal guarding
 * to resolveTaskFile — the single seam that keeps serving inside the task tree.
 */
export function resolveReviewSiteFile(
  tasksDir: string,
  id: string,
  segments: readonly string[],
): string | null {
  return resolveTaskFile(tasksDir, id, ["artifacts", "review-site", ...segments]);
}

/**
 * Serve-time review-data injection (design review-data-injection.md).
 *
 * The review template may ship large run data (geometry, full measurement
 * arrays) out-of-line: instead of the LLM transcribing megabytes of literals,
 * it writes a sentinel `window.<NAME> = "__REVIEW_INJECT:<NAME>__";` and
 * declares the source in `REVIEW_MANIFEST.data_sources`. This route reads the
 * hashed artifact from disk, verifies its sha256 against `produced_from`, and
 * splices its bytes over the sentinel before sending — so the browser still
 * receives ONE self-contained document (same sandbox/CSP/linter boundary) and
 * provenance is guaranteed by construction, not transcription.
 *
 * Backward-compat is mandatory: a fully-inlined template (no sentinel) returns
 * null so the caller falls through to the unchanged `sendFile` path.
 *
 * Generic by contract: it reads a manifest, resolves paths (through the same
 * traversal-guarded `resolveTaskFile` the route uses), checks hashes, and
 * splices bytes. It knows nothing about any protocol or global's meaning.
 *
 * Fails closed: any missing artifact, hash mismatch, malformed manifest,
 * non-JSON artifact bytes, or a sentinel that is not present exactly once
 * THROWS — the caller 500s rather than serve a half-injected document.
 */
async function injectReviewData(
  tasksDir: string,
  id: string,
  file: string,
): Promise<string | null> {
  const html = await readFile(file, "utf8");
  // Fast string scan, not a parse: no sentinel → fully-inlined template.
  if (!html.includes("__REVIEW_INJECT:")) return null;

  const manifest = extractManifest(html);
  if (manifest === null) {
    throw new Error("review-site template has an injection sentinel but no static window.REVIEW_MANIFEST object literal");
  }
  const dataSources = manifest["data_sources"];
  if (dataSources === null || typeof dataSources !== "object") {
    throw new Error("review-site template has an injection sentinel but REVIEW_MANIFEST declares no data_sources");
  }

  // Map every declared source path → its declared sha256, read off
  // produced_from (`{ [key]: "path@<sha256>" }`). Each data_sources artifact
  // must have a matching hash here — that is the provenance the splice enforces.
  const hashByPath = new Map<string, string>();
  const producedFrom = manifest["produced_from"];
  if (producedFrom !== null && typeof producedFrom === "object") {
    for (const ref of Object.values(producedFrom as Record<string, unknown>)) {
      if (typeof ref !== "string") continue;
      const at = ref.lastIndexOf("@");
      if (at === -1) continue;
      hashByPath.set(ref.slice(0, at), ref.slice(at + 1));
    }
  }

  // Undeclared/malformed-sentinel detection runs against the TEMPLATE, before
  // any data is spliced — injected data may legitimately contain the marker
  // string as a value, so a post-splice residual scan would 500 valid data.
  // Every quoted sentinel must name a declared data_sources entry, and every
  // raw marker occurrence must be part of a well-formed quoted sentinel (a
  // bare/malformed marker would otherwise ship live to the browser).
  const SENTINEL_RE = /"__REVIEW_INJECT:([A-Za-z0-9_]+)__"/g;
  const sources = dataSources as Record<string, unknown>;
  const sentinelCounts = new Map<string, number>();
  for (const m of html.matchAll(SENTINEL_RE)) {
    const name = m[1]!;
    if (!Object.hasOwn(sources, name)) {
      throw new Error(`template sentinel "__REVIEW_INJECT:${name}__" has no data_sources entry`);
    }
    sentinelCounts.set(name, (sentinelCounts.get(name) ?? 0) + 1);
  }
  const markerCount = html.split("__REVIEW_INJECT:").length - 1;
  const quotedCount = [...sentinelCounts.values()].reduce((a, b) => a + b, 0);
  if (markerCount !== quotedCount) {
    throw new Error(
      'template contains a malformed injection marker (every __REVIEW_INJECT: must be a quoted "__REVIEW_INJECT:<NAME>__" sentinel)',
    );
  }

  const replacementByName = new Map<string, string>();
  for (const [name, entry] of Object.entries(sources)) {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`data_sources.${name} is not an object`);
    }
    const { artifact, transform } = entry as { artifact?: unknown; transform?: unknown };
    if (typeof artifact !== "string" || artifact.length === 0) {
      throw new Error(`data_sources.${name}.artifact must be a non-empty string`);
    }
    if (transform !== undefined && transform !== "identity") {
      throw new Error(`data_sources.${name}.transform "${String(transform)}" is unsupported (only "identity")`);
    }

    // Resolve under <taskDir>/artifacts/ through the SAME traversal guard the
    // route uses — a "../" or absolute artifact path is rejected here.
    const artifactFile = resolveTaskFile(tasksDir, id, ["artifacts", ...artifact.split("/")]);
    if (artifactFile === null) {
      throw new Error(`data_sources.${name}.artifact "${artifact}" does not resolve inside the task tree`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(artifactFile);
    } catch {
      throw new Error(`data_sources.${name}.artifact "${artifact}" is missing`);
    }

    const declaredHash = hashByPath.get(artifact);
    if (declaredHash === undefined) {
      throw new Error(`data_sources.${name}.artifact "${artifact}" has no matching produced_from hash`);
    }
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== declaredHash) {
      throw new Error(
        `data_sources.${name}.artifact "${artifact}" hash ${actualHash.slice(0, 12)}… ≠ declared ${declaredHash.slice(0, 12)}…`,
      );
    }

    // The sentinel is spliced UNQUOTED (`window.<NAME> = <bytes>`), so the
    // bytes MUST be a pure JSON value literal — otherwise a hash-declared
    // artifact could carry JS statements (e.g. a `window.location` navigation
    // sink, the one exfil channel the CSP cannot block) straight into the
    // inline script. Parse to validate, then splice the ORIGINAL bytes (never
    // a re-serialization) so the hash-verified bytes are preserved exactly;
    // valid JSON is expression-only, so the assignment stays inert data.
    try {
      JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(
        `data_sources.${name}.artifact "${artifact}" is not valid JSON — refusing to splice it into an inline script`,
      );
    }

    // The sentinel (INCLUDING its quotes) must appear exactly once in the
    // TEMPLATE, else a textual splice would corrupt the document or drop data.
    const count = sentinelCounts.get(name) ?? 0;
    if (count !== 1) {
      throw new Error(`sentinel "__REVIEW_INJECT:${name}__" appears ${count} time(s) in the template; expected exactly 1`);
    }
    // Escape `<` as `\u003c` before splicing: the bytes land inside an inline
    // <script> RAWTEXT block, where a `</script>` inside a JSON string value
    // would terminate the element early and break the page. The escape is
    // JSON/JS-transparent (the parsed value is identical), so the hash-verified
    // data is unchanged as a VALUE while the document stays parseable.
    replacementByName.set(name, bytes.toString("utf8").replaceAll("<", "\\u003c"));
  }

  // Single pass over the ORIGINAL template: replacements never re-scan spliced
  // data, so injected values containing sentinel-like strings can neither trip
  // a residual check nor corrupt a later splice. Every match is declared (the
  // pre-scan threw otherwise) and validated (the loop above covered all of
  // data_sources), so the lookup cannot miss.
  return html.replace(SENTINEL_RE, (_match, name: string) => replacementByName.get(name)!);
}

/**
 * Build the dashboard Express app (Process B, design §4). Every data route
 * reads only disk under `config.tasksDir`; the only live channel is /events,
 * which carries notifications, not data.
 */
export function createApp(config: DashboardConfig): Express {
  const app = express();
  app.use(express.json({ limit: "64kb" }));

  const { tasksDir } = config;

  app.get("/api/tasks", async (_req, res) => {
    res.json(await listTasks(tasksDir));
  });

  app.get("/api/tasks/:id", async (req, res) => {
    const detail = await getTask(tasksDir, req.params.id);
    if (!detail) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    res.json(detail);
  });

  app.get("/api/tasks/:id/manifest", async (req, res) => {
    const manifest = await getManifest(tasksDir, req.params.id);
    if (!manifest) {
      res.status(404).json({ error: "manifest not found" });
      return;
    }
    res.json(manifest);
  });

  app.get("/api/tasks/:id/phases/:phase", async (req, res) => {
    const detail = await getPhase(tasksDir, req.params.id, req.params.phase);
    if (!detail) {
      res.status(404).json({ error: "phase not found" });
      return;
    }
    res.json(detail);
  });

  // Evidence images (design §5: phases/{phase}/evidence/).
  app.get("/api/tasks/:id/phases/:phase/evidence/:file", (req, res) => {
    const file = resolveTaskFile(tasksDir, req.params.id, [
      "phases",
      req.params.phase,
      "evidence",
      req.params.file,
    ]);
    if (!file) {
      res.status(400).json({ error: "invalid path" });
      return;
    }
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  // Review-site static serve (design §3 two-layer trust, C5/R2). Serves ANY
  // task's artifacts/review-site/ tree over one route, quarantined by a CSP so a
  // review page can only reach its own bytes + the allow-listed CDN — never the
  // dashboard's own APIs or a parent frame. Generic by contract: no
  // skill-specific logic. Traversal is guarded solely by resolveTaskFile
  // (path-to-regexp already splits *path into decoded segments; ".." / empty /
  // absolute segments are rejected there, keeping serving inside the task tree).
  app.get("/api/tasks/:id/review-site/*path", async (req, res) => {
    const segments = req.params.path as string[];
    const file = resolveReviewSiteFile(tasksDir, req.params.id, segments);
    if (!file) {
      res.status(400).json({ error: "invalid path" });
      return;
    }
    res.setHeader("Content-Security-Policy", reviewSiteCsp());

    // index.html gains the serve-time injection path: if the template carries a
    // data-injection sentinel, splice the hashed artifact bytes in and send the
    // buffered result. No sentinel → null → fall through to the sendFile path
    // below, byte-identical to a fully-inlined template (backward-compat).
    if (segments[segments.length - 1] === "index.html") {
      let injected: string | null;
      try {
        injected = await injectReviewData(tasksDir, req.params.id, file);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "review-data injection failed" });
        return;
      }
      if (injected !== null) {
        res.type("html").send(injected);
        return;
      }
    }

    // sendFile sets Content-Type from the extension (.html/.js/.css/.json).
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  // Reviewer verification scratch — proof the reviewer RAN code (design §10, §14).
  app.get("/api/tasks/:id/verification/:phase/:file", (req, res) => {
    const file = resolveTaskFile(tasksDir, req.params.id, [
      "review",
      "verification",
      req.params.phase,
      req.params.file,
    ]);
    if (!file) {
      res.status(400).json({ error: "invalid path" });
      return;
    }
    res.type("text/plain");
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  app.get("/api/tasks/:id/suggestions", async (req, res) => {
    const suggestions = await getSuggestions(tasksDir, req.params.id);
    if (!suggestions) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    res.json(suggestions);
  });

  app.post("/api/tasks/:id/suggestions", async (req, res) => {
    const body = req.body as { phase?: unknown; text?: unknown };
    if (typeof body?.phase !== "string" || typeof body?.text !== "string" || body.text.trim() === "") {
      res.status(400).json({ error: "phase and non-empty text are required" });
      return;
    }
    const entry = await appendSuggestion(
      tasksDir,
      req.params.id,
      { phase: body.phase, text: body.text.trim() },
      config.user,
    );
    if (!entry) {
      res.status(404).json({ error: "task not found or entry invalid" });
      return;
    }
    res.status(201).json(entry);
  });

  // Human review verdict write (design/review-loop-and-roles.md "trust
  // line"): the trusted shell writes review/verdict/{phase}.json here — the
  // untrusted review-site iframe never reaches this route directly, only via
  // the shell's postMessage bridge -> an explicit "Finish review" click.
  app.post("/api/tasks/:id/review/finish", async (req, res) => {
    const result = await finishReview(tasksDir, req.params.id, req.body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json(result.value);
  });

  // Cross-process notify seam (design §4, §13): the harness (Process A)
  // POSTs here after an atomic write lands; we forward to publishEvent(),
  // which validates and fans out to connected /events clients. This is the
  // only coupling from the dashboard back to the harness — a notification,
  // never primary data (clients still re-read disk).
  app.post("/internal/events", (req, res) => {
    publishEvent(req.body as SseEvent);
    res.status(204).end();
  });

  app.get("/events", handleSse);

  app.use(express.static(STATIC_ROOT));

  // Malformed JSON body (express.json() throws a SyntaxError before any
  // route handler runs) -> a clean 400 instead of express's default HTML
  // error page. Must be registered last (4-arg signature) and after static
  // so it only catches body-parse failures, not route/static 404s.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (err instanceof SyntaxError && "body" in err) {
        res.status(400).json({ error: "malformed JSON body" });
        return;
      }
      next(err);
    },
  );

  return app;
}

/** Start the server and (optionally) the dev SSE replay. */
export function startServer(config: DashboardConfig): void {
  const app = createApp(config);
  app.listen(config.port, () => {
    console.log(`[labrat] dashboard on http://localhost:${config.port}`);
    console.log(`[labrat] tasks dir: ${config.tasksDir}`);
    if (config.devReplay) {
      console.log("[labrat] dev SSE replay ON");
      void startDevReplay(config.tasksDir);
    }
  });
}

// Runnable entrypoint:  TASKS_DIR=./fixtures/tasks tsx src/dashboard/server.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer(loadConfig());
}
