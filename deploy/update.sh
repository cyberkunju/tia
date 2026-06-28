#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# TIA continuous deploy. Polls origin's default branch; on a new commit it
# pulls and runs `docker compose up -d --build`. Idempotent, lock-guarded,
# self-locating (works from wherever the repo is checked out).
# Invoked every minute by the tia-deploy.timer systemd user unit.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

LOG="${TIA_DEPLOY_LOG:-$HOME/Deploy/tia-deploy.log}"
mkdir -p "$(dirname "$LOG")"

# Single-flight: never let two deploys overlap.
exec 9>"/tmp/tia-deploy.lock"
flock -n 9 || { echo "$(date -Is) busy, skip" >>"$LOG"; exit 0; }

log() { echo "$(date -Is) $*" >>"$LOG"; }

# Default branch tracked by origin/HEAD (no network needed for the name).
BRANCH="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
BRANCH="${BRANCH:-master}"

git fetch --quiet origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

[ "$LOCAL" = "$REMOTE" ] && exit 0   # nothing new

log "change on $BRANCH: ${LOCAL:0:7} -> ${REMOTE:0:7}; deploying"
git reset --hard "origin/$BRANCH"                 >>"$LOG" 2>&1
docker compose up -d --build --remove-orphans     >>"$LOG" 2>&1
docker image prune -f                             >>"$LOG" 2>&1

# Post-deploy health gate: confirm the stack actually serves before calling it a
# success, so a broken build is surfaced in the log instead of silently "deployed".
# Hits the api /health through the nginx edge (the same path real traffic uses).
WEB_PORT="$(sed -n 's/^WEB_PORT=//p' .env 2>/dev/null | tr -d '"'\''' | head -n1)"
WEB_PORT="${WEB_PORT:-8090}"
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${WEB_PORT}/api/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
if [ "$healthy" = 1 ]; then
  log "deploy ok @ $(git rev-parse --short HEAD) - health check passed"
else
  log "DEPLOY WARNING @ $(git rev-parse --short HEAD) - /api/health not OK after 60s; check 'docker compose logs'"
fi
