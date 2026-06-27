.PHONY: help install seed synth eval test api web whatsapp dispatch dispatch-build dev demo demo-seed-3 clean

help:
	@echo "TIA — Touchless Invoice Agent"
	@echo ""
	@echo "  make install    install all deps (uv for workers/ai, bun for apps/web + workers/whatsapp)"
	@echo "  make seed       seed master data from data/seed/*.xlsx"
	@echo "  make synth      generate the sample input cases + gold"
	@echo "  make eval       run the eval harness (F1, ECE, pass/fail)"
	@echo "  make test       run all test suites (python pytest + bun)"
	@echo "  make api        run the core FastAPI on :8000"
	@echo "  make web        run the Vite dev server on :5173"
	@echo "  make whatsapp   run the WhatsApp bridge on :8088 (forwards to the core)"
	@echo "  make dispatch   build + run Rust dispatch service on :8001"
	@echo "  make dev        api + web in parallel"
	@echo "  make demo       full: install, seed, synth, eval, then run dev"

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
