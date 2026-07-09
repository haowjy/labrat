# System Architecture

## LabRat as Claude Science Extension

LabRat is not standalone. It reads directly from `~/.claude-science/`:

- **Skills** — protocol instructions (SKILL.md), resources, reference
  figures, ground-truth gates
- **Runtime** — kernel helpers (kernel.py) injected into the agent's
  environment
- **Agents** — agent profiles that define roles and model selection

The authoring loop lives in Claude Science (skill-creator,
paper-protocol-to-skill). The execution loop lives in LabRat.

```
Claude Science (authoring)              LabRat (execution)
┌─────────────────────────┐            ┌──────────────────────────────┐
│ Skills, agents, runtime │   reads    │ Agent SDK harness            │
│                         ├───────────►│   ~/.claude-science/         │
│ skill-creator           │            │                              │
│ paper-protocol-to-skill │            │ folder watcher →             │
│ microct-3d-analysis     │  feedback  │   detect type →              │
│ <protocol skills>       │◄───────────┤   load skills →              │
│                         │            │   worker + reviewer →        │
│ Skill author reads      │            │   review chain →             │
│ accumulated suggestions │            │   dashboard                  │
└─────────────────────────┘            └──────────────────────────────┘
```

## Technology

| Layer | Choice | Why |
|---|---|---|
| Agent runtime | `@anthropic-ai/claude-agent-sdk` (TypeScript) | Sessions, hooks, tool management, conversation control |
| Skills/runtime | `~/.claude-science/` | Extension of Claude Science |
| Web server | Express.js | Minimal, serves dashboard and task API |
| Real-time updates | Server-Sent Events | One-directional progress |
| Dashboard UI | HTML + vanilla JS | No build step, fast iteration |
| Task state | SQLite or JSON files | Local, queryable for suggestions |
| Imaging | Python (nibabel, scipy, skimage, matplotlib) | Agent writes + runs via Bash tool |
| Data format | DICOM (.dcm series or .zip) | What the scanner exports |
| Agent model | claude-sonnet-4-6 | Worker and reviewer |

## File Intake

### MVP: local folder watcher

Watch a configured directory. When a DICOM series directory (or zip)
appears, queue a task. One configured protocol per watched folder.

### Later: Box integration, auto-detection

Not in hackathon scope unless time allows.

## Dashboard

Web UI served by Express.js. Connected to the running LabRat instance.
Demo via Tailscale.

### Task list / queue
- Current task: status, progress (streamed via SSE)
- Queue: upcoming files detected by watcher
- History: completed tasks with links to review chain

### Review chain (per task)
Shows every major phase the agent executed. For each phase, the dashboard
reads the phase directory (see `protocols/task-directory.md`).

### Suggestion capture
Per-phase text input. Stored in local DB. Accumulated suggestions readable
by skill author in Claude Science for protocol refinement.

### Design direction
Clean, clinical, high-contrast. Dark background for imaging evidence.
Monospace for measurements. System fonts. One accent color.
