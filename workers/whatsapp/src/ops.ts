/**
 * Operational CLI for connecting a real Meta WhatsApp number to TIA.
 *
 *   bun run src/ops.ts verify                  # check the token can see the number + show its status
 *   bun run src/ops.ts register [pin]          # activate the number on the Cloud API (6-digit PIN)
 *   bun run src/ops.ts subscribe [wabaId]      # subscribe this Meta app to the WABA (so webhooks fire)
 *   bun run src/ops.ts fields [wabaId]         # list the app's current WABA subscription
 *   bun run src/ops.ts send <to> [text]        # send a free-form text (in-window smoke test)
 *
 * Reads credentials from the environment (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
 * WHATSAPP_WABA_ID, WHATSAPP_API_VERSION, WHATSAPP_REGISTER_PIN). Nothing is hardcoded; tokens are
 * never printed in full.
 */
export {};

const env = Bun.env;
const TOKEN = (env.WHATSAPP_TOKEN ?? "").trim();
const PHONE_ID = (env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
const WABA_ID_ENV = (env.WHATSAPP_WABA_ID ?? "").trim();
const API = (env.WHATSAPP_API_VERSION ?? "v23.0").trim();
const BASE = `https://graph.facebook.com/${API}`;

function obfuscate(token: string): string {
  return token.length > 16 ? `${token.slice(0, 8)}…${token.slice(-6)}` : "***";
}

function requireToken(): void {
  if (TOKEN.length === 0) {
    console.error("✗ WHATSAPP_TOKEN is not set. Put it in services/whatsapp/.env or export it.");
    process.exit(1);
  }
}

async function graph(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function show(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(26)} ${value ?? "N/A"}`);
}

async function verify(): Promise<void> {
  requireToken();
  if (PHONE_ID.length === 0) {
    console.error("✗ WHATSAPP_PHONE_NUMBER_ID is not set.");
    process.exit(1);
  }
  console.log(`Verifying token ${obfuscate(TOKEN)} against phone-number-id ${PHONE_ID} (${API})…`);
  const r = await graph("GET", `${PHONE_ID}?fields=verified_name,display_phone_number,quality_rating,status,code_verification_status,platform_type`);
  if (!r.ok) {
    console.error("✗ FAILURE:", JSON.stringify(r.data, null, 2));
    console.error("\nCheck: token belongs to the same Business Manager as the WABA, and has scopes");
    console.error("whatsapp_business_management + whatsapp_business_messaging; phone-number-id is correct.");
    process.exit(1);
  }
  const d = r.data as Record<string, unknown>;
  console.log("✓ Token can see the number:");
  show("Verified name", d.verified_name);
  show("Display number", d.display_phone_number);
  show("Quality rating", d.quality_rating);
  show("Status", d.status);
  show("Code verification", d.code_verification_status);
  show("Platform", d.platform_type);
}

async function register(pin: string): Promise<void> {
  requireToken();
  if (PHONE_ID.length === 0) {
    console.error("✗ WHATSAPP_PHONE_NUMBER_ID is not set.");
    process.exit(1);
  }
  console.log(`Registering / activating ${PHONE_ID} on the Cloud API…`);
  const r = await graph("POST", `${PHONE_ID}/register`, { messaging_product: "whatsapp", pin });
  if (!r.ok) {
    console.error("✗ FAILURE:", JSON.stringify(r.data, null, 2));
    process.exit(1);
  }
  console.log("✓ Registered/activated:", JSON.stringify(r.data));
}

async function subscribe(wabaId: string): Promise<void> {
  requireToken();
  if (wabaId.length === 0) {
    console.error("✗ Provide a WABA id: `ops subscribe <wabaId>` or set WHATSAPP_WABA_ID.");
    process.exit(1);
  }
  console.log(`Subscribing this app to WABA ${wabaId}…`);
  const r = await graph("POST", `${wabaId}/subscribed_apps`);
  if (!r.ok) {
    console.error("✗ FAILURE:", JSON.stringify(r.data, null, 2));
    process.exit(1);
  }
  console.log("✓ Subscribed:", JSON.stringify(r.data));
  console.log("Now set the webhook Callback URL to https://<host>/webhook/whatsapp,");
  console.log(`the Verify token to your WHATSAPP_VERIFY_TOKEN, and subscribe the 'messages' field.`);
}

async function fields(wabaId: string): Promise<void> {
  requireToken();
  if (wabaId.length === 0) {
    console.error("✗ Provide a WABA id: `ops fields <wabaId>` or set WHATSAPP_WABA_ID.");
    process.exit(1);
  }
  const r = await graph("GET", `${wabaId}/subscribed_apps`);
  console.log(r.ok ? "✓ Current subscription:" : "✗ FAILURE:", JSON.stringify(r.data, null, 2));
  if (!r.ok) process.exit(1);
}

async function send(to: string, text: string): Promise<void> {
  requireToken();
  if (PHONE_ID.length === 0 || to.length === 0) {
    console.error("✗ Usage: ops send <recipient-msisdn> [text]   (recipient incl. country code)");
    process.exit(1);
  }
  console.log(`Sending text from ${PHONE_ID} to ${to}…`);
  const r = await graph("POST", `${PHONE_ID}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text, preview_url: false },
  });
  if (!r.ok) {
    console.error("✗ FAILURE:", JSON.stringify(r.data, null, 2));
    console.error("\nIf the error code is 131047/131026/470, the 24h window is closed - the recipient");
    console.error("must message you first, or you must send an approved template.");
    process.exit(1);
  }
  console.log("✓ Sent:", JSON.stringify(r.data));
}

async function main(): Promise<void> {
  const [cmd, a1, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "verify":
      return verify();
    case "register":
      return register((a1 ?? env.WHATSAPP_REGISTER_PIN ?? "").trim());
    case "subscribe":
      return subscribe((a1 ?? WABA_ID_ENV).trim());
    case "fields":
      return fields((a1 ?? WABA_ID_ENV).trim());
    case "send":
      return send((a1 ?? "").trim(), rest.join(" ") || "TIA WhatsApp connectivity test ✅");
    default:
      console.log("Commands: verify | register [pin] | subscribe [wabaId] | fields [wabaId] | send <to> [text]");
      process.exit(cmd === undefined ? 0 : 1);
  }
}

main().catch((error) => {
  console.error("ops failed:", error);
  process.exit(1);
});
