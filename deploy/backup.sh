#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# TIA backup: Postgres dump + invoice-PDF archive, optionally encrypted and
# shipped off-box. Run by tia-backup.timer (daily) or `make db-backup`.
#
# The DB dump is the critical step (runs inside the db container over its local
# socket, so no password is read here). The PDF archive, encryption, and off-box
# upload are best-effort add-ons — a failure in any of them warns but never loses
# the local DB dump.
#
#   TIA_BACKUP_DIR          where backups are written  (default: ~/Deploy/tia-backups)
#   TIA_BACKUP_RETAIN       how many of each to keep    (default: 14)
#   TIA_DB_CONTAINER        db container                (default: tia-db-1)
#   TIA_API_CONTAINER       api container (holds PDFs)  (default: tia-api-1)
#   TIA_BACKUP_ENCRYPT_KEY  if set, AES-256 encrypt each artifact (openssl, pbkdf2)
#   TIA_BACKUP_REMOTE       if set, upload each artifact off-box via rclone or aws
#                           (e.g. "myremote:tia-backups" for rclone, or
#                            "s3://my-bucket/tia" for the aws CLI)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

BACKUP_DIR="${TIA_BACKUP_DIR:-$HOME/Deploy/tia-backups}"
RETAIN="${TIA_BACKUP_RETAIN:-14}"
DB_CONTAINER="${TIA_DB_CONTAINER:-tia-db-1}"
API_CONTAINER="${TIA_API_CONTAINER:-tia-api-1}"
mkdir -p "$BACKUP_DIR"

PGUSER="$(sed -n 's/^POSTGRES_USER=//p' .env 2>/dev/null | head -1)"; PGUSER="${PGUSER:-tia}"
PGDB="$(sed -n 's/^POSTGRES_DB=//p' .env 2>/dev/null | head -1)"; PGDB="${PGDB:-tia}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_OUT="$BACKUP_DIR/tia_${PGDB}_${STAMP}.sql.gz"
PDF_OUT="$BACKUP_DIR/tia_pdfs_${STAMP}.tar.gz"

artifacts=()

# 1) DB dump (critical — self-contained via --clean --if-exists).
docker exec "$DB_CONTAINER" pg_dump -U "$PGUSER" -d "$PGDB" --clean --if-exists | gzip -9 > "$DB_OUT"
echo "db backup ok: $DB_OUT ($(du -h "$DB_OUT" | cut -f1))"
artifacts+=("$DB_OUT")

# 2) Invoice-PDF archive (best-effort — the durable copy of generated invoices).
if docker exec "$API_CONTAINER" sh -c 'tar czf - -C /app/staging . 2>/dev/null' > "$PDF_OUT" 2>/dev/null \
   && [ -s "$PDF_OUT" ]; then
  echo "pdf archive ok: $PDF_OUT ($(du -h "$PDF_OUT" | cut -f1))"
  artifacts+=("$PDF_OUT")
else
  rm -f "$PDF_OUT"
  echo "warn: pdf archive skipped (api container '$API_CONTAINER' unavailable or empty staging)"
fi

# 3) Optional encryption (AES-256, key-derived with pbkdf2).
if [ -n "${TIA_BACKUP_ENCRYPT_KEY:-}" ]; then
  enc=()
  for f in "${artifacts[@]}"; do
    if openssl enc -aes-256-cbc -pbkdf2 -salt -in "$f" -out "$f.enc" -pass env:TIA_BACKUP_ENCRYPT_KEY; then
      rm -f "$f"; enc+=("$f.enc"); echo "encrypted: $f.enc"
    else
      echo "warn: encryption failed for $f (left plaintext)"; enc+=("$f")
    fi
  done
  artifacts=("${enc[@]}")
fi

# 4) Optional off-box upload (rclone or aws CLI, whichever is present).
if [ -n "${TIA_BACKUP_REMOTE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    for f in "${artifacts[@]}"; do rclone copy "$f" "$TIA_BACKUP_REMOTE" && echo "uploaded (rclone): $(basename "$f")" || echo "warn: rclone upload failed for $f"; done
  elif command -v aws >/dev/null 2>&1; then
    for f in "${artifacts[@]}"; do aws s3 cp "$f" "${TIA_BACKUP_REMOTE%/}/" && echo "uploaded (aws): $(basename "$f")" || echo "warn: aws upload failed for $f"; done
  else
    echo "warn: TIA_BACKUP_REMOTE set but neither rclone nor aws found — off-box upload skipped"
  fi
fi

# 5) Retain only the newest $RETAIN of each artifact family (incl .enc variants).
for pat in "tia_${PGDB}_*.sql.gz*" "tia_pdfs_*.tar.gz*"; do
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR"/$pat 2>/dev/null | tail -n +"$((RETAIN + 1))" | xargs -r rm -f
done
echo "retained newest $RETAIN of each family in $BACKUP_DIR"
