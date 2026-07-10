import { useCallback, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import {
  appendVerdictLog,
  applyReviewMessage,
  newReviewVerdict,
  revokeEvidence,
  withStatus,
} from "../lib/review-bridge.js";

/**
 * The DOM-facing half of the F1 postMessage bridge. lib/review-bridge.js is
 * pure (no window/document); this hook is the one place that actually
 * listens for `message` events, checks `event.source` against the real
 * mounted iframe's `contentWindow`, and watches for an unexpected reload —
 * ported unchanged from app.js's `initReviewVerdict`/`onReviewMessage`
 * (design/review-architecture-decision.md; goal doc "carry the F1
 * postMessage security unchanged").
 *
 * Holds the mounted <iframe> ELEMENT (not its .contentWindow) and reads
 * .contentWindow fresh at message-check time, rather than caching it once
 * in the ref callback: `iframeEl.contentWindow` can still be null in the
 * instant the ref callback fires (the nested browsing context isn't always
 * initialized synchronously with element insertion — a real browser timing
 * quirk, confirmed live: the vanilla shell never hit this because it built
 * the iframe via innerHTML and looked it up afterward, by which point the
 * browser had already finished creating it). By the time any message
 * actually arrives FROM that iframe, its contentWindow is necessarily
 * established — reading it lazily sidesteps the race with no security
 * cost: `contentWindow` is the same stable WindowProxy across that
 * element's navigations either way (the exact fact F1's load-counter
 * already depends on).
 *
 * Usage: `const { verdict, bindIframe, setVerdict } = useReviewBridge();`
 * then `html\`<iframe ref=${bindIframe} key=${srcKey} .../>\`` — pass a
 * `key` that changes per task/review-site so Preact mounts a genuinely new
 * iframe element instead of reusing one across tasks; `bindIframe` re-arms
 * the bridge every time it's called with a freshly-mounted element, exactly
 * mirroring `renderReviews()` always rebuilding the DOM in the vanilla shell.
 */
export function useReviewBridge() {
  const [verdict, setVerdictState] = useState(newReviewVerdict);
  // The mounted <iframe> element, or null when none is mounted / the
  // bridge has been revoked. Never read contentWindow into a ref directly
  // — see the timing note above.
  const iframeElRef = useRef(null);

  const bindIframe = useCallback((iframeEl) => {
    if (!iframeEl) {
      // Unmount (task switched away, or the Reviews view was left): drop the
      // element ref so any message from the outgoing frame is rejected.
      iframeElRef.current = null;
      return;
    }
    setVerdictState(newReviewVerdict());
    iframeElRef.current = iframeEl;
    let loads = 0;
    iframeEl.addEventListener("load", () => {
      loads += 1;
      // The first `load` is the expected initial document the shell just
      // mounted; any later one on the SAME frame element is a navigation/
      // reload the shell did not initiate. The WindowProxy survives that
      // navigation, so `event.source` alone can't distinguish it (F1) —
      // this counter is what does.
      if (loads > 1) {
        iframeElRef.current = null;
        setVerdictState((v) =>
          revokeEvidence(v, "the sandboxed frame navigated or reloaded itself"),
        );
      }
    });
  }, []);

  useEffect(() => {
    function handleMessage(event) {
      const win = iframeElRef.current ? iframeElRef.current.contentWindow : null;
      if (!win || event.source !== win) return;
      setVerdictState((v) => applyReviewMessage(v, event.data));
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  /** The reviewer's EXPLICIT verdict — the only committable value (F1). */
  const setVerdict = useCallback((status) => {
    setVerdictState((v) =>
      appendVerdictLog(
        withStatus(v, status),
        status === "pass" ? "Reviewer marked pass." : "Reviewer marked fail.",
      ),
    );
  }, []);

  return { verdict, bindIframe, setVerdict };
}
