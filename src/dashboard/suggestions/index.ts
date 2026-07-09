import type { SuggestionEntry } from "../../schema/index.js";

/** TODO(wave-3): POST suggestion → suggestions.json */
export async function appendSuggestion(
  _taskDir: string,
  _entry: Omit<SuggestionEntry, "id" | "createdAt">,
): Promise<SuggestionEntry> {
  // TODO(wave-3)
  throw new Error("suggestions not implemented");
}
