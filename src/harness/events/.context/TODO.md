# TODO — harness/events

Deferred work colocated with this module. Full triage: work-dir `gaps-backlog.md`.

- [ ] **Lifecycle hooks + notification delivery** (#5) — this module's `notifyEvent`
  → dashboard `publishEvent` is the single choke point every state transition
  flows through. A hook system taps it here: skill-declared code on transitions,
  first use = researcher notifications (cadence immediate/digest/stream;
  configurable channels + secrets). Skill declares intent; user config owns
  policy/secrets; harness enforces.
