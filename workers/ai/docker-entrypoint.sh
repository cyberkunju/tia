#!/usr/bin/env sh
# ─────────────────────────────────────────────────────────────────────────────
# TIA API entrypoint: wait for the DB, seed master data + eval fixtures once,
# then hand off (exec) to uvicorn so signals/PID 1 behave correctly.
# Everything here is idempotent and individually toggleable via env vars.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

# 1) Block until Postgres accepts connections (no-op for SQLite).
python - <<'PY'
import os, sys, time
url = os.environ.get("DATABASE_URL", "")
if url.startswith("postgresql"):
    from sqlalchemy import create_engine, text
    engine = create_engine(url, pool_pre_ping=True)
    deadline = 60
    for attempt in range(1, deadline + 1):
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            print(f"db: ready after {attempt}s", flush=True)
            break
        except Exception as exc:  # noqa: BLE001
            print(f"db: waiting ({attempt}/{deadline}) - {exc.__class__.__name__}", flush=True)
            time.sleep(1)
    else:
        print("db: unreachable, giving up", file=sys.stderr, flush=True)
        sys.exit(1)
else:
    print("db: sqlite (no wait)", flush=True)
PY

# 2) Seed master data (clients / employees / payroll). Idempotent reseed.
if [ "${TIA_SEED_ON_START:-true}" = "true" ]; then
  echo "seed: loading master data from data/seed"
  python -m tia_ai.seed
fi

# 3) Generate the synthetic input cases + gold ground truth used by /eval.
#    Non-fatal: the API serves fine even if fixture generation hiccups.
if [ "${TIA_SYNTH_ON_START:-true}" = "true" ]; then
  echo "synth: generating eval fixtures"
  python -m tia_ai.synthgen || echo "synth: generation skipped (non-fatal)"
fi

# 4) Right-size uvicorn workers to the container's ACTUAL cpu + memory budget,
#    unless UVICORN_WORKERS is pinned to a number. This makes one image correct
#    on a 1-CPU/1GB box and a 16-core server alike: never more workers than
#    memory can hold (no OOM) or cores can run (no thrash). Each worker resident
#    set is ~170MB + transient; we budget TIA_MB_PER_WORKER (default 300) so a
#    burst of concurrent uploads never pushes the container over its limit.
derive_workers() {
  mb_per_worker="${TIA_MB_PER_WORKER:-300}"; base_mb=300
  # cores: cgroup v2 cpu.max ("quota period"); fall back to nproc.
  cores=""
  if [ -r /sys/fs/cgroup/cpu.max ]; then
    # shellcheck disable=SC2046
    set -- $(cat /sys/fs/cgroup/cpu.max 2>/dev/null)
    if [ "${1:-max}" != "max" ] && [ "${2:-0}" -gt 0 ] 2>/dev/null; then
      cores=$(( ($1 + $2 - 1) / $2 ))
    fi
  fi
  [ -z "$cores" ] && cores=$(nproc 2>/dev/null || echo 1)
  [ "$cores" -lt 1 ] 2>/dev/null && cores=1
  # memory limit: cgroup v2 memory.max, else v1, else unlimited.
  memmax=""
  [ -r /sys/fs/cgroup/memory.max ] && memmax=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)
  { [ -z "$memmax" ] || [ "$memmax" = "max" ]; } && [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ] \
    && memmax=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)
  mem_workers=999
  if [ -n "$memmax" ] && [ "$memmax" != "max" ] && [ "$memmax" -gt 0 ] 2>/dev/null; then
    mem_mb=$(( memmax / 1024 / 1024 ))
    mem_workers=$(( (mem_mb - base_mb) / mb_per_worker ))
    [ "$mem_workers" -lt 1 ] && mem_workers=1
  fi
  w="$cores"; [ "$mem_workers" -lt "$w" ] && w="$mem_workers"
  cap="${TIA_MAX_WORKERS:-8}"; [ "$w" -gt "$cap" ] && w="$cap"
  [ "$w" -lt 1 ] && w=1
  echo "$w"
}

WORKERS="${UVICORN_WORKERS:-auto}"
case "$WORKERS" in
  ""|auto|AUTO) WORKERS="$(derive_workers)"; echo "api: auto-sized to ${WORKERS} worker(s) for this box (override with UVICORN_WORKERS)";;
  *) echo "api: ${WORKERS} worker(s) (pinned via UVICORN_WORKERS)";;
esac

# 5) Serve. proxy-headers so the nginx X-Forwarded-* chain is trusted.
exec uvicorn tia_ai.api.app:app \
  --host 0.0.0.0 --port 8000 \
  --workers "${WORKERS}" \
  --proxy-headers --forwarded-allow-ips '*' \
  --log-level "${LOG_LEVEL:-info}"
