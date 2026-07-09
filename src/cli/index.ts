#!/usr/bin/env node
/** TODO(wave-4): CLI entrypoint — enqueue a path (watcher stub) */
async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: labrat <input-path>");
    process.exit(1);
  }
  console.log(`enqueue not implemented yet: ${inputPath}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
