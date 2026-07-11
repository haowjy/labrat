/**
 * Serve the LabRat dashboard against a task tree, for live viewing over
 * tailscale. Boots the same createApp the tests use; stays running.
 *   SERVE_TASKS_DIR=/path/to/tasks SERVE_PORT=8787 npx tsx scripts/serve-dashboard.mts
 */
import { createApp } from "../src/dashboard/server.js";

const tasksDir = process.env.SERVE_TASKS_DIR ?? "./tasks";
const port = Number(process.env.SERVE_PORT ?? 8787);

const app = createApp({ tasksDir, user: "reviewer", port, devReplay: false });
app.listen(port, "127.0.0.1", () => {
  console.log(`labrat dashboard serving ${tasksDir} on http://127.0.0.1:${port}`);
});
