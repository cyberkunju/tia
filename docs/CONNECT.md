# TIA Connect — the public protocol surface

TIA exposes its 17 grounded tools as a Model Context Protocol (MCP) server so
**any** MCP-aware host — Claude Desktop, Cursor, custom OpenAI clients, internal
agents — can drive TASC's month-close without reimplementing TIA's domain
logic. The same tools power the in-app `/qa/stream` agentic chat.

## Architecture

```
Frontend                                Backend (FastAPI on :8000)
─────────                               ──────────────────────────
Assistant.tsx (side panel)              /qa/stream      → structured-event SSE
  ↓ fetch + ReadableStream                                {type: tool|token|done|error}
InvoiceChatTrigger.tsx (sparkle)        /qa             → blocking compatibility shim
  → ?aida=<id> URL param                /metrics/leakage
icebreakers.ts (~28 prompts)            /finance/leakage/{emp}/recover
LeakageSentinelCard.tsx                 /invoices/{id}/sap-b1-payload
                                        /mcp            → FastMCP streamable_http_app
                                          ├─ 12 read tools
                                          └─  5 write tools
                                        qa/agent.py: tool registry
                                        qa/streaming.py: AsyncOpenAI + event yielder
                                        finance/leakage.py: 5-reason taxonomy
                                        finance/recovery.py: catch-up invoice builder
                                        integrations/sap_b1/mapping.py: OData v4 payload
                                        mcp/server.py: FastMCP, 17 @mcp.tool wrappers
```

## Transport options

Two transports, same tool registry. Choose by your client:

| Transport          | URL / command                          | Best for                              |
|--------------------|----------------------------------------|---------------------------------------|
| Streamable HTTP    | `https://tia.cyberkunju.com/mcp/`      | Claude, Cursor, Kiro, GPT, web hosts  |
| Streamable HTTP    | `http://127.0.0.1:8000/mcp/` (local)   | Same host / server-to-server          |
| stdio (subprocess) | `uv run tia-mcp`                       | Claude Desktop, local CLI clients     |

The HTTP transport is **stateless JSON** (multi-worker- and proxy-safe). Always
use the **trailing slash** (`/mcp/`) to skip the mount redirect.

> Security note: the public HTTP endpoint is currently unauthenticated and
> exposes write tools. Put it behind a bearer token / Cloudflare Access before
> real use. The stdio transport runs locally and needs no network auth.

### Claude Desktop (stdio, local)

```json
{
  "mcpServers": {
    "tia": {
      "command": "uv",
      "args": ["--directory", "/absolute/path/to/tia/workers/ai", "run", "tia-mcp"]
    }
  }
}
```

### Claude / Cursor / Kiro / GPT (remote Streamable HTTP)

```json
{
  "mcpServers": {
    "tia": {
      "url": "https://tia.cyberkunju.com/mcp/"
    }
  }
}
```

Kiro (`~/.kiro/settings/mcp.json`) and Cursor use the same `url` shape. Hosts
that speak only stdio can bridge to the URL with `npx mcp-remote
https://tia.cyberkunju.com/mcp/`.

## Tool inventory

All 17 tools share the data-isolation boundary: when a Client persona is
querying through `/qa`, every tool is scoped to that client's `client_code`
server-side — the LLM cannot widen its own scope. (The MCP surface doesn't
expose `scope`; it assumes the host is acting on behalf of an internal
operator.)

### Read tools (12)

