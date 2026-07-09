import path from "node:path";

/**
 * Dashboard runtime config. The dashboard is Process B (design §4): it reads
 * ONLY disk under `tasksDir` and never couples to the harness process.
 */
export type DashboardConfig = {
  /** Root of the task tree the dashboard serves (design §5). */
  readonly tasksDir: string;
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
  const tasksDir = path.resolve(env["TASKS_DIR"] ?? "./tasks");
  const user = env["LABRAT_USER"] ?? "jimmy@voluma.bio";
  const port = Number.parseInt(env["PORT"] ?? "4600", 10);
  const devReplay = env["SSE_DEV_REPLAY"] === "1";
  return { tasksDir, user, port, devReplay };
}
