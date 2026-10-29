#!/usr/bin/env bash
# Cheap context for a cron session: no tests, no builds, just facts.
# Injected into the agent prompt as the `script` of the hourly job.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 0

echo "=== lock ==="
scripts/agent-lock.sh status

echo
echo "=== branch / last commits ==="
git rev-parse --abbrev-ref HEAD
git log --oneline -6

echo
echo "=== working tree ==="
if [[ -z "$(git status --porcelain)" ]]; then
  echo "clean"
else
  git status --short | head -20
  echo "(dirty: a previous session may have died mid-ticket)"
fi

echo
echo "=== next ticket ==="
sed -n '1,40p' docs/NEXT.md 2>/dev/null || echo "docs/NEXT.md missing"

echo
echo "=== open tickets ==="
grep -c '^- \[ \]' docs/SHIP-PLAN.md 2>/dev/null
grep -c '^- \[!\]' docs/SHIP-PLAN.md 2>/dev/null

echo
echo "=== last progress entry ==="
awk '/^## /{n++} n>=2' docs/PROGRESS.md 2>/dev/null | head -20
