/**
 * Server entrypoint. Loads + validates config (fail-fast), serves the bridge on Bun, and shuts
 * down gracefully. No database: the bridge is a pure transport adapter to the core API.
 */
import { getConfig, redactedSummary } from "./config.ts";
import { buildApp } from "./app.ts";

function main(): void {
  const config = getConfig();
  const built = buildApp({ config });

  console.log("[whatsapp] starting", JSON.stringify(redactedSummary(config)));

  const server = Bun.serve({ port: config.server.port, fetch: built.app.fetch, idleTimeout: 30 });

  console.log(`[whatsapp] listening on :${config.server.port}`);
  console.log(`[whatsapp] webhook:   /webhook/whatsapp`);
  console.log(`[whatsapp] forwards → ${config.upstream.apiUrl}/intake/whatsapp`);
  if (!config.server.isProduction) {
    console.log(`[whatsapp] simulator: POST /internal/simulator/whatsapp (dev only)`);
  }

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[whatsapp] received ${signal}, shutting down…`);
    try {
      await server.stop(true);
    } catch {
      /* ignore */
    }
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main();
