/**
 * Configuration loader with fail-fast validation.
 *
 * The bridge is a pure transport adapter between the Meta WhatsApp Cloud API and the TIA core
 * API: it owns no database. It downloads inbound media, stages it, and forwards each message to
 * the core's `POST /intake/whatsapp` (CONTRACTS.md §2), then replies to the user with the result.
 */
export type EnvSource = Record<string, string | undefined>;

export interface AppConfig {
  readonly meta: {
    readonly token: string;
    readonly phoneNumberId: string;
    readonly appSecret: string;
    readonly verifyToken: string;
    readonly apiVersion: string;
  };
  readonly upstream: {
    /** TIA core API base, e.g. http://localhost:8000 . */
    readonly apiUrl: string;
  };
  readonly server: {
    readonly port: number;
    readonly isProduction: boolean;
    /** Public base URL of THIS bridge, used to build attachment_url the core can fetch. */
    readonly publicUrl: string;
  };
  readonly ingest: {
    readonly maxMediaBytes: number;
  };
  readonly storage: {
    readonly stagingDir: string;
  };
  readonly internal: {
    /** Optional shared secret guarding the outbound /internal/notify endpoint. */
    readonly secret: string;
  };
}

export class ConfigError extends Error {
  readonly keys: readonly string[];
  constructor(message: string, keys: readonly string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.keys = keys;
  }
}

const DEFAULT_API_VERSION = "v23.0";
const DEFAULT_PORT = 8088;
const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024;

function clean(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

function req(env: EnvSource, key: string, missing: string[]): string {
  const v = clean(env[key]);
  if (v === undefined) {
    missing.push(key);
    return "";
  }
  return v;
}

function parseInt10(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: EnvSource = Bun.env): AppConfig {
  const missing: string[] = [];
  const port = parseInt10(clean(env.PORT), DEFAULT_PORT);

  const config: AppConfig = {
    meta: {
      token: req(env, "WHATSAPP_TOKEN", missing),
      phoneNumberId: req(env, "WHATSAPP_PHONE_NUMBER_ID", missing),
      appSecret: clean(env.WHATSAPP_APP_SECRET) ?? "",
      verifyToken: req(env, "WHATSAPP_VERIFY_TOKEN", missing),
      apiVersion: clean(env.WHATSAPP_API_VERSION) ?? DEFAULT_API_VERSION,
    },
    upstream: {
      apiUrl: (req(env, "UPSTREAM_API_URL", missing)).replace(/\/+$/, ""),
    },
    server: {
      port,
      isProduction: (clean(env.NODE_ENV) ?? "").toLowerCase() === "production",
      publicUrl: (clean(env.BRIDGE_PUBLIC_URL) ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    },
    ingest: { maxMediaBytes: parseInt10(clean(env.MAX_MEDIA_BYTES), DEFAULT_MAX_MEDIA_BYTES) },
    storage: { stagingDir: clean(env.STAGING_DIR) ?? "./staging" },
    internal: { secret: clean(env.INTERNAL_SECRET) ?? "tia-internal-dev" },
  };

  if (missing.length > 0) {
    throw new ConfigError(
      `Configuration error - missing required keys: ${missing.join(", ")}.`,
      missing,
    );
  }
  return Object.freeze(config);
}

export function graphBaseUrl(cfg: AppConfig): string {
  return `https://graph.facebook.com/${cfg.meta.apiVersion}`;
}

export function redactedSummary(cfg: AppConfig): Record<string, unknown> {
  return {
    meta: {
      tokenPresent: cfg.meta.token.length > 0,
      phoneNumberIdPresent: cfg.meta.phoneNumberId.length > 0,
      appSecretPresent: cfg.meta.appSecret.length > 0,
      verifyTokenPresent: cfg.meta.verifyToken.length > 0,
      apiVersion: cfg.meta.apiVersion,
    },
    upstreamApiUrl: cfg.upstream.apiUrl,
    publicUrl: cfg.server.publicUrl,
    port: cfg.server.port,
    isProduction: cfg.server.isProduction,
    stagingDir: cfg.storage.stagingDir,
  };
}

let cached: AppConfig | undefined;
export function getConfig(): AppConfig {
  if (cached === undefined) cached = loadConfig();
  return cached;
}
export function resetConfigCache(): void {
  cached = undefined;
}
