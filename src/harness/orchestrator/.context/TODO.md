# TODO — harness/orchestrator

Deferred work colocated with the state machine. Full triage: work-dir `gaps-backlog.md`.

- [ ] **`pending_review` state** (#6) — no such state today; gates auto-advance in
  `runGate`. Add it as either a human-approval gate (pauses the run until sign-off,
  reusing `paused`) or an inbox (auto-advance + notify). Ties to the review-bundle
  dashboard view.
- [ ] **Blind held-out validation mode** (#7) — a terminal scoring phase that
  unseals a ground truth kept outside the worker trust boundary and scores the run
  (Dice/IoU). Two modes: production vs validation.
- [ ] **Orphan detection / run resume** (#11) — a killed run leaves `state: running`
  frozen and unrecoverable (see the OA6-1RK stalls). Add `resume <task-id>` (pick up
  from `currentPhase`) or startup detection of orphaned `running` tasks.
