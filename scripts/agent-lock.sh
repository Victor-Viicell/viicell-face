#!/usr/bin/env bash
# Single-writer guard for the rotating agent sessions.
#
#   scripts/agent-lock.sh start   # exit 1 if another session holds it
#   scripts/agent-lock.sh status
#   scripts/agent-lock.sh stop
#
# A lock older than STALE_MIN minutes is considered abandoned (a session that
# crashed or was killed) and is taken over, with a warning.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$ROOT/.agent-lock"
# A session is expected to finish a ticket well inside this window. The script
# itself exits immediately, so liveness cannot be checked with kill(0) — the
# lock is purely time-based, and a dead session frees it after one hour.
STALE_MIN=75

now() { date +%s; }

age_min() {
  local ts="$1"
  echo $(( ( $(now) - ts ) / 60 ))
}

case "${1:-status}" in
  start)
    if [[ -d "$LOCK" ]]; then
      ts=$(cat "$LOCK/since" 2>/dev/null || echo 0)
      owner=$(cat "$LOCK/owner" 2>/dev/null || echo "?")
      mins=$(age_min "${ts:-0}")
      if (( mins < STALE_MIN )); then
        echo "busy: held by $owner for ${mins}m" >&2
        exit 1
      fi
      echo "stale lock ($owner, ${mins}m) — taking over" >&2
      rm -rf "$LOCK"
    fi
    mkdir -p "$LOCK" || exit 1
    echo "${2:-$(hostname)-$$}" > "$LOCK/owner"
    now > "$LOCK/since"
    echo "locked by $(cat "$LOCK/owner") at $(date -Is)"
    ;;
  stop)
    if [[ -d "$LOCK" ]]; then
      rm -rf "$LOCK"
      echo "released"
    else
      echo "no lock"
    fi
    ;;
  status)
    if [[ -d "$LOCK" ]]; then
      ts=$(cat "$LOCK/since" 2>/dev/null || echo 0)
      echo "held by $(cat "$LOCK/owner" 2>/dev/null || echo '?') for $(age_min "${ts:-0}")m"
    else
      echo "free"
    fi
    ;;
  *)
    echo "usage: $0 start|stop|status" >&2
    exit 2
    ;;
esac
