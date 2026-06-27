# TIA - WhatsApp bridge (`workers/whatsapp`)

A thin, stateless **Meta WhatsApp Cloud API adapter** (Bun + Hono + TypeScript). It is the bridge
the core's `POST /intake/whatsapp` contract (CONTRACTS.md §2) was designed for: a client or
employee sends a timesheet to the TASC WhatsApp number - as an Excel/PDF **file**, a **photo** of a
handwritten sheet, or **typed text** - and this service:

1. verifies the webhook is genuinely from Meta (HMAC over the raw body, constant-time),
2. acknowledges within milliseconds (Meta drops slow webhooks),
3. de-duplicates retries (in-memory ring + the forwarded `Idempotency-Key`),
4. downloads any attachment from the Graph API and **stages** it (served back at `/media/<hash>`),
5. **forwards** the message to the core: `POST {UPSTREAM_API_URL}/intake/whatsapp`,
6. replies to the user - sending the generated **invoice PDF** when the pipeline auto-approved, or a
   status message when it routed to human review.

It owns **no database**: the core is the single source of truth. That keeps the bridge a pure
transport layer and avoids a second persistence stack.

## Why it's built this way

| Concern | Decision |
| --- | --- |
| Authenticity | `X-Hub-Signature-256` HMAC-SHA256 over the exact raw body, verified **before** parsing. |
| Fast ACK | raw body → verify → **200 immediately**, heavy work on a microtask. |
| At-least-once | in-memory dedup ring + `Idempotency-Key` forwarded to the core's `events` table. |
| Decoupling | the core fetches `attachment_url` from this bridge's `/media/<hash>`; the bridge never touches the DB. |
| Multi-number | replies originate FROM the number the message arrived on (24h window is per-number). |
| Trust boundary | MIME/size guards on media; the `/media` route is name-validated and read-only. |

## Run

```bash
cd workers/whatsapp
bun install
cp .env.example .env     # Meta creds + UPSTREAM_API_URL + BRIDGE_PUBLIC_URL
bun run dev              # http://localhost:8088 ; forwards to UPSTREAM_API_URL/intake/whatsapp
```

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/webhook/whatsapp` | Meta verification handshake |
| POST | `/webhook/whatsapp` | inbound delivery (signed) → forwards to the core |
| GET | `/media/:name` | serves staged inbound media for the core to download |
| GET | `/healthz` | liveness + configured upstream |
| POST | `/internal/notify` | optional outbound push (secret-guarded) |
| POST | `/internal/simulator/whatsapp` | **dev only** - sign + inject a payload (hidden in production) |

## Test without a live Meta number

```bash
bun run dev                 # one shell
bun run src/simulate.ts     # another - fires text / document / image samples through the bridge
```

## Connect a real number

```bash
bun run ops verify          # check the token sees the number + status
bun run ops register 123456 # activate on the Cloud API
bun run ops subscribe       # subscribe the app to the WABA (webhooks fire)
bun run ops send 9715XXXX   # in-window text smoke test
```
Then point the Meta webhook **Callback URL** to `https://<host>/webhook/whatsapp`, set the
**Verify token** to `WHATSAPP_VERIFY_TOKEN`, and subscribe the **messages** field.

## Tests

```bash
bun test        # signature, dedup, parser, sender, full adapter→core e2e (no network)
bun run typecheck
```
