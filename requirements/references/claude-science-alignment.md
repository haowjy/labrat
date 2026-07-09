# Claude Science Alignment

How LabRat's features map to Claude Science's existing marketing and
architecture. LabRat extends Claude Science — this document shows that
the extension is natural, not bolted on.

## Feature mapping

| Claude Science feature | How LabRat extends it |
|---|---|
| **60+ curated skills** | LabRat reads skills directly from `~/.claude-science/`. Skills authored in Claude Science become execution protocols for LabRat. No duplication, no translation layer. |
| **Auditable provenance** ("every output carries an auditable history") | LabRat's `provenance/manifest.yaml` follows the same prov-model from the microct-analysis provenance skill. Every phase records technique, parameters, evidence, decisions, code. The provenance is structured folders on disk, not opaque logs. |
| **Actor-critic pairs** | Worker agent + reviewer agent. Independent sessions, independent context. The reviewer doesn't share the worker's reasoning chain — same principle as Claude Science's actor-critic architecture, extended to autonomous execution. |
| **Reviewer agent** | LabRat's reviewer is a separate Agent SDK session that loads the same skills and ground-truth gates. Bounded K=2 iterations. Judge-gates what reaches the scientist. |
| **Session forking** | LabRat creates fresh reviewer sessions (not forks) with conversation anchors for selective history access — the reviewer can explore the worker's session tree without loading the full context. See `architecture/reviewer-anchoring.md`. |
| **Reproducible workflows** ("figures include exact code + environment + plain-language description + full message history") | Each phase records the code the agent wrote (`code/`), the decisions (`decisions.md`), the evidence (`evidence/`), and the measurements (`measurements.json`). The provenance manifest ties it together. Same protocol + same gates = same analysis. |
| **Skill system** (SKILL.md, resources, assets) | LabRat treats skills as protocol definitions. The skill's agentic loop instructions (render → reason → validate → gate) become the worker's methodology. Ground-truth gates from assets become pass/fail criteria. |
| **skill-creator / paper-protocol-to-skill** | The authoring loop stays in Claude Science. LabRat is the execution loop. Suggestions captured during review feed back to the skill author for the next revision. |

## The extension relationship

Claude Science is for **interactive, human-in-the-loop** scientific analysis.
The scientist works with Claude, session by session, directing the analysis.

LabRat is for **autonomous, batch execution** of protocols that have already
been refined in Claude Science. The scientist reviews afterward, not during.

```
Authoring (Claude Science)         Execution (LabRat)           Refinement
┌─────────────────────┐          ┌──────────────────────┐
│ Scientist + Claude   │          │ Autonomous agent      │
│ refine the protocol  │  skills  │ executes the protocol │  suggestions
│ interactively        ├─────────►│ on new data           ├──────────┐
│                      │          │                       │          │
│ skill-creator        │          │ worker + reviewer     │          │
│ paper-to-skill       │          │ provenance + gates    │          │
└─────────────────────┘          └──────────────────────┘          │
        ▲                                                          │
        └──────────────────────────────────────────────────────────┘
```

## What Claude Science already claims that LabRat delivers

From Claude Science marketing (claude.ai/science):

> "Every output carries an auditable history — reproducible, transparent,
> and built to meet the standards of peer review."

LabRat operationalizes this for batch processing. The provenance manifest
is machine-readable, the review chain is human-readable, and every
measurement traces back through artifact → phase → technique → decision.

> "Actor-critic pairs catch errors before they compound."

LabRat's worker/reviewer architecture is exactly this, extended to run
without human intervention. The reviewer catches errors; the scientist
reviews the reviewer's findings — two layers of verification.

> "60+ skills across domains"

Each skill is a potential LabRat protocol. The skill author doesn't need
to know about LabRat — they write a skill in Claude Science, and LabRat
can execute it if it follows the `record_phase` pattern.

## What LabRat adds beyond Claude Science

| Capability | Claude Science | LabRat |
|---|---|---|
| **Batch processing** | One session, one dataset | Folder watcher queues datasets, processes sequentially |
| **Autonomous execution** | Human directs each step | Agent follows skill protocol end-to-end |
| **Cross-session review** | Within-session actor-critic | Separate reviewer session with selective history access |
| **Dashboard** | Session transcript | Phase-by-phase review UI with evidence, measurements, gates |
| **Suggestion loop** | Verbal feedback in session | Structured suggestions in DB, readable by skill author |
| **Context management** | Manual session forking | `record_phase` compaction with provenance persistence |

## Demo angle

"Claude Science is how you build the analysis protocol. LabRat is how you
run it 30 times." The demo shows one execution of one protocol — but the
architecture generalizes to any skill that follows the phase pattern.
