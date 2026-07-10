import express, { type Express } from "express";
import { loadConfig, type DashboardConfig } from "./config.js";
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
 * Build the Content-Security-Policy for the review-site route (design C5/R2).
 * Quarantines a served review page to its own bytes + any allow-listed CDNs:
 * `connect-src 'none'` blocks fetch/XHR back to the dashboard APIs;
 * `frame-ancestors 'self'` (C5) stops third-party framing; `base-uri 'none'`
 * blocks <base> rewriting; `form-action 'none'` (does NOT fall back to
 * default-src) blocks form POSTs to dashboard endpoints; `object-src 'none'`
 * blocks <object>/<embed>. The script-src directive is built by filtering empty
 * tokens, so an empty allowlist yields exactly `script-src 'self' 'unsafe-inline'`
 * (no trailing space). Decision point (C4): if/when a route serves a Plotly
 * template, add `'unsafe-eval'` to script-src here — Plotly's bundle evals.
 *
 * `'unsafe-inline'` on script-src is LOAD-BEARING (R4): the site ships as a
 * single inlined index.html because an opaque-origin sandboxed iframe refuses
 * every external `<script src>`/`<link href>` subresource, so the inline
 * `<script>`/`<style>` blocks MUST be permitted or the page renders blank.
 * The cost: `'unsafe-inline'` also permits inline event handlers (`onerror=`)
 * and inline scripts, and `connect-src 'none'` does NOT block navigation
 * (`window.location = evil`; no `navigate-to` directive exists). Those two
 * exfil classes are caught not here but by the deterministic linter
 * (`review-site/check.ts` G5) — the sandbox + CSP contain external
 * loads/connections; the linter contains navigation + inline-handler exfil.
 * The two layers together are the boundary.
 */
export function reviewSiteCsp(cdnAllowlist: string = REVIEW_SITE_CDN_ALLOWLIST): string {
  const scriptSrc = ["'self'", "'unsafe-inline'", ...cdnAllowlist.split(/\s+/)]
    .filter((t) => t !== "")
    .join(" ");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
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
  app.get("/api/tasks/:id/review-site/*path", (req, res) => {
    const segments = req.params.path as string[];
    const file = resolveReviewSiteFile(tasksDir, req.params.id, segments);
    if (!file) {
      res.status(400).json({ error: "invalid path" });
      return;
    }
    res.setHeader("Content-Security-Policy", reviewSiteCsp());
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
