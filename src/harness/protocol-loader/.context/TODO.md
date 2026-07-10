# TODO — harness/protocol-loader

Deferred work colocated with skill/protocol resolution. Full triage: work-dir `gaps-backlog.md`.

- [ ] **Load skills/ + agents/ from the repo directly** (#9) — resolution currently
  scans the Claude Science registry (`$CLAUDE_SCIENCE_HOME/orgs/*/skills/`). Make it
  also read the repo's vendored `skills/` and `agents/` so the repo is self-runnable
  and the `export-skills-to-claude-science.sh` bridge becomes optional.
