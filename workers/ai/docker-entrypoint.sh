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

# 4) Serve. proxy-headers so the nginx X-Forwarded-* chain is trusted.
echo "api: starting uvicorn (${UVICORN_WORKERS:-2} worker(s))"
exec uvicorn tia_ai.api.app:app \
  --host 0.0.0.0 --port 8000 \
  --workers "${UVICORN_WORKERS:-2}" \
  --proxy-headers --forwarded-allow-ips '*' \
  --log-level "${LOG_LEVEL:-info}"
