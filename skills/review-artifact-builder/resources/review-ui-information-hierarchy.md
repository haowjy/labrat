# Review UI — Information Hierarchy

Load when writing a review-artifact phase. This resource teaches what the
reviewer sees and in what order.

## The reviewer's attention

The reviewer's job is to form an independent judgment about the protocol's
output, then record that judgment. Everything in the review UI serves one
of these two actions. Anything that doesn't is noise.

**Order matters.** If the reviewer sees the agent's conclusion before the
evidence, they anchor on it. If they see a table of numbers before the 3D
render, they evaluate numbers instead of anatomy. The information order
determines whether the review is substantive or ceremonial.

## What to show, in order

1. **Primary evidence — center stage.** The 3D render, the plot, the
   image. The thing a domain expert actually evaluates. This gets the
   most screen space and loads first. Everything else is secondary to this.

2. **The review question — specific, alongside the evidence.** Not "is
   this correct?" but "does this landmark sit on the distal condylar
   surface?" or "does this segmentation capture the tibial plateau?" The
   question is visible while the reviewer looks at the evidence, guiding
   what they look for.

3. **The agent's conclusion — after the evidence.** Show the proposed
   measurement, confidence level, and any flags only after the reviewer
   has had time to form their own impression. This prevents anchoring.

4. **Supporting data — secondary panel.** Tables of derived quantities,
   statistics, intermediate values. Available but not competing with the
   primary evidence for attention. Use a tab or collapsible panel.

5. **Reference context — on demand.** What the paper reported, what's
   typical for this species/anatomy/age. Available when the reviewer
   wants to contextualize their observation. Not shown by default — it
   biases the judgment.

## Honesty surfaces

The review UI is where the protocol's uncertainty becomes the reviewer's
information. Show it, don't hide it:

- **Confidence flags.** Where the agent was uncertain — a low-margin bone
  identity call, a landmark that passed on distance but not on clean
  anatomical placement.
- **Disagreements.** When the in-phase reviewer and the agent disagreed,
  show both positions.
- **Visual anomalies.** Measurement lines that cross (rotational mismatch
  when bones are measured in separate frames). Segmentation gaps. Ambiguous
  boundaries. Show them with labels explaining the cause.

The reviewer confirms WITH these flags visible. Hiding uncertainty makes
the review ceremonial — the reviewer rubber-stamps because everything
looks clean, when the real question was in the thing that was hidden.

## Anti-patterns

- **Numbers before evidence.** A table of measurements at the top. The
  reviewer evaluates numbers against ranges instead of looking at anatomy.
- **Abstract questions.** "Review the segmentation results." Tell them
  specifically what to look at and what would be wrong.
- **Agent conclusion front and center.** "The agent measured femur length
  as 2.41 mm. Confirm?" The reviewer anchors on 2.41 and checks whether
  it's plausible, instead of looking at where the landmarks actually sit.
- **Reference values as validation gates.** "Published range: 2.2–2.6 mm.
  This measurement: 2.41 mm. PASS." The reviewer skips visual inspection
  because the number is in range.
