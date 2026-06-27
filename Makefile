.PHONY: help install seed synth eval api web dev demo demo-seed-3 clean

help:
	@echo "TIA — Touchless Invoice Agent"
	@echo ""
	@echo "  make install    install python+node deps (uv + bun)"
	@echo "  make seed       seed master data from data/seed/*.xlsx"
	@echo "  make synth      generate the 7 sample input cases + gold"
	@echo "  make eval       run the eval harness (F1, ECE, pass/fail)"
	@echo "  make api        run FastAPI on :8000"
	@echo "  make web        run Vite dev server on :5173"
	@echo "  make dev        api + web in parallel"
	@echo "  make demo       full: install, seed, synth, eval, then run dev"

install:
	cd workers/ai && uv sync
	cd apps/web && bun install

seed:
	cd workers/ai && uv run python -m tia_ai.seed

synth:
	cd workers/ai && uv run python -m tia_ai.synthgen

eval:
	cd workers/ai && uv run python -m tia_ai.eval.run

api:
	cd workers/ai && uv run uvicorn tia_ai.api.app:app --host 0.0.0.0 --port 8000 --reload

web:
	cd apps/web && bun run dev

dev:
	@( cd workers/ai && uv run uvicorn tia_ai.api.app:app --host 0.0.0.0 --port 8000 --reload ) & \
	cd apps/web && bun run dev

demo: install seed synth eval
	@echo ""
	@echo "All set. Open two terminals:"
	@echo "  Terminal 1:  make api"
	@echo "  Terminal 2:  make web   then open http://127.0.0.1:5173"
	@echo ""

demo-seed-3:
	@cd workers/ai && uv run python - <<'PY'
	import requests
	BASE = "http://127.0.0.1:8000"
	from pathlib import Path
	root = Path("../../data/synthetic")
	for f in ["case_07_clean.xlsx", "case_01_email_no_empid.eml", "case_04_handwritten.png"]:
	    p = root / f
	    mime = "application/octet-stream"
	    if p.suffix == ".xlsx": mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	    elif p.suffix == ".eml": mime = "message/rfc822"
	    elif p.suffix == ".png": mime = "image/png"
	    files = {"file": (p.name, p.read_bytes(), mime)}
	    r = requests.post(f"{BASE}/intake/upload", files=files, headers={"Idempotency-Key": p.name})
	    print(f.ljust(36), r.status_code, r.json().get("routing"), r.json().get("confidence"))
	PY

clean:
	rm -rf workers/ai/.venv apps/web/node_modules apps/web/dist staging tia.db
