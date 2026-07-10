import { html, useEffect, useState } from "../vendor/preact-htm.js";

// Matches the CSS breakpoint (styles.css RESPONSIVE block) where the
// wrapped sidebar actually becomes an off-canvas drawer. Below this width,
// `open` in this component's state controls a real fixed-position panel;
// at/above it, `.drawer-body` is `display:contents` (a no-op wrapper) —
// this hook exists so `inert` below can match that same boundary, instead
// of inert-ing the sidebar at desktop widths where it's always in-flow.
const MOBILE_QUERY = "(max-width: 700px)";

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

/**
 * Turns its children (the sidebar) into a true off-canvas drawer at mobile
 * widths (~700px and below, matching the shell's existing breakpoint) —
 * replacing the old CSS-only behavior of squashing the sidebar into a
 * max-height:200px horizontal strip above the content. At desktop widths
 * this is a no-op wrapper (styles.css makes `.drawer-body` `display:contents`
 * above the breakpoint, so `.sidebar` lays out exactly as it always has, a
 * direct flex child of `.app`).
 *
 * Escape closes it; so does clicking the backdrop; so does the caller
 * (App.js closes it on task select, so picking a task lands the reviewer on
 * content instead of leaving them behind the nav).
 */
export function MobileDrawer({ open, onClose, children }) {
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    // Lock background scroll while the drawer covers the viewport — only
    // matters at the mobile widths where the drawer is actually visible;
    // harmless (and reverted) at desktop widths where it's not.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  return html`
    <div
      class="drawer-backdrop ${open ? "drawer-backdrop-open" : ""}"
      onClick=${onClose}
      aria-hidden=${open ? "false" : "true"}
    ></div>
    <div
      class="drawer-body ${open ? "drawer-body-open" : ""}"
      inert=${isMobile && !open}
    >
      ${children}
    </div>
  `;
}
