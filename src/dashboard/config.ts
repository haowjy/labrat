import path from "node:path";
import { loadConfig as loadLabratConfig } from "../config/index.js";

/**
 * Dashboard runtime config. The dashboard is Process B (design §4): it reads
 * ONLY disk under `tasksDir` and never couples to the harness process.
 *
 * Derived from the single {@link loadLabratConfig} seam (src/config) —
 * `tasksDir` and `devReplay` are dashboard-specific and have no equivalent
 * there.
 */
export type DashboardConfig = {
  /** Root of the task tree the dashboard serves (design §5). */
  readonly tasksDir: string;
  /** Claude Science registry root — for the read-only skill-browse route.
   * Threaded from the single config seam (`scienceHome`), never read from env
   * in the route. */
  readonly scienceHome: string;
  /** Author stamped on suggestions submitted through the UI (design §17). */
  readonly user: string;
  readonly port: number;
  /**
   * Dev-only: replay a scripted sequence of the 8 SSE event types so the live
   * ticker can be exercised without the harness. Never on in prod.
   */
  readonly devReplay: boolean;
};

/** Load config from the environment, with dev-friendly defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const labratConfig = loadLabratConfig(env);
  const tasksDir = path.resolve(env["TASKS_DIR"] ?? "./tasks");
  const devReplay = env["SSE_DEV_REPLAY"] === "1";
  return {
    tasksDir,
    scienceHome: labratConfig.scienceHome,
    user: labratConfig.dashboard.user,
    port: labratConfig.dashboard.port,
    devReplay,
  };
}