| Tool                       | What it returns                                                                |
|----------------------------|--------------------------------------------------------------------------------|
| `get_client_settings`      | Name, jurisdiction, currency, TRN, dispatch rules                              |
| `get_contract`             | Active contract: rate card, SOWs, OT cap, markup, VAT rate, SAC code           |
| `get_invoice`              | Invoice totals, status, rule_results (R1..R10) — accepts id or sequence_no     |
| `get_timesheet`            | Status, routing, confidence, hitl_reason, failed validations                   |
| `get_events`               | Append-only audit timeline for any entity                                      |
| `search_employees`         | Fuzzy search by name / emp_id / email                                          |
| `get_employee_history`     | Payroll + billed-invoice history (decide one-off vs chronic miss)              |
| `find_revenue_leakage`     | Top 10 unbilled associates + per-client aggregates + trailing baseline         |
| `verify_audit_chain`       | ok flag, total events, head hash, any chain breaks                             |
| `metrics_stp`              | Touchless processing rate                                                      |
| `list_clients`             | Roster of clients TASC bills                                                   |
| `prepare_sap_b1_payload`   | SAP B1 OData v4 A/R Invoice JSON body — `POST /b1s/v2/Invoices`                |

### Write tools (5)

Every write also emits `agent.<tool>_invoked` to the audit chain — the proof
that an agent (vs a human in the FinOps console) initiated the mutation.

| Tool                       | What it does                                                                                                     |
|----------------------------|------------------------------------------------------------------------------------------------------------------|
| `recover_leakage`          | Issue a catch-up invoice for one (emp_id, period). Sequence number gets a `-R\d+` suffix.                        |
| `dispatch_invoice`         | Force-dispatch a generated invoice (idempotent on the invoice id).                                                |
| `clawback_invoice`         | Pre-dispatch → voided in-place. Post-dispatch → returns `requires_console` (credit-note flow needs the FinOps UI). |
| `approve_timesheet`        | Approve a HITL timesheet and regenerate its invoice (idempotency-keyed).                                          |
| `resend_invoice_email`     | Re-send invoice email with a fresh idempotency key.                                                              |

## Example walkthrough — month-close

Ask any MCP host: *"Run TIA's month-close for June 2026."*

```
1. find_revenue_leakage(period="June 2026")
   → {total_aed: 47820, associate_count: 12, by_client: [...], entries: [...]}
2. For each entry: recover_leakage(emp_id, "June 2026", entry.reason)
   → {ok: true, invoice_sequence_no: "TIA-CL004-JUNE2026-R001", amount_aed: 3985, ...}
3. metrics_stp()  → {rate: 0.91, ...}
4. verify_audit_chain()  → {ok: true, total: 287, head_hash: "0xa7b3...", ...}
5. Prose summary: "Recovered 12 unbilled associates totaling AED 47,820 across
   3 clients. Touchless rate now 91%. Audit chain advanced to 0xa7b3... with
   no breaks."
```

The Claude skill at `.claude/skills/tia-month-close.md` codifies this workflow
so dropping into the skill triggers the right tool sequence automatically.

## Audit-chain guarantee

Every TIA event — system or agent — chains to its predecessor via
`sha256(prev_hash + actor + entity_id + action + payload + before + after)`.
`verify_audit_chain()` re-walks the chain and reports tamper evidence with the
head hash. The MCP host can call it before AND after a multi-write workflow to
prove no other actor touched the chain in between.

## Adding a connector

New tools live in [`workers/ai/tia_ai/qa/agent.py`](../workers/ai/tia_ai/qa/agent.py).
Add to the `_DISPATCH` registry there + the OpenAI schema in `TOOLS`, then add a
`@mcp.tool(...)` wrapper in [`workers/ai/tia_ai/mcp/server.py`](../workers/ai/tia_ai/mcp/server.py).
Both transports pick up the new tool automatically on next start.

Writes should:

1. Take a `session: Session` first param + tool args.
2. Mutate, then emit a domain event via `orchestrator.log_event(...)`.
3. Call `_log_agent_invocation(...)` so the agentic-mutation receipt is on the chain.
4. Return a small dict — `{ok: bool, ...}` — for the `result_summary` in the
   streaming tool strip.

Reads should:

1. Honour `scope: str | None` for data isolation.
2. Return a JSON-serialisable dict.
3. Never make outbound network calls without flagging it in the tool description.
