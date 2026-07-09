# Agent Composition

Two agent sessions per task. The harness orchestrates — no LLM orchestrator.

## Worker Agent

Loads skills from `~/.claude-science/`. Writes and runs Python code guided
by the skill instructions. Follows the skill's agentic loop:
render → reason → validate against ground truth → rewrite if needed.

The worker does NOT call fixed pipeline drivers. It writes analysis code on
the fly, using kernel helpers as building blocks and skill instructions as
methodology. It can study reference material, but it is free to rewrite
and re-approach — like the dev-workflow pattern.

The worker's job is the part the human currently does by hand: look at the
3D image, place landmarks, adjust, rotate, look again, adjust again, loop
until it looks right. The agent does this with renders + vision checks +
ground-truth gates instead of eyeballs.

## Reviewer Agent

Separate Agent SDK session. **Fresh prompt, not a fork.** Independent
context — does not share the worker's reasoning chain. Loads the same
skills and ground-truth gates.

The reviewer's primary surface is the worker's structured outputs:
phase records (summary.md, decisions.md, measurements.json, evidence/).
It reads these from disk and forms its own judgment.

For selective investigation, the reviewer has anchor-based access to
specific points in the worker's session — see `reviewer-anchoring.md`.
Anchors let the reviewer drill into specific decisions without loading
the full worker conversation.

Examines the worker's artifacts: phase records, evidence images,
measurements, provenance. Checks every measurement against ground-truth
gates. Flags issues. Judge-gates what reaches the human.

Bounded: K review iterations (default 2), then surface remaining concerns
to the dashboard with confidence flags.

### Why fresh session, not fork

Two strategies for sub-agents:

1. **Fork the conversation** — clone the worker's session. The reviewer
   inherits everything. Problem: it's biased by the worker's reasoning
   chain and loaded with irrelevant context (code iteration noise).

2. **Fresh session with structured access** — completely new prompt.
   The reviewer reads structured outputs (phase records on disk) and
   uses conversation anchors to investigate specific decisions.

LabRat uses strategy 2. The reviewer should approach the work with an
**overview lens** — examine what the worker produced, form independent
opinions, then selectively investigate. Like a reviewer who reads the
diff first, then asks "why did you do this?" only when something
doesn't look right.

This matches CodeRabbit's pattern where verification agents are
separate from the review agent, and the dev-workflow pattern where
builder and reviewer are independent agents that loop until
convergence.

## Harness as Orchestrator

The Agent SDK harness itself (TypeScript, not an LLM) manages:
- Task queue (one at a time for now)
- Worker session → reviewer session handoff
- Anchor generation during worker execution (short hashes per
  significant turn — tool calls, decisions, gate checks)
- Compaction triggers between phases
- Dashboard state updates via SSE
- Provenance persistence
- `explore_anchor` tool for the reviewer (bounded history lookups)
