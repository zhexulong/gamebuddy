#!/bin/sh
# CI sentinel: standing watcher that EXITS when a new failed run appears on
# origin (any workflow, any branch push we made), so a tracked background
# task wrapping it delivers a fail-fast wake. Re-arm after each wake.
#
# Usage: scripts/ci-sentinel.sh [max_hours]
# Exit 1 = new CI failure detected (details on stdout).
# Exit 0 = clean window elapsed (default 8h) — re-arm.
set -u
MAX_HOURS="${1:-8}"
DEADLINE=$(( $(date +%s) + MAX_HOURS * 3600 ))
SEEN_FILE="${HOME}/.local/share/cortexkit/mc-ci-sentinel-seen"
touch "$SEEN_FILE"

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  FAILS=$(gh run list --limit 15 --json databaseId,workflowName,headBranch,conclusion,createdAt \
    -q '.[] | select(.conclusion=="failure") | "\(.databaseId) \(.workflowName) \(.headBranch) \(.createdAt)"' 2>/dev/null)
  if [ -n "$FAILS" ]; then
    NEW=$(printf '%s\n' "$FAILS" | while read -r id rest; do
      grep -qF "$id" "$SEEN_FILE" || printf '%s %s\n' "$id" "$rest"
    done)
    if [ -n "$NEW" ]; then
      printf '%s\n' "$NEW" | while read -r id rest; do printf '%s\n' "$id" >> "$SEEN_FILE"; done
      echo "CI FAILURE DETECTED:"
      printf '%s\n' "$NEW"
      FIRST=$(printf '%s\n' "$NEW" | head -1 | cut -d' ' -f1)
      gh run view "$FIRST" --json jobs \
        -q '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | "  job: \(.name)"' 2>/dev/null
      exit 1
    fi
  fi
  sleep 45
done
echo "clean window elapsed (${MAX_HOURS}h) — re-arm the sentinel"
exit 0
