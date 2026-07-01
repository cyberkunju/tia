.PHONY: help install seed synth eval test test-cov api web whatsapp dispatch dispatch-build mail mail-once dev demo demo-seed-3 clean db-backup db-restore retention

help:
	@echo "TIA — Touchless Invoice Agent"
	@echo ""
	@echo "  make install    install all deps (uv for workers/ai, bun for apps/web + workers/whatsapp)"
	@echo "  make seed       seed master data from data/seed/*.xlsx"
	@echo "  make synth      generate the sample input cases + gold"
	@echo "  make eval       run the eval harness (F1, ECE, pass/fail)"
	@echo "  make test       run all test suites (python pytest + bun)"
	@echo "  make test-cov   run pytest with coverage gate (fail under 100%)"
	@echo "  make api        run the core FastAPI on :8000"
	@echo "  make web        run the Vite dev server on :5173"
	@echo "  make whatsapp   run the WhatsApp bridge on :8088 (forwards to the core)"
	@echo "  make dispatch   build + run Rust dispatch service on :8001"
	@echo "  make mail       poll Zoho Mail (tia@cyberkunju.com) forever, ingest each unseen msg"
	@echo "  make mail-once  poll Zoho once for debugging"
	@echo "  make dev        api + web in parallel"
	@echo "  make demo       full: install, seed, synth, eval, then run dev"
	@echo "  make db-backup  pg_dump the running compose Postgres (gzip, pruned)"
	@echo "  make db-restore FILE=dump.sql.gz   restore a dump into the running db"

install:
	cd workers/ai && uv sync
	cd apps/web && bun install
	cd workers/whatsapp && bun install

seed:
	cd workers/ai && uv run python -m tia_ai.seed

synth:
	cd workers/ai && uv run python -m tia_ai.synthgen

eval:
	cd workers/ai && uv run python -m tia_ai.eval.run

test:
	cd workers/ai && uv run python -m pytest -q
	cd workers/whatsapp && bun test
	cd apps/web && bun run test

test-cov:
	cd workers/ai && uv run python -m pytest -q --cov=tia_ai --cov-report=term-missing --cov-fail-under=100

api:
	cd workers/ai && uv run uvicorn tia_ai.api.app:app --host 0.0.0.0 --port 8000 --reload

web:
	cd apps/web && bun run dev

whatsapp:
	cd workers/whatsapp && bun run dev

dispatch-build:
	cd services/dispatch && cargo build --release

dispatch: dispatch-build
	@DATABASE_URL="sqlite:///$(PWD)/tia.db" \
	 OUTBOX_DIR="$(PWD)/staging/outbox" \
	 PORT=8001 \
	 ./services/dispatch/target/release/tia-dispatch

mail:
	@echo "Polling Zoho Mail every ZOHO_POLL_INTERVAL_SEC seconds (default 30s)"
	@echo "Set ZOHO_IMAP_USER + ZOHO_IMAP_PASSWORD in .env first."
	cd workers/ai && uv run python -m tia_ai.mailbox.poller --loop

mail-once:
	@echo "Polling Zoho Mail once (for debugging)"
	cd workers/ai && uv run python -m tia_ai.mailbox.poller

dev:
	@( cd workers/ai && uv run uvicorn tia_ai.api.app:app --host 0.0.0.0 --port 8000 --reload ) & \
	cd apps/web && bun run dev

demo: install seed synth eval
	@echo ""
	@echo "All set. Open terminals:"
	@echo "  Terminal 1:  make api        (core on :8000)"
	@echo "  Terminal 2:  make web         then open http://127.0.0.1:5173"
	@echo "  Terminal 3:  make whatsapp    (bridge on :8088 — needs Meta creds in workers/whatsapp/.env)"
	@echo ""

clean:
	rm -rf workers/ai/.venv apps/web/node_modules apps/web/dist staging tia.db \
	       workers/whatsapp/node_modules workers/whatsapp/staging

# ── Ops: database backup / restore (operate on the running compose db) ──────
db-backup:
	bash deploy/backup.sh

db-restore:
	@test -n "$(FILE)" || { echo "usage: make db-restore FILE=path/to/dump.sql.gz"; exit 1; }
	@echo "Restoring $(FILE) into the running db (tia-db-1)…"
	gunzip -c "$(FILE)" | docker exec -i tia-db-1 psql -U $${POSTGRES_USER:-tia} -d $${POSTGRES_DB:-tia}

retention:
	@echo "Retention dry-run (old raw staging files eligible for purge; add --purge to delete):"
	cd workers/ai && uv run python -m tia_ai.retention
