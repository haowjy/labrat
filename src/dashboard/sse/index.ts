import type { Request, Response } from "express";
import { subscribe } from "../../harness/events/index.js";

/** TODO(wave-3): /events SSE stream */
export function handleSse(_req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const unsubscribe = subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  _req.on("close", () => {
    unsubscribe();
    res.end();
  });
}
