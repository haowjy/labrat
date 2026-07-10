# Review UI — Interactions & Verdict Panel

Load when writing a review-artifact phase. This resource teaches what the
reviewer can DO in the review UI and how verdicts flow through the trust
boundary.

## The interaction loop

The core pattern: **adjust → observe → confirm.**

1. The reviewer sees the evidence (a 3D render, a plot, a values table).
2. They adjust something — move a landmark, change a threshold, rotate
   the view to inspect from another angle.
3. The artifact recomputes derived quantities in response.
4. The reviewer observes the effect and decides: is the result correct now?
5. They record their verdict.

This is how domain experts build confidence. They don't just look — they
probe. The review UI must support probing, not just display.

## The verdict panel

The verdict panel is a trusted shell component (`VerdictPanel.js`) that
lives outside the sandboxed review surface. It owns the verdict state —
the iframe never writes verdicts.

**What it shows:**
- A verdict pill (pass/fail/corrected status)
- Mark pass / Mark fail buttons
- An adjustments chip list (interactions the reviewer made)
- A notes textarea for the reviewer's reasoning
- A "Finish review" button that commits the verdict to disk

**How it connects to the iframe:**
- When the reviewer adjusts something in the 3D scene (iframe), the
  bridge sends an `interaction` message to the shell
- The verdict pill auto-flips to "corrected" — the reviewer expressed
  judgment through the interaction
- But `interaction` never sets the committable `status` — only an
  explicit button click in the trusted shell can do that
- The "Finish review" button POSTs the verdict to the harness, which
  writes `review/verdict/{phase}.json`

## The postMessage bridge

Two layers: a pure trust-critical library (`lib/review-bridge.js`) and a
DOM-facing hook (`useReviewBridge.js`).

**Iframe → shell (3 message types):**

| Type | Payload | What it does |
|------|---------|-------------|
| `ready` | none | Scene loaded, interactive. Shell enables the verdict panel. |
| `interaction` | `action`, `id`, `position` | Reviewer adjusted something. Shell records as evidence, tints verdict pill "corrected." Never sets committable status. |
| `metrics-updated` | `metrics` (finite numbers only) | Recomputed values after adjustment. Displayed in shell, informational only. |

**Shell → iframe (planned, not built):**

The shell currently never postMessages to the iframe. `REVIEW_MSG_TYPES`
in `review-bridge.js` defines only the three iframe-to-shell types above;
`useReviewBridge.js` listens for messages but never calls
`iframe.contentWindow.postMessage(...)`. The following are planned
extensions:

| Type | Payload | What it would do |
|------|---------|-----------------|
| `highlight` | `itemId` | Reviewer hovers a verdict row in the shell. Iframe highlights the corresponding item in the 3D scene. |
| `reset` | none | Revert all adjustments for this phase. |

**Trust invariants:**
- Shell validates message **structure** (strict key allowlists, id regex
  `^[A-Za-z0-9_-]{1,128}$`, finite-number-only for positions/metrics)
- `interaction` is untrusted evidence — it can flip `verdict.corrected`
  but never `verdict.status`
- Evidence cap (500 items) and rate limiting (20 msgs/1000ms) prevent
  flooding
- Bridge revocation on unexpected iframe reload/navigation — if the
  iframe reloads itself, the shell drops the trusted window reference
  and clears accumulated evidence

## Progressive disclosure for interactions

Not everything is interactive by default:

- **Primary action: viewing.** Rotate, zoom, pan the 3D scene. Always
  available. No mode to enter.
- **Secondary action: selecting.** Click to select a landmark or
  structure. Shows details in the verdict panel. Available by default
  but doesn't modify anything.
- **Tertiary action: adjusting.** Move a landmark, change a threshold.
  The reviewer enters an explicit edit mode (Place mode in MPR editors).
  Edit handles are not shown by default — they clutter the view.

## Linked views

**Within the iframe (built):** when the artifact shows multiple views (3D
scene + 2D slices, or 3D + data table), they share state:

- Selecting a landmark in the data table highlights it in 3D and scrolls
  2D slices to its position
- Moving a landmark in 2D updates the 3D view and recomputes metrics

This linking is the main value of a multi-view UI. Without it, multiple
views are just separate windows that happen to be on screen together.

**Cross-boundary (planned, not built):** hovering a verdict row in the
shell would highlight the corresponding item in the iframe via the
`highlight` bridge message. This requires the shell-to-iframe channel
described above, which does not exist yet.

## What the verdict captures

The finished verdict (`review/verdict/{phase}.json`) includes:
- `phase` — which phase was reviewed
- `human_verdict` — pass, fail, or corrected
- `corrected` — boolean, whether the reviewer made adjustments
- `notes` — the reviewer's reasoning
- `adjustments` — list of interactions the reviewer made
- `agent_confidence` — merged from the agent's `confidence.json`
- `agent_gate_decision` + `agent_gate_feedback` — from the gate reviewer

This is the provenance record. The disk file is the contract — if the
verdict isn't on disk, the review didn't happen.
