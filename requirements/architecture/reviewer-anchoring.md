# Reviewer Anchoring

How the reviewer accesses the worker's history without loading the full
session.

## The problem

The reviewer needs to understand what the worker did — but loading the
full worker conversation biases the review (the reviewer sees the
worker's reasoning, not just its outputs) and wastes context (the
worker's 50-turn session is mostly code iteration noise).

## The solution: fresh session + conversation anchors

The reviewer gets a completely new session. It loads:

1. The same skill prefix (SKILL.md + resources + ground-truth gates)
2. Reviewer-specific instructions
3. The worker's structured outputs (phase directories on disk)
4. An `explore_anchor` tool for selective history access

The reviewer does NOT get the worker's conversation. It reads the
phase records (summary.md, decisions.md, measurements.json, evidence/)
and forms its own judgment. When something looks wrong, it uses anchors
to investigate specific decisions.

## Anchor mechanics

### Generation

The harness assigns an anchor ID to each significant conversation turn
during the worker's session. "Significant" means:

- Tool calls (code execution, file writes, renders)
- Decision points (the agent stating a choice)
- Gate checks (measurements vs. ground truth)
- Phase transitions (record_phase calls)

Not every turn gets an anchor — chat-style reasoning turns that don't
produce artifacts are skipped.

### Format

Short hash, 5-6 alphanumeric characters. Derived from a hash of the
turn content (deterministic, content-addressable). Short because:

- The agent generates and references these in text
- UUIDs are 36 characters — that's 36 tokens per reference
- 5-char hashes are 1-2 tokens per reference
- Collision risk is negligible within a single task (~100 anchors)

Example: `a3f7c`, `b1e2d`, `c9a4f`

### Storage

The harness maintains an anchor index per task:

```
tasks/{task-id}/anchors/
├── index.yaml          # anchor-id → turn number, timestamp, summary
└── turns/
    ├── a3f7c.md        # full turn content (tool call + result)
    ├── b1e2d.md
    └── ...
```

Each anchor file contains the full turn content — what the agent said,
what tool it called, what the result was. The index has one-line
summaries for browsing.

### The agent writes anchor references

The skill instructions tell the worker to reference anchors in its
phase records:

```markdown
## Decisions (in decisions.md)

- Threshold set to 2500 HU based on histogram bimodality [anchor:a3f7c]
- Watershed seeds placed at diaphyseal ends [anchor:b1e2d]
```

This makes phase records self-documenting — the reviewer sees what was
decided and can drill into how it was decided.

## The `explore_anchor` tool

Available to the reviewer agent. Three modes:

### `explore_anchor({ id: "a3f7c" })`

Returns the full content of that anchor turn — what the agent did,
what it saw, what it decided.

### `explore_anchor({ id: "a3f7c", direction: "up", depth: 3 })`

Returns summaries of the 3 turns leading up to this anchor. Shows
what context the agent had when it made the decision. Useful for
understanding "why did it choose 2500 HU?" — look up to see the
histogram analysis that preceded it.

### `explore_anchor({ id: "a3f7c", direction: "down", depth: 3 })`

Returns summaries of the 3 turns following this anchor. Shows what
happened after the decision. Useful for understanding "did the
threshold choice cause problems downstream?"

### Bounded windows

Depth is capped (default 5, max 10). The reviewer can't accidentally
load the full session by exploring deeply. Each exploration returns
summaries (1-2 sentences per turn) except for the target anchor, which
returns full content.

## Why this matters for review quality

### Without anchors (fork or full history)

The reviewer sees everything — including the worker's wrong turns,
its frustration, its reasoning about why it tried approach A before
switching to approach B. This biases the review. The reviewer
"understands" the worker's choices and is less likely to challenge
them. It's like a code reviewer who reads the commit messages before
reading the diff — they review the intent, not the code.

### With anchors (overview lens)

The reviewer sees structured outputs and decides for itself whether
the results look right. When something looks off, it investigates
specific decisions. It approaches the work fresh — like a reviewer
who reads the diff first, then asks "why did you do this?" only when
something doesn't make sense.

This is the overview reviewer lens: examine what the worker produced,
form an independent opinion, then selectively investigate.

## Interaction with prompt caching

The reviewer's system prompt is stable:

```
[1] Skill instructions (same as worker)    ← cached (shared with worker)
[2] Reviewer instructions                  ← cached
[3] Phase record summaries                 ← per-task, small
```

Anchor lookups are tool results — they go into the conversation, not
the system prompt. The cached prefix survives across multiple anchor
lookups. The reviewer's context grows slowly (one anchor lookup at a
time), not catastrophically (not the entire worker history).

## Implementation priority

For the hackathon:

1. **Phase records are the primary review surface.** The reviewer reads
   phase directories. This works without anchors.
2. **Anchors are a stretch goal.** They make the reviewer smarter but
   aren't required for the demo. The reviewer can still check
   measurements against gates and flag confidence issues from phase
   records alone.
3. **If anchors ship**: the harness generates anchor IDs during worker
   execution, the skill instructions tell the worker to reference them,
   and the reviewer gets the explore_anchor tool.
