import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";

/**
 * Shared atomic-write helper (design §3): temp file → fsync → rename, so a
 * crash mid-write never leaves a half-written status file on disk. Both
 * process A (harness) and process B (dashboard) write files that the other
 * side's readers trust, so this lives outside both — a shared dependency
 * alongside schema, not owned by either process.
 */
export async function atomicWriteText(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(tmpPath, filePath);
}

/** Write JSON atomically: temp file → fsync → rename (design §3). */
export async function atomicWriteJson(
  filePath: string,
  data: unknown,
): Promise<void> {
  await atomicWriteText(filePath, `${JSON.stringify(data, null, 2)}\n`);
}
