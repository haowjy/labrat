# Phase-harness eval

Proves a single protocol phase can be run **in isolation** — reset,
re-run, resumed — without re-running the whole pipeline.

Exercises three CLI-level entry points against a fixture task tree
(`validation/fixtures/toy-stats-task/`, a completed `toy-stats` run):

- `resetTaskToPhase` (CLI: `run-phase`'s sibling, `reset-to <task-id>
  <phase>`) — truncates the fixture's `phasesComplete` to just before
  `regression` and deletes `phases/regression/` + `artifacts/regression/`,
  undoing the fixture's shipped-complete state for that one phase.
- `runPhaseInIsolation` (CLI: `run-phase <task-id> <phase> [--gate]`) —
  runs *only* the `regression` phase's worker against the untouched
  `classify` outputs already on disk, reconstructing `priorPhaseSummaries`
  from `phases/classify/summary.md` rather than any in-memory state.
- Asserts `artifacts/regression/regression.json` reappears with the shape
  the regression skill is expected to produce (`slope`, `intercept`,
  `r_squared`, `n`).

## Running it

This is a **live** run: `run-phase` drives the real worker through the
Claude Agent SDK, so it needs the same environment `labrat enqueue` needs:

- API auth configured for the SDK.
- `~/.claude-science` provisioned with the `toy-stats` skill + its conda
  env (`environment.yml` under `skills/toy-stats/`).

```
npx tsx validation/phase-harness/eval.ts
```

The fixture itself is never mutated — the eval copies
`validation/fixtures/toy-stats-task/` into a fresh `mkdtemp` scratch
`tasks/` root, runs against the copy, and deletes the scratch dir when
done (pass or fail).

## Manual walkthrough

Same steps, run by hand against a real task dir (see the top-level
`AGENTS.md` / lane report for a full transcript):

```
npm run dev -- reset-to <task-id> regression
npm run dev -- run-phase <task-id> regression
npm run dev -- resume <task-id>
```
