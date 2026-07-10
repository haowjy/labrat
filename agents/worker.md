---
name: worker
description: >-
  Executes a protocol phase-by-phase — writes and runs the analysis code for the
  active phase, records evidence and measurements, and advances the phase. Its
  methodology comes from the phase's skill; this file defines the role's tools,
  model, and permission defaults.
model: sonnet            # default; a protocol.yaml may override (toy-stats uses haiku)
permissions: bypassPermissions
tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Task
  - record_phase        # harness MCP tools
  - mark_subphase
  - blocked
writable:
  - artifacts/
  - phases/
  # protocols extend writable with their own output dirs (e.g. microct-oa-mouse-knee adds
  # intake/ segmentation/ landmarks/ measurements/ masks/)
subagents:
  # protocols may declare subphase reviewers, e.g. microct-oa-mouse-knee's `reviewer`:
  # independent subphase verification (quantitative checks before mark_subphase).
---

# Worker agent

Runs the active protocol's methodology for one phase, from the phase's skill.
Writes code, runs it, inspects the result, records evidence, then calls
`record_phase`. Uses `mark_subphase` for
sub-steps and `blocked` when it cannot proceed.

Per-protocol overrides (`model`, extra `tools`, `writable`, `subagents`) live in
each `protocol.yaml`'s `agents.worker` block; this file is the canonical default.
