#!/usr/bin/env bash
#
# Export the repo's vendored skills into a Claude Science registry, so the
# LabRat harness (which resolves skills from the registry, not from repo/skills)
# can run them.
#
# Source of truth: <repo>/skills/. This installs/updates each skill into
#   $CLAUDE_SCIENCE_HOME/orgs/<org>/skills/<name>/
# It MERGES (copies over), preserving any Claude Science bookkeeping already in
# the target (e.g. .catalog_stamp, .sync-org) rather than wiping the dir.
#
# Usage:
#   scripts/export-skills-to-claude-science.sh [--dry-run]
#
# Env:
#   CLAUDE_SCIENCE_HOME   default: ~/.claude-science
#   CLAUDE_SCIENCE_ORG    org id; auto-detected when exactly one org exists
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/skills"
SCIENCE_HOME="${CLAUDE_SCIENCE_HOME:-$HOME/.claude-science}"
ORGS="$SCIENCE_HOME/orgs"

[[ -d "$SRC" ]]  || { echo "error: no skills/ dir at $SRC" >&2; exit 1; }
[[ -d "$ORGS" ]] || { echo "error: Claude Science orgs dir not found: $ORGS (set CLAUDE_SCIENCE_HOME)" >&2; exit 1; }

# Resolve target org.
if [[ -n "${CLAUDE_SCIENCE_ORG:-}" ]]; then
  ORG="$CLAUDE_SCIENCE_ORG"
else
  mapfile -t ORGS_FOUND < <(find "$ORGS" -mindepth 1 -maxdepth 1 -type d -printf '%f\n')
  case ${#ORGS_FOUND[@]} in
    1) ORG="${ORGS_FOUND[0]}" ;;
    0) echo "error: no orgs under $ORGS" >&2; exit 1 ;;
    *) echo "error: multiple orgs — set CLAUDE_SCIENCE_ORG to one of: ${ORGS_FOUND[*]}" >&2; exit 1 ;;
  esac
fi

DEST="$ORGS/$ORG/skills"
echo "Exporting skills"
echo "  from: $SRC"
echo "  to:   $DEST"
[[ $DRY_RUN -eq 1 ]] && echo "  (dry run — no changes)"

count=0
for skill in "$SRC"/*/; do
  name="$(basename "$skill")"
  target="$DEST/$name"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  would install: $name"
  else
    mkdir -p "$target"
    cp -R "$skill." "$target/"
    echo "  installed: $name"
  fi
  count=$((count + 1))
done

echo "Done — $count skill(s) → org $ORG."
