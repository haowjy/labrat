import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";

/** Write text atomically: temp file → fsync → rename (design §3). */
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
