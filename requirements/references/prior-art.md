# Prior Art and Design Inspirations

## CodeRabbit — the primary model

CodeRabbit is the architectural template for LabRat. Both are autonomous
review systems that process incoming artifacts through a structured pipeline
with independent verification.

### Key patterns adopted

- **Fixed pipeline stages, not free-roaming.** CodeRabbit looks like a
  free-roaming agent but is tightly constrained: fixed stages, bounded
  recursion, judge gating. LabRat uses protocol-defined phases from the
  skill, not unbounded exploration.

- **Review agent + verification agent separation.** The review agent
  surfaces findings; verification agents filter before anything reaches
  the human. LabRat: worker agent produces analysis; reviewer agent
  independently verifies before the dashboard shows results.

- **Bounded recursion.** CodeRabbit caps investigation depth to prevent
  infinite loops. LabRat: K review iterations (default 2), then surface
  remaining concerns with confidence flags.

- **Sandbox execution.** CodeRabbit's agent writes shell commands in a
  sandbox rather than calling predefined tools — "no tool schemas to
  maintain." LabRat: the agent writes Python on the fly, not calling
  fixed pipeline drivers.

- **Queue decouples intake from execution.** CodeRabbit uses Cloud Tasks
  to handle PR bursts. LabRat: folder watcher queues tasks, harness
  processes one at a time.

### Sources
- [How CodeRabbit Works: Inside Its AI Code Review Pipeline](https://medium.com/data-science-collective/how-coderabbit-actually-works-331aeab55ec8)
- [CodeRabbit built with Google Cloud Run](https://cloud.google.com/blog/products/ai-machine-learning/how-coderabbit-built-its-ai-code-review-agent-with-google-cloud-run)
- [Architecting CodeRabbit at scale: Event Storm & Context Engine](https://learnwithparam.com/blog/architecting-coderabbit-ai-agent-at-scale)
- [Pipeline AI vs. agentic AI for code reviews](https://www.coderabbit.ai/blog/pipeline-ai-vs-agentic-ai-for-code-reviews-let-the-model-reason-within-reason)

## PROV-AGENT — provenance for agentic workflows

Unified provenance tracking for AI agent interactions. Enables queries for
agent decisions' rationales, root-cause tracing, downstream impact, and
hallucination detection by comparing generated data against domain
constraints.

Relevant to LabRat's phase compaction → provenance pattern: every
compaction extracts findings to a persistent record, making the agent's
reasoning auditable even after context is trimmed.

### Source
- [PROV-AGENT: Unified Provenance for Tracking AI Agent Interactions](https://arxiv.org/abs/2508.02866)

## Experiment-as-Code Labs

Encodes experiments as declarative configurations compiled to device-level
APIs. As workflows become adaptive, there's a growing gap in mechanisms
for specifying, modifying, and reasoning about experiments.

Relevant to LabRat: the skill (SKILL.md) is the declarative specification;
the agent is the adaptive execution; the provenance manifest is the
reasoning record.

### Source
- [Experiment-as-Code Labs: A Declarative Stack](https://arxiv.org/abs/2605.04375)

## Agent Laboratory

LLM agents as research assistants. Demonstrates agents conducting
literature review, generating research ideas, designing experiments,
executing in silico, analyzing data, and drafting papers.

Relevant: the pattern of autonomous multi-phase scientific work with
structured outputs at each phase.

### Source
- [Agent Laboratory: Using LLM Agents as Research Assistants](https://arxiv.org/abs/2501.04227)

## Meridian Dev-Workflow — the builder/reviewer loop

From the prompts repo. The dev-workflow pattern uses:
- Independent builder and reviewer agents
- Review as adversarial verification ("find the risks the implementer
  can't see")
- Bounded review iterations
- Structured finding reports with severity and fix direction
- Frame-rot escalation when patching won't converge

LabRat adopts this directly: worker = builder, reviewer = reviewer,
with the same independence and bounded-iteration patterns.

### Source
- `../prompts/meridian-dev-workflow/skills/review/SKILL.md`
- `../prompts/meridian-dev-workflow/skills/dev-workflow/SKILL.md`

## Microct-Analysis Provenance Skill

From the prompts repo. Defines:
- Vocabulary: protocol, technique, step, judgment, analysis run, artifact
- Minimum record per step: inputs, technique, parameters, command, outputs,
  QC evidence, judgment, confidence, deviations
- Prov-model: YAML manifest shape aligned with W3C PROV
- Reviewer rule: if a result number cannot be traced through
  artifact → step → technique/protocol → judgment, provenance is incomplete

LabRat's `provenance/manifest.yaml` follows this model directly.

### Source
- `../prompts/microct-analysis/skills/provenance/SKILL.md`
- `../prompts/microct-analysis/skills/provenance/resources/prov-model.md`

## Claude Science Skill-Creator

The full skill authoring loop: draft → test → review → improve → publish.
Includes eval framework, blind comparison, description optimization.
Skills are authored via `host.skills.*` SDK. This is the authoring
environment that produces the protocols LabRat executes.

### Source
- `~/.claude-science/.../skills/skill-creator/SKILL.md`

## Paper-Protocol-to-Skill

Turns published methods sections into operational analysis skills.
Extracts landmark definitions, captures reference figures and published
values as ground-truth gates, flags every step the paper leaves
underspecified. This is how the mouse-knee OA skill was built.

The pattern: operationalize (not just describe), gate every value, flag
what's left to judgment.

### Source
- `~/.claude-science/.../skills/paper-protocol-to-skill/SKILL.md`

## Other scientific agent systems (2025-2026)

- **GPT-5 + Ginkgo Bioworks** (Feb 2026): autonomously designed and
  iterated 36,000+ experiments across six rounds, human involvement
  limited to reagent prep and plate loading.
- **The AI Scientist, Robin, SciSciGPT, Biomni, OpenLens AI**: autonomous
  scientific discovery agents spanning hypothesis to paper.
- **ChemCrow**: LLM front-end grafted onto chemistry tools via action-queue
  API — similar queue-based architecture to LabRat.

### Sources
- [AI, agentic models and lab automation — the beginning of scAInce](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1649155/full)
- [A Survey of AI Scientists](https://arxiv.org/abs/2510.23045)
- [Graph of Trace: Visualizing Execution Traces of Scientific Agents](https://arxiv.org/abs/2606.15116)
