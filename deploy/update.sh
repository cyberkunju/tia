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

# Quarantine: if the incoming commit already failed health + was rolled back,
# don't redeploy it every minute — wait for a NEW commit (a fix) to supersede it.
QUARANTINE="${TIA_DEPLOY_QUARANTINE:-$HOME/Deploy/tia-bad-commit}"
if [ -f "$QUARANTINE" ] && [ "$(cat "$QUARANTINE" 2>/dev/null)" = "$REMOTE" ]; then
  exit 0
fi

WEB_PORT="$(sed -n 's/^WEB_PORT=//p' .env 2>/dev/null | tr -d '"'\''' | head -n1)"
WEB_PORT="${WEB_PORT:-8090}"
check_health() {
  for _ in $(seq 1 30); do
    curl -fsS "http://localhost:${WEB_PORT}/api/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
deploy() { docker compose up -d --build --remove-orphans >>"$LOG" 2>&1; docker image prune -f >>"$LOG" 2>&1; }

PREV="$LOCAL"   # the commit we're leaving — it was serving, so it's the rollback target
log "change on $BRANCH: ${LOCAL:0:7} -> ${REMOTE:0:7}; deploying"
git reset --hard "origin/$BRANCH" >>"$LOG" 2>&1
deploy

if check_health; then
  log "deploy ok @ $(git rev-parse --short HEAD) - health check passed"
  rm -f "$QUARANTINE"   # clear any prior quarantine now that we're healthy
else
  log "DEPLOY FAILED @ ${REMOTE:0:7} - /api/health not OK after 60s; rolling back to ${PREV:0:7}"
  echo "$REMOTE" > "$QUARANTINE"          # don't retry this bad commit until a fix lands
  git reset --hard "$PREV" >>"$LOG" 2>&1
  deploy
  if check_health; then
    log "ROLLBACK ok - restored ${PREV:0:7}; bad commit ${REMOTE:0:7} quarantined (push a fix to retry)"
  else
    log "ROLLBACK FAILED - ${PREV:0:7} also unhealthy; MANUAL intervention needed (docker compose logs)"
  fi
fi
