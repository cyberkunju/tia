#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# TIA database backup. pg_dump the compose Postgres to a timestamped, gzipped
# dump and prune old ones. Run by tia-backup.timer (daily) or `make db-backup`.
#
# pg_dump runs INSIDE the db container over its local socket, so no password is
# read or passed here. Backups land outside the repo (gitignored by location).
#
#   TIA_BACKUP_DIR     where dumps are written   (default: ~/Deploy/tia-backups)
#   TIA_BACKUP_RETAIN  how many dumps to keep     (default: 14)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

BACKUP_DIR="${TIA_BACKUP_DIR:-$HOME/Deploy/tia-backups}"
RETAIN="${TIA_BACKUP_RETAIN:-14}"
CONTAINER="${TIA_DB_CONTAINER:-tia-db-1}"
mkdir -p "$BACKUP_DIR"

PGUSER="$(sed -n 's/^POSTGRES_USER=//p' .env 2>/dev/null | head -1)"; PGUSER="${PGUSER:-tia}"
PGDB="$(sed -n 's/^POSTGRES_DB=//p' .env 2>/dev/null | head -1)"; PGDB="${PGDB:-tia}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/tia_${PGDB}_${STAMP}.sql.gz"

# --clean --if-exists makes the dump self-contained and idempotent on restore.
docker exec "$CONTAINER" pg_dump -U "$PGUSER" -d "$PGDB" --clean --if-exists \
  | gzip -9 > "$OUT"

echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"

# Retain only the newest $RETAIN dumps.
ls -1t "$BACKUP_DIR"/tia_*.sql.gz 2>/dev/null | tail -n +"$((RETAIN + 1))" | xargs -r rm -f
echo "retained newest $RETAIN dump(s) in $BACKUP_DIR"
