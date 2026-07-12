# Review UI — Information Hierarchy

Load when writing a review-artifact phase. This resource teaches what the
reviewer sees and in what order.

## Evidence-led, not interaction-led

The reviewer's job is to verify the protocol's call — not to explore a 3D
scene and form an impression. The review UI leads with the decisive evidence
(the numbers the call depends on, their states, the flags), then provides
spatial drill-down so the reviewer can confirm WHERE those numbers come from.

**Order matters.** If the reviewer sees a 3D mesh before the ratios and
cutoffs, they evaluate anatomy instead of verifying the call. If they see the
agent's conclusion before the evidence that supports it, they anchor. The
information order determines whether the review is substantive or ceremonial.

## What to show, in order

### 1. The decisive evidence — owned by the dashboard shell

The decisive numbers (ratios, cutoffs, pass/fail states) are shown by the
dashboard's trusted `EvidencePanel`, which reads measurements from disk. The
artifact does NOT duplicate this as a banner — the shell handles it.

The reviewer reads the decisive numbers in the shell, then enters the
artifact to verify WHERE those numbers come from spatially.

### 2. Spatial evidence — four-up multiplanar (the artifact's primary job)

The artifact's default view is a four-up multiplanar layout: 3D scene +
three orthogonal slice panes, equal quadrants, linked crosshairs. The
measurement geometry is drawn on the anatomy:

- **Measurement lines** — the femoral-length line, the width line, drawn as
  the protocol measured them, labeled with their mm value as DOM badges on
  the line in the 3D quadrant. "The line ends in the wrong place" is the
  primary spatial failure mode — the overlay makes it visible.
- **Landmark markers** — colored rings at each placed landmark, with
  confidence halos (bright = high, dim = needs confirmation). Visible in all
  four quadrants — the 3D marker and the slice crosshairs are synchronized.
- **Linked views** — selecting a landmark in any quadrant drives all four
  views to that position. The reviewer confirms in the 3D what the slices
  show, and in the slices what the 3D surface hides.

Each quadrant can be expanded to fill the full stage for detail inspection,
then collapsed back to the four-up.

### 3. Guided per-landmark tour — camera, rule, then adjust

Replace free-roam with a structured checklist. For each landmark (low
confidence / `requires_confirmation` first):

1. **Camera flies to** a good framing of the landmark
2. **All three slices jump** to the landmark's voxel position
3. **The operational rule** is stated inline ("groove top: proximal-most
   sustained anterior-midline concavity, proximal to the condylar bulge —
   not where the condyles merge")
4. **The measurement lines** this landmark contributes to are highlighted
5. **Drag-to-adjust** is offered — only after the reviewer has seen the
   evidence and the rule

The tour is the verification procedure the protocol prescribes, automated.
The reviewer can skip it and free-roam, but the default path is guided.

### 4. The agent's conclusion — after the evidence

Show the OA-progression interpretation, the agent's confidence, and the
gate reviewer's assessment AFTER the reviewer has seen the decisive numbers
and the spatial evidence. This prevents anchoring.

Three parts:
- **Stage read** — where this specimen falls on the progression spectrum,
  derived from the ratios' magnitudes (not the binary cutoff)
- **Concordance** — do the osteophyte index and the subchondral-collapse
  index tell one story? State disagreements.
- **Confidence and basis** — distance from cutoffs, gray-zone flags, the
  single-specimen limit

### 5. Supporting data — secondary, on demand

The full values table (all nine rows with units, honesty flags), structural
check results (CC == 1, compartment symmetry), and the raw landmark
positions. Available in a tab or collapsible panel, not competing with the
evidence banner or spatial views.

### 6. Reference context — expandable, not default

Published cutoff ranges, per-model ROC values, what's typical for this
species/age. Available when the reviewer wants to contextualize. Not shown
by default — it biases the judgment toward checking whether a number is "in
range" instead of whether the landmarks are correctly placed.

## Honesty surfaces

The review UI is where the protocol's uncertainty becomes the reviewer's
information. Show it, don't hide it:

- **Flagged sub-measurements.** When the worker flagged `requires_human_review`,
  surface the flag AND the reason (known limits, iteration count, confidence)
  in the evidence banner, not buried in a JSON file the reviewer never sees.
- **Confidence per landmark.** Visual distinction — bright halo for high
  confidence, dim/pulsing for needs-confirmation. The reviewer's eye goes to
  the uncertain landmarks first.
- **Disagreements.** When the in-phase reviewer and the agent disagreed,
  show both positions in the evidence banner.
- **Measurement-line anomalies.** Lines that cross (rotational mismatch),
  lines that end off the bone surface, disproportionate lengths — label them
  with the cause.

Hiding uncertainty makes the review ceremonial — the reviewer rubber-stamps
because the 3D scene looks clean, while the real question was in the ratio
they never saw.

## Anti-patterns

- **3D scene alone as the primary evidence.** A bare mesh with dots. The
  reviewer orbits, sees bone, and concludes "looks right" — while the
  decisive ratio is borderline and the orthogonal slices would have shown
  the problem. The four-up forces linked verification.
- **Duplicating the shell's evidence display.** The decisive numbers already
  live in the dashboard's trusted EvidencePanel. An evidence banner inside
  the artifact repeats them (untrusted) and steals viewport from the spatial
  views. The artifact shows measurement values on the lines, not in a banner.
- **Agent conclusion front and center.** "The agent classified this as early
  OA. Confirm?" The reviewer anchors on the classification instead of
  verifying the placement.
- **Interaction before observation.** Drag handles shown by default. The
  reviewer adjusts before understanding what the current placement means.
  Adjustment is offered after the tour presents the evidence and rule.
- **Reference values as validation gates.** "Published range: 2.2–2.6 mm.
  This measurement: 2.41 mm. PASS." The reviewer skips spatial inspection
  because the number is in range.
- **Slices behind a tab.** Orthogonal slices hidden as "Advanced" content
  the reviewer must click to reach. They are primary verification — they sit
  beside the 3D in the four-up, not behind a tab.
