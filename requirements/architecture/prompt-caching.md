# Prompt Caching Strategy

## The cost problem

A microCT analysis session generates massive token volume. The skill text
alone (SKILL.md + resources + reference figures) can be 20-30K tokens.
Each phase involves multiple iterations of code writing, rendering, and
gate checking. Without caching strategy, every turn re-reads the full
skill context. With 5 phases and ~10 turns per phase, that's 50 uncached
reads of the same skill text.

## Claude prompt caching mechanics

| Property | Value |
|---|---|
| Default TTL | 5 minutes |
| Extended TTL | 1 hour (2x write cost) |
| Cached read cost | ~10% of input token price |
| Cache granularity | Prefix-based (system, then messages in order) |
| Workspace isolation | Per-workspace since Feb 2026 |
| Minimum cacheable | 1024 tokens (Sonnet), 2048 tokens (Opus/Haiku) |

## Strategy: skill text as cached system prompt prefix

The worker agent's system prompt should be structured as:

```
[1] Skill instructions (SKILL.md + resources)     ← cached prefix
[2] Protocol-specific context (ground-truth gates) ← cached prefix
[3] Task-specific context (this scan's metadata)   ← per-task
[4] Phase instructions (current phase guidance)    ← per-phase
```

Layers [1] and [2] are identical across all tasks using the same protocol.
They form a stable prefix that stays cached across turns within a task
and potentially across tasks if processing is fast enough (within TTL).

Layer [3] changes per task but is stable within a task.
Layer [4] changes per phase.

### Cache breakpoints

Use `cache_control: { type: "ephemeral" }` on the last block of the
cached prefix. In the Agent SDK, this means marking the system prompt
blocks appropriately.

## Phase boundaries and cache timing

Each phase involves multiple turns (code write → run → check → revise).
Within a phase, turns should be frequent enough to stay within the 5-min
TTL. This is natural — agentic code-writing loops iterate fast.

The critical moment is the **phase transition**. When `record_phase` fires:

1. Harness triggers context compaction (clears conversation history)
2. Agent restarts with clean context for the next phase
3. System prompt prefix [1]+[2] is still cached if within TTL
4. New phase instructions [4] are appended

If compaction + phase transition takes < 5 minutes (it should — it's
a harness operation, not waiting for human input), the cached prefix
survives. The agent pays full input cost only for the new phase context.

### Timing implications

```
Phase N completes
  → record_phase tool call (~instant)
  → harness reads phase dir (~instant)
  → harness appends to manifest (~instant)
  → harness triggers compaction (~seconds)
  → agent resumes with clean context
  → first turn of Phase N+1

Total gap: seconds, well within 5-min TTL
```

Because LabRat is autonomous (no human in the loop during execution),
there are no idle gaps where the cache would expire. The only idle gap
is between tasks, which is fine — each task can pay the cold-start cost.

### Extended TTL consideration

The 1-hour TTL tier costs 2x write but saves on long sessions. For a
5-phase analysis with ~10 turns per phase:

- **5-min TTL**: Cache stays warm within phases. May expire during
  particularly long phases (segmentation with many iterations). Cost
  is predictable — worst case is re-caching the prefix per phase.
- **1-hour TTL**: Cache survives across all phases of a single task.
  Worth it if the skill prefix is large (30K+ tokens) and phases are
  long. The 2x write cost amortizes over many reads.

**Default to 5-min TTL for hackathon.** It's simpler, the autonomous
loop keeps turns frequent, and the cost difference is marginal for a
demo. Revisit for production.

## Two sub-agent strategies and their cache implications

There are two ways to structure the reviewer's relationship to the
worker's session:

### Strategy A: Fork the conversation

Clone the worker's session state. The reviewer starts with the full
worker context and adds reviewer instructions on top.

- **Cache impact**: Reviewer inherits the worker's cached prefix, BUT
  also inherits the full conversation history (all turns, all code
  output, all evidence descriptions). This defeats the purpose of
  independent review — the reviewer is biased by the worker's reasoning.
- **Token cost**: High. The reviewer loads everything the worker saw.
- **Verdict**: Wrong for LabRat. We want independent review.

### Strategy B: Fresh session with anchor-based history access

Create a completely new session for the reviewer. Load the same skill
prefix (cache hit if within TTL), but give the reviewer structured
access to the worker's outputs via **conversation anchors** — not the
raw conversation.

- **Cache impact**: The skill prefix [1]+[2] is shared between worker
  and reviewer sessions. If both run within the TTL window, the reviewer
  gets a cache hit on the skill text. The reviewer's context is small:
  skill prefix + phase records + anchor-based lookups.
