# Demo Script (3 minutes)

## The pitch (why this matters)

Lab analysis has two parts: the physical work (cutting bone, mounting
slides, running the scanner) and the digital analysis (looking at images,
placing landmarks, scoring, measuring). The physical work can't be
automated — that's robots and scalpels, not software. But the analysis
that follows is tedious, precision-demanding, and poorly reproducible.

A grad student spends an hour per scan rotating a 3D view, placing
landmarks, adjusting, checking. Multiply by 30 scans per study. That's
30 hours where the scientific judgment is 5 minutes per scan and the
rest is mechanical. Worse: the results vary person to person, day to
day, because manual landmark placement demands precision that humans
can't reliably deliver.

LabRat automates the analysis. The protocol is authored in Claude Science.
The agent executes it autonomously — looking, placing, adjusting, checking
with renders and ground-truth gates instead of eyeballs. A reviewer agent
independently verifies. The scientist reviews the finished product, not a
half-done checkpoint. And it's reproducible: same protocol, same gates,
same answer every time (or a flag when it can't converge).

## The script

**0:00–0:20** — "Scientists repeat the same analysis protocol on dozens of
samples. The physical lab work stays manual — you still need a human to
run the scanner. But the digital analysis that follows? That's what we
automated. LabRat is the autonomous execution layer for Claude Science."

**0:20–0:50** — Show a DICOM series dropping into the watched folder. LabRat
detects it, loads the OA mouse-knee protocol from Claude Science, starts
processing. Dashboard shows live progress.

**0:50–1:40** — Agent works through the protocol. Show the dashboard
streaming: "segmenting bone... threshold 2500 HU... watershed split...
placing landmarks... trochlear groove at z=218... gate check: femur
length 2.42mm PASS..." The agent is doing what the grad student does —
looking, placing, adjusting, checking — but autonomously and reproducibly.

**1:40–2:20** — Agent finishes. Reviewer agent runs. Dashboard shows the
review chain: each phase with evidence images, measurements with gate
status (green/yellow/red), confidence flags. Click through segmentation
overlay, landmark placements on 3D views, final measurement table.

**2:20–2:50** — Scientist reviews. Types a suggestion on the landmark
phase: "Growth plate boundary looks too deep on the medial side."
Stored in LabRat's DB. "This suggestion feeds back to the skill author
in Claude Science — next protocol revision will address it."

**2:50–3:00** — "This is one protocol for one imaging modality. The same
harness runs any analysis protocol authored in Claude Science — histology
scoring, flow cytometry gating, western blot quantification. The physical
lab work stays human. The analysis doesn't have to."

## Judging Alignment

| Criterion | Weight | How we score |
|---|---|---|
| **Demo** | 30% | Real scan, real processing, real results. Not a mockup. |
| **Impact** | 25% | Named user (Dr. Awad's lab), real workflow, generalizable. |
| **Claude Use** | 25% | Agent SDK, skills from Claude Science, agentic code writing, reviewer agent, provenance. |
| **Depth** | 20% | Reviewer agent shows we wrestled with: what happens when the agent gets it wrong? |
