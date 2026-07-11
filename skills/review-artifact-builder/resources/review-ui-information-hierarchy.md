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

### 1. The decisive evidence — banner, always visible

The numbers the call depends on. Each measured ratio shown against its
cutoff, colored by state (`pass` / `concern` / `fail`), with flagged items
(`requires_human_review`) sorted first. This is the evidence panel — it
answers "what is this specimen's call, and where is the uncertainty?"

The banner stays visible across all views (3D, slices, tour). It is not a
tab the reviewer navigates to — it is the frame around every view.

What belongs here:
- Each decisive ratio: value, cutoff range, state
- Flagged sub-measurements (sorted first, visually distinct)
- The worker's own known-limits narrative for flagged items
- Concordance summary: do the signals agree?

What does NOT belong here:
- The OA-progression interpretation (that comes after, not before)
- Raw sub-measurements (those are drill-down detail)
- The agent's conclusion or confidence (shown after, to prevent anchoring)

### 2. Spatial evidence — 3D + slices with measurement overlays

The 3D scene and linked orthogonal slices, with the actual measurement
geometry drawn on the bone:

- **Measurement lines** — the femoral-length line, the width line, drawn as
  the protocol measured them, labeled with their mm value and the index they
  contribute to. "The line ends in the wrong place" is the primary spatial
  failure mode — the overlay makes it visible.
- **Landmark markers** — colored rings at each placed landmark, with
  confidence halos (bright = high, dim = needs confirmation).
- **Linked slices** — selecting a landmark drives all three slice sliders to
  its position. The reviewer confirms slice-by-slice what the 3D surface
  hides — bled labels, off-by-a-slice placements.

The spatial views serve the banner: when a decisive ratio is flagged, the
reviewer drills into the spatial view to see whether the contributing
landmarks are placed correctly. The spatial views do not stand alone — they
are the evidence for a specific question raised by the banner.

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

- **3D scene as the primary evidence.** A bare mesh with dots. The reviewer
  orbits, sees bone, and concludes "looks right" — while the decisive ratio
  is borderline and invisible. The 3D scene is drill-down, not the lead.
- **Numbers before spatial context.** A table of measurements at the top
  with no spatial evidence below. The reviewer evaluates numbers against
  ranges instead of checking WHERE the measurements come from.
- **Agent conclusion front and center.** "The agent classified this as early
  OA. Confirm?" The reviewer anchors on the classification instead of
  verifying the placement.
- **Interaction before observation.** Drag handles shown by default. The
  reviewer adjusts before understanding what the current placement means.
  Adjustment is offered after the tour presents the evidence and rule.
- **Reference values as validation gates.** "Published range: 2.2–2.6 mm.
  This measurement: 2.41 mm. PASS." The reviewer skips spatial inspection
  because the number is in range.
- **Decisive evidence in a tab.** The ratios and flags hidden behind a
  "Data" tab the reviewer must click. The banner is always visible — it
  frames every view.
