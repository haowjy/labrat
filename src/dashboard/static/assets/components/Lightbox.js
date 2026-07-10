import { html } from "../vendor/preact-htm.js";

/** Evidence-image viewer. `open` is `{src, cap} | null`; passing null hides it. */
export function Lightbox({ open, onClose }) {
  return html`
    <div class="lightbox ${open ? "open" : ""}" onClick=${onClose}>
      ${open
        ? html`<img src=${open.src} alt=${open.cap} /><div class="cap">${open.cap}</div>`
        : null}
    </div>
  `;
}