- **Token cost**: Low. The reviewer reads structured outputs (phase
  directories), not the worker's full reasoning chain.
- **Verdict**: This is what LabRat uses.

## Conversation anchors

Each significant step in the worker's session gets an **anchor ID** —
a short hash (not a UUID — too many tokens to generate and reference).
The anchor is a content-addressable identifier for a point in the
conversation tree.

```
anchor: a3f7c  →  "segmentation: threshold set to 2500 HU"
anchor: b1e2d  →  "segmentation: watershed split, 2 components"
anchor: c9a4f  →  "landmarks: trochlear groove placed at z=218"
```

### What anchors enable

The reviewer (or any sub-agent) can:

- **Look up** a specific anchor to read what happened at that point
- **Explore up** the conversation tree to see what led to a decision
- **Explore down** to see what followed from a decision

This gives the reviewer an **overview lens** — it can examine what the
worker did wrong at specific points without loading the entire session.
The reviewer sees the structured outputs (phase records) by default,
and uses anchors to drill into specific decisions when something looks
off.

### Anchor format

Short hash, 5-6 characters. Generated by the harness from a hash of
the conversation turn content. The agent references anchors in its
phase records:

```markdown
## Decisions

- Threshold set to 2500 HU based on histogram bimodality [anchor:a3f7c]
- Watershed seeds placed at diaphyseal ends [anchor:b1e2d]
- Split produced 2 components; femur identified by condyle count [anchor:d4b8a]
```

### Anchor resolution

The harness provides a tool (e.g., `explore_anchor`) that:

1. Takes an anchor ID and a direction (up/down/context)
2. Returns a summary of that conversation turn and its neighbors
3. Does NOT dump the full conversation — returns a bounded window

This keeps the reviewer's context small while giving it the ability to
investigate specific decisions.

### Cache implications of anchors

Anchor lookups are small, targeted reads — they don't pollute the
reviewer's context with the worker's full chain. The reviewer's system
prompt stays stable (skill prefix + reviewer instructions), so the
cached prefix survives across multiple anchor lookups.

## Parameter changes and timing effects

| Change | Effect on cache | Effect on cost |
|---|---|---|
| Adding a resource to the skill | Invalidates cached prefix | One cold read, then re-cached |
| Changing ground-truth gates | Invalidates layer [2] | One cold read per task |
| Changing phase order | No effect on prefix | Phase instructions [4] are per-phase anyway |
| Adding reviewer iterations (K) | More turns in reviewer session | More cached reads of reviewer prefix |
| Switching from 5-min to 1-hour TTL | Cache survives longer | 2x write cost, fewer re-caches |
| Longer phases (more iterations) | Risk of TTL expiry within phase | Consider 1-hour TTL for production |

## Cost model sketch (per task, 5-min TTL)

Assumptions: skill prefix 25K tokens, 5 phases, 10 turns/phase,
reviewer 5 turns, Sonnet 4.6 pricing ($3/M input, $15/M output).

| Component | Tokens | Cost |
|---|---|---|
| Skill prefix cold read (worker) | 25K input | $0.075 |
| Skill prefix cached reads (49 turns) | 25K × 49 × 0.1 | $0.368 |
| Conversation turns (estimated) | ~500K total input | $1.50 |
| Output tokens (estimated) | ~200K total output | $3.00 |
| Reviewer session | ~100K input + 50K output | $1.05 |
| **Total per task** | | **~$6.00** |

vs. without caching (every turn reads full prefix):

| Component | Tokens | Cost |
|---|---|---|
| Skill prefix every turn (50 turns) | 25K × 50 | $3.75 |
| Everything else | same | $4.55 |
| **Total per task** | | **~$8.30** |

Caching saves ~28% on input costs. For a 30-sample study, that's
~$70 saved. Not dramatic at hackathon scale, but meaningful for
production.

## Implementation notes for hackathon

1. **System prompt structure**: Concatenate SKILL.md + resources as
   the system prompt prefix. Mark with `cache_control`.
2. **Use 5-min TTL**: Default, no configuration needed.
3. **Autonomous pacing keeps cache warm**: No human idle time means
   turns stay within TTL naturally.
4. **Fresh reviewer session**: Load same skill prefix (cache hit),
   give reviewer the phase directory paths + anchor tool.
5. **Don't optimize early**: Get it working first. Cache strategy is
   a parameter change, not an architecture change.
