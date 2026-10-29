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
STALE_MIN=110

now() { date +%s; }

age_min() {
  local ts="$1"
  echo $(( ( $(now) - ts ) / 60 ))
}

case "${1:-status}" in
  start)
    if [[ -d "$LOCK" ]]; then
      ts=$(cat "$LOCK/since" 2>/dev/null || echo 0)
      pid=$(cat "$LOCK/pid" 2>/dev/null || echo "?")
      mins=$(age_min "${ts:-0}")
      if (( mins < STALE_MIN )) && kill -0 "$pid" 2>/dev/null 2>&1; then
        echo "busy: session $pid has held the lock for ${mins}m" >&2
        exit 1
      fi
      if (( mins < STALE_MIN )); then
        echo "busy: lock from pid $pid (${mins}m, pid gone but not yet stale)" >&2
        exit 1
      fi
      echo "stale lock from pid $pid (${mins}m) — taking over" >&2
      rm -rf "$LOCK"
    fi
    mkdir -p "$LOCK"
    echo $$ > "$LOCK/pid"
    now > "$LOCK/since"
    echo "locked by $$ at $(date -Is)"
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
      echo "held by $(cat "$LOCK/pid" 2>/dev/null) for $(age_min "${ts:-0}")m"
    else
      echo "free"
    fi
    ;;
  *)
    echo "usage: $0 start|stop|status" >&2
    exit 2
    ;;
esac
