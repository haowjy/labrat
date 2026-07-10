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
      startDevReplay();
    }
  });
}

// Runnable entrypoint:  TASKS_DIR=./fixtures/tasks tsx src/dashboard/server.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer(loadConfig());
}
