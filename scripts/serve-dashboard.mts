/**
 * Serve the LabRat dashboard against a task tree, for live viewing over
 * tailscale. Boots the same createApp the tests use; stays running.
 *   SERVE_TASKS_DIR=/path/to/tasks SERVE_PORT=8787 npx tsx scripts/serve-dashboard.mts
 */
import { loadConfig } from "../src/dashboard/config.js";
import { createApp } from "../src/dashboard/server.js";

// Thread the full config through the one seam (so scienceHome et al. resolve),
// then override tasksDir/port from the SERVE_* env for local serving.
const base = loadConfig();
const tasksDir = process.env.SERVE_TASKS_DIR ?? base.tasksDir;
const port = Number(process.env.SERVE_PORT ?? base.port);

const app = createApp({ ...base, tasksDir, port, devReplay: false });
app.listen(port, "127.0.0.1", () => {
  console.log(`labrat dashboard serving ${tasksDir} on http://127.0.0.1:${port}`);
});
