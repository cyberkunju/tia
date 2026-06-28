"""TIA Connect - MCP (Model Context Protocol) server surface.

Exposes the TIA agent's 17 tools to any MCP-aware client (Claude Desktop,
Cursor, OpenAI-compatible MCP hosts, etc.) over two transports:

- **stdio** via the `tia-mcp` console script (declared in pyproject.toml).
  Used by Claude Desktop / claude_desktop_config.json.
- **streamable HTTP** mounted at `/mcp` in the FastAPI app. Used by any web
  MCP client that can speak HTTP.

The singleton `mcp = FastMCP(...)` lives here so both transports share the
same tool registry. The 17 tool wrappers themselves are registered by
`tia_ai.mcp.server` on import (we eagerly import below).
"""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

mcp = FastMCP(
    name="TIA - Touchless Invoice Agent",
    instructions=(
        "TIA is TASC Outsourcing's autonomous billing operator for UAE staffing. "
        "Use these tools to read state (invoices, timesheets, contracts, audit chain, "
        "revenue leakage) and to mutate state (recover leakage, dispatch, clawback, "
        "approve, resend email). Every write is recorded on a tamper-evident audit "
        "chain. Prefer the smallest tool set; quote IDs and AED amounts verbatim."
    ),
    # The streamable_http_app exposes its route at this path INTERNALLY. We
    # mount the sub-app under /mcp in api/app.py, so set the internal path to
    # "/" — the public URL ends up at /mcp (not /mcp/mcp).
    streamable_http_path="/",
    # Stateless + JSON responses. The API runs multiple uvicorn workers and sits
    # behind nginx + Cloudflare; a stateful SSE session would break because the
    # follow-up request can land on a different worker that doesn't hold the
    # in-memory session (causing client hangs). Stateless makes every JSON-RPC
    # request self-contained, and json_response returns plain application/json
    # instead of an SSE stream — proxy- and multi-worker-safe, which is exactly
    # what a request/response tool server needs.
    stateless_http=True,
    json_response=True,
    # FastMCP auto-enables DNS-rebinding protection (allowed_hosts limited to
    # localhost) when host is 127.0.0.1, which rejects every proxied/public Host
    # header with 421 Misdirected Request. This server is reached only through
    # nginx + the Cloudflare edge (where host/origin control lives), so we turn
    # the in-app host check off and accept the reverse-proxied Host.
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
        allowed_hosts=["*"],
        allowed_origins=["*"],
    ),
)

# Eager import to register every @mcp.tool wrapper on the singleton above.
from . import server as _server  # noqa: E402,F401


def run_stdio() -> None:
    """Entry point for the `tia-mcp` console script (stdio transport).

    Claude Desktop's claude_desktop_config.json launches us via:
        {"command": "uv", "args": ["--directory", "/path/to/workers/ai", "run", "tia-mcp"]}
    """
    # FastMCP.run() defaults to stdio transport.
    mcp.run()


__all__ = ["mcp", "run_stdio"]
