import type { ProtocolYaml } from "../../schema/index.js";

/** TODO(wave-2): fs.watch on incoming dir → detect new DICOM series/zip */
export type WatcherConfig = {
  readonly incomingDir: string;
  readonly onEnqueue: (inputPath: string) => Promise<void>;
};

export function startWatcher(_config: WatcherConfig): void {
  // TODO(wave-4)
}
