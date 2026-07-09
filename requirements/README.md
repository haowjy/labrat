# LabRat — Requirements

## Problem

Lab scientists repeat the same analysis workflow dozens of times per study.
A preclinical bone researcher scans 30 mouse femurs on a microCT, then
manually opens each one, rotates the 3D view, places landmarks, adjusts
them, rotates again, checks, adjusts again — a full day of mechanical work
where the actual scientific judgment is maybe 10 minutes. The rest is
tedious looping through look → place → adjust → look.

## Product

LabRat is the autonomous execution layer for Claude Science. Scientists
author and refine analysis protocols (Skills) in Claude Science. LabRat
watches a folder, picks up incoming data, runs the protocol autonomously
using the Agent SDK, and produces a complete review chain showing every
major phase with evidence, measurements, confidence, and provenance. The
scientist reviews the finished analysis — not a half-done checkpoint.

CodeRabbit for lab data.

## Documents

- [architecture/](architecture/) — system architecture, agent composition,
  phase compaction
- [protocols/](protocols/) — the first protocol (mouse-knee OA geometric
  indices) and task directory structure
- [references/](references/) — prior art, design inspirations, research

## Build Schedule (Wed–Fri)

### Wednesday
- Agent SDK hello-world: session loads skills from `~/.claude-science/`
- `record_phase` tool implementation
- Agent processes OA6-1RK DICOM through at least intake + segmentation
- Phase records written to disk

### Thursday
- Reviewer agent session: independently checks worker artifacts
- Dashboard: Express server, task status page, SSE progress
- Review chain page: shows all phases with evidence and measurements
- Suggestion capture per phase

### Friday
- Local folder watcher: detect new DICOM, queue task, run
- End-to-end: file appears → agent runs → reviewer checks → dashboard
- Polish dashboard, record demo
- Push to GitHub

### Buffer
Saturday–Monday (away). Everything must be demoable by Friday night.

## What we are NOT building

- Mobile-optimized UI
- Multi-tenancy or user auth
- Batch processing UI (sequential queue only)
- Automated skill refinement (suggestions are recorded for human author)
- Self-contained exported HTML review (review lives in dashboard)
- Fixed Python pipeline drivers (agent writes code on the fly)
- An LLM orchestrator agent (harness is code)

## Open Questions

1. Product name — LabRat is working name, may change.
2. Bonemorph tarball — corrupted. Agent writes code using kernel helpers,
   so the package isn't strictly needed. Kernel.py loading path TBD.
3. Reviewer agent model — same as worker, or cheaper/different?
4. Protocol skill naming — "bonemorph-oa-mouse-knee" is inaccurate. TBD.
5. Tailscale demo setup details.
