import { useEffect, useRef, useState } from "../vendor/preact-htm.js";

const PULSE_MS = 900;

/** True for ~PULSE_MS right after `value` changes — drives a brief
 * highlight ring on a card when its live status changes. Purely a CSS
 * transition trigger; the data itself still only ever changes via the
 * existing SSE-notification -> re-fetch pattern (design §13) — this hook
 * doesn't add a new data source, just reacts to a value that already
 * changed. Shared by Sidebar.js's TaskCard and Dashboard.js's SampleCard —
 * both show the same live per-sample state, just at different scales
 * (extracted here rather than left duplicated across the two).
 */
export function usePulseOnChange(value) {
  const [pulsing, setPulsing] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    setPulsing(true);
    const t = setTimeout(() => setPulsing(false), PULSE_MS);
    return () => clearTimeout(t);
  }, [value]);
  return pulsing;
}
